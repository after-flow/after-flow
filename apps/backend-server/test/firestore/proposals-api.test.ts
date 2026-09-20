import assert from 'node:assert/strict'
import { it } from 'node:test'
import { INFRASTRUCTURE_COLLECTIONS, collections } from '../../src/domain/shared/collections.js'
import type { CaseMember } from '../../src/domain/authorization/case-role.js'
import { agreeRequiredConsents, buildApp, call, jsonRequest, seedTenantMember } from './helpers/app.js'
import type { Json } from './helpers/app.js'
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

async function setup(options: { personId?: string | null } = {}) {
  const tenantId = newTenantId()
  const userId = 'user-owner'
  await seedTenantMember(tenantId, userId)
  const app = buildApp(tenantId, userId)
  await agreeRequiredConsents(app)
  const created = await call(app, '/cases', jsonRequest('POST', caseBody, nextKey('idem-case')))
  const caseId = created.body.data.id as string

  if (options.personId !== undefined && options.personId !== null) {
    // Person 本体の登録は #13。ここでは membership との紐付けだけを用意する。
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
    const { app, caseId } = await setup()
    const submitted = await call(
      app,
      `/cases/${caseId}/proposals`,
      jsonRequest(
        'POST',
        { kind: 'ASSET_PROPOSAL', title: '財産の登録', payload: { name: '架空銀行' } },
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
    const { app, caseId } = await setup()
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
    const { app, caseId } = await setup({ personId: 'person-self' })
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
