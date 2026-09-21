/**
 * モック API。
 *
 * 応答の形は Backend と同じ（封筒・Case 配下パス・Idempotency-Key/expectedVersion の検査・
 * strict body）にする。差があると、モックでだけ通る画面の分岐が生まれてしまうため。
 * `/auth/login` は無い（`lib/auth/mock.ts` がサインインを担い、ここは Authorization を検査しない）。
 * 本番コードからは参照しない。
 */
import { HttpResponse, http, delay } from 'msw'
import type {
  AcknowledgeInsightRequest,
  Asset,
  Benefit,
  CaseResource,
  Contract,
  ConsentKind,
  CreateAssetRequest,
  CreateBenefitRequest,
  CreateContractRequest,
  CreateLiabilityRequest,
  CreatePersonRequest,
  CreateRelationshipRequest,
  DocumentKind,
  ExcludePersonRequest,
  GuidanceResource,
  InheritanceMethod,
  Liability,
  MeResource,
  MessageAcceptedResource,
  MessageResource,
  Person,
  ReportProgressRequest,
  SetContractPolicyRequest,
  TaskCommandResource,
  UpdateAssetRequest,
  UpdateBenefitRequest,
  UpdateContractRequest,
  UpdateLiabilityRequest,
  UpdatePersonRequest,
} from '@aftercare/public-contracts'
import { SELF_PERSON_ID, db, nextId } from './db'
import { computeFlowStages, taskActions } from './rules'
import { guessKind, startAnalysis } from './analysis'
import { sampleContent, uploadedFiles } from './content'
import { watchCase } from './watch'
import { stableHash } from './proposals'
import { fail, jsonBody, notFound, ok, page, requireExpectedVersion, requireIdempotencyKey } from './http'

const BASE = '/api/v1'

/** マイナンバーが載っている可能性が高い書類は受け付けない（企画書セクション5）。 */
const MY_NUMBER_HINTS = ['マイナンバー', '個人番号', '住民票', '源泉徴収', 'mynumber']

function caseOf(caseId: string) {
  return db.cases.find((c) => c.id === caseId)
}

function taskOf(caseId: string, taskId: string) {
  return db.tasks.find((t) => t.caseId === caseId && t.id === taskId)
}

/** 手続きの `allowedActions`/`blockedActions` を、いまの状態から作り直す。 */
function refreshTaskActions(task: (typeof db.tasks)[number]) {
  const decided =
    db.persons.filter((p) => p.caseId === task.caseId && p.isHeir && !p.excludedAt).length > 0 &&
    db.persons
      .filter((p) => p.caseId === task.caseId && p.isHeir && !p.excludedAt)
      .every((h) => db.decisions.find((d) => d.personId === h.id)?.confirmed)
  const { allowed, blocked } = taskActions(task.status, {
    assetDisposal: task.assetDisposal,
    decided,
    evidenceRequired: task.evidenceRequired,
    hasEvidence: task.evidences.length > 0,
  })
  task.allowedActions = allowed
  task.blockedActions = blocked
}

function refreshAllTaskActions(caseId: string) {
  for (const t of db.tasks.filter((x) => x.caseId === caseId)) refreshTaskActions(t)
}

function overviewOf(caseId: string) {
  const kase = caseOf(caseId)!
  const tasks = db.tasks.filter((t) => t.caseId === caseId)
  const flowStages = computeFlowStages(tasks)

  const heirs = db.persons.filter((p) => p.caseId === caseId && p.isHeir && !p.excludedAt)
  const perHeir = heirs.map((p) => {
    const d = db.decisions.find((x) => x.personId === p.id)
    return {
      personId: p.id,
      personName: p.name,
      method: d?.method ?? null,
      state: d?.state ?? 'DRAFT',
      confirmed: d?.confirmed ?? false,
    }
  })

  const upcoming = tasks
    .map((t) => t.deadline)
    .filter((d): d is NonNullable<typeof d> => Boolean(d) && d!.dueDate != null)
    .filter((d) => d.daysRemaining != null && d.daysRemaining <= 7)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))

  const taskCounts: Partial<Record<(typeof tasks)[number]['status'], number>> = {}
  for (const t of tasks) taskCounts[t.status] = (taskCounts[t.status] ?? 0) + 1

  const decisionTask = tasks.find((t) => t.stage === 'decision')

  return {
    case: kase,
    aggregatedAt: new Date().toISOString(),
    consistency: 'SNAPSHOT' as const,
    caseVersion: kase.caseVersion,
    taskCounts,
    totalTasks: tasks.length,
    flowStages,
    upcomingDeadlines: upcoming,
    unresolvedDeadlineCount: tasks.filter((t) => t.deadline && t.deadline.dueDate == null).length,
    pendingApprovalCount: db.approvals.filter((a) => a.caseId === caseId && a.status === 'PENDING').length,
    appliedApprovalCount: db.approvals.filter((a) => a.caseId === caseId && a.applicationStatus === 'APPLIED').length,
    inheritanceDecision: {
      decided: perHeir.length > 0 && perHeir.every((h) => h.confirmed),
      unknown: heirs.length === 0,
      perHeir,
      deliberationDeadline: decisionTask?.deadline
        ? { ...decisionTask.deadline, id: 'deliberation-period', taskId: null }
        : null,
    },
    recentAgentRuns: db.agentRuns.filter((r) => r.caseId === caseId).slice(0, 10),
    aiConnected: true,
  }
}

function consentStatus() {
  const missingRequired = db.consents.filter((c) => c.required && !c.satisfied).map((c) => c.kind)
  const missingOptional = db.consents.filter((c) => !c.required && !c.satisfied).map((c) => c.kind)
  return {
    documents: db.consents,
    outstanding: missingRequired.length > 0,
    availability: {
      manualManagement: true,
      externalAi: !missingOptional.includes('CROSS_BORDER_AI'),
      missingRequired,
      missingOptional,
    },
  }
}

/** 承認された提案を業務状態へ反映する。反映できたら true を返す。 */
function applyProposal(proposalId: string): { applied: boolean; reason?: string } {
  const proposal = db.proposals.find((p) => p.id === proposalId)
  if (!proposal) return { applied: false, reason: '提案が見つかりません。' }
  const fieldsOf = () => (proposal.payload.fields ?? proposal.payload) as Record<string, unknown>
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

  switch (proposal.kind) {
    case 'ASSET_PROPOSAL': {
      const f = fieldsOf()
      const asset: Asset = {
        id: nextId('asset'),
        caseId: proposal.caseId,
        name: str(f.name, '（名称未設定）'),
        kind: (f.kind as Asset['kind']) ?? 'OTHER',
        institution: typeof f.institution === 'string' ? f.institution : undefined,
        amount: typeof f.amount === 'number' ? f.amount : undefined,
        currency: 'JPY',
        source: 'AI',
        confirmation: 'UNCONFIRMED',
        version: 1,
      }
      db.assets.push(asset)
      return { applied: true }
    }
    case 'LIABILITY_PROPOSAL': {
      const f = fieldsOf()
      const liability: Liability = {
        id: nextId('liab'),
        caseId: proposal.caseId,
        name: str(f.name, '（名称未設定）'),
        kind: (f.kind as Liability['kind']) ?? 'OTHER',
        creditor: typeof f.creditor === 'string' ? f.creditor : undefined,
        amount: typeof f.amount === 'number' ? f.amount : undefined,
        currency: 'JPY',
        source: 'AI',
        confirmation: 'UNCONFIRMED',
        version: 1,
      }
      db.liabilities.push(liability)
      return { applied: true }
    }
    case 'CONTRACT_PROPOSAL': {
      const f = fieldsOf()
      const contract: Contract = {
        id: nextId('contract'),
        caseId: proposal.caseId,
        name: str(f.name, '（名称未設定）'),
        kind: (f.kind as Contract['kind']) ?? 'OTHER',
        provider: typeof f.provider === 'string' ? f.provider : undefined,
        policy: 'UNDECIDED',
        progress: 'NOT_STARTED',
        source: 'AI',
        version: 1,
      }
      db.contracts.push(contract)
      return { applied: true }
    }
    case 'PERSON_PROPOSAL': {
      const f = fieldsOf()
      const person: Person = {
        id: nextId('person'),
        caseId: proposal.caseId,
        name: str(f.name, '（名前未設定）'),
        relationship: str(f.relationship, ''),
        role: (f.role as Person['role']) ?? 'RELATED',
        isHeir: Boolean(f.isHeir),
        version: 1,
      }
      db.persons.push(person)
      refreshAllTaskActions(proposal.caseId)
      return { applied: true }
    }
    case 'TASK_PROPOSAL': {
      const p = proposal.payload
      const status = 'NOT_STARTED' as const
      const assetDisposal = Boolean(p.assetDisposal)
      const { allowed, blocked } = taskActions(status, {
        assetDisposal,
        decided: false,
        evidenceRequired: false,
        hasEvidence: false,
      })
      const now = new Date().toISOString()
      db.tasks.push({
        id: nextId('task'),
        caseId: proposal.caseId,
        conditional: false,
        submitToSource: 'MANUAL',
        targetDate: null,
        title: str(p.title, proposal.title),
        summary: str(p.summary, proposal.summary),
        status,
        stage: (p.stage as (typeof db.tasks)[number]['stage'] | undefined) ?? 'contracts',
        category: str(p.category, '手続き'),
        submitTo: typeof p.submitTo === 'string' ? p.submitTo : null,
        assigneeId: null,
        dependencyTaskIds: [],
        escalation: null,
        source: 'AI',
        evidenceRequired: false,
        assetDisposal,
        requiredDocuments: [],
        completionReportedBy: null,
        completionReportedAt: null,
        deadline: null,
        evidences: [],
        allowedActions: allowed,
        blockedActions: blocked,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      return { applied: true }
    }
    case 'DOCUMENT_REQUEST':
    case 'EVIDENCE_PROPOSAL':
    case 'ESCALATION_PROPOSAL':
      // これらは記録・お願いの共有そのものが結果であり、業務データを新設しない
      return { applied: true }
    default:
      return { applied: false, reason: 'この種類の提案には対応していません。' }
  }
}

export const handlers = [
  /* ---------- 利用登録 ---------- */
  http.get(`${BASE}/me`, () => ok<MeResource>(me())),
  http.post(`${BASE}/me`, () => ok<MeResource>(me(), 200)),

  /* ---------- 同意 ---------- */
  http.get(`${BASE}/consents`, () => ok(consentStatus())),
  http.post(`${BASE}/consents`, async ({ request }) => {
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    const agreements = Array.isArray(body.agreements) ? (body.agreements as { kind: ConsentKind; version: string }[]) : []
    const now = new Date().toISOString()
    for (const a of agreements) {
      const doc = db.consents.find((c) => c.kind === a.kind)
      if (doc) {
        doc.agreedVersion = a.version
        doc.agreedAt = now
        doc.satisfied = a.version === doc.version
      }
    }
    return ok(consentStatus())
  }),

  /* ---------- Case ---------- */
  http.get(`${BASE}/cases`, () => page(db.cases)),
  http.post(`${BASE}/cases`, async ({ request }) => {
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    const now = new Date().toISOString()
    const id = nextId('case')
    const created: CaseResource = {
      id,
      deceasedName: String(body.deceasedName ?? ''),
      deceasedNameKana: typeof body.deceasedNameKana === 'string' ? body.deceasedNameKana : null,
      dateOfDeath: String(body.dateOfDeath ?? ''),
      dateOfBirth: typeof body.dateOfBirth === 'string' ? body.dateOfBirth : null,
      funeralCompletedAt: null,
      knownAt: typeof body.knownAt === 'string' ? body.knownAt : null,
      ownerName: String(body.ownerName ?? ''),
      relationshipToDeceased: String(body.relationshipToDeceased ?? ''),
      municipality: null,
      ownerPersonId: null,
      selfPersonId: null,
      aiPlanningRestriction: null,
      status: 'ACTIVE',
      version: 1,
      caseVersion: 1,
      createdAt: now,
      updatedAt: now,
      allowedActions: ['UPDATE_BASIC_INFO', 'ADMINISTER'],
    }
    if (body.ownerPerson && typeof body.ownerPerson === 'object') {
      const personId = nextId('person')
      db.persons.push({
        id: personId,
        caseId: id,
        name: created.ownerName,
        relationship: created.relationshipToDeceased,
        role: 'HEIR_CANDIDATE',
        isHeir: Boolean((body.ownerPerson as { isHeir?: boolean }).isHeir),
        version: 1,
      })
      created.ownerPersonId = personId
      created.selfPersonId = personId
    }
    db.cases.push(created)
    return ok(created, 201)
  }),
  http.get(`${BASE}/cases/:caseId/overview`, ({ params }) => {
    const kase = caseOf(String(params.caseId))
    if (!kase) return notFound()
    watchCase(kase.id)
    return ok(overviewOf(kase.id))
  }),
  http.get(`${BASE}/cases/:caseId`, ({ params }) => {
    const kase = caseOf(String(params.caseId))
    return kase ? ok(kase) : notFound()
  }),
  http.patch(`${BASE}/cases/:caseId`, async ({ params, request }) => {
    const kase = caseOf(String(params.caseId))
    if (!kase) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    const ver = requireExpectedVersion(body, kase)
    if (ver) return ver
    if ('deceasedName' in body && typeof body.deceasedName === 'string') kase.deceasedName = body.deceasedName
    if ('municipality' in body) kase.municipality = typeof body.municipality === 'string' ? body.municipality : null
    if ('dateOfBirth' in body) kase.dateOfBirth = typeof body.dateOfBirth === 'string' ? body.dateOfBirth : null
    if ('knownAt' in body) kase.knownAt = typeof body.knownAt === 'string' ? body.knownAt : null
    if ('funeralCompletedAt' in body) kase.funeralCompletedAt = typeof body.funeralCompletedAt === 'string' ? body.funeralCompletedAt : null
    kase.version += 1
    kase.caseVersion += 1
    kase.updatedAt = new Date().toISOString()
    refreshAllTaskActions(kase.id)
    return ok(kase)
  }),

  /* ---------- Document ---------- */
  http.get(`${BASE}/cases/:caseId/documents`, ({ params }) => page(db.documents.filter((d) => d.caseId === String(params.caseId) && !d.archived))),
  http.post(`${BASE}/cases/:caseId/documents`, async ({ params, request }) => {
    const caseId = String(params.caseId)
    if (!caseOf(caseId)) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const form = await request.formData()
    const file = form.get('file')
    const kindField = form.get('kind')
    if (!(file instanceof File)) return fail('VALIDATION_FAILED', 'file が必要です。', { field: 'file' })
    if (file.size > 10 * 1024 * 1024) return fail('PAYLOAD_TOO_LARGE', '10MBまでの書類をお預かりできます。', { maxBytes: 10 * 1024 * 1024 })
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type) && file.type !== '')
      return fail('UNSUPPORTED_MEDIA_TYPE', 'PDF・JPEG・PNGのみお預かりできます。')

    await delay(200)
    const now = new Date().toISOString()
    const isSensitive = MY_NUMBER_HINTS.some((h) => file.name.toLowerCase().includes(h.toLowerCase()))
    const id = nextId('doc')
    uploadedFiles.set(id, file)
    const doc = {
      id,
      caseId,
      fileName: file.name,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      sha256: stableHash({ name: file.name, size: file.size }),
      kind: (typeof kindField === 'string' ? (kindField as DocumentKind) : guessKind(file.name)) ?? 'OTHER',
      kindSource: 'MANUAL' as const,
      storageState: (isSensitive ? 'FAILED' : 'STORED') as 'FAILED' | 'STORED',
      inspection: isSensitive
        ? {
            status: 'REJECTED' as const,
            completed: true,
            findings: [{ kind: 'SENSITIVE_NUMBER' as const, message: 'マイナンバーが書かれている可能性があるため、お預かりできません。', locationHint: null }],
          }
        : { status: 'PASSED' as const, completed: true, findings: [] },
      analysis: { state: 'NOT_REQUESTED' as const, agentRunId: null, canRequest: !isSensitive, blockedReasons: [], run: null },
      extractionCandidates: [],
      proposalRefs: [],
      approvalRefs: [],
      evidenceRefs: [],
      archived: false,
      archivedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    db.documents.push(doc)
    if (!isSensitive) startAnalysis(doc)
    return ok(doc, 201)
  }),
  http.get(`${BASE}/cases/:caseId/documents/:documentId`, ({ params }) => {
    const doc = db.documents.find((d) => d.id === String(params.documentId) && d.caseId === String(params.caseId))
    return doc ? ok(doc) : notFound()
  }),
  http.get(`${BASE}/cases/:caseId/documents/:documentId/content`, async ({ params }) => {
    const doc = db.documents.find((d) => d.id === String(params.documentId) && d.caseId === String(params.caseId))
    if (!doc) return notFound()
    const blob = uploadedFiles.get(doc.id) ?? sampleContent(doc)
    return new HttpResponse(blob, { headers: { 'Content-Type': blob.type || doc.contentType } })
  }),
  http.post(`${BASE}/cases/:caseId/documents/:documentId/archive`, async ({ params, request }) => {
    const doc = db.documents.find((d) => d.id === String(params.documentId) && d.caseId === String(params.caseId))
    if (!doc) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    const ver = requireExpectedVersion(body, doc)
    if (ver) return ver
    doc.archived = true
    doc.archivedAt = new Date().toISOString()
    doc.version += 1
    doc.updatedAt = doc.archivedAt
    return ok(doc)
  }),

  /* ---------- Task ---------- */
  http.get(`${BASE}/cases/:caseId/tasks`, ({ params }) => page(db.tasks.filter((t) => t.caseId === String(params.caseId)))),
  http.post(`${BASE}/cases/:caseId/tasks`, async ({ params, request }) => {
    const caseId = String(params.caseId)
    if (!caseOf(caseId)) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    const now = new Date().toISOString()
    const status = 'NOT_STARTED' as const
    const { allowed, blocked } = taskActions(status, { assetDisposal: false, decided: false, evidenceRequired: Boolean(body.evidenceRequired), hasEvidence: false })
    const created = {
      id: nextId('task'),
      caseId,
      title: String(body.title ?? ''),
      summary: typeof body.summary === 'string' ? body.summary : '',
      status,
      stage: (body.stage as (typeof db.tasks)[number]['stage']) ?? 'contracts',
      category: String(body.category ?? '手続き'),
      submitTo: typeof body.submitTo === 'string' ? body.submitTo : null,
      assigneeId: null,
      dependencyTaskIds: [],
      escalation: null,
      source: 'MANUAL' as const,
      conditional: false,
      submitToSource: 'MANUAL' as const,
      targetDate: null,
      evidenceRequired: Boolean(body.evidenceRequired),
      assetDisposal: false,
      requiredDocuments: [],
      completionReportedBy: null,
      completionReportedAt: null,
      deadline: null,
      evidences: [],
      allowedActions: allowed,
      blockedActions: blocked,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    db.tasks.push(created)
    return ok(created, 201)
  }),
  http.get(`${BASE}/cases/:caseId/tasks/:taskId`, ({ params }) => {
    const t = taskOf(String(params.caseId), String(params.taskId))
    return t ? ok(t) : notFound()
  }),
  http.patch(`${BASE}/cases/:caseId/tasks/:taskId`, async ({ params, request }) => {
    const t = taskOf(String(params.caseId), String(params.taskId))
    if (!t) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    const ver = requireExpectedVersion(body, t)
    if (ver) return ver
    if (typeof body.title === 'string') t.title = body.title
    if (typeof body.summary === 'string') t.summary = body.summary
    if ('submitTo' in body) t.submitTo = typeof body.submitTo === 'string' ? body.submitTo : null
    if ('assigneeId' in body) t.assigneeId = typeof body.assigneeId === 'string' ? body.assigneeId : null
    if (Array.isArray(body.requiredDocuments)) {
      t.requiredDocuments = (body.requiredDocuments as { id: string; label: string; documentId: string | null; collected?: boolean }[]).map((r) => ({
        id: r.id,
        label: r.label,
        documentId: r.documentId,
        collected: r.collected ?? false,
        source: t.requiredDocuments.find((x) => x.id === r.id)?.source ?? 'MANUAL',
      }))
    }
    t.version += 1
    t.updatedAt = new Date().toISOString()
    return ok(t)
  }),
  http.post(`${BASE}/cases/:caseId/tasks/:taskId/commands`, async ({ params, request }) => {
    const t = taskOf(String(params.caseId), String(params.taskId))
    if (!t) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    const ver = requireExpectedVersion(body, t)
    if (ver) return ver
    const command = body.command as TaskCommandResource
    if (!t.allowedActions.includes(command)) {
      const blocked = t.blockedActions.find((b) => b.action === command)
      return fail('PRECONDITION_FAILED', 'いまの状態ではこの操作はできません。', { reason: blocked?.reason ?? 'INVALID_TRANSITION' })
    }
    const TRANSITIONS: Partial<Record<TaskCommandResource, (typeof db.tasks)[number]['status']>> = {
      start: 'COLLECTING_INFORMATION',
      requestDocuments: 'WAITING_DOCUMENTS',
      markReady: 'READY',
      reportSubmission: 'SUBMITTED',
      awaitExternal: 'WAITING_EXTERNAL',
      complete: 'COMPLETED',
      reopen: 'ACTION_REQUIRED',
      flagActionRequired: 'ACTION_REQUIRED',
    }
    const next = TRANSITIONS[command]
    if (next) t.status = next
    if (command === 'complete') {
      t.completionReportedBy = SELF_PERSON_ID
      t.completionReportedAt = new Date().toISOString()
    }
    t.version += 1
    t.updatedAt = new Date().toISOString()
    refreshTaskActions(t)
    return ok(t)
  }),
  http.post(`${BASE}/cases/:caseId/tasks/:taskId/evidences`, async ({ params, request }) => {
    const t = taskOf(String(params.caseId), String(params.taskId))
    if (!t) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    t.evidences.push({
      id: nextId('ev'),
      label: String(body.label ?? ''),
      kind: (body.kind as (typeof t.evidences)[number]['kind']) ?? 'OTHER',
      note: typeof body.note === 'string' ? body.note : null,
      recordedAt: new Date().toISOString(),
    })
    t.version += 1
    t.updatedAt = new Date().toISOString()
    refreshTaskActions(t)
    return ok(t)
  }),
  http.get(`${BASE}/cases/:caseId/tasks/:taskId/guidance`, ({ params }) => {
    const taskId = String(params.taskId)
    const existing = db.guidance[taskId]
    if (existing) return ok(existing)
    return ok<GuidanceResource>({
      taskId,
      status: 'NOT_REQUESTED',
      target: null,
      where: null,
      bring: [],
      steps: [],
      formExampleUrl: null,
      formExampleLabel: null,
      note: null,
      sources: [],
      citations: [],
      missing: [],
      failureReason: null,
      researchedBy: null,
      agentRunId: null,
      version: 0,
      updatedAt: new Date().toISOString(),
    })
  }),
  http.post(`${BASE}/cases/:caseId/tasks/:taskId/guidance/requests`, async ({ params, request }) => {
    const t = taskOf(String(params.caseId), String(params.taskId))
    if (!t) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const taskId = t.id
    const now = new Date().toISOString()
    const researching: GuidanceResource = {
      taskId,
      status: 'RESEARCHING',
      target: t.submitTo ?? t.title,
      where: null,
      bring: [],
      steps: [],
      formExampleUrl: null,
      formExampleLabel: null,
      note: null,
      sources: [],
      citations: [],
      missing: [],
      failureReason: null,
      researchedBy: 'AI',
      agentRunId: nextId('run'),
      version: 1,
      updatedAt: now,
    }
    db.guidance[taskId] = researching
    setTimeout(() => {
      db.guidance[taskId] = {
        ...researching,
        status: 'COMPLETED',
        where: t.submitTo ?? '窓口にご確認ください',
        // 持ち物は、その手続きの持ち物の一覧から作る。どの手続きにも同じ「印鑑」を返すと、
        // 押印が任意の死亡届などにも印鑑が出てしまう
        bring: t.requiredDocuments.length > 0 ? t.requiredDocuments.map((r) => r.label) : ['手続きをする方の本人確認書類'],
        // どの手続きにも当てはまる手順だけにする（死亡届のように、用紙を窓口でもらわない手続きもある）
        steps: ['持ち物をそろえて、窓口へ行きます。', '窓口の案内にしたがって提出します。'],
        note: '受付時間は自治体・機関によって異なります。事前にご確認ください。',
        sources: [{ label: `${t.submitTo ?? '窓口'}の案内`, url: 'https://example.com/guidance', checkedAt: new Date().toISOString() }],
        version: researching.version + 1,
        updatedAt: new Date().toISOString(),
      }
    }, 4500)
    return ok(researching, 202)
  }),

  /* ---------- Asset / Liability / Contract / Benefit ---------- */
  http.get(`${BASE}/cases/:caseId/assets`, ({ params }) => page(db.assets.filter((a) => a.caseId === String(params.caseId)))),
  http.post(`${BASE}/cases/:caseId/assets`, async ({ params, request }) => {
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as CreateAssetRequest
    const created: Asset = { id: nextId('asset'), caseId: String(params.caseId), name: body.name, kind: body.kind, institution: body.institution, amount: body.amount ?? undefined, currency: 'JPY', source: 'MANUAL', confirmation: 'UNCONFIRMED', taxAttention: body.taxAttention, note: body.note, version: 1 }
    db.assets.push(created)
    return ok(created, 201)
  }),
  http.patch(`${BASE}/cases/:caseId/assets/:id`, async ({ params, request }) => {
    const a = db.assets.find((x) => x.id === String(params.id) && x.caseId === String(params.caseId))
    if (!a) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as UpdateAssetRequest
    const ver = requireExpectedVersion(body, a)
    if (ver) return ver
    Object.assign(a, body, { version: a.version + 1 })
    return ok(a)
  }),
  http.post(`${BASE}/cases/:caseId/assets/:id/confirm`, async ({ params, request }) => {
    const a = db.assets.find((x) => x.id === String(params.id) && x.caseId === String(params.caseId))
    if (!a) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    const ver = requireExpectedVersion(body, a)
    if (ver) return ver
    a.confirmation = 'CONFIRMED'
    a.confirmationRecord = { state: 'CONFIRMED', confirmedAt: new Date().toISOString(), confirmedBy: SELF_PERSON_ID, confirmedVersion: a.version + 1 }
    a.version += 1
    return ok(a)
  }),

  http.get(`${BASE}/cases/:caseId/liabilities`, ({ params }) => page(db.liabilities.filter((l) => l.caseId === String(params.caseId)))),
  http.post(`${BASE}/cases/:caseId/liabilities`, async ({ params, request }) => {
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as CreateLiabilityRequest
    const created: Liability = { id: nextId('liab'), caseId: String(params.caseId), name: body.name, kind: body.kind, creditor: body.creditor, amount: body.amount ?? undefined, currency: 'JPY', source: 'MANUAL', confirmation: 'UNCONFIRMED', note: body.note, version: 1 }
    db.liabilities.push(created)
    return ok(created, 201)
  }),
  http.patch(`${BASE}/cases/:caseId/liabilities/:id`, async ({ params, request }) => {
    const l = db.liabilities.find((x) => x.id === String(params.id) && x.caseId === String(params.caseId))
    if (!l) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as UpdateLiabilityRequest
    const ver = requireExpectedVersion(body, l)
    if (ver) return ver
    Object.assign(l, body, { version: l.version + 1 })
    return ok(l)
  }),
  http.post(`${BASE}/cases/:caseId/liabilities/:id/confirm`, async ({ params, request }) => {
    const l = db.liabilities.find((x) => x.id === String(params.id) && x.caseId === String(params.caseId))
    if (!l) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    const ver = requireExpectedVersion(body, l)
    if (ver) return ver
    l.confirmation = 'CONFIRMED'
    l.confirmationRecord = { state: 'CONFIRMED', confirmedAt: new Date().toISOString(), confirmedBy: SELF_PERSON_ID, confirmedVersion: l.version + 1 }
    l.version += 1
    return ok(l)
  }),

  http.get(`${BASE}/cases/:caseId/contracts`, ({ params }) => page(db.contracts.filter((c) => c.caseId === String(params.caseId)))),
  http.post(`${BASE}/cases/:caseId/contracts`, async ({ params, request }) => {
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as CreateContractRequest
    const created: Contract = { id: nextId('contract'), caseId: String(params.caseId), name: body.name, kind: body.kind, provider: body.provider, policy: 'UNDECIDED', progress: 'NOT_STARTED', source: 'MANUAL', note: body.note, version: 1 }
    db.contracts.push(created)
    return ok(created, 201)
  }),
  http.patch(`${BASE}/cases/:caseId/contracts/:id`, async ({ params, request }) => {
    const c = db.contracts.find((x) => x.id === String(params.id) && x.caseId === String(params.caseId))
    if (!c) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as UpdateContractRequest
    const ver = requireExpectedVersion(body, c)
    if (ver) return ver
    Object.assign(c, body, { version: c.version + 1 })
    return ok(c)
  }),
  http.post(`${BASE}/cases/:caseId/contracts/:id/policy`, async ({ params, request }) => {
    const c = db.contracts.find((x) => x.id === String(params.id) && x.caseId === String(params.caseId))
    if (!c) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as SetContractPolicyRequest
    const ver = requireExpectedVersion(body, c)
    if (ver) return ver
    c.policy = body.policy
    c.policyRecord = { decidedAt: new Date().toISOString(), decidedBy: SELF_PERSON_ID, note: body.note ?? null }
    c.version += 1
    return ok(c)
  }),
  http.post(`${BASE}/cases/:caseId/contracts/:id/progress`, async ({ params, request }) => {
    const c = db.contracts.find((x) => x.id === String(params.id) && x.caseId === String(params.caseId))
    if (!c) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as ReportProgressRequest
    const ver = requireExpectedVersion(body, c)
    if (ver) return ver
    c.progress = body.progress
    c.progressRecord = { reportedAt: new Date().toISOString(), reportedBy: SELF_PERSON_ID, source: 'USER_REPORTED', note: body.note ?? null }
    c.version += 1
    return ok(c)
  }),

  http.get(`${BASE}/cases/:caseId/benefits`, ({ params }) => page(db.benefits.filter((b) => b.caseId === String(params.caseId)))),
  http.post(`${BASE}/cases/:caseId/benefits`, async ({ params, request }) => {
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as CreateBenefitRequest
    const created: Benefit = { id: nextId('benefit'), caseId: String(params.caseId), name: body.name, kind: body.kind, provider: body.provider, amount: body.amount ?? undefined, currency: 'JPY', progress: 'NOT_STARTED', note: body.note, version: 1 }
    db.benefits.push(created)
    return ok(created, 201)
  }),
  http.patch(`${BASE}/cases/:caseId/benefits/:id`, async ({ params, request }) => {
    const b = db.benefits.find((x) => x.id === String(params.id) && x.caseId === String(params.caseId))
    if (!b) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as UpdateBenefitRequest
    const ver = requireExpectedVersion(body, b)
    if (ver) return ver
    Object.assign(b, body, { version: b.version + 1 })
    return ok(b)
  }),
  http.post(`${BASE}/cases/:caseId/benefits/:id/progress`, async ({ params, request }) => {
    const b = db.benefits.find((x) => x.id === String(params.id) && x.caseId === String(params.caseId))
    if (!b) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as ReportProgressRequest
    const ver = requireExpectedVersion(body, b)
    if (ver) return ver
    b.progress = body.progress
    b.progressRecord = { reportedAt: new Date().toISOString(), reportedBy: SELF_PERSON_ID, source: 'USER_REPORTED', note: body.note ?? null }
    b.version += 1
    return ok(b)
  }),

  /* ---------- Proposal / Approval ---------- */
  http.get(`${BASE}/cases/:caseId/proposals`, ({ params }) => page(db.proposals.filter((p) => p.caseId === String(params.caseId)))),
  http.get(`${BASE}/cases/:caseId/proposals/:proposalId`, ({ params }) => {
    const p = db.proposals.find((x) => x.id === String(params.proposalId) && x.caseId === String(params.caseId))
    return p ? ok(p) : notFound()
  }),
  http.patch(`${BASE}/cases/:caseId/proposals/:proposalId`, async ({ params, request }) => {
    const prev = db.proposals.find((x) => x.id === String(params.proposalId) && x.caseId === String(params.caseId))
    if (!prev) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    const ver = requireExpectedVersion(body, prev)
    if (ver) return ver
    const payload = (body.payload ?? prev.payload) as Record<string, unknown>
    const now = new Date().toISOString()
    const revised = {
      ...prev,
      payload,
      payloadHash: stableHash(payload),
      proposalVersion: prev.proposalVersion + 1,
      supersedesProposalVersion: prev.proposalVersion,
      status: 'SUBMITTED' as const,
      version: prev.version + 1,
      updatedAt: now,
    }
    db.proposals.push(revised)
    // 旧版に結びついた確認待ちの Approval は無効になる
    for (const a of db.approvals.filter((x) => x.proposalId === prev.id && x.status === 'PENDING')) {
      a.status = 'EXPIRED'
      a.updatedAt = now
    }
    return ok(revised)
  }),
  http.post(`${BASE}/cases/:caseId/proposals/:proposalId/approval-requests`, async ({ params, request }) => {
    const p = db.proposals.find((x) => x.id === String(params.proposalId) && x.caseId === String(params.caseId))
    if (!p) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    const ver = requireExpectedVersion(body, p)
    if (ver) return ver
    const now = new Date().toISOString()
    const approval = {
      id: nextId('apr'),
      caseId: p.caseId,
      proposalId: p.id,
      proposalVersion: p.proposalVersion,
      payloadHash: p.payloadHash,
      status: 'PENDING' as const,
      applicationStatus: 'NOT_APPLIED' as const,
      applicationFailureReason: null,
      decidedByUserId: null,
      decidedAt: null,
      decisionNote: null,
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      assetDisposal: p.assetDisposal,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    db.approvals.push(approval)
    p.status = 'AWAITING_APPROVAL'
    p.updatedAt = now
    return ok(approval, 201)
  }),

  http.get(`${BASE}/cases/:caseId/approvals`, ({ params }) => page(db.approvals.filter((a) => a.caseId === String(params.caseId)))),
  http.get(`${BASE}/cases/:caseId/approvals/:approvalId`, ({ params }) => {
    const a = db.approvals.find((x) => x.id === String(params.approvalId) && x.caseId === String(params.caseId))
    return a ? ok(a) : notFound()
  }),
  http.post(`${BASE}/cases/:caseId/approvals/:approvalId/approve`, async ({ params, request }) => {
    const a = db.approvals.find((x) => x.id === String(params.approvalId) && x.caseId === String(params.caseId))
    if (!a) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    const ver = requireExpectedVersion(body, a)
    if (ver) return ver
    if (a.status !== 'PENDING') return fail('PRECONDITION_FAILED', 'すでに結論が出ています。', { reason: 'ALREADY_DECIDED' })
    if (body.payloadHash !== a.payloadHash) return fail('PRECONDITION_FAILED', '内容が更新されています。開き直してから、もう一度お試しください。', { reason: 'STALE_PAYLOAD' })
    const { applied, reason } = applyProposal(a.proposalId)
    const now = new Date().toISOString()
    a.status = 'APPROVED'
    a.applicationStatus = applied ? 'APPLIED' : 'FAILED'
    a.applicationFailureReason = applied ? null : (reason ?? '反映できませんでした。')
    a.decidedByUserId = SELF_PERSON_ID
    a.decidedAt = now
    a.decisionNote = typeof body.note === 'string' ? body.note : null
    a.version += 1
    a.updatedAt = now
    const proposal = db.proposals.find((p) => p.id === a.proposalId)
    if (proposal) {
      proposal.status = applied ? 'APPLIED' : proposal.status
      proposal.updatedAt = now
    }
    refreshAllTaskActions(a.caseId)
    return ok(a)
  }),
  http.post(`${BASE}/cases/:caseId/approvals/:approvalId/reject`, async ({ params, request }) => {
    const a = db.approvals.find((x) => x.id === String(params.approvalId) && x.caseId === String(params.caseId))
    if (!a) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    const ver = requireExpectedVersion(body, a)
    if (ver) return ver
    const now = new Date().toISOString()
    a.status = 'REJECTED'
    a.decidedByUserId = SELF_PERSON_ID
    a.decidedAt = now
    a.decisionNote = typeof body.note === 'string' ? body.note : null
    a.version += 1
    a.updatedAt = now
    const proposal = db.proposals.find((p) => p.id === a.proposalId)
    if (proposal) {
      proposal.status = 'REJECTED'
      proposal.updatedAt = now
    }
    return ok(a)
  }),

  /* ---------- Person ---------- */
  http.get(`${BASE}/cases/:caseId/persons`, ({ params }) => page(db.persons.filter((p) => p.caseId === String(params.caseId)))),
  http.post(`${BASE}/cases/:caseId/persons`, async ({ params, request }) => {
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as CreatePersonRequest
    const created: Person = {
      id: nextId('person'),
      caseId: String(params.caseId),
      name: body.name,
      nameKana: body.nameKana,
      relationship: body.relationship,
      role: body.role ?? 'RELATED',
      isHeir: body.isHeir ?? false,
      dateOfBirth: body.dateOfBirth,
      specialCircumstance: body.specialCircumstance ?? null,
      contact: body.contact,
      note: body.note,
      version: 1,
    }
    db.persons.push(created)
    refreshAllTaskActions(created.caseId)
    return ok(created, 201)
  }),
  http.patch(`${BASE}/cases/:caseId/persons/:id`, async ({ params, request }) => {
    const p = db.persons.find((x) => x.id === String(params.id) && x.caseId === String(params.caseId))
    if (!p) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as UpdatePersonRequest
    const ver = requireExpectedVersion(body, p)
    if (ver) return ver
    Object.assign(p, body, { version: p.version + 1 })
    return ok(p)
  }),
  http.post(`${BASE}/cases/:caseId/persons/:id/exclude`, async ({ params, request }) => {
    const p = db.persons.find((x) => x.id === String(params.id) && x.caseId === String(params.caseId))
    if (!p) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as ExcludePersonRequest
    const ver = requireExpectedVersion(body, p)
    if (ver) return ver
    p.excludedAt = new Date().toISOString()
    p.version += 1
    refreshAllTaskActions(p.caseId)
    return ok(p)
  }),
  http.post(`${BASE}/cases/:caseId/relationships`, async ({ params, request }) => {
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as CreateRelationshipRequest
    const created = { id: nextId('rel'), caseId: String(params.caseId), fromPersonId: body.fromPersonId, toPersonId: body.toPersonId, kind: body.kind, note: body.note, version: 1 }
    return ok(created, 201)
  }),

  /* ---------- 相続方法（Decision） ---------- */
  http.get(`${BASE}/cases/:caseId/inheritance-decisions`, ({ params }) => page(db.decisions.filter((d) => d.personId && db.persons.some((p) => p.id === d.personId && p.caseId === String(params.caseId))))),
  http.post(`${BASE}/cases/:caseId/inheritance-decisions/:personId`, async ({ params, request }) => {
    const personId = String(params.personId)
    if (!db.persons.some((p) => p.id === personId && p.caseId === String(params.caseId))) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as { method: InheritanceMethod | null; state: 'DRAFT' | 'REPORTED'; note?: string }
    const now = new Date().toISOString()
    let d = db.decisions.find((x) => x.personId === personId)
    if (!d) {
      d = { personId, method: null, state: 'DRAFT', confirmed: false, reportedByUserId: null, confirmedByUserId: null, confirmedAt: null, note: null, version: 0, updatedAt: now }
      db.decisions.push(d)
    }
    if (d.confirmed && body.state !== 'DRAFT') return fail('CONFLICT', 'すでに本人が確定しています。', { reason: 'ALREADY_CONFIRMED_BY_SELF' })
    d.method = body.method
    d.state = body.state
    d.confirmed = false
    d.reportedByUserId = SELF_PERSON_ID
    d.note = body.note ?? null
    d.version += 1
    d.updatedAt = now
    refreshAllTaskActions(String(params.caseId))
    return ok(d)
  }),
  http.post(`${BASE}/cases/:caseId/inheritance-decisions/:personId/confirm`, async ({ params, request }) => {
    const personId = String(params.personId)
    if (!db.persons.some((p) => p.id === personId && p.caseId === String(params.caseId))) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as { expectedVersion: number; method: InheritanceMethod; note?: string }
    const d = db.decisions.find((x) => x.personId === personId)
    if (!d) return fail('CONFLICT', '先に相続の方法を記録してください。', { reason: 'NOT_RECORDED' })
    const ver = requireExpectedVersion(body, d)
    if (ver) return ver
    const now = new Date().toISOString()
    d.method = body.method
    d.state = 'CONFIRMED'
    d.confirmed = true
    d.confirmedByUserId = SELF_PERSON_ID
    d.confirmedAt = now
    d.note = body.note ?? d.note
    d.version += 1
    d.updatedAt = now
    refreshAllTaskActions(String(params.caseId))
    return ok(d)
  }),

  /* ---------- Insight ---------- */
  http.get(`${BASE}/cases/:caseId/insights`, ({ params }) => page(db.insights.filter((i) => i.caseId === String(params.caseId)))),
  http.post(`${BASE}/cases/:caseId/insights/:id/acknowledge`, async ({ params, request }) => {
    const i = db.insights.find((x) => x.id === String(params.id) && x.caseId === String(params.caseId))
    if (!i) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = (await jsonBody(request)) as unknown as AcknowledgeInsightRequest
    i.status = 'ACKNOWLEDGED'
    i.statusUpdatedAt = new Date().toISOString()
    if (body.note) i.professionalReviewNote = body.note
    return ok(i)
  }),
  http.post(`${BASE}/cases/:caseId/insights/:id/dismiss`, async ({ params, request }) => {
    const i = db.insights.find((x) => x.id === String(params.id) && x.caseId === String(params.caseId))
    if (!i) return notFound()
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    await jsonBody(request)
    i.status = 'DISMISSED'
    i.statusUpdatedAt = new Date().toISOString()
    return ok(i)
  }),

  /* ---------- Chat ---------- */
  http.get(`${BASE}/cases/:caseId/messages`, ({ params }) => page(db.messages.filter((m) => m.caseId === String(params.caseId)))),
  http.post(`${BASE}/cases/:caseId/messages`, async ({ params, request }) => {
    const caseId = String(params.caseId)
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    const now = new Date().toISOString()
    const message: MessageResource = {
      id: nextId('msg'),
      caseId,
      role: 'user',
      body: String(body.body ?? ''),
      agentRunId: null,
      replyRunId: null,
      professionalNotice: false,
      escalationProposalId: null,
      createdAt: now,
    }
    db.messages.push(message)
    const runId = nextId('run')
    const accepted: MessageAcceptedResource = { message, runId, runAccepted: true, reason: null }
    setTimeout(() => {
      db.messages.push({
        id: nextId('msg'),
        caseId,
        role: 'assistant',
        body: 'ご相談ありがとうございます。個別の法律・税務判断が必要な内容については、専門家へのご相談をおすすめします。手続きの進め方については、引き続きこちらでご案内します。',
        agentRunId: runId,
        replyRunId: null,
        professionalNotice: true,
        escalationProposalId: null,
        createdAt: new Date().toISOString(),
      })
    }, 800)
    return HttpResponse.json({ data: accepted, meta: { requestId: crypto.randomUUID() } }, { status: 202 })
  }),

  /* ---------- Agent Run（自動調査の依頼） ---------- */
  http.post(`${BASE}/cases/:caseId/agent-runs`, async ({ params, request }) => {
    const caseId = String(params.caseId)
    const idem = requireIdempotencyKey(request)
    if (idem) return idem
    const body = await jsonBody(request)
    if (body.operation === 'document_analysis' && typeof body.targetId === 'string') {
      const doc = db.documents.find((d) => d.id === body.targetId && d.caseId === caseId)
      if (!doc) return notFound()
      if (!doc.analysis.canRequest) return fail('PRECONDITION_FAILED', 'いまは読み取りを依頼できません。')
      startAnalysis(doc)
      const run = db.agentRuns.find((r) => r.id === doc.analysis.agentRunId)
      return ok(run, 202)
    }
    return fail('FEATURE_NOT_CONNECTED', 'この環境ではまだ使えません。')
  }),
]

function me(): MeResource {
  return {
    userId: 'mock_user',
    tenantId: 'mock-tenant',
    registered: true,
    active: true,
    emailVerified: true,
    registeredAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
  }
}
