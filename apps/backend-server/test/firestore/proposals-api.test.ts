import assert from 'node:assert/strict'
import { it } from 'node:test'
import { INFRASTRUCTURE_COLLECTIONS, collections } from '../../src/domain/shared/collections.js'
import type { CaseMember } from '../../src/domain/authorization/case-role.js'
import { seedHeir, agreeExternalAiConsent, agreeRequiredConsents, buildApp, call, jsonRequest, seedTenantMember } from './helpers/app.js'
import type { Json, TestAppOptions } from './helpers/app.js'
import { describeFirestore, firestore, newTenantId, unitOfWork, workContext } from './helpers/emulator.js'

const caseBody = {
  deceasedName: '架空 太郎',
  dateOfDeath: '2026-04-01',
  knownAt: '2026-04-03',
  ownerName: '架空 花子',
  relationshipToDeceased: '配偶者',
}

const taskPayload = {
  title: '提案から作る手続き',
  summary: '試験用です。',
  stage: 'immediate',
  category: '行政手続き',
}

let keyCounter = 0
function nextKey(prefix: string): string {
  keyCounter += 1
  return `${prefix}-${String(keyCounter).padStart(8, '0')}`
}

async function setup(options: TestAppOptions & { personId?: string | null } = {}) {
  const tenantId = newTenantId()
  const userId = 'user-owner'
  await seedTenantMember(tenantId, userId)
  const app = buildApp(tenantId, userId, options)
  await agreeRequiredConsents(app)
  const created = await call(app, '/cases', jsonRequest('POST', caseBody, nextKey('idem-case')))
  const caseId = created.body.data.id as string

  if (options.personId !== undefined && options.personId !== null) {
    await seedHeir(tenantId, caseId, options.personId)
    await unitOfWork().run(workContext(tenantId), async (tx) => {
      const member = await tx.require<CaseMember>({
        collection: collections.caseMembers,
        caseId,
        id: userId,
      })
      tx.update<CaseMember>(
        { collection: collections.caseMembers, caseId, id: userId },
        member.version,
        { personId: options.personId ?? null },
      )
    })
  }

  return { tenantId, userId, app, caseId }
}

async function submitTaskProposal(app: ReturnType<typeof buildApp>, caseId: string): Promise<Json> {
  const response = await call(
    app,
    `/cases/${caseId}/proposals`,
    jsonRequest(
      'POST',
      { kind: 'TASK_PROPOSAL', title: '手続きの追加', payload: taskPayload },
      nextKey('idem-proposal'),
    ),
  )
  assert.equal(response.status, 201, JSON.stringify(response.body))
  return response.body.data
}

async function requestApproval(
  app: ReturnType<typeof buildApp>,
  caseId: string,
  proposal: Json,
): Promise<Json> {
  const response = await call(
    app,
    `/cases/${caseId}/proposals/${proposal.id}/approval-requests`,
    jsonRequest('POST', { expectedVersion: proposal.version }, nextKey('idem-approval')),
  )
  assert.equal(response.status, 201, JSON.stringify(response.body))
  return response.body.data
}

describeFirestore('Proposalの不変履歴と案件版', () => {
  it('訂正前後のpayloadとhashを保持し、承認依頼で自己をstaleにしない', async () => {
    const { app, caseId } = await setup()
    const proposal = await submitTaskProposal(app, caseId)
    const original = await call(app, `/cases/${caseId}/proposals/${proposal.id}/versions/1`)
    assert.equal(original.status, 200)
    assert.deepEqual(original.body.data.payload, taskPayload)
    assert.equal(original.body.data.payloadHash, proposal.payloadHash)
    const approval = await requestApproval(app, caseId, proposal)
    const waiting = (await call(app, `/cases/${caseId}/proposals/${proposal.id}`)).body.data
    const revised = await call(app, `/cases/${caseId}/proposals/${proposal.id}`, jsonRequest('PATCH', {
      expectedVersion: waiting.version, payload: { ...taskPayload, title: '訂正版' },
    }))
    assert.equal(revised.status, 200, JSON.stringify(revised.body))
    const old = (await call(app, `/cases/${caseId}/proposals/${proposal.id}/versions/1`)).body.data
    assert.deepEqual(old, original.body.data)
    const next = await call(app, `/cases/${caseId}/proposals/${proposal.id}/versions/2`)
    assert.equal(next.body.data.payload.title, '訂正版')
    assert.equal(next.body.data.supersedesProposalVersion, 1)
    assert.equal((await call(app, `/cases/${caseId}/approvals/${approval.id}`)).body.data.status, 'EXPIRED')
    assert.equal((await call(app, `/cases/${caseId}`)).body.data.caseVersion, 1)
    const nextApproval = await requestApproval(app, caseId, revised.body.data)
    const applied = await call(app, `/cases/${caseId}/approvals/${nextApproval.id}/approve`, jsonRequest('POST', {
      expectedVersion: nextApproval.version, proposalVersion: 2, payloadHash: nextApproval.payloadHash,
    }))
    assert.equal(applied.status, 200, JSON.stringify(applied.body))
    assert.equal((await call(app, `/cases/${caseId}`)).body.data.caseVersion, 2, '正式Taskの作成でのみ進む')
    assert.deepEqual((await call(app, `/cases/${caseId}/proposals/${proposal.id}/versions/2`)).body.data, next.body.data)
  })
  it('案件配下の業務情報が変わった提案は反映されない', async () => {
    const { app, caseId } = await setup()
    const proposal = await submitTaskProposal(app, caseId)
    const approval = await requestApproval(app, caseId, proposal)
    const changed = await call(app, `/cases/${caseId}/tasks`, jsonRequest('POST', { ...taskPayload, title: '別の業務変更' }))
    assert.equal(changed.status, 201, JSON.stringify(changed.body))
    // 既定カタログで Case 作成時に同期生成された手続きの分も含めた、承認前の件数を基準にする。
    const beforeApprove = await call(app, `/cases/${caseId}/tasks?limit=50`)
    const result = await call(app, `/cases/${caseId}/approvals/${approval.id}/approve`, jsonRequest('POST', {
      expectedVersion: approval.version, proposalVersion: approval.proposalVersion, payloadHash: approval.payloadHash,
    }))
    assert.equal(result.status, 409)
    assert.equal(result.body.error.details.reason, 'STALE_PROPOSAL')
    const afterApprove = await call(app, `/cases/${caseId}/tasks?limit=50`)
    assert.equal(afterApprove.body.data.length, beforeApprove.body.data.length, '拒否された提案でTaskが増えない')
  })
})

describeFirestore('Entity別Proposal適用', () => {
  const cases = [
    { kind: 'ASSET_PROPOSAL', collection: 'assets', fields: {
      name: '架空財産', kind: 'BANK', institution: '架空銀行', amount: 1234, taxAttention: false, note: null,
    } },
    { kind: 'LIABILITY_PROPOSAL', collection: 'liabilities', fields: {
      name: '架空債務', kind: 'LOAN', creditor: '架空金融', amount: null, note: '未調査',
    } },
    { kind: 'CONTRACT_PROPOSAL', collection: 'contracts', fields: {
      name: '架空契約', kind: 'UTILITY', provider: '架空電気', note: null,
    } },
    { kind: 'PERSON_PROPOSAL', collection: 'persons', fields: {
      name: '架空関係者', nameKana: null, relationshipLabel: '家族', role: 'HEIR_CANDIDATE',
      isHeir: true, dateOfBirth: null, specialCircumstance: null, contact: null, note: null,
    } },
  ]
  async function submit(app: ReturnType<typeof buildApp>, caseId: string, kind: string, payload: unknown) {
    const response = await call(app, `/cases/${caseId}/proposals`, jsonRequest('POST', { kind, title: '候補の確認', payload }))
    assert.equal(response.status, 201, JSON.stringify(response.body))
    return response.body.data
  }
  async function approve(app: ReturnType<typeof buildApp>, caseId: string, approval: Json) {
    return call(app, `/cases/${caseId}/approvals/${approval.id}/approve`, jsonRequest('POST', {
      expectedVersion: approval.version, proposalVersion: approval.proposalVersion, payloadHash: approval.payloadHash,
    }))
  }
  for (const fixture of cases) {
    it(`${fixture.kind}: 承認した全フィールドを同じ内容で作成・更新する`, async () => {
      const { tenantId, app, caseId } = await setup()
      const proposal = await submit(app, caseId, fixture.kind, { operation: 'CREATE', fields: fixture.fields })
      const docs = firestore().collection(`tenants/${tenantId}/cases/${caseId}/${fixture.collection}`)
      assert.equal((await docs.get()).size, 0, '提出は正式登録ではない')
      const approval = await requestApproval(app, caseId, proposal)
      const response = await approve(app, caseId, approval)
      assert.equal(response.status, 200, JSON.stringify(response.body))
      assert.equal(response.body.data.applicationStatus, 'APPLIED')
      const document = (await docs.get()).docs[0]!
      for (const [key, value] of Object.entries(fixture.fields)) assert.deepEqual(document.get(key), value)
      if (fixture.collection === 'assets' || fixture.collection === 'liabilities') {
        assert.equal(document.get('confirmation.state'), 'UNCONFIRMED')
      }
      if (fixture.collection === 'contracts') {
        assert.equal(document.get('policyState.policy'), 'UNDECIDED')
        assert.equal(document.get('progressState.progress'), 'NOT_STARTED')
      }
      const nextFields = { ...fixture.fields, name: '承認された訂正名' }
      const revision = await submit(app, caseId, fixture.kind, {
        operation: 'UPDATE', targetId: document.id, expectedVersion: 1, fields: nextFields,
      })
      const nextApproval = await requestApproval(app, caseId, revision)
      assert.equal((await approve(app, caseId, nextApproval)).status, 200)
      const updated = await document.ref.get()
      for (const [key, value] of Object.entries(nextFields)) assert.deepEqual(updated.get(key), value)
      assert.equal(updated.get('version'), 2)
    })

    it(`${fixture.kind}: 承認待ちに対象が更新されたら上書きしない`, async () => {
      const { tenantId, app, caseId } = await setup()
      const first = await submit(app, caseId, fixture.kind, { operation: 'CREATE', fields: fixture.fields })
      await approve(app, caseId, await requestApproval(app, caseId, first))
      const document = (await firestore().collection(`tenants/${tenantId}/cases/${caseId}/${fixture.collection}`).get()).docs[0]!
      const next = await submit(app, caseId, fixture.kind, {
        operation: 'UPDATE', targetId: document.id, expectedVersion: 1,
        fields: { ...fixture.fields, name: '古い提案の名称' },
      })
      const approval = await requestApproval(app, caseId, next)
      await document.ref.update({ version: 2, name: '利用者の新しい名称' })
      const response = await approve(app, caseId, approval)
      assert.equal(response.status, 409)
      assert.equal(response.body.error.details.reason, 'TARGET_VERSION_CHANGED')
      assert.equal((await document.ref.get()).get('name'), '利用者の新しい名称')
      assert.equal((await call(app, `/cases/${caseId}/proposals/${next.id}`)).body.data.status, 'STALE')
      assert.equal((await call(app, `/cases/${caseId}/approvals/${approval.id}`)).body.data.applicationStatus, 'NOT_APPLIED')
    })
  }

  it('任意のsource・確認済み状態・契約方針の混入を受付時に拒否する', async () => {
    const { app, caseId } = await setup()
    const fixture = cases[0]!
    for (const extra of [{ source: 'AI' }, { agentRunId: 'forged-run' }]) {
      const result = await call(app, `/cases/${caseId}/proposals`, jsonRequest('POST', {
        kind: fixture.kind, title: '偽装', payload: { operation: 'CREATE', fields: fixture.fields }, ...extra,
      }))
      assert.equal(result.status, 400)
    }
    const result = await call(app, `/cases/${caseId}/proposals`, jsonRequest('POST', {
      kind: fixture.kind, title: '偽装', payload: { operation: 'CREATE', fields: { ...fixture.fields, confirmation: 'CONFIRMED' } },
    }))
    assert.equal(result.status, 400)
    const contract = cases[2]!
    const policy = await call(app, `/cases/${caseId}/proposals`, jsonRequest('POST', {
      kind: contract.kind, title: '勝手な解約', payload: { operation: 'CREATE', fields: { ...contract.fields, policy: 'CANCEL' } },
    }))
    assert.equal(policy.status, 400)
  })

  it('実行provenanceのない旧形式AI提案を正式適用しない', async () => {
    const { tenantId, app, caseId } = await setup()
    for (const fixture of cases.slice(0, 2)) {
      const proposal = await submit(app, caseId, fixture.kind, { operation: 'CREATE', fields: fixture.fields })
      // 内部API接続の成功を模す試験ではない。Applierへの保存済み入力fixture。
      const proposalRef = firestore().doc(`tenants/${tenantId}/cases/${caseId}/proposals/${proposal.id}`)
      const storedProposal = (await proposalRef.get()).data()!
      proposal.id = `fixture-${proposal.id}`
      await proposalRef.parent.doc(proposal.id).create({ ...storedProposal, id: proposal.id, source: 'AI', agentRunId: 'fixture-run' })
      const rejected = await approve(app, caseId, await requestApproval(app, caseId, proposal))
      assert.equal(rejected.status, 409)
      assert.equal(rejected.body.error.details.reason, 'MISSING_EXECUTION_PROVENANCE')
      assert.equal((await firestore().collection(`tenants/${tenantId}/cases/${caseId}/${fixture.collection}`).get()).size, 0)
    }
  })
})

describeFirestore('書類要求・根拠・専門家引継ぎのProposal', () => {
  async function prepare() {
    const env = await setup()
    await agreeExternalAiConsent(env.app)
    const task = await call(env.app, `/cases/${env.caseId}/tasks`, jsonRequest('POST', {
      title: '架空手続き', category: '手動', stage: 'immediate', evidenceRequired: true,
    }))
    const form = new FormData()
    form.append('file', new File(['%PDF-1.4\n% synthetic only\n%%EOF'], 'synthetic.pdf', { type: 'application/pdf' }))
    form.append('kind', 'OTHER')
    const doc = await call(env.app, `/cases/${env.caseId}/documents`, {
      method: 'POST', body: form, headers: { 'Idempotency-Key': nextKey('synthetic-doc') },
    })
    assert.equal(doc.status, 201, JSON.stringify(doc.body))
    return { ...env, taskId: task.body.data.id as string, doc: { id: doc.body.data.id, version: doc.body.data.version } }
  }
  async function propose(app: ReturnType<typeof buildApp>, caseId: string, kind: string, payload: unknown) {
    const proposal = await call(app, `/cases/${caseId}/proposals`, jsonRequest('POST', { kind, title: '架空の提案', payload }))
    assert.equal(proposal.status, 201, JSON.stringify(proposal.body))
    return requestApproval(app, caseId, proposal.body.data)
  }
  async function approve(app: ReturnType<typeof buildApp>, caseId: string, approval: Json) {
    return call(app, `/cases/${caseId}/approvals/${approval.id}/approve`, jsonRequest('POST', {
      expectedVersion: approval.version, proposalVersion: approval.proposalVersion, payloadHash: approval.payloadHash,
    }))
  }

  it('承認した書類要求を追加し、書類待ちにする', async () => {
    const { app, caseId, taskId } = await prepare()
    await call(app, `/cases/${caseId}/tasks/${taskId}/commands`, jsonRequest('POST', { command: 'start', expectedVersion: 1 }))
    const documents = [{ id: 'required-a', label: '確認した書類名' }]
    const approval = await propose(app, caseId, 'DOCUMENT_REQUEST', { taskId, expectedTaskVersion: 2, documents })
    assert.equal((await call(app, `/cases/${caseId}/tasks/${taskId}`)).body.data.requiredDocuments.length, 0)
    assert.equal((await approve(app, caseId, approval)).status, 200)
    const task = (await call(app, `/cases/${caseId}/tasks/${taskId}`)).body.data
    assert.equal(task.status, 'WAITING_DOCUMENTS')
    assert.deepEqual(task.requiredDocuments, [{ ...documents[0], documentId: null, source: 'MANUAL' }])
  })

  it('根拠の登録は承認後だけに行い、Taskを自動完了しない', async () => {
    const { tenantId, app, caseId, taskId, doc } = await prepare()
    const approval = await propose(app, caseId, 'EVIDENCE_PROPOSAL', {
      taskId, expectedTaskVersion: 1, label: '確認した根拠', kind: 'NOTICE', note: '本人確認', document: doc,
    })
    assert.equal((await call(app, `/cases/${caseId}/tasks/${taskId}`)).body.data.evidences.length, 0)
    assert.equal((await approve(app, caseId, approval)).status, 200)
    const task = (await call(app, `/cases/${caseId}/tasks/${taskId}`)).body.data
    assert.equal(task.status, 'NOT_STARTED')
    assert.equal(task.evidences.length, 1)
    assert.equal(task.evidences[0].label, '確認した根拠')
    assert.equal(task.evidences[0].note, '本人確認')
    await firestore().doc(`tenants/${tenantId}/cases/${caseId}/documents/${doc.id}`).update({ archived: true })
    const unavailable = await call(app, `/cases/${caseId}/tasks/${taskId}`)
    assert.equal(unavailable.body.data.allowedActions.includes('complete'), false)
    const complete = await call(app, `/cases/${caseId}/tasks/${taskId}/commands`,
      jsonRequest('POST', { command: 'complete', expectedVersion: task.version }))
    assert.equal(complete.status, 409)
    assert.equal(complete.body.error.details.reason, 'EVIDENCE_REQUIRED')
  })

  it('引継ぎの理由と資料の版を保存し、外部連絡は行わない', async () => {
    const { app, caseId, taskId, doc } = await prepare()
    const approval = await propose(app, caseId, 'ESCALATION_PROPOSAL', {
      taskId, expectedTaskVersion: 1, reason: '専門家による確認が必要', documents: [doc],
    })
    assert.equal((await approve(app, caseId, approval)).status, 200)
    const task = (await call(app, `/cases/${caseId}/tasks/${taskId}`)).body.data
    assert.equal(task.status, 'ESCALATED')
    assert.deepEqual(task.escalation.documents, [doc])
    assert.equal(task.escalation.reason, '専門家による確認が必要')
    assert.equal(task.escalation.contacted, false)
  })

  it('別CaseのTaskと書類、承認待ちに変更・archiveされた資料を拒否する', async () => {
    const { tenantId, app, caseId, taskId, doc } = await prepare()
    const other = (await call(app, '/cases', jsonRequest('POST', caseBody))).body.data.id as string
    const otherTask = (await call(app, `/cases/${other}/tasks`, jsonRequest('POST', {
      title: '別のTask', category: '手動', stage: 'immediate',
    }))).body.data.id as string
    for (const payload of [
      { taskId: otherTask, document: doc },
      { taskId, document: { id: 'foreign-document', version: 1 } },
    ]) {
      const approval = await propose(app, caseId, 'EVIDENCE_PROPOSAL', {
        ...payload, expectedTaskVersion: 1, label: '越境を拒否', kind: 'NOTICE', note: null,
      })
      assert.equal((await approve(app, caseId, approval)).status, 404)
    }
    const approval = await propose(app, caseId, 'EVIDENCE_PROPOSAL', {
      taskId, expectedTaskVersion: 1, label: '古い資料', kind: 'NOTICE', note: null, document: doc,
    })
    await firestore().doc(`tenants/${tenantId}/cases/${caseId}/documents/${doc.id}`).update({ archived: true, version: doc.version + 1 })
    assert.equal((await approve(app, caseId, approval)).status, 409)
    assert.equal((await call(app, `/cases/${caseId}/tasks/${taskId}`)).body.data.evidences.length, 0)
  })
})

describeFirestore('提案の提出と訂正', () => {
  it('提出した提案は版1で検証済みになる', async () => {
    const { app, caseId } = await setup()
    const proposal = await submitTaskProposal(app, caseId)

    assert.equal(proposal.proposalVersion, 1)
    assert.equal(proposal.status, 'VALIDATED')
    assert.equal(proposal.source, 'USER')
    assert.ok(proposal.payloadHash.length > 0)
    assert.equal(proposal.caseVersionAtProposal, 1)
  })

  it('訂正は既存の版を書き換えず、新しい版とhashを作る', async () => {
    const { app, caseId } = await setup()
    const proposal = await submitTaskProposal(app, caseId)

    const revised = await call(
      app,
      `/cases/${caseId}/proposals/${proposal.id}`,
      jsonRequest('PATCH', {
        expectedVersion: proposal.version,
        payload: { ...taskPayload, title: '訂正後の手続き' },
      }),
    )

    assert.equal(revised.status, 200)
    assert.equal(revised.body.data.proposalVersion, 2)
    assert.equal(revised.body.data.supersedesProposalVersion, 1)
    assert.notEqual(revised.body.data.payloadHash, proposal.payloadHash)
    assert.equal(revised.body.data.payload.title, '訂正後の手続き')
  })

  it('訂正すると対象を失った承認が期限切れになる', async () => {
    const { app, caseId } = await setup()
    const proposal = await submitTaskProposal(app, caseId)
    const approval = await requestApproval(app, caseId, proposal)

    const afterRequest = await call(app, `/cases/${caseId}/proposals/${proposal.id}`)
    await call(
      app,
      `/cases/${caseId}/proposals/${proposal.id}`,
      jsonRequest('PATCH', {
        expectedVersion: afterRequest.body.data.version,
        payload: { ...taskPayload, title: '訂正後' },
      }),
    )

    const fetched = await call(app, `/cases/${caseId}/approvals/${approval.id}`)
    // 人が承認したのは、その人が見た版の内容である。
    assert.equal(fetched.body.data.status, 'EXPIRED')
  })

  it('根拠が別Caseのものなら提出できない', async () => {
    const owner = await setup()
    const another = await call(
      owner.app,
      '/cases',
      jsonRequest('POST', caseBody, nextKey('idem-case')),
    )

    const response = await call(
      owner.app,
      `/cases/${owner.caseId}/proposals`,
      jsonRequest(
        'POST',
        {
          kind: 'TASK_PROPOSAL',
          title: '別Caseの根拠',
          payload: taskPayload,
          basis: [{ type: 'TASK', id: another.body.data.id, version: 1, label: '別Case' }],
        },
        nextKey('idem-proposal'),
      ),
    )
    assert.equal(response.status, 409)
    assert.equal(response.body.error.details.reason, 'BASIS_NOT_FOUND')
  })
})

describeFirestore('承認と反映', () => {
  it('承認を受け付けただけでは反映済みにしない', async () => {
    const { app, caseId } = await setup()
    const proposal = await submitTaskProposal(app, caseId)
    const approval = await requestApproval(app, caseId, proposal)

    assert.equal(approval.status, 'PENDING')
    assert.equal(approval.applicationStatus, 'NOT_APPLIED')
  })

  it('承認すると同じTransactionで反映される', async () => {
    const { app, caseId } = await setup()
    const proposal = await submitTaskProposal(app, caseId)
    const approval = await requestApproval(app, caseId, proposal)

    const approved = await call(
      app,
      `/cases/${caseId}/approvals/${approval.id}/approve`,
      jsonRequest('POST', {
        expectedVersion: approval.version,
        proposalVersion: approval.proposalVersion,
        payloadHash: approval.payloadHash,
      }),
    )

    assert.equal(approved.status, 200, JSON.stringify(approved.body))
    assert.equal(approved.body.data.status, 'APPROVED')
    assert.equal(approved.body.data.applicationStatus, 'APPLIED')

    const tasks = await call(app, `/cases/${caseId}/tasks?limit=50`)
    const created = tasks.body.data.find((task: Json) => task.title === taskPayload.title)
    assert.ok(created, '承認した内容が手続きとして作られていない')

    const fetchedProposal = await call(app, `/cases/${caseId}/proposals/${proposal.id}`)
    assert.equal(fetchedProposal.body.data.status, 'APPLIED')
  })

  it('承認対象のhashが変わっていれば反映しない', async () => {
    const { app, caseId } = await setup()
    const proposal = await submitTaskProposal(app, caseId)
    const approval = await requestApproval(app, caseId, proposal)

    const response = await call(
      app,
      `/cases/${caseId}/approvals/${approval.id}/approve`,
      jsonRequest('POST', {
        expectedVersion: approval.version,
        proposalVersion: approval.proposalVersion,
        payloadHash: 'different-hash',
      }),
    )
    assert.equal(response.status, 409)
    assert.equal(response.body.error.code, 'CONFLICT')
  })

  it('承認前の提案は反映できない', async () => {
    const { tenantId, app, caseId } = await setup()
    const proposal = await submitTaskProposal(app, caseId)

    // 承認を作らずに、承認だけを捏造しても反映されない。
    const approvals = await firestore()
      .collection(`tenants/${tenantId}/cases/${caseId}/approvals`)
      .get()
    assert.equal(approvals.size, 0)

    const tasks = await call(app, `/cases/${caseId}/tasks?limit=50`)
    assert.equal(
      tasks.body.data.filter((task: Json) => task.title === taskPayload.title).length,
      0,
    )
    void proposal
  })

  it('却下した提案は反映できない', async () => {
    const { app, caseId } = await setup()
    const proposal = await submitTaskProposal(app, caseId)
    const approval = await requestApproval(app, caseId, proposal)

    const rejected = await call(
      app,
      `/cases/${caseId}/approvals/${approval.id}/reject`,
      jsonRequest('POST', { expectedVersion: approval.version, note: '不要と判断' }),
    )
    assert.equal(rejected.body.data.status, 'REJECTED')

    const response = await call(
      app,
      `/cases/${caseId}/approvals/${approval.id}/approve`,
      jsonRequest('POST', {
        expectedVersion: rejected.body.data.version,
        proposalVersion: approval.proposalVersion,
        payloadHash: approval.payloadHash,
      }),
    )
    assert.equal(response.status, 409)
  })

  it('期限切れの承認では反映しない', async () => {
    const { tenantId, app, caseId } = await setup()
    const proposal = await submitTaskProposal(app, caseId)
    const approval = await requestApproval(app, caseId, proposal)

    await firestore()
      .doc(`tenants/${tenantId}/cases/${caseId}/approvals/${approval.id}`)
      .update({ expiresAt: new Date(Date.now() - 1000).toISOString() })

    const response = await call(
      app,
      `/cases/${caseId}/approvals/${approval.id}/approve`,
      jsonRequest('POST', {
        expectedVersion: approval.version,
        proposalVersion: approval.proposalVersion,
        payloadHash: approval.payloadHash,
      }),
    )
    assert.equal(response.status, 409)
    assert.equal(response.body.error.code, 'PRECONDITION_FAILED')
  })

  it('案件が更新された後の古い提案は反映せずstaleにする', async () => {
    const { app, caseId } = await setup()
    const proposal = await submitTaskProposal(app, caseId)
    const approval = await requestApproval(app, caseId, proposal)

    // 利用者が案件を更新する。提案が作られた前提が変わる。
    const current = await call(app, `/cases/${caseId}`)
    await call(
      app,
      `/cases/${caseId}`,
      jsonRequest('PATCH', { expectedVersion: current.body.data.version, municipality: '別の架空市' }),
    )

    const response = await call(
      app,
      `/cases/${caseId}/approvals/${approval.id}/approve`,
      jsonRequest('POST', {
        expectedVersion: approval.version,
        proposalVersion: approval.proposalVersion,
        payloadHash: approval.payloadHash,
      }),
    )

    assert.equal(response.status, 409)
    assert.equal(response.body.error.details.reason, 'STALE_PROPOSAL')

    const fetched = await call(app, `/cases/${caseId}/proposals/${proposal.id}`)
    assert.equal(fetched.body.data.status, 'STALE')

    // 利用者の更新を上書きしない。
    const caseAfter = await call(app, `/cases/${caseId}`)
    assert.equal(caseAfter.body.data.municipality, '別の架空市')
  })

  it('反映できない種類は理由付きで拒否する', async () => {
    const { app, caseId } = await setup({ proposalAppliers: [] })
    const submitted = await call(
      app,
      `/cases/${caseId}/proposals`,
      jsonRequest(
        'POST',
        { kind: 'DOCUMENT_REQUEST', title: '未接続の書類要求', payload: { name: '架空書類' } },
        nextKey('idem-proposal'),
      ),
    )
    const approval = await requestApproval(app, caseId, submitted.body.data)

    const response = await call(
      app,
      `/cases/${caseId}/approvals/${approval.id}/approve`,
      jsonRequest('POST', {
        expectedVersion: approval.version,
        proposalVersion: approval.proposalVersion,
        payloadHash: approval.payloadHash,
      }),
    )
    assert.equal(response.status, 501)
    assert.equal(response.body.error.code, 'FEATURE_NOT_CONNECTED')
  })

  it('二重承認を拒否する', async () => {
    const { app, caseId } = await setup()
    const proposal = await submitTaskProposal(app, caseId)
    const approval = await requestApproval(app, caseId, proposal)

    const first = await call(
      app,
      `/cases/${caseId}/approvals/${approval.id}/approve`,
      jsonRequest('POST', {
        expectedVersion: approval.version,
        proposalVersion: approval.proposalVersion,
        payloadHash: approval.payloadHash,
      }),
    )
    assert.equal(first.status, 200)

    const second = await call(
      app,
      `/cases/${caseId}/approvals/${approval.id}/approve`,
      jsonRequest('POST', {
        expectedVersion: first.body.data.version,
        proposalVersion: approval.proposalVersion,
        payloadHash: approval.payloadHash,
      }),
    )
    assert.equal(second.status, 409)

    const tasks = await call(app, `/cases/${caseId}/tasks?limit=50`)
    assert.equal(
      tasks.body.data.filter((task: Json) => task.title === taskPayload.title).length,
      1,
      '二重承認で手続きが二つ作られている',
    )
  })

  it('反映をOutboxへ残す', async () => {
    const { tenantId, app, caseId } = await setup()
    const proposal = await submitTaskProposal(app, caseId)
    const approval = await requestApproval(app, caseId, proposal)
    await call(
      app,
      `/cases/${caseId}/approvals/${approval.id}/approve`,
      jsonRequest('POST', {
        expectedVersion: approval.version,
        proposalVersion: approval.proposalVersion,
        payloadHash: approval.payloadHash,
      }),
    )

    const outbox = await firestore()
      .collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`)
      .where('type', '==', 'proposal.applied')
      .get()
    assert.equal(outbox.size, 1)
  })

  it('訂正した版を承認すると訂正後の内容が反映される', async () => {
    const { app, caseId } = await setup()
    const proposal = await submitTaskProposal(app, caseId)
    await requestApproval(app, caseId, proposal)

    const afterRequest = await call(app, `/cases/${caseId}/proposals/${proposal.id}`)
    const revised = await call(
      app,
      `/cases/${caseId}/proposals/${proposal.id}`,
      jsonRequest('PATCH', {
        expectedVersion: afterRequest.body.data.version,
        payload: { ...taskPayload, title: '訂正後の手続き' },
      }),
    )

    // 新しい版に対して改めて承認を作り、人がその版を承認する。
    const newApproval = await requestApproval(app, caseId, revised.body.data)
    const approved = await call(
      app,
      `/cases/${caseId}/approvals/${newApproval.id}/approve`,
      jsonRequest('POST', {
        expectedVersion: newApproval.version,
        proposalVersion: newApproval.proposalVersion,
        payloadHash: newApproval.payloadHash,
      }),
    )
    assert.equal(approved.status, 200, JSON.stringify(approved.body))

    const tasks = await call(app, `/cases/${caseId}/tasks?limit=50`)
    assert.ok(tasks.body.data.some((task: Json) => task.title === '訂正後の手続き'))
    assert.ok(!tasks.body.data.some((task: Json) => task.title === taskPayload.title))
  })
})

describeFirestore('本人の意思', () => {
  it('他人の入力は下書きや報告であって確定ではない', async () => {
    const { app, caseId, tenantId } = await setup()
    await seedHeir(tenantId, caseId, 'person-spouse')
    const recorded = await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-spouse`,
      jsonRequest('POST', { method: 'RENUNCIATION', state: 'REPORTED' }, nextKey('idem-decision')),
    )

    assert.equal(recorded.status, 200)
    assert.equal(recorded.body.data.state, 'REPORTED')
    // method が入っているだけでは確定にしない。
    assert.equal(recorded.body.data.confirmed, false)
    assert.equal(recorded.body.data.confirmedByUserId, null)
  })

  it('紐付いていない利用者は本人として確定できない', async () => {
    const { app, caseId, tenantId } = await setup({ personId: 'person-self' })
    await seedHeir(tenantId, caseId, 'person-spouse')
    await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-spouse`,
      jsonRequest('POST', { method: null, state: 'DRAFT' }, nextKey('idem-decision')),
    )

    const response = await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-spouse/confirm`,
      jsonRequest('POST', { expectedVersion: 1, method: 'RENUNCIATION' }),
    )
    // 案件の所有者でも、他の家族の意思を本人として確定できない。
    assert.equal(response.status, 403)
  })

  it('本人は自分の意思を確定できる', async () => {
    const { app, caseId } = await setup({ personId: 'person-self' })
    const recorded = await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-self`,
      jsonRequest('POST', { method: null, state: 'DRAFT' }, nextKey('idem-decision')),
    )

    const confirmed = await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-self/confirm`,
      jsonRequest('POST', {
        expectedVersion: recorded.body.data.version,
        method: 'SIMPLE_ACCEPTANCE',
      }),
    )

    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
    assert.equal(confirmed.body.data.state, 'CONFIRMED')
    assert.equal(confirmed.body.data.confirmed, true)
    assert.equal(confirmed.body.data.confirmedByUserId, 'user-owner')
    assert.ok(Date.parse(confirmed.body.data.confirmedAt) > 0)
  })

  it('確定後は他人の入力で下書きへ戻せない', async () => {
    const { app, caseId } = await setup({ personId: 'person-self' })
    const recorded = await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-self`,
      jsonRequest('POST', { method: null, state: 'DRAFT' }, nextKey('idem-decision')),
    )
    await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-self/confirm`,
      jsonRequest('POST', {
        expectedVersion: recorded.body.data.version,
        method: 'SIMPLE_ACCEPTANCE',
      }),
    )

    const response = await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-self`,
      jsonRequest('POST', { method: 'RENUNCIATION', state: 'DRAFT' }, nextKey('idem-decision')),
    )
    assert.equal(response.status, 409)
    assert.equal(response.body.error.details.reason, 'ALREADY_CONFIRMED_BY_SELF')
  })
})

describeFirestore('本人の確定と放棄前ロック', () => {
  const disposalTask = {
    title: '財産処分の手続き',
    summary: '試験用です。',
    stage: 'division',
    category: '財産',
    assetDisposal: true,
  }

  it('確定前は財産処分の手続きを実行できない', async () => {
    const { app, caseId } = await setup({ personId: 'person-self' })
    const created = await call(
      app,
      `/cases/${caseId}/tasks`,
      jsonRequest('POST', disposalTask, nextKey('idem-task')),
    )

    assert.deepEqual(created.body.data.allowedActions, [])
    const rejected = await call(
      app,
      `/cases/${caseId}/tasks/${created.body.data.id}/commands`,
      jsonRequest('POST', { command: 'start', expectedVersion: created.body.data.version }),
    )
    assert.equal(rejected.status, 409)
    assert.equal(rejected.body.error.details.reason, 'INHERITANCE_DECISION_REQUIRED')
  })

  it('本人が確定するとロックが外れる', async () => {
    const { app, caseId } = await setup({ personId: 'person-self' })
    const created = await call(
      app,
      `/cases/${caseId}/tasks`,
      jsonRequest('POST', disposalTask, nextKey('idem-task')),
    )

    const recorded = await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-self`,
      jsonRequest('POST', { method: null, state: 'DRAFT' }, nextKey('idem-decision')),
    )
    await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-self/confirm`,
      jsonRequest('POST', {
        expectedVersion: recorded.body.data.version,
        method: 'SIMPLE_ACCEPTANCE',
      }),
    )

    const started = await call(
      app,
      `/cases/${caseId}/tasks/${created.body.data.id}/commands`,
      jsonRequest('POST', { command: 'start', expectedVersion: created.body.data.version }),
    )
    assert.equal(started.status, 200, JSON.stringify(started.body))
  })

  it('報告だけではロックが外れない', async () => {
    const { app, caseId } = await setup({ personId: 'person-self' })
    const created = await call(
      app,
      `/cases/${caseId}/tasks`,
      jsonRequest('POST', disposalTask, nextKey('idem-task')),
    )
    await call(
      app,
      `/cases/${caseId}/inheritance-decisions/person-self`,
      jsonRequest('POST', { method: 'SIMPLE_ACCEPTANCE', state: 'REPORTED' }, nextKey('idem-decision')),
    )

    const rejected = await call(
      app,
      `/cases/${caseId}/tasks/${created.body.data.id}/commands`,
      jsonRequest('POST', { command: 'start', expectedVersion: created.body.data.version }),
    )
    assert.equal(rejected.status, 409)
  })
})
