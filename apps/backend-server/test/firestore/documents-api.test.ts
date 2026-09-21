import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import type { DocumentInspector } from '../../src/application/ports/inspection.js'
import { MAX_DOCUMENT_BYTES } from '../../src/domain/document/content-type.js'
import { INFRASTRUCTURE_COLLECTIONS } from '../../src/domain/shared/collections.js'
import type { createApp } from '../../src/app.js'
import {
  agreeExternalAiConsent,
  agreeRequiredConsents,
  buildApp,
  call,
  jsonRequest,
  seedTenantMember,
} from './helpers/app.js'
import type { TestAppOptions } from './helpers/app.js'
import { describeFirestore, firestore, newTenantId } from './helpers/emulator.js'

/** 原本は JSON ではないため、封筒を解かずにそのまま受け取る。 */
async function rawGet(app: ReturnType<typeof createApp>, path: string): Promise<Response> {
  return app.request(`http://localhost/api/v1${path}`)
}

/**
 * 合成した書類。
 *
 * 先頭の署名だけ本物と同じにし、中身は意味のない値にする。
 * 実在の個人文書は試験に使わない。
 */
function syntheticPdf(marker = 'synthetic'): Uint8Array {
  return new Uint8Array([...Buffer.from('%PDF-1.7\n'), ...Buffer.from(marker), 0x0a])
}

function syntheticPng(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
}

/** 拡張子と申告だけ PDF に見せかけた、実体の異なるファイル。 */
function disguisedExecutable(): Uint8Array {
  return new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00])
}

function uploadRequest(
  content: Uint8Array,
  options: { fileName?: string; contentType?: string; kind?: string } = {},
): RequestInit {
  const form = new FormData()
  form.append(
    'file',
    new File([new Uint8Array(content)], options.fileName ?? 'synthetic.pdf', {
      type: options.contentType ?? 'application/pdf',
    }),
  )
  form.append('kind', options.kind ?? 'DEATH_CERTIFICATE')
  return { method: 'POST', body: form }
}

function withKey(init: RequestInit, key: string): RequestInit {
  return { ...init, headers: { 'Idempotency-Key': key } }
}

const caseBody = {
  deceasedName: '架空 太郎',
  dateOfDeath: '2026-04-01',
  ownerName: '架空 花子',
  relationshipToDeceased: '配偶者',
}

async function setup(options: TestAppOptions = {}) {
  const tenantId = newTenantId()
  const userId = 'user-owner'
  await seedTenantMember(tenantId, userId)
  const app = buildApp(tenantId, userId, options)
  await agreeRequiredConsents(app)
  await agreeExternalAiConsent(app, options.catalog)
  const created = await call(app, '/cases', jsonRequest('POST', caseBody, `idem-case-${userId}-1`))
  assert.equal(created.status, 201)
  return { tenantId, userId, app, caseId: created.body.data.id as string }
}

describeFirestore('原本の登録', () => {
  it('保存済み候補・根拠・提案/承認とRun待機を再取得でき、ページ境界や別Caseで混線しない', async () => {
    const { tenantId, app, caseId } = await setup()
    const uploaded = await call(app, `/cases/${caseId}/documents`, withKey(uploadRequest(syntheticPdf()), 'links-document'))
    assert.equal(uploaded.status, 201)
    const document = uploaded.body.data
    assert.deepEqual(document.extractionCandidates, [])
    assert.equal(document.analysis.run, null)
    const submitted = await call(app, `/cases/${caseId}/proposals`, jsonRequest('POST', {
      kind: 'TASK_PROPOSAL', title: '書類に基づく手続き', payload: { title: '架空手続き', stage: 'immediate', category: '合成' },
      basis: [{ type: 'DOCUMENT', id: document.id, version: document.version, label: '合成書類' }],
    }))
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body))
    const proposal = submitted.body.data
    const approval = await call(app, `/cases/${caseId}/proposals/${proposal.id}/approval-requests`, jsonRequest('POST', { expectedVersion: proposal.version }))
    assert.equal(approval.status, 201, JSON.stringify(approval.body))
    const caseRef = firestore().doc(`tenants/${tenantId}/cases/${caseId}`)
    const persisted = (await caseRef.collection('proposals').doc(proposal.id).get()).data()!
    const base = { tenantId, caseId, version: 1, schemaVersion: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    const batch = firestore().batch()
    for (let i = 0; i < 101; i++) batch.set(caseRef.collection('proposals').doc(`unrelated-${i}`), { ...persisted, ...base, id: `unrelated-${i}`, basis: [] })
    batch.set(caseRef.collection('proposals').doc('zzz-candidate'), { ...persisted, ...base, id: 'zzz-candidate', source: 'AI' })
    batch.set(caseRef.collection('evidence').doc('evidence-ref'), { ...base, id: 'evidence-ref', taskId: 'task-ref', documentId: document.id,
      label: '提出根拠', kind: 'RECEIPT', note: null, recordedBy: 'user-owner' })
    batch.set(caseRef.collection('agentRuns').doc('document-run'), { ...base, id: 'document-run', operation: 'document_analysis', status: 'WAITING_DOCUMENT',
      targetType: 'DOCUMENT', targetId: document.id, caseVersionAtAccept: 1, attempt: 1, currentAttemptId: 'attempt',
      failureReason: null, waitingFor: '追加書類', startedAt: null, finishedAt: null, cancelRequestedBy: null })
    batch.update(caseRef.collection('documents').doc(document.id), { agentRunId: 'document-run', analysisState: 'RUNNING' })
    batch.set(firestore().doc(`tenants/${tenantId}/cases/other-case/proposals/foreign`), { ...persisted, ...base, id: 'foreign', caseId: 'other-case', source: 'AI' })
    await batch.commit()
    for (const path of [`/cases/${caseId}/documents/${document.id}`, `/cases/${caseId}/documents`]) {
      const response = await call(app, path)
      assert.equal(response.status, 200, JSON.stringify(response.body))
      const view = Array.isArray(response.body.data) ? response.body.data[0] : response.body.data
      assert.deepEqual(view.extractionCandidates.map((c: any) => c.id), ['zzz-candidate'])
      assert.equal(view.proposalRefs.length, 2)
      assert.equal(view.approvalRefs[0].applicationStatus, 'NOT_APPLIED')
      assert.equal(view.evidenceRefs[0].id, 'evidence-ref')
      assert.equal(view.analysis.run.waiting, true); assert.equal(view.analysis.run.status, 'WAITING_DOCUMENT')
      assert.equal(view.inspection.status, 'PENDING'); assert.equal(view.analysis.canRequest, false)
      assert.equal(JSON.stringify(view).includes('objectKey'), false)
    }
  })

  it('保存できた書類は STORED になり、検査は未実施のまま残る', async () => {
    const { app, caseId } = await setup()
    const content = syntheticPdf()
    const response = await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(content), 'idem-doc-0001'),
    )

    assert.equal(response.status, 201)
    assert.equal(response.body.data.storageState, 'STORED')
    assert.equal(response.body.data.contentType, 'application/pdf')
    assert.equal(response.body.data.sizeBytes, content.byteLength)
    assert.equal(response.body.data.sha256, createHash('sha256').update(content).digest('hex'))

    // 検査器が未接続なら合格にしない。
    assert.equal(response.body.data.inspection.status, 'PENDING')
    assert.equal(response.body.data.inspection.completed, false)
  })

  it('AI 未接続と検査未合格を解析できない理由として返す', async () => {
    const { app, caseId } = await setup()
    const response = await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(syntheticPdf()), 'idem-doc-0002'),
    )

    assert.equal(response.body.data.analysis.state, 'NOT_REQUESTED')
    assert.equal(response.body.data.analysis.canRequest, false)
    // 「解析開始」「マスキング済み」に見える応答を返さない。
    // 外部AI同意は setup() で済ませているので、残る理由はこの2つ。
    assert.deepEqual(response.body.data.analysis.blockedReasons.sort(), [
      'AI_NOT_CONNECTED',
      'INSPECTION_NOT_PASSED',
    ])
  })

  it('申告だけ PDF の別形式を拒否する', async () => {
    const { app, caseId } = await setup()
    const response = await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(disguisedExecutable()), 'idem-doc-0003'),
    )

    assert.equal(response.status, 415)
    assert.equal(response.body.error.code, 'UNSUPPORTED_MEDIA_TYPE')
    assert.equal(response.body.error.details.detected, null)
  })

  it('実体と申告が食い違う場合を拒否する', async () => {
    const { app, caseId } = await setup()
    // 中身は PNG だが PDF として申告している。
    const response = await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(syntheticPng(), { contentType: 'application/pdf' }), 'idem-doc-0004'),
    )
    assert.equal(response.status, 415)
    assert.equal(response.body.error.details.detected, 'image/png')
  })

  it('対応外の形式を拒否する', async () => {
    const { app, caseId } = await setup()
    const response = await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(
        uploadRequest(syntheticPdf(), { contentType: 'image/heic', fileName: 'photo.heic' }),
        'idem-doc-0005',
      ),
    )
    assert.equal(response.status, 415)
    assert.deepEqual(response.body.error.details.supported, [
      'application/pdf',
      'image/jpeg',
      'image/png',
    ])
  })

  it('上限を超えるファイルを拒否する', async () => {
    const { app, caseId } = await setup()
    const tooLarge = new Uint8Array(MAX_DOCUMENT_BYTES + 1024)
    tooLarge.set(Buffer.from('%PDF-1.7\n'))
    const response = await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(tooLarge), 'idem-doc-0006'),
    )
    assert.equal(response.status, 413)
    assert.equal(response.body.error.code, 'PAYLOAD_TOO_LARGE')
  })

  it('ファイルが無い要求を拒否する', async () => {
    const { app, caseId } = await setup()
    const form = new FormData()
    form.append('kind', 'OTHER')
    const response = await call(app, `/cases/${caseId}/documents`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-doc-0007' },
      body: form,
    })
    assert.equal(response.status, 400)
    assert.equal(response.body.error.details.field, 'file')
  })

  it('Idempotency-Key が無い登録を 428 で拒否する', async () => {
    const { app, caseId } = await setup()
    const response = await call(app, `/cases/${caseId}/documents`, uploadRequest(syntheticPdf()))
    assert.equal(response.status, 428)
  })
})

describeFirestore('登録の再送と回収', () => {
  it('同じ要求の再送で原本が二重にならない', async () => {
    const { tenantId, app, caseId } = await setup()
    const content = syntheticPdf()
    const first = await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(content), 'idem-doc-0010'),
    )
    const second = await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(content), 'idem-doc-0010'),
    )

    assert.equal(second.status, 201)
    assert.equal(second.body.data.id, first.body.data.id)
    assert.equal(second.body.data.version, first.body.data.version)

    const stored = await firestore().collection(`tenants/${tenantId}/cases/${caseId}/documents`).get()
    assert.equal(stored.size, 1)
  })

  it('同じキーで別のファイルを拒否する', async () => {
    const { app, caseId } = await setup()
    await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(syntheticPdf('a')), 'idem-doc-0011'),
    )
    const conflicting = await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(syntheticPdf('b')), 'idem-doc-0011'),
    )
    assert.equal(conflicting.status, 409)
    assert.equal(conflicting.body.error.code, 'IDEMPOTENCY_KEY_REUSED')
  })

  it('登録の事実を監査と Outbox に残す', async () => {
    const { tenantId, app, caseId } = await setup()
    await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(syntheticPdf()), 'idem-doc-0012'),
    )

    const audits = await firestore()
      .collection(`tenants/${tenantId}/cases/${caseId}/auditEvents`)
      .where('type', '==', 'document.registered')
      .get()
    assert.equal(audits.size, 1)

    const outbox = await firestore()
      .collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`)
      .where('type', '==', 'document.registered')
      .get()
    assert.equal(outbox.size, 1)
    // 未検査のまま解析受付にしない。
    assert.equal(outbox.docs[0]?.get('payload').inspectionStatus, 'PENDING')
  })
})

describeFirestore('検査の結果', () => {
  const passingInspector: DocumentInspector = {
    id: 'test-double',
    version: '0.0.0',
    inspect: async () => ({
      status: 'PASSED',
      findings: [],
      inspectorId: 'test-double',
      inspectorVersion: '0.0.0',
      maskedObjectKey: null,
    }),
  }

  const rejectingInspector: DocumentInspector = {
    id: 'test-double',
    version: '0.0.0',
    inspect: async () => ({
      status: 'REJECTED',
      findings: [
        { kind: 'SENSITIVE_NUMBER', message: '対象の番号が含まれています。', locationHint: '1ページ目' },
      ],
      inspectorId: 'test-double',
      inspectorVersion: '0.0.0',
      maskedObjectKey: null,
    }),
  }

  const failingInspector: DocumentInspector = {
    id: 'test-double',
    version: '0.0.0',
    inspect: async () => {
      throw new Error('inspector unavailable')
    },
  }

  it('合格した書類だけが解析の前提を満たす', async () => {
    const { app, caseId } = await setup({ inspector: passingInspector, aiConnected: true })
    const response = await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(syntheticPdf()), 'idem-doc-0020'),
    )
    assert.equal(response.body.data.inspection.status, 'PASSED')
    assert.equal(response.body.data.inspection.completed, true)
    assert.deepEqual(response.body.data.analysis.blockedReasons, [])
    assert.equal(response.body.data.analysis.canRequest, true)

    // 撤回すると、既存書類の解析前提も改めて満たさなくなる。
    await call(app, '/consents/revocations', jsonRequest('POST', { kind: 'CROSS_BORDER_AI' }))
    const after = await call(app, `/cases/${caseId}/documents/${response.body.data.id}`)
    assert.deepEqual(after.body.data.analysis.blockedReasons, ['CONSENT_REQUIRED'])
    assert.equal(after.body.data.analysis.canRequest, false)
  })

  it('拒否された書類は原本を保持せず、理由を残す', async () => {
    const { app, caseId } = await setup({ inspector: rejectingInspector })
    const registered = await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(syntheticPdf()), 'idem-doc-0021'),
    )

    assert.equal(registered.body.data.inspection.status, 'REJECTED')
    assert.equal(registered.body.data.storageState, 'FAILED')
    assert.equal(registered.body.data.inspection.findings[0].kind, 'SENSITIVE_NUMBER')
    // 検出した値そのものは返さない。
    assert.equal(registered.body.data.inspection.findings[0].locationHint, '1ページ目')

    const content = await rawGet(app, `/cases/${caseId}/documents/${registered.body.data.id}/content`)
    assert.equal(content.status, 409)
    assert.equal(((await content.json()) as Record<string, any>).error.code, 'PRECONDITION_FAILED')
  })

  it('検査そのものの失敗を合格にも拒否にもしない', async () => {
    const { app, caseId } = await setup({ inspector: failingInspector, aiConnected: true })
    const response = await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(syntheticPdf()), 'idem-doc-0022'),
    )
    assert.equal(response.body.data.inspection.status, 'FAILED')
    assert.equal(response.body.data.inspection.completed, true)
    assert.ok(response.body.data.analysis.blockedReasons.includes('INSPECTION_NOT_PASSED'))
  })
})

describeFirestore('原本の取得', () => {
  it('登録した内容をそのまま取得できる', async () => {
    const { caseId, app } = await setup()
    const content = syntheticPdf('roundtrip')
    const registered = await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(content), 'idem-doc-0030'),
    )

    const response = await rawGet(app, `/cases/${caseId}/documents/${registered.body.data.id}/content`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Type'), 'application/pdf')
    assert.equal(response.headers.get('Content-Disposition'), 'attachment')
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), content)
  })

  it('参加していない利用者は取得できない', async () => {
    const owner = await setup()
    const registered = await call(
      owner.app,
      `/cases/${owner.caseId}/documents`,
      withKey(uploadRequest(syntheticPdf()), 'idem-doc-0031'),
    )

    await seedTenantMember(owner.tenantId, 'user-outsider')
    const outsider = buildApp(owner.tenantId, 'user-outsider')
    await agreeRequiredConsents(outsider)

    const response = await rawGet(
      outsider,
      `/cases/${owner.caseId}/documents/${registered.body.data.id}/content`,
    )
    assert.equal(response.status, 404)
  })

  it('別 Case の documentId へ差し替えても取得できない', async () => {
    const owner = await setup()
    const registered = await call(
      owner.app,
      `/cases/${owner.caseId}/documents`,
      withKey(uploadRequest(syntheticPdf()), 'idem-doc-0032'),
    )

    const another = await call(
      owner.app,
      '/cases',
      jsonRequest('POST', caseBody, 'idem-case-another-1'),
    )
    const response = await call(
      owner.app,
      `/cases/${another.body.data.id}/documents/${registered.body.data.id}`,
    )
    assert.equal(response.status, 404)
  })
})

describeFirestore('一覧と除外', () => {
  it('除外した書類は通常の一覧に出ないが、参照は壊さない', async () => {
    const { app, caseId } = await setup()
    const registered = await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(syntheticPdf()), 'idem-doc-0040'),
    )
    const documentId = registered.body.data.id

    const archived = await call(
      app,
      `/cases/${caseId}/documents/${documentId}/archive`,
      jsonRequest('POST', { expectedVersion: registered.body.data.version }),
    )
    assert.equal(archived.status, 200)
    assert.equal(archived.body.data.archived, true)
    assert.ok(archived.body.data.archivedAt)

    const normal = await call(app, `/cases/${caseId}/documents`)
    assert.equal(normal.body.data.length, 0)

    const including = await call(app, `/cases/${caseId}/documents?includeArchived=true`)
    assert.equal(including.body.data.length, 1)

    // 完全消去ではない。詳細も原本も引き続き取得できる。
    assert.equal((await call(app, `/cases/${caseId}/documents/${documentId}`)).status, 200)
    assert.equal((await rawGet(app, `/cases/${caseId}/documents/${documentId}/content`)).status, 200)
  })

  it('古い版での除外は 409 になる', async () => {
    const { app, caseId } = await setup()
    const registered = await call(
      app,
      `/cases/${caseId}/documents`,
      withKey(uploadRequest(syntheticPdf()), 'idem-doc-0041'),
    )
    const response = await call(
      app,
      `/cases/${caseId}/documents/${registered.body.data.id}/archive`,
      jsonRequest('POST', { expectedVersion: 99 }),
    )
    assert.equal(response.status, 409)
    assert.equal(response.body.error.code, 'CONFLICT')
  })

  it('一覧の続きをカーソルで取得できる', async () => {
    const { app, caseId } = await setup()
    for (let index = 0; index < 4; index += 1) {
      await call(
        app,
        `/cases/${caseId}/documents`,
        withKey(uploadRequest(syntheticPdf(`page-${index}`)), `idem-doc-page-000${index}`),
      )
    }

    const collected: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2'
      const page = await call(app, `/cases/${caseId}/documents${query}`)
      collected.push(...page.body.data.map((item: { id: string }) => item.id))
      cursor = page.body.meta.nextCursor
      pages += 1
      assert.ok(pages <= 4)
    } while (cursor)

    assert.equal(collected.length, 4)
    assert.equal(new Set(collected).size, 4)
  })
})
