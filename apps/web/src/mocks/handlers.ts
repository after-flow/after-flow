import { HttpResponse, http, delay } from 'msw'
import {
  CASE_ID,
  FLOW_STAGE_LABELS,
  db,
  ruleKeys,
  nextId,
  todayISO,
} from './db'
import { analysisRuns, isMaskedCase, startAnalysis } from './analysis'
import { deliberationDue, syncRuleTasks } from './rules'
import { sampleContent, uploadedFiles } from './content'
import { watchCase } from './watch'
import type {
  Approval,
  Asset,
  Benefit,
  CaseDocument,
  CaseOverview,
  ChatMessage,
  Contract,
  Evidence,
  FlowStage,
  InheritanceMethod,
  Insight,
  Liability,
  Person,
  Task,
  TaskStatus,
} from '@aftercare/public-contracts'

const BASE = '/api/v1'
const list = <T>(items: T[]) => HttpResponse.json({ items, total: items.length })

/** 担当者の名前は、人の登録から毎回引く（名前の直し・削除に追従させるため） */
function withAssignee(t: Task): Task {
  const person = t.assigneeId ? db.persons.find((p) => p.id === t.assigneeId) : undefined
  return { ...t, assigneeId: person?.id, assigneeName: person?.name }
}

/** マイナンバーが載っている可能性が高い書類は受け付けない（企画書セクション5） */
const MY_NUMBER_HINTS = ['マイナンバー', '個人番号', '住民票', '源泉徴収', 'mynumber']

function overview(caseId: string): CaseOverview {
  const kase = db.cases.find((c) => c.id === caseId)!
  const tasks = db.tasks.filter((t) => t.caseId === caseId)

  const flowStages: FlowStage[] = FLOW_STAGE_LABELS.map(({ id, label }) => {
    const inStage = tasks.filter((t) => t.stage === id)
    const done = inStage.filter((t) => t.status === 'COMPLETED').length
    return {
      id,
      label,
      totalTasks: inStage.length,
      completedTasks: done,
      state:
        inStage.length === 0
          ? 'NOT_STARTED'
          : done === inStage.length
            ? 'COMPLETED'
            : done > 0 || inStage.some((t) => t.status !== 'NOT_STARTED')
              ? 'IN_PROGRESS'
              : 'NOT_STARTED',
    }
  })

  const heirs = db.persons.filter((p) => p.caseId === caseId && p.isHeir)
  const perHeir = heirs.map((p) => ({
    personId: p.id,
    personName: p.name,
    method: db.decisions[p.id] ?? null,
  }))

  const upcomingDeadlines = tasks
    .map((t) => t.deadline)
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
    .filter((d) => d.daysRemaining <= 7)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))

  const taskCounts: Partial<Record<TaskStatus, number>> = {}
  for (const t of tasks) taskCounts[t.status] = (taskCounts[t.status] ?? 0) + 1

  return {
    case: kase,
    upcomingDeadlines,
    pendingApprovalCount: db.approvals.filter((a) => a.caseId === caseId && a.status === 'PENDING')
      .length,
    flowStages,
    inheritanceDecision: {
      decided: perHeir.length > 0 && perHeir.every((h) => h.method != null),
      perHeir,
      deliberationDeadline: deliberationDue(kase),
    },
    recentAgentRuns: [
      ...analysisRuns.filter((r) => r.caseId === caseId),
      {
        id: 'run_3',
        caseId,
        type: 'case_planning',
        status: 'SUCCEEDED',
        summary: '書類の内容をもとに、手続きの候補と期限を整理しました。',
        startedAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
        finishedAt: new Date(Date.now() - 5 * 3600_000 + 40_000).toISOString(),
        producedApprovalIds: ['apr_3'],
      },
      {
        id: 'run_2',
        caseId,
        type: 'document_analysis',
        status: 'SUCCEEDED',
        summary: '「預金通帳_表紙.jpg」を解析し、2件の提案を作成しました。',
        startedAt: new Date(Date.now() - 20 * 3600_000).toISOString(),
        finishedAt: new Date(Date.now() - 20 * 3600_000 + 25_000).toISOString(),
        producedApprovalIds: ['apr_1', 'apr_2'],
      },
    ],
    taskCounts,
  }
}

function consentStatus() {
  return {
    documents: db.consents,
    outstanding: db.consents.some((c) => c.required && c.agreedVersion !== c.version),
  }
}

export const handlers = [
  /* ---------- 認証 ---------- */
  http.post(`${BASE}/auth/login`, async () => {
    await delay(300)
    return HttpResponse.json({ token: 'mock-token' })
  }),

  /* ---------- 同意 ---------- */
  http.get(`${BASE}/consents`, () => HttpResponse.json(consentStatus())),

  http.post(`${BASE}/consents`, async ({ request }) => {
    const body = (await request.json()) as {
      agreements: { kind: string; version: string }[]
    }
    const now = new Date().toISOString()
    for (const a of body.agreements) {
      const doc = db.consents.find((c) => c.kind === a.kind)
      if (doc) {
        doc.agreedVersion = a.version
        doc.agreedAt = now
      }
    }
    return HttpResponse.json(consentStatus())
  }),

  /* ---------- Case ---------- */
  http.get(`${BASE}/cases`, () => list(db.cases)),

  http.post(`${BASE}/cases`, async ({ request }) => {
    const body = (await request.json()) as Record<string, string>
    const created = {
      id: nextId('case'),
      deceasedName: body.deceasedName,
      deceasedNameKana: body.deceasedNameKana,
      dateOfDeath: body.dateOfDeath,
      dateOfBirth: body.dateOfBirth,
      knownAt: body.knownAt,
      ownerName: body.ownerName,
      relationshipToDeceased: body.relationshipToDeceased,
      status: 'ACTIVE' as const,
      createdAt: new Date().toISOString(),
    }
    db.cases.push(created)

    // Rule Engine 相当：ご逝去日が分かった時点で、あてはまる可能性のある手続きと期限を用意する
    db.tasks = syncRuleTasks(created, db.tasks, ruleKeys, nextId)

    return HttpResponse.json(created, { status: 201 })
  }),

  http.get(`${BASE}/cases/:caseId/overview`, ({ params }) => {
    const kase = db.cases.find((c) => c.id === params.caseId)
    if (!kase) return HttpResponse.json({ code: 'NOT_FOUND', message: 'ケースが見つかりません' }, { status: 404 })
    return HttpResponse.json(overview(String(params.caseId)))
  }),

  http.get(`${BASE}/cases/:caseId`, ({ params }) => {
    const kase = db.cases.find((c) => c.id === params.caseId)
    return kase
      ? HttpResponse.json(kase)
      : HttpResponse.json({ code: 'NOT_FOUND', message: 'ケースが見つかりません' }, { status: 404 })
  }),

  http.patch(`${BASE}/cases/:caseId`, async ({ params, request }) => {
    const kase = db.cases.find((c) => c.id === params.caseId)
    if (!kase) return HttpResponse.json({ code: 'NOT_FOUND', message: '見つかりません' }, { status: 404 })
    Object.assign(kase, await request.json())
    // 故人の状況（生年月日・質問への答え）が変わったら、あてはまる手続きを洗い出し直す
    db.tasks = syncRuleTasks(kase, db.tasks, ruleKeys, nextId)
    return HttpResponse.json(kase)
  }),

  /* ---------- 自律調査（task_execution 相当） ---------- */
  http.post(`${BASE}/tasks/:taskId/guidance/research`, ({ params }) => {
    const t = db.tasks.find((x) => x.id === params.taskId)
    if (!t) return HttpResponse.json({ code: 'NOT_FOUND', message: '見つかりません' }, { status: 404 })

    const kase = db.cases.find((c) => c.id === t.caseId)
    const target = kase?.municipality ?? 'お住まいの自治体'

    t.guidance = {
      ...t.guidance,
      research: {
        status: 'RESEARCHING',
        target,
        startedAt: new Date().toISOString(),
        agentRunId: nextId('run'),
      },
    }

    // エージェントが調べ終わるまでの時間を模擬する
    setTimeout(() => {
      const current = db.tasks.find((x) => x.id === params.taskId)
      if (!current?.guidance?.research) return

      // 3回に1回くらいは調べきれない、という状況も再現する
      const roll = Math.random()
      const now = new Date().toISOString()

      if (roll < 0.15) {
        current.guidance.research = {
          ...current.guidance.research,
          status: 'FAILED',
          completedAt: now,
          failureReason: `${target}の公開ページで、この手続きの案内を見つけられませんでした。`,
        }
        return
      }

      current.guidance = {
        ...current.guidance,
        where: `${target} 戸籍住民課（本庁舎1階 ②番窓口）`,
        bring: ['死亡診断書（原本）', '届出人の本人確認書類'],
        steps: [
          '病院などで受け取った死亡診断書の左側（死亡届）に記入します。',
          '火葬許可申請書と一緒に、戸籍住民課の窓口へ提出します。',
          '火葬許可証を受け取ります（火葬の当日に火葬場へ出します）。',
        ],
        note: '時間外・休日は宿直窓口でも受け付けています。',
        researchedBy: 'AI',
        sources: [
          {
            label: `${target} 公式サイト「死亡届」`,
            url: 'https://www.city.example.lg.jp/kurashi/koseki/shibou.html',
            checkedAt: now,
          },
          {
            label: '法務省「死亡届」',
            url: 'https://www.moj.go.jp/MINJI/minji79.html',
            checkedAt: now,
          },
        ],
        research: {
          ...current.guidance.research,
          status: roll < 0.5 ? 'PARTIAL' : 'COMPLETED',
          completedAt: now,
          confidence: roll < 0.5 ? 'MEDIUM' : 'HIGH',
          missing: roll < 0.5 ? ['宿直窓口の受付時間', '駐車場の有無'] : undefined,
        },
      }
    }, 4500)

    return HttpResponse.json(t)
  }),

  /* ---------- Document ---------- */
  http.get(`${BASE}/cases/:caseId/documents`, ({ params }) =>
    list(db.documents.filter((d) => d.caseId === params.caseId)),
  ),

  http.post(`${BASE}/cases/:caseId/documents`, async ({ params, request }) => {
    const form = await request.formData()
    const file = form.get('file') as File | null
    await delay(900)

    if (!file) {
      return HttpResponse.json({ code: 'INVALID_REQUEST', message: 'ファイルがありません' }, { status: 400 })
    }

    // Cloud Storage への保存より前に検知する（企画書セクション5）
    const name = file.name.toLowerCase()
    if (MY_NUMBER_HINTS.some((h) => file.name.includes(h) || name.includes(h))) {
      return HttpResponse.json(
        {
          code: 'MY_NUMBER_DETECTED',
          message: 'マイナンバーが記載された書類はアップロードできません。',
        },
        { status: 422 },
      )
    }
    if (!/\.(pdf|jpe?g|png|heic)$/i.test(file.name)) {
      return HttpResponse.json(
        { code: 'UNSUPPORTED_FILE_TYPE', message: '対応していないファイル形式です。' },
        { status: 415 },
      )
    }

    const doc: CaseDocument = {
      id: nextId('doc'),
      caseId: String(params.caseId),
      fileName: file.name,
      kind: 'OTHER',
      kindSource: 'AI',
      analysisStatus: 'ANALYZING',
      sizeBytes: file.size,
      uploadedAt: new Date().toISOString(),
      myNumberScan: isMaskedCase(file.name) ? 'MASKED' : 'CLEAN',
      extractions: [],
    }
    db.documents.unshift(doc)
    uploadedFiles.set(doc.id, file)

    // 読み取りの完了をあとから反映する（document_analysis の代役。ファイル名で結果を出し分ける）
    startAnalysis(doc)

    return HttpResponse.json(doc, { status: 201 })
  }),

  http.get(`${BASE}/documents/:documentId`, ({ params }) => {
    const doc = db.documents.find((d) => d.id === params.documentId)
    return doc
      ? HttpResponse.json(doc)
      : HttpResponse.json({ code: 'NOT_FOUND', message: '書類が見つかりません' }, { status: 404 })
  }),

  // 原本。本物の Backend と同じ道筋（ケースの下）で返す
  http.get(`${BASE}/cases/:caseId/documents/:documentId/content`, async ({ params }) => {
    const doc = db.documents.find((d) => d.id === params.documentId && d.caseId === params.caseId)
    if (!doc) return HttpResponse.json({ code: 'NOT_FOUND', message: '書類が見つかりません' }, { status: 404 })
    await delay(300)
    const blob = uploadedFiles.get(doc.id) ?? sampleContent(doc)
    return new HttpResponse(blob, { headers: { 'Content-Type': blob.type || 'application/octet-stream' } })
  }),

  http.delete(`${BASE}/documents/:documentId`, ({ params }) => {
    db.documents = db.documents.filter((d) => d.id !== params.documentId)
    uploadedFiles.delete(String(params.documentId))
    return new HttpResponse(null, { status: 204 })
  }),

  /* ---------- Task ---------- */
  http.get(`${BASE}/cases/:caseId/tasks`, ({ params }) =>
    list(db.tasks.filter((t) => t.caseId === params.caseId).map(withAssignee)),
  ),

  http.post(`${BASE}/cases/:caseId/tasks`, async ({ params, request }) => {
    const body = (await request.json()) as Record<string, string>
    const created: Task = {
      id: nextId('task'),
      caseId: String(params.caseId),
      title: body.title,
      summary: body.summary ?? '',
      submitTo: body.submitTo,
      status: 'NOT_STARTED',
      stage: 'government',
      category: body.category ?? 'その他',
      source: 'MANUAL',
      assetDisposal: false,
      evidences: [],
      updatedAt: new Date().toISOString(),
    }
    db.tasks.push(created)
    return HttpResponse.json(created, { status: 201 })
  }),

  http.get(`${BASE}/tasks/:taskId`, ({ params }) => {
    const t = db.tasks.find((x) => x.id === params.taskId)
    if (!t) return HttpResponse.json({ code: 'NOT_FOUND', message: '見つかりません' }, { status: 404 })
    return HttpResponse.json({
      ...withAssignee(t),
      evidences: db.evidences.filter((e) => e.taskId === t.id),
    })
  }),

  http.patch(`${BASE}/tasks/:taskId`, async ({ params, request }) => {
    const t = db.tasks.find((x) => x.id === params.taskId)
    if (!t) return HttpResponse.json({ code: 'NOT_FOUND', message: '見つかりません' }, { status: 404 })
    const body = (await request.json()) as Partial<Task> & { assigneeId?: string | null }
    if (body.assigneeId) {
      const person = db.persons.find((p) => p.id === body.assigneeId && p.caseId === t.caseId)
      if (!person || person.excludedAt) {
        return HttpResponse.json({ code: 'PRECONDITION_FAILED', message: 'その方は担当にできません' }, { status: 409 })
      }
    }
    const { assigneeId, assigneeName: _ignored, ...rest } = body
    Object.assign(t, rest, { updatedAt: new Date().toISOString() })
    if (assigneeId !== undefined) t.assigneeId = assigneeId ?? undefined
    return HttpResponse.json({ ...withAssignee(t), evidences: db.evidences.filter((e) => e.taskId === t.id) })
  }),

  http.post(`${BASE}/tasks/:taskId/complete`, ({ params }) => {
    const t = db.tasks.find((x) => x.id === params.taskId)
    if (!t) return HttpResponse.json({ code: 'NOT_FOUND', message: '見つかりません' }, { status: 404 })
    t.status = 'COMPLETED'
    t.updatedAt = new Date().toISOString()
    return HttpResponse.json({ ...withAssignee(t), evidences: db.evidences.filter((e) => e.taskId === t.id) })
  }),

  http.post(`${BASE}/tasks/:taskId/reopen`, ({ params }) => {
    const t = db.tasks.find((x) => x.id === params.taskId)
    if (!t) return HttpResponse.json({ code: 'NOT_FOUND', message: '見つかりません' }, { status: 404 })
    t.status = 'ACTION_REQUIRED'
    t.updatedAt = new Date().toISOString()
    return HttpResponse.json({ ...withAssignee(t), evidences: db.evidences.filter((e) => e.taskId === t.id) })
  }),

  http.post(`${BASE}/tasks/:taskId/evidences`, async ({ params, request }) => {
    const body = (await request.json()) as Partial<Evidence>
    const created: Evidence = {
      id: nextId('ev'),
      taskId: String(params.taskId),
      label: body.label ?? '',
      kind: body.kind ?? 'OTHER',
      note: body.note,
      recordedAt: new Date().toISOString(),
    }
    db.evidences.push(created)
    return HttpResponse.json(created, { status: 201 })
  }),

  /* ---------- Deadline ---------- */
  http.get(`${BASE}/cases/:caseId/deadlines`, ({ params }) =>
    list(
      db.tasks
        .filter((t) => t.caseId === params.caseId && t.deadline)
        .map((t) => t.deadline!)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    ),
  ),

  /* ---------- Asset / Liability / Contract / Benefit ---------- */
  http.get(`${BASE}/cases/:caseId/assets`, ({ params }) =>
    list(db.assets.filter((a) => a.caseId === params.caseId)),
  ),
  http.post(`${BASE}/cases/:caseId/assets`, async ({ params, request }) => {
    const body = (await request.json()) as Partial<Asset>
    const created = { id: nextId('asset'), caseId: String(params.caseId), ...body } as Asset
    db.assets.push(created)
    return HttpResponse.json(created, { status: 201 })
  }),
  http.patch(`${BASE}/assets/:id`, async ({ params, request }) => {
    const a = db.assets.find((x) => x.id === params.id)
    if (!a) return HttpResponse.json({ code: 'NOT_FOUND', message: '見つかりません' }, { status: 404 })
    Object.assign(a, await request.json())
    return HttpResponse.json(a)
  }),

  http.get(`${BASE}/cases/:caseId/liabilities`, ({ params }) =>
    list(db.liabilities.filter((l) => l.caseId === params.caseId)),
  ),
  http.post(`${BASE}/cases/:caseId/liabilities`, async ({ params, request }) => {
    const body = (await request.json()) as Partial<Liability>
    const created = { id: nextId('liab'), caseId: String(params.caseId), ...body } as Liability
    db.liabilities.push(created)
    return HttpResponse.json(created, { status: 201 })
  }),
  http.patch(`${BASE}/liabilities/:id`, async ({ params, request }) => {
    const l = db.liabilities.find((x) => x.id === params.id)
    if (!l) return HttpResponse.json({ code: 'NOT_FOUND', message: '見つかりません' }, { status: 404 })
    Object.assign(l, await request.json())
    return HttpResponse.json(l)
  }),

  http.get(`${BASE}/cases/:caseId/contracts`, ({ params }) =>
    list(db.contracts.filter((c) => c.caseId === params.caseId)),
  ),
  http.post(`${BASE}/cases/:caseId/contracts`, async ({ params, request }) => {
    const body = (await request.json()) as Partial<Contract>
    const created = { id: nextId('contract'), caseId: String(params.caseId), ...body } as Contract
    db.contracts.push(created)
    return HttpResponse.json(created, { status: 201 })
  }),
  http.patch(`${BASE}/contracts/:id`, async ({ params, request }) => {
    const c = db.contracts.find((x) => x.id === params.id)
    if (!c) return HttpResponse.json({ code: 'NOT_FOUND', message: '見つかりません' }, { status: 404 })
    Object.assign(c, await request.json())
    return HttpResponse.json(c)
  }),

  http.get(`${BASE}/cases/:caseId/benefits`, ({ params }) =>
    list(db.benefits.filter((b) => b.caseId === params.caseId)),
  ),
  http.patch(`${BASE}/benefits/:id`, async ({ params, request }) => {
    const b = db.benefits.find((x) => x.id === params.id)
    if (!b) return HttpResponse.json({ code: 'NOT_FOUND', message: '見つかりません' }, { status: 404 })
    Object.assign(b, (await request.json()) as Partial<Benefit>)
    return HttpResponse.json(b)
  }),

  /* ---------- Approval ---------- */
  http.get(`${BASE}/cases/:caseId/approvals`, ({ params }) =>
    list(
      db.approvals
        .filter((a) => a.caseId === params.caseId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    ),
  ),

  http.get(`${BASE}/approvals/:id`, ({ params }) => {
    const a = db.approvals.find((x) => x.id === params.id)
    return a
      ? HttpResponse.json(a)
      : HttpResponse.json({ code: 'NOT_FOUND', message: '見つかりません' }, { status: 404 })
  }),

  http.post(`${BASE}/approvals/:id/approve`, async ({ params, request }) => {
    const a = db.approvals.find((x) => x.id === params.id)
    if (!a) return HttpResponse.json({ code: 'NOT_FOUND', message: '見つかりません' }, { status: 404 })
    const body = (await request.json()) as { edits?: Record<string, string>; note?: string }

    if (body.edits) {
      for (const row of a.diff) {
        if (body.edits[row.field] !== undefined) row.after = body.edits[row.field]
      }
    }
    a.status = 'APPROVED'
    a.decidedAt = new Date().toISOString()
    a.decisionNote = body.note

    applyProposal(a)
    return HttpResponse.json(a)
  }),

  http.post(`${BASE}/approvals/:id/reject`, async ({ params, request }) => {
    const a = db.approvals.find((x) => x.id === params.id)
    if (!a) return HttpResponse.json({ code: 'NOT_FOUND', message: '見つかりません' }, { status: 404 })
    const body = (await request.json()) as { note?: string }
    a.status = 'REJECTED'
    a.decidedAt = new Date().toISOString()
    a.decisionNote = body.note
    return HttpResponse.json(a)
  }),

  /* ---------- Person ---------- */
  http.get(`${BASE}/cases/:caseId/persons`, ({ params }) =>
    list(db.persons.filter((p) => p.caseId === params.caseId)),
  ),
  http.post(`${BASE}/cases/:caseId/persons`, async ({ params, request }) => {
    const body = (await request.json()) as Partial<Person>
    const created = { id: nextId('person'), caseId: String(params.caseId), ...body } as Person
    db.persons.push(created)
    return HttpResponse.json(created, { status: 201 })
  }),
  http.patch(`${BASE}/persons/:id`, async ({ params, request }) => {
    const p = db.persons.find((x) => x.id === params.id)
    if (!p) return HttpResponse.json({ code: 'NOT_FOUND', message: '見つかりません' }, { status: 404 })
    Object.assign(p, await request.json())
    return HttpResponse.json(p)
  }),
  http.delete(`${BASE}/persons/:id`, ({ params }) => {
    db.persons = db.persons.filter((p) => p.id !== params.id)
    delete db.decisions[String(params.id)]
    return new HttpResponse(null, { status: 204 })
  }),

  /* ---------- Decision ---------- */
  http.post(`${BASE}/cases/:caseId/inheritance-decisions`, async ({ request }) => {
    const body = (await request.json()) as { personId: string; method: InheritanceMethod | null }
    db.decisions[body.personId] = body.method
    return new HttpResponse(null, { status: 204 })
  }),

  /* ---------- Insight ---------- */
  http.get(`${BASE}/cases/:caseId/insights`, ({ params }) => {
    watchCase(String(params.caseId))
    return list(
      db.insights
        .filter((i) => i.caseId === params.caseId)
        .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt)),
    )
  }),

  http.patch(`${BASE}/insights/:id`, async ({ params, request }) => {
    const i = db.insights.find((x) => x.id === params.id)
    if (!i) return HttpResponse.json({ code: 'NOT_FOUND', message: '見つかりません' }, { status: 404 })
    const body = (await request.json()) as { status: Insight['status'] }
    i.status = body.status
    return HttpResponse.json(i)
  }),

  /* ---------- Chat ---------- */
  http.get(`${BASE}/cases/:caseId/messages`, ({ params }) =>
    list(db.messages.filter((m) => m.caseId === params.caseId)),
  ),

  http.post(`${BASE}/cases/:caseId/messages`, async ({ params, request }) => {
    const caseId = String(params.caseId)
    const { body } = (await request.json()) as { body: string }

    db.messages.push({
      id: nextId('msg'),
      caseId,
      role: 'user',
      body,
      createdAt: new Date().toISOString(),
    })

    await delay(800)

    const needsProfessional = /放棄|限定承認|相続税|登記|裁判|遺留分|分割/.test(body)
    const reply: ChatMessage = {
      id: nextId('msg'),
      caseId,
      role: 'assistant',
      body: buildReply(caseId, body),
      createdAt: new Date().toISOString(),
      professionalNotice: needsProfessional,
      escalationApprovalId: needsProfessional ? ensureEscalationApproval(caseId) : undefined,
    }
    db.messages.push(reply)
    return HttpResponse.json(reply, { status: 201 })
  }),
]

function buildReply(caseId: string, question: string): string {
  const ov = overview(caseId)
  const nearest = ov.upcomingDeadlines[0]

  if (/優先|なに|何を|次/.test(question)) {
    return nearest
      ? `いま期限がいちばん近いのは「${nearest.taskTitle ?? nearest.label}」です（${nearest.dueDate} まで、${nearest.basisLabel}）。「やること」の画面から、必要な書類と窓口をご確認ください。\n\n手続きそのもの（提出・届出）はご本人にお願いしています。`
      : '直近7日以内に期限を迎える手続きはありません。まずは書類の追加から進めてみてください。'
  }
  if (/死亡届/.test(question)) {
    return '死亡届は、亡くなった方の本籍地・死亡地・届出人の住所地のいずれかの市区町村の窓口に提出します。死亡診断書と一緒に提出し、火葬許可証を受け取ります。期限は死亡を知った日から7日以内です。'
  }
  if (/放棄/.test(question)) {
    return '相続放棄を検討される場合、故人の預金を使う、故人の財産を売ったり捨てたりする、故人の財産から借金を返すといった行為は避けてください。これらは単純承認とみなされ、放棄ができなくなるおそれがあります。期限は、自分が相続人になったと知った時から原則3か月です。'
  }
  // 画面の「聞いてみる例」に出している質問。答えが無いと、決まり文句だけが返っていた
  if (/口座|銀行/.test(question)) {
    return '故人の口座は、金融機関が亡くなったことを知った時点で止められます。死亡届を出しても、役所から金融機関へ自動で知らせることはありません。止まると、公共料金などの引き落としもできなくなるので、引き落とし先の変更を先に確かめておくと安心です。相続の手続きが済むまで、原則として引き出しはできません（一定額までの仮払いの制度はあります）。'
  }
  return `ご質問ありがとうございます。いまのケースの状況（未完了の手続き ${
    Object.entries(ov.taskCounts)
      .filter(([k]) => k !== 'COMPLETED')
      .reduce((n, [, v]) => n + (v ?? 0), 0)
  } 件、確認待ちの提案 ${ov.pendingApprovalCount} 件）をふまえてお答えします。より具体的な内容は、「やること」の画面からご確認ください。`
}

function ensureEscalationApproval(caseId: string): string {
  const existing = db.approvals.find(
    (a) => a.caseId === caseId && a.kind === 'ESCALATION_PROPOSAL' && a.status === 'PENDING',
  )
  if (existing) return existing.id

  const created: Approval = {
    id: nextId('apr'),
    caseId,
    kind: 'ESCALATION_PROPOSAL',
    status: 'PENDING',
    title: '専門家への相談を記録として追加する',
    summary:
      'ご質問の内容には個別の法律・税務判断が含まれます。専門家への相談を手続きとして追加する提案です。',
    createdAt: new Date().toISOString(),
    assetDisposal: false,
    diff: [
      { field: '手続き名', before: null, after: '弁護士に相続方法について相談する' },
      { field: '状態', before: null, after: '専門家対応中（ESCALATED）' },
    ],
  }
  db.approvals.push(created)
  return created.id
}

/** 承認された提案を、アプリ内の情報として反映する（外部への提出等は行わない） */
function applyProposal(a: Approval) {
  const value = (field: string) => a.diff.find((d) => d.field === field)?.after ?? ''

  const yen = (field: string) => {
    const digits = value(field).replace(/[^\d]/g, '')
    return digits ? Number(digits) : undefined
  }

  if (a.kind === 'ASSET_PROPOSAL') {
    db.assets.push({
      id: nextId('asset'),
      caseId: a.caseId,
      name: value('名称'),
      kind: 'BANK',
      institution: value('金融機関') || undefined,
      amount: yen('残高'),
      source: 'AI',
      confirmation: 'CONFIRMED',
      version: 1,
    })
  }

  if (a.kind === 'LIABILITY_PROPOSAL') {
    db.liabilities.push({
      id: nextId('liability'),
      caseId: a.caseId,
      name: value('名称'),
      kind: 'LOAN',
      creditor: value('借りている先') || undefined,
      amount: yen('金額'),
      source: 'AI',
      confirmation: 'CONFIRMED',
      version: 1,
    })
  }

  if (a.kind === 'CONTRACT_PROPOSAL') {
    db.contracts.push({
      id: nextId('contract'),
      caseId: a.caseId,
      name: value('名称'),
      kind: value('名称').includes('保険') ? 'INSURANCE' : 'OTHER',
      provider: value('契約先') || undefined,
      policy: 'UNDECIDED',
      progress: 'NOT_STARTED',
      source: 'AI',
      version: 1,
    })
  }

  // 「故人の情報を登録する」のように手続き名を持たない提案からは、手続きを作らない。
  // 作ると名前も期限もない手続きができ、ほかを片づけたあとに「やること」の先頭に出てきてしまう。
  if ((a.kind === 'TASK_PROPOSAL' || a.kind === 'ESCALATION_PROPOSAL') && value('手続き名').trim()) {
    db.tasks.push({
      id: nextId('task'),
      caseId: a.caseId,
      title: value('手続き名'),
      summary: a.summary,
      submitTo: value('提出先') || undefined,
      status: a.kind === 'ESCALATION_PROPOSAL' ? 'ESCALATED' : 'NOT_STARTED',
      stage: a.assetDisposal ? 'transfer' : 'government',
      category: a.kind === 'ESCALATION_PROPOSAL' ? '相続' : 'その他',
      source: 'AI',
      assetDisposal: a.assetDisposal,
      evidences: [],
      updatedAt: new Date().toISOString(),
    })
  }

  if (a.kind === 'DOCUMENT_REQUEST') {
    const target = db.tasks.find((t) => t.caseId === a.caseId && t.id === 'task_4')
    target?.requiredDocuments?.push({
      id: nextId('rd'),
      label: value('必要書類'),
      collected: false,
      source: 'AI',
    })
  }
}

export { CASE_ID, todayISO }
