import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { RuleCatalog } from '../../src/domain/task/rule-engine.js'
import { PLACEHOLDER_RULE_CATALOG } from '../../src/domain/task/rule-catalog.js'
import { INFRASTRUCTURE_COLLECTIONS } from '../../src/domain/shared/collections.js'
import {
  agreeRequiredConsents,
  buildApp,
  call,
  jsonRequest,
  seedTenantMember,
  seedHeir,
} from './helpers/app.js'
import type { Json, TestAppOptions } from './helpers/app.js'
import { describeFirestore, firestore, newTenantId } from './helpers/emulator.js'

/** 業務レビュー済みという前提の架空ルール。実際の法定期限ではない。 */
const REVIEWED_CATALOG: RuleCatalog = {
  placeholder: false,
  deadlineRules: [
    {
      id: 'fixture-notification',
      version: '1.0.0',
      label: '架空の届出期限',
      basis: 'KNOWN_AT',
      period: { unit: 'DAY', count: 7, includeFirstDay: false },
      basisLabel: '相続の開始を知った日の翌日から数えて7日以内',
      knownAtLabel: '相続の開始を知った日',
      legalNature: 'JURISDICTIONAL',
      jurisdiction: '架空市',
      reviewed: true,
      sourceUrl: 'https://example.test/fixture',
      sourceCheckedAt: '2026-09-20T00:00:00+09:00',
      extendable: false,
      critical: true,
      reviewedBy: { name: 'テスト 司法書士', qualification: 'JUDICIAL_SCRIVENER' },
    },
  ],
  initialProcedures: [
    {
      id: 'fixture-notification',
      title: '架空の届出を行う',
      summary: '試験用の手続きです。',
      stage: 'immediate',
      category: '行政手続き',
      submitTo: null,
      evidenceRequired: false,
      assetDisposal: false,
      requiredDocuments: [],
      deadlineRuleId: 'fixture-notification',
      applicability: { default: 'yes', rules: [] },
      variants: [],
      targetDate: null,
    },
    {
      id: 'fixture-disposal',
      title: '架空の財産処分を行う',
      summary: '相続方法の確定まで実行できない手続きです。',
      stage: 'division',
      category: '財産',
      submitTo: null,
      evidenceRequired: true,
      assetDisposal: true,
      requiredDocuments: [],
      deadlineRuleId: null,
      applicability: { default: 'yes', rules: [] },
      variants: [],
      targetDate: null,
    },
  ],
  deliberationDeadlineRuleId: null,
  reviewedBy: { name: 'テスト 司法書士', qualification: 'JUDICIAL_SCRIVENER' },
  reviewedAt: '2026-09-20T00:00:00+09:00',
}

/** 業務レビュー未了(reviewed:false)のルールだけを持つ架空カタログ。 */
const UNREVIEWED_CATALOG: RuleCatalog = {
  placeholder: true,
  deadlineRules: [
    {
      id: 'fixture-unreviewed',
      version: '0.0.0-draft',
      label: '架空の未レビュー期限',
      basis: 'KNOWN_AT',
      period: { unit: 'DAY', count: 14, includeFirstDay: false },
      basisLabel: '相続の開始を知った日の翌日から数えて14日以内',
      knownAtLabel: '相続の開始を知った日',
      legalNature: 'JURISDICTIONAL',
      jurisdiction: '架空市',
      reviewed: false,
      sourceUrl: null,
      sourceCheckedAt: null,
      extendable: null,
      critical: false,
      reviewedBy: null,
    },
  ],
  initialProcedures: [
    {
      id: 'fixture-unreviewed',
      title: '架空の未レビュー手続き',
      summary: '',
      stage: 'immediate',
      category: '行政手続き',
      submitTo: null,
      evidenceRequired: false,
      assetDisposal: false,
      requiredDocuments: [],
      deadlineRuleId: 'fixture-unreviewed',
      applicability: { default: 'yes', rules: [] },
      variants: [],
      targetDate: null,
    },
  ],
  deliberationDeadlineRuleId: null,
  reviewedBy: null,
  reviewedAt: null,
}

const caseBody = {
  deceasedName: '架空 太郎',
  dateOfDeath: '2026-04-01',
  knownAt: '2026-04-03',
  ownerName: '架空 花子',
  relationshipToDeceased: '配偶者',
}

let keyCounter = 0
function nextKey(prefix: string): string {
  keyCounter += 1
  return `${prefix}-${String(keyCounter).padStart(8, '0')}`
}

async function setup(options: TestAppOptions = {}, overrides: Partial<typeof caseBody> = {}) {
  const tenantId = newTenantId()
  const userId = 'user-owner'
  await seedTenantMember(tenantId, userId)
  const app = buildApp(tenantId, userId, options)
  await agreeRequiredConsents(app)
  const created = await call(app, '/cases', jsonRequest('POST', { ...caseBody, ...overrides }, nextKey('idem-case')))
  assert.equal(created.status, 201)
  return { tenantId, userId, app, caseId: created.body.data.id as string }
}

async function initialize(app: ReturnType<typeof buildApp>, caseId: string) {
  const response = await call(
    app,
    `/cases/${caseId}/tasks/initialize`,
    jsonRequest('POST', {}, nextKey('idem-init')),
  )
  assert.equal(response.status, 200)
  return response
}

describeFirestore('Taskの担当者・必要書類・依存関係', () => {
  const taskInput = { title: '架空の手動Task', stage: 'immediate', category: '手動' }

  it('担当者・書類要求・先行Taskを保存し、先行Taskが完了するまで着手を拒否する', async () => {
    const { tenantId, app, caseId } = await setup()
    await seedHeir(tenantId, caseId, 'person-assignee')
    const first = await call(app, `/cases/${caseId}/tasks`, jsonRequest('POST', taskInput))
    const firstId = first.body.data.id as string
    const created = await call(app, `/cases/${caseId}/tasks`, jsonRequest('POST', {
      ...taskInput, assigneeId: 'person-assignee', dependencyTaskIds: [firstId],
      requiredDocuments: [{ id: 'request-a', label: '架空の証明書', documentId: null }],
    }))
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const task = created.body.data
    assert.equal(task.assigneeId, 'person-assignee')
    assert.deepEqual(task.dependencyTaskIds, [firstId])
    assert.equal(task.requiredDocuments[0].source, 'MANUAL')
    assert.ok(task.blockedActions.some((action: Json) => action.action === 'start' && action.reason === 'DEPENDENCY_NOT_COMPLETED'))
    const blocked = await call(app, `/cases/${caseId}/tasks/${task.id}/commands`,
      jsonRequest('POST', { command: 'start', expectedVersion: 1 }))
    assert.equal(blocked.status, 409)
    await call(app, `/cases/${caseId}/tasks/${firstId}/commands`,
      jsonRequest('POST', { command: 'complete', expectedVersion: 1 }))
    const started = await call(app, `/cases/${caseId}/tasks/${task.id}/commands`,
      jsonRequest('POST', { command: 'start', expectedVersion: 1 }))
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const updated = await call(app, `/cases/${caseId}/tasks/${task.id}`, jsonRequest('PATCH', {
      expectedVersion: started.body.data.version, assigneeId: null, dependencyTaskIds: [], requiredDocuments: [],
    }))
    assert.equal(updated.status, 200)
    assert.equal(updated.body.data.assigneeId, null)
    assert.deepEqual(updated.body.data.requiredDocuments, [])
  })

  it('間接的な循環と並行する相互依存を拒否する', async () => {
    const { app, caseId } = await setup()
    const a = (await call(app, `/cases/${caseId}/tasks`, jsonRequest('POST', taskInput))).body.data
    const b = (await call(app, `/cases/${caseId}/tasks`, jsonRequest('POST', taskInput))).body.data
    const responses = await Promise.all([
      call(app, `/cases/${caseId}/tasks/${a.id}`, jsonRequest('PATCH', { expectedVersion: 1, dependencyTaskIds: [b.id] })),
      call(app, `/cases/${caseId}/tasks/${b.id}`, jsonRequest('PATCH', { expectedVersion: 1, dependencyTaskIds: [a.id] })),
    ])
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409])
    assert.equal(responses.find(r => r.status === 409)!.body.error.details.reason, 'DEPENDENCY_CYCLE')
  })

  it('別Caseの担当者・Task・書類およびsource偽装を拒否する', async () => {
    const { tenantId, app, caseId } = await setup()
    const other = await call(app, '/cases', jsonRequest('POST', caseBody))
    const otherId = other.body.data.id as string
    await seedHeir(tenantId, otherId, 'other-person')
    const task = await call(app, `/cases/${otherId}/tasks`, jsonRequest('POST', taskInput))
    for (const extra of [
      { assigneeId: 'other-person' },
      { dependencyTaskIds: [task.body.data.id] },
      { requiredDocuments: [{ id: 'doc', label: '書類', documentId: 'other-document' }] },
    ]) {
      const response = await call(app, `/cases/${caseId}/tasks`, jsonRequest('POST', { ...taskInput, ...extra }))
      assert.equal(response.status, 404)
    }
    const forged = await call(app, `/cases/${caseId}/tasks`, jsonRequest('POST', {
      ...taskInput, requiredDocuments: [{ id: 'doc', label: '書類', documentId: null, source: 'AI' }],
    }))
    assert.equal(forged.status, 400)
  })

  it('legacy形式で複製された200件のDeadlineを削除し、正規docだけ残す。再送で版を余分に増やさない', async () => {
    const { tenantId, app, caseId } = await setup({ ruleCatalog: REVIEWED_CATALOG })
    await initialize(app, caseId)
    const deadlines = firestore().collection(`tenants/${tenantId}/cases/${caseId}/deadlines`)
    const original = (await deadlines.get()).docs[0]!.data()
    const canonicalId = original.id as string
    const batch = firestore().batch()
    for (let index = 0; index < 200; index++) {
      const id = `extra-deadline-${index}`
      batch.create(deadlines.doc(id), { ...original, id })
    }
    await batch.commit()
    await firestore().doc(`tenants/${tenantId}/cases/${caseId}`).update({ knownAt: '2026-05-01' })
    const response = await call(app, `/cases/${caseId}/deadlines/reevaluate`, jsonRequest('POST', {}))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    // 正規 doc（起算日訂正で dueDate が変わる）だけが updated に入る。legacy 200 件は削除される
    // （reevaluate の応答の removed は Task のみを数えるため、Deadline の削除件数はここには出ない）。
    assert.deepEqual(response.body.data.updated, [canonicalId])

    const afterFirst = await deadlines.get()
    assert.equal(afterFirst.size, 1, '正規 doc 以外の legacy 複製が削除されている')
    assert.equal(afterFirst.docs[0]!.id, canonicalId)
    assert.equal(afterFirst.docs[0]!.get('version'), 2)

    const next = await call(app, `/cases/${caseId}/deadlines/reevaluate`, jsonRequest('POST', {}))
    assert.deepEqual(next.body.data.updated, [])
    assert.equal((await deadlines.get()).size, 1)
  })
})

async function findTask(
  app: ReturnType<typeof buildApp>,
  caseId: string,
  title: string,
): Promise<Json> {
  const list = await call(app, `/cases/${caseId}/tasks?limit=50`)
  const found = list.body.data.find((task: Json) => task.title === title)
  assert.ok(found, `${title} が見つからない`)
  return found
}

describeFirestore('初期手続きの生成', () => {
  it('Case から定義どおりの手続きを作る', async () => {
    const { app, caseId } = await setup({ ruleCatalog: REVIEWED_CATALOG })

    // Case 作成のトランザクション内で同期生成されるため、initialize を呼ぶ前から揃っている。
    const list = await call(app, `/cases/${caseId}/tasks`)
    assert.equal(list.body.data.length, 2)
    assert.equal(list.body.data[0].source, 'RULE_ENGINE')

    // initialize は補正経路として残るが、同期済みの Case では何も作らない。
    const response = await initialize(app, caseId)
    assert.equal(response.body.data.created.length, 0)
    const listAfter = await call(app, `/cases/${caseId}/tasks`)
    assert.equal(listAfter.body.data.length, 2)
  })

  it('再実行しても手続きが重複しない', async () => {
    const { app, caseId } = await setup({ ruleCatalog: REVIEWED_CATALOG })
    await initialize(app, caseId)
    const second = await initialize(app, caseId)

    // 同じ定義から二度作らない。
    assert.equal(second.body.data.created.length, 0)
    const list = await call(app, `/cases/${caseId}/tasks`)
    assert.equal(list.body.data.length, 2)
  })

  it('レビュー済みルールから期限を算定する', async () => {
    const { app, caseId } = await setup({ ruleCatalog: REVIEWED_CATALOG })
    await initialize(app, caseId)

    const deadlines = await call(app, `/cases/${caseId}/deadlines`)
    const deadline = deadlines.body.data[0]
    assert.equal(deadline.confirmation, 'CONFIRMED')
    // 知った日 2026-04-03 + 7 日
    assert.equal(deadline.dueDate, '2026-04-10')
    assert.equal(deadline.startDate, '2026-04-03')
    assert.equal(deadline.timezone, 'Asia/Tokyo')
    assert.equal(deadline.ruleVersion, '1.0.0')
    assert.ok(deadline.sourceUrl)
  })

  it('業務レビュー未了のルールでは日付を返さない', async () => {
    // PLACEHOLDER_RULE_CATALOG は STATUTORY な2ルールを reviewed:true にしてある
    // ため、未レビューの挙動はローカルの UNREVIEWED_CATALOG で確認する。
    const { app, caseId } = await setup({ ruleCatalog: UNREVIEWED_CATALOG })
    await initialize(app, caseId)

    const deadlines = await call(app, `/cases/${caseId}/deadlines?limit=50`)
    assert.ok(deadlines.body.data.length > 0)
    for (const deadline of deadlines.body.data) {
      assert.equal(deadline.confirmation, 'UNCONFIRMED')
      // 未確認の期限を確定済みの表示用 DTO として返さない。
      assert.equal(deadline.dueDate, null)
      assert.equal(deadline.daysRemaining, null)
      assert.equal(deadline.severity, null)
      assert.equal(deadline.unresolvedReason, 'RULE_UNCONFIRMED')
      // 何を待っているかが分かるよう、根拠の説明は返す。
      assert.ok(deadline.basisLabel.length > 0)
    }
  })

  it('placeholderカタログでもSTATUTORYなルールは確定した期限を出す（死亡届・相続方法の選択）', async () => {
    const { app, caseId } = await setup({ ruleCatalog: PLACEHOLDER_RULE_CATALOG })
    await initialize(app, caseId)

    const deadlines = await call(app, `/cases/${caseId}/deadlines?limit=50`)
    const notification = deadlines.body.data.find((d: Json) => d.ruleId === 'death-notification')
    const choice = deadlines.body.data.find((d: Json) => d.ruleId === 'inheritance-choice')
    assert.ok(notification)
    assert.ok(choice)
    assert.equal(notification.confirmation, 'CONFIRMED')
    // 知った日 2026-04-03 を含めて7日（戸籍法43条の初日算入）
    assert.equal(notification.dueDate, '2026-04-09')
    assert.equal(choice.confirmation, 'CONFIRMED')
    // 知った日 2026-04-03 の翌日から3か月（民法143条）
    assert.equal(choice.dueDate, '2026-07-03')
  })

  it('知った日が未入力なら死亡日から数え、入力後は知った日で数え直す', async () => {
    const { app, caseId } = await setup({ ruleCatalog: REVIEWED_CATALOG }, { knownAt: undefined })
    await initialize(app, caseId)

    const before = await call(app, `/cases/${caseId}/deadlines`)
    const beforeDeadline = before.body.data[0]
    // 死亡日 2026-04-01 + 7日。以前はここを死亡日で補完せず「要確認」にしていたが、
    // 申し送り3-3で「知った日」を起算日にしつつ未入力時は死亡日で代替する方針に変わった。
    assert.equal(beforeDeadline.startDate, '2026-04-01')
    assert.equal(beforeDeadline.dueDate, '2026-04-08')
    assert.equal(beforeDeadline.unresolvedReason, null)
    assert.match(beforeDeadline.basisLabel, /知った日が未入力のため/)

    const current = await call(app, `/cases/${caseId}`)
    await call(
      app,
      `/cases/${caseId}`,
      jsonRequest('PATCH', { expectedVersion: current.body.data.version, knownAt: '2026-04-03' }),
    )
    // PATCH と同じ Transaction 内で洗い出しが走るため、期限はここで既に更新されている。
    const after = await call(app, `/cases/${caseId}/deadlines`)
    const afterDeadline = after.body.data[0]
    assert.equal(afterDeadline.startDate, '2026-04-03')
    assert.equal(afterDeadline.dueDate, '2026-04-10')
    assert.doesNotMatch(afterDeadline.basisLabel, /知った日が未入力のため/)

    // reevaluate は補正経路。同期済みの Case では何も変えない（冪等）。
    const reevaluated = await call(
      app,
      `/cases/${caseId}/deadlines/reevaluate`,
      jsonRequest('POST', {}, nextKey('idem-reeval')),
    )
    assert.equal(reevaluated.body.data.updated.length, 0)
  })

  it('知った日を後入力しても死亡日と同じ日付ならPATCHでbasisLabelの付記が消える', async () => {
    const { app, caseId } = await setup({ ruleCatalog: REVIEWED_CATALOG }, { knownAt: undefined })
    await initialize(app, caseId)

    const before = await call(app, `/cases/${caseId}/deadlines`)
    assert.match(before.body.data[0].basisLabel, /知った日が未入力のため/)

    const current = await call(app, `/cases/${caseId}`)
    // 死亡日と同じ日付を「知った日」として入力する。dueDate 自体は変わらない。
    await call(
      app,
      `/cases/${caseId}`,
      jsonRequest('PATCH', { expectedVersion: current.body.data.version, knownAt: '2026-04-01' }),
    )
    // dueDate/startDate は変わらないが、basisLabel の付記は PATCH と同じ Transaction で消える。
    const after = await call(app, `/cases/${caseId}/deadlines`)
    assert.equal(after.body.data[0].dueDate, '2026-04-08')
    assert.doesNotMatch(after.body.data[0].basisLabel, /知った日が未入力のため/)

    // reevaluate は補正経路。同期済みの Case では何も変えない（冪等）。
    const reevaluated = await call(
      app,
      `/cases/${caseId}/deadlines/reevaluate`,
      jsonRequest('POST', {}, nextKey('idem-reeval')),
    )
    assert.equal(reevaluated.body.data.updated.length, 0)
  })

  it('起算日を訂正すると期限を作り直す', async () => {
    const { app, caseId } = await setup({ ruleCatalog: REVIEWED_CATALOG })
    await initialize(app, caseId)

    const current = await call(app, `/cases/${caseId}`)
    await call(
      app,
      `/cases/${caseId}`,
      jsonRequest('PATCH', { expectedVersion: current.body.data.version, knownAt: '2026-04-10' }),
    )
    // PATCH と同じ Transaction 内で期限が作り直される。
    const deadlines = await call(app, `/cases/${caseId}/deadlines`)
    assert.equal(deadlines.body.data[0].dueDate, '2026-04-17')

    // reevaluate は補正経路。同期済みの Case では何も変えない（冪等）。
    const reevaluated = await call(
      app,
      `/cases/${caseId}/deadlines/reevaluate`,
      jsonRequest('POST', {}, nextKey('idem-reeval')),
    )
    assert.equal(reevaluated.body.data.updated.length, 0)
  })
})

describeFirestore('手続きの状態遷移', () => {
  it('status を PATCH で変更できない', async () => {
    const { app, caseId } = await setup({ ruleCatalog: REVIEWED_CATALOG })
    await initialize(app, caseId)
    const task = await findTask(app, caseId, '架空の届出を行う')

    const response = await call(
      app,
      `/cases/${caseId}/tasks/${task.id}`,
      jsonRequest('PATCH', { expectedVersion: task.version, status: 'COMPLETED' }),
    )
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'VALIDATION_FAILED')
  })

  it('準備完了・提出報告・完了を別の状態として扱う', async () => {
    const { app, caseId } = await setup({ ruleCatalog: REVIEWED_CATALOG })
    await initialize(app, caseId)
    let task = await findTask(app, caseId, '架空の届出を行う')

    const run = async (command: string, version: number) => {
      const response = await call(
        app,
        `/cases/${caseId}/tasks/${task.id}/commands`,
        jsonRequest('POST', { command, expectedVersion: version }),
      )
      assert.equal(response.status, 200, `${command}: ${JSON.stringify(response.body)}`)
      task = response.body.data
      return response.body.data
    }

    assert.equal((await run('start', task.version)).status, 'COLLECTING_INFORMATION')
    assert.equal((await run('markReady', task.version)).status, 'READY')
    assert.equal((await run('reportSubmission', task.version)).status, 'SUBMITTED')
    assert.equal((await run('awaitExternal', task.version)).status, 'WAITING_EXTERNAL')

    const completed = await run('complete', task.version)
    assert.equal(completed.status, 'COMPLETED')
    // 本人による完了報告であり、外部機関の確認ではない。
    assert.equal(completed.completionReportedBy, 'user-owner')
    assert.ok(completed.completionReportedAt)
  })

  it('許されない遷移を拒否する', async () => {
    const { app, caseId } = await setup({ ruleCatalog: REVIEWED_CATALOG })
    await initialize(app, caseId)
    const task = await findTask(app, caseId, '架空の届出を行う')

    const response = await call(
      app,
      `/cases/${caseId}/tasks/${task.id}/commands`,
      jsonRequest('POST', { command: 'reportSubmission', expectedVersion: task.version }),
    )
    assert.equal(response.status, 409)
    assert.equal(response.body.error.details.reason, 'INVALID_TRANSITION')
  })

  it('古い版の操作を拒否する', async () => {
    const { app, caseId } = await setup({ ruleCatalog: REVIEWED_CATALOG })
    await initialize(app, caseId)
    const task = await findTask(app, caseId, '架空の届出を行う')

    await call(
      app,
      `/cases/${caseId}/tasks/${task.id}/commands`,
      jsonRequest('POST', { command: 'start', expectedVersion: task.version }),
    )
    const stale = await call(
      app,
      `/cases/${caseId}/tasks/${task.id}/commands`,
      jsonRequest('POST', { command: 'markReady', expectedVersion: task.version }),
    )
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'CONFLICT')
  })

  it('expectedVersion の欠落を 428 で返す', async () => {
    const { app, caseId } = await setup({ ruleCatalog: REVIEWED_CATALOG })
    await initialize(app, caseId)
    const task = await findTask(app, caseId, '架空の届出を行う')

    const response = await call(
      app,
      `/cases/${caseId}/tasks/${task.id}/commands`,
      jsonRequest('POST', { command: 'start' }),
    )
    assert.equal(response.status, 428)
  })

  it('完了を Outbox に残す', async () => {
    const { tenantId, app, caseId } = await setup({ ruleCatalog: REVIEWED_CATALOG })
    await initialize(app, caseId)
    const task = await findTask(app, caseId, '架空の届出を行う')

    await call(
      app,
      `/cases/${caseId}/tasks/${task.id}/commands`,
      jsonRequest('POST', { command: 'complete', expectedVersion: task.version }),
    )
    const outbox = await firestore()
      .collection(`tenants/${tenantId}/${INFRASTRUCTURE_COLLECTIONS.outbox}`)
      .where('type', '==', 'task.completed')
      .get()
    assert.equal(outbox.size, 1)
  })
})

describeFirestore('完了条件', () => {
  it('一般的な手動の手続きは本人の報告で完了できる', async () => {
    const { app, caseId } = await setup({ ruleCatalog: REVIEWED_CATALOG })
    const created = await call(
      app,
      `/cases/${caseId}/tasks`,
      jsonRequest(
        'POST',
        { title: '自分用のメモ手続き', stage: 'immediate', category: 'その他' },
        nextKey('idem-task'),
      ),
    )
    assert.equal(created.status, 201)
    // 全 Task に一律の書類添付を強制しない。
    assert.ok(created.body.data.allowedActions.includes('complete'))

    const completed = await call(
      app,
      `/cases/${caseId}/tasks/${created.body.data.id}/commands`,
      jsonRequest('POST', { command: 'complete', expectedVersion: created.body.data.version }),
    )
    assert.equal(completed.status, 200)
    assert.equal(completed.body.data.status, 'COMPLETED')
  })

  it('根拠が必要な手続きは根拠なしで完了できない', async () => {
    const { app, caseId } = await setup({
      ruleCatalog: REVIEWED_CATALOG,
      decisions: { isConfirmed: async () => true },
    })
    await initialize(app, caseId)
    const task = await findTask(app, caseId, '架空の財産処分を行う')

    assert.ok(
      task.blockedActions.some(
        (blocked: Json) => blocked.action === 'complete' && blocked.reason === 'EVIDENCE_REQUIRED',
      ),
    )

    const rejected = await call(
      app,
      `/cases/${caseId}/tasks/${task.id}/commands`,
      jsonRequest('POST', { command: 'complete', expectedVersion: task.version }),
    )
    assert.equal(rejected.status, 409)
    assert.equal(rejected.body.error.details.reason, 'EVIDENCE_REQUIRED')

    const withEvidence = await call(
      app,
      `/cases/${caseId}/tasks/${task.id}/evidences`,
      jsonRequest('POST', { label: '受付印のある控え', kind: 'RECEIPT' }, nextKey('idem-evidence')),
    )
    assert.equal(withEvidence.status, 201)
    assert.equal(withEvidence.body.data.evidences.length, 1)

    const completed = await call(
      app,
      `/cases/${caseId}/tasks/${task.id}/commands`,
      jsonRequest('POST', { command: 'complete', expectedVersion: withEvidence.body.data.version }),
    )
    assert.equal(completed.status, 200)
  })
})

describeFirestore('放棄前ロック', () => {
  it('相続方法が未確定の間は財産処分の手続きを実行できない', async () => {
    const { app, caseId } = await setup({ ruleCatalog: REVIEWED_CATALOG })
    await initialize(app, caseId)
    const task = await findTask(app, caseId, '架空の財産処分を行う')

    // フロントの非表示ではなく Backend が判定する。
    assert.deepEqual(task.allowedActions, [])
    assert.ok(
      task.blockedActions.some(
        (blocked: Json) => blocked.reason === 'INHERITANCE_DECISION_REQUIRED',
      ),
    )

    const rejected = await call(
      app,
      `/cases/${caseId}/tasks/${task.id}/commands`,
      jsonRequest('POST', { command: 'start', expectedVersion: task.version }),
    )
    assert.equal(rejected.status, 409)
    assert.equal(rejected.body.error.details.reason, 'INHERITANCE_DECISION_REQUIRED')
  })

  it('確定していれば着手できる', async () => {
    const { app, caseId } = await setup({
      ruleCatalog: REVIEWED_CATALOG,
      decisions: { isConfirmed: async () => true },
    })
    await initialize(app, caseId)
    const task = await findTask(app, caseId, '架空の財産処分を行う')

    const started = await call(
      app,
      `/cases/${caseId}/tasks/${task.id}/commands`,
      jsonRequest('POST', { command: 'start', expectedVersion: task.version }),
    )
    assert.equal(started.status, 200)
  })
})

describeFirestore('権限と境界', () => {
  it('閲覧のみの利用者には操作を許さない', async () => {
    const owner = await setup({ ruleCatalog: REVIEWED_CATALOG })
    await initialize(owner.app, owner.caseId)
    const task = await findTask(owner.app, owner.caseId, '架空の届出を行う')

    await seedTenantMember(owner.tenantId, 'user-viewer')
    await firestore()
      .doc(`tenants/${owner.tenantId}/cases/${owner.caseId}/caseMembers/user-viewer`)
      .set({
        id: 'user-viewer',
        tenantId: owner.tenantId,
        caseId: owner.caseId,
        version: 1,
        schemaVersion: 1,
        userId: 'user-viewer',
        role: 'VIEWER',
        active: true,
        personId: null,
      })

    const viewer = buildApp(owner.tenantId, 'user-viewer', { ruleCatalog: REVIEWED_CATALOG })
    await agreeRequiredConsents(viewer)

    const fetched = await call(viewer, `/cases/${owner.caseId}/tasks/${task.id}`)
    assert.equal(fetched.status, 200)
    assert.deepEqual(fetched.body.data.allowedActions, [])

    const rejected = await call(
      viewer,
      `/cases/${owner.caseId}/tasks/${task.id}/commands`,
      jsonRequest('POST', { command: 'start', expectedVersion: task.version }),
    )
    assert.equal(rejected.status, 403)
  })

  it('別 Case の taskId へ差し替えても操作できない', async () => {
    const owner = await setup({ ruleCatalog: REVIEWED_CATALOG })
    await initialize(owner.app, owner.caseId)
    const task = await findTask(owner.app, owner.caseId, '架空の届出を行う')

    const another = await call(
      owner.app,
      '/cases',
      jsonRequest('POST', caseBody, nextKey('idem-case')),
    )
    const response = await call(owner.app, `/cases/${another.body.data.id}/tasks/${task.id}`)
    assert.equal(response.status, 404)
  })
})

describeFirestore('手続き定義 ID (procedureId)', () => {
  it('手動作成の Task は procedureId が null で、存在する ID を指定でき、未知の ID は拒否する', async () => {
    const { app, caseId } = await setup()
    const plain = await call(app, `/cases/${caseId}/tasks`, jsonRequest('POST', { title: '架空の手動Task', stage: 'immediate', category: '手動' }))
    assert.equal(plain.status, 201)
    assert.equal(plain.body.data.procedureId, null)
    const mapped = await call(app, `/cases/${caseId}/tasks`, jsonRequest('POST', { title: '死亡届（手動登録）', stage: 'immediate', category: '手動', procedureId: 'death-notification' }))
    assert.equal(mapped.status, 201, JSON.stringify(mapped.body))
    assert.equal(mapped.body.data.procedureId, 'death-notification')
    const unknown = await call(app, `/cases/${caseId}/tasks`, jsonRequest('POST', { title: '架空の手動Task', stage: 'immediate', category: '手動', procedureId: 'unknown-procedure' }))
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.error.code, 'VALIDATION_FAILED')
  })

  it('procedureId を更新でき、null で解除でき、未知の ID への更新は拒否する', async () => {
    const { app, caseId } = await setup()
    const created = await call(app, `/cases/${caseId}/tasks`, jsonRequest('POST', { title: '架空の手動Task', stage: 'immediate', category: '手動' }))
    const updated = await call(app, `/cases/${caseId}/tasks/${created.body.data.id}`, jsonRequest('PATCH', { expectedVersion: created.body.data.version, procedureId: 'collect-family-register' }))
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
    assert.equal(updated.body.data.procedureId, 'collect-family-register')
    const cleared = await call(app, `/cases/${caseId}/tasks/${created.body.data.id}`, jsonRequest('PATCH', { expectedVersion: updated.body.data.version, procedureId: null }))
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.data.procedureId, null)
    const unknown = await call(app, `/cases/${caseId}/tasks/${created.body.data.id}`, jsonRequest('PATCH', { expectedVersion: cleared.body.data.version, procedureId: 'unknown-procedure' }))
    assert.equal(unknown.status, 400)
  })

  it('カタログの dependencyProcedureIds は同じ Case 内の Task ID へ解決され、DTO に procedureId が載る', async () => {
    const { app, caseId } = await setup()
    const list = await call(app, `/cases/${caseId}/tasks`)
    const byProcedure = (procedureId: string) => list.body.data.find((task: { procedureId: string | null }) => task.procedureId === procedureId)
    const division = byProcedure('estate-division'), register = byProcedure('collect-family-register'), choice = byProcedure('inheritance-choice')
    assert.ok(division && register && choice)
    assert.deepEqual([...division.dependencyTaskIds].sort(), [register.id, choice.id].sort())
    assert.deepEqual(byProcedure('bank-accounts').dependencyTaskIds, [choice.id])
    assert.deepEqual(register.dependencyTaskIds, [])
  })
})
