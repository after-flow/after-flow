import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { api, getAll, type Page } from './client'
import { isDocumentInProgress } from '@/lib/model/document'
import type {
  AgentOperationResource,
  AiCapabilitiesResource,
  Asset,
  Benefit,
  ConfirmEstateItemRequest,
  ConsentKind,
  ConsentStatusResource,
  Contract,
  ContractPolicy,
  ContractProgress,
  CreateAssetRequest,
  CreateBenefitRequest,
  CreateContractRequest,
  CreateLiabilityRequest,
  CreatePersonRequest,
  CreateRelationshipRequest,
  DocumentKind,
  DocumentResource,
  GuidanceResource,
  Insight,
  InheritanceDecisionResource,
  InheritanceMethod,
  Liability,
  MessageAcceptedResource,
  MessageResource,
  Person,
  ProposalResource,
  ApprovalResource,
  TaskCommandResource,
  TaskRequiredDocumentResource,
  TaskResource,
  UpdateAssetRequest,
  UpdateBenefitRequest,
  UpdateContractRequest,
  UpdateLiabilityRequest,
  UpdatePersonRequest,
} from '@aftercare/public-contracts'
import type { CaseOverviewResource, CaseProfileResource } from '@aftercare/public-contracts'
import type { CaseResource } from '@aftercare/public-contracts'
import type { AgentRunResource } from '@aftercare/public-contracts'

export const qk = {
  consents: ['consents'] as const,
  cases: ['cases'] as const,
  case: (caseId: string) => ['cases', caseId] as const,
  overview: (caseId: string) => ['cases', caseId, 'overview'] as const,
  documents: (caseId: string) => ['cases', caseId, 'documents'] as const,
  document: (caseId: string, documentId: string) => ['cases', caseId, 'documents', documentId] as const,
  documentContent: (caseId: string, documentId: string) => ['cases', caseId, 'documents', documentId, 'content'] as const,
  tasks: (caseId: string) => ['cases', caseId, 'tasks'] as const,
  task: (caseId: string, taskId: string) => ['cases', caseId, 'tasks', taskId] as const,
  taskGuidance: (caseId: string, taskId: string) => ['cases', caseId, 'tasks', taskId, 'guidance'] as const,
  assets: (caseId: string) => ['cases', caseId, 'assets'] as const,
  liabilities: (caseId: string) => ['cases', caseId, 'liabilities'] as const,
  contracts: (caseId: string) => ['cases', caseId, 'contracts'] as const,
  benefits: (caseId: string) => ['cases', caseId, 'benefits'] as const,
  proposals: (caseId: string) => ['cases', caseId, 'proposals'] as const,
  proposal: (caseId: string, proposalId: string) => ['cases', caseId, 'proposals', proposalId] as const,
  approvals: (caseId: string) => ['cases', caseId, 'approvals'] as const,
  approval: (caseId: string, approvalId: string) => ['cases', caseId, 'approvals', approvalId] as const,
  persons: (caseId: string) => ['cases', caseId, 'persons'] as const,
  decisions: (caseId: string) => ['cases', caseId, 'inheritance-decisions'] as const,
  messages: (caseId: string) => ['cases', caseId, 'messages'] as const,
  insights: (caseId: string) => ['cases', caseId, 'insights'] as const,
  agentRuns: (caseId: string) => ['cases', caseId, 'agent-runs'] as const,
  aiCapabilities: ['ai', 'capabilities'] as const,
}

type ListOpts<T> = Omit<UseQueryOptions<Page<T>>, 'queryKey' | 'queryFn'>

/** 自律調査の結果を待つ上限。これを過ぎたら追いかけるのをやめる。 */
export const RESEARCH_POLL_TIMEOUT_MS = 5 * 60_000
/** チャットの回答を待つ上限。 */
export const CHAT_REPLY_POLL_TIMEOUT_MS = 2 * 60_000

/* ---------- 同意 ---------- */

export function useConsents() {
  return useQuery({
    queryKey: qk.consents,
    queryFn: () => api.get<ConsentStatusResource>('/consents'),
    staleTime: 5 * 60_000,
  })
}

export function useAgreeConsents() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (agreements: { kind: ConsentKind; version: string }[]) =>
      api.post<ConsentStatusResource>('/consents', { agreements }),
    onSuccess: (status) => {
      qc.setQueryData(qk.consents, status)
    },
  })
}

/* ---------- Case ---------- */

export function useCases() {
  return useQuery({
    queryKey: qk.cases,
    queryFn: () => api.list<CaseResource>('/cases'),
  })
}

export function useCase(caseId: string) {
  return useQuery({
    queryKey: qk.case(caseId),
    queryFn: () => api.get<CaseResource>(`/cases/${caseId}`),
    enabled: Boolean(caseId),
  })
}

export function useCaseOverview(caseId: string) {
  return useQuery({
    queryKey: qk.overview(caseId),
    queryFn: () => api.get<CaseOverviewResource>(`/cases/${caseId}/overview`),
    enabled: Boolean(caseId),
    refetchInterval: 30_000,
  })
}

export interface CreateCaseInput {
  deceasedName: string
  deceasedNameKana?: string
  dateOfDeath: string
  dateOfBirth?: string
  knownAt?: string
  ownerName: string
  relationshipToDeceased: string
  /** 作成者本人を Person として同時登録する。isHeir=true で相続人候補。 */
  ownerPerson?: { isHeir: boolean }
}

export function useCreateCase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateCaseInput) => api.post<CaseResource>('/cases', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.cases })
    },
  })
}

/** 故人の状況の答え。省略した項目は Backend が UNKNOWN として保存する。 */
export type CaseProfileInput = Partial<Omit<CaseProfileResource, 'answeredAt'>> & { answeredAt: string }

/**
 * 市区町村・生年月日・故人の状況の登録。
 * `profile` は丸ごと置き換え（null で未回答に戻す）。Backend が答えにあわせて手続きを洗い出し直す。
 */
export function useUpdateCase(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    // dateOfBirth は null で「消す」。undefined だと送られず、前の値が残ってしまう
    // funeralCompletedAt も null で「まだ」に戻す
    mutationFn: (patch: {
      expectedVersion: number
      municipality?: string
      dateOfBirth?: string | null
      profile?: CaseProfileInput | null
      funeralCompletedAt?: string | null
    }) => api.patch<CaseResource>(`/cases/${caseId}`, patch),
    onSuccess: (updated) => {
      qc.setQueryData(qk.case(caseId), updated)
      // 故人の状況・日付が変わると、Backend が手続きを洗い出し直す
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
      void qc.invalidateQueries({ queryKey: qk.cases })
    },
  })
}

/* ---------- Document ---------- */

export function useDocuments(caseId: string, opts?: ListOpts<DocumentResource>) {
  return useQuery({
    queryKey: qk.documents(caseId),
    queryFn: () => api.list<DocumentResource>(`/cases/${caseId}/documents`),
    enabled: Boolean(caseId),
    ...opts,
  })
}

export function useDocument(caseId: string, documentId: string) {
  return useQuery({
    queryKey: qk.document(caseId, documentId),
    queryFn: () => api.get<DocumentResource>(`/cases/${caseId}/documents/${documentId}`),
    enabled: Boolean(caseId && documentId),
    // 保存中・検査中・解析中の書類は、終わるまで追いかける
    refetchInterval: (q) => (q.state.data && isDocumentInProgress(q.state.data) ? 3_000 : false),
  })
}

/**
 * 書類の原本（PDF・画像）。
 * 死亡診断書や戸籍などの個人情報そのものなので、画面を離れたらすぐ手放す（gcTime を短く）。
 * 見つからない・保存されていないなどの失敗は、何度叩いても変わらないため再試行しない。
 */
export function useDocumentContent(caseId: string, documentId: string | undefined) {
  return useQuery({
    queryKey: qk.documentContent(caseId, documentId ?? ''),
    queryFn: ({ signal }) => api.blob(`/cases/${caseId}/documents/${documentId}/content`, signal),
    enabled: Boolean(caseId && documentId),
    staleTime: Infinity,
    gcTime: 30_000,
    retry: false,
  })
}

export function useUploadDocument(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    // 失敗の理由（マイナンバー検知など）はアップロード画面が自分で出す
    meta: { handlesError: true },
    mutationFn: ({ file, kind }: { file: File; kind: DocumentKind }) => {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('kind', kind)
      return api.upload<DocumentResource>(`/cases/${caseId}/documents`, fd)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.documents(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
    },
  })
}

/** 一覧から外す（アーカイブ）。個人データの完全消去ではない。 */
export function useArchiveDocument(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ documentId, expectedVersion }: { documentId: string; expectedVersion: number }) =>
      api.post<DocumentResource>(`/cases/${caseId}/documents/${documentId}/archive`, { expectedVersion }),
    onSuccess: (doc) => {
      qc.setQueryData(qk.document(caseId, doc.id), doc)
      void qc.invalidateQueries({ queryKey: qk.documents(caseId) })
    },
  })
}

/** 解析（自動調査）を依頼する。ローカルでは 501 FEATURE_NOT_CONNECTED になりうるので画面側で無視する。 */
export function useRequestDocumentAnalysis(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    meta: { handlesError: true },
    mutationFn: (documentId: string) =>
      api.post<AgentRunResource>(`/cases/${caseId}/agent-runs`, {
        operation: 'document_analysis' satisfies AgentOperationResource,
        targetType: 'DOCUMENT',
        targetId: documentId,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.documents(caseId) })
    },
  })
}

/* ---------- Task / Deadline ---------- */

export function useTasks(caseId: string) {
  return useQuery({
    queryKey: qk.tasks(caseId),
    queryFn: () => api.list<TaskResource>(`/cases/${caseId}/tasks`),
    enabled: Boolean(caseId),
  })
}

export function useTask(caseId: string, taskId: string) {
  return useQuery({
    queryKey: qk.task(caseId, taskId),
    queryFn: () => api.get<TaskResource>(`/cases/${caseId}/tasks/${taskId}`),
    enabled: Boolean(caseId && taskId),
  })
}

/** guidance は Task から独立したリソース（GET は未依頼でも 200 { status: 'NOT_REQUESTED' } を返す）。 */
export function useTaskGuidance(caseId: string, taskId: string) {
  return useQuery({
    queryKey: qk.taskGuidance(caseId, taskId),
    queryFn: () => api.get<GuidanceResource>(`/cases/${caseId}/tasks/${taskId}/guidance`),
    enabled: Boolean(caseId && taskId),
    refetchInterval: (q) => {
      const status = q.state.data?.status
      if (status !== 'RESEARCHING' && status !== 'WAITING') return false
      const updatedAt = q.state.data?.updatedAt ? new Date(q.state.data.updatedAt).getTime() : null
      if (updatedAt && Date.now() - updatedAt > RESEARCH_POLL_TIMEOUT_MS) return false
      return 3_000
    },
  })
}

export function useRequestGuidance(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    meta: { handlesError: true },
    mutationFn: (taskId: string) =>
      api.post<GuidanceResource>(`/cases/${caseId}/tasks/${taskId}/guidance/requests`, {}),
    onSuccess: (guidance, taskId) => {
      qc.setQueryData(qk.taskGuidance(caseId, taskId), guidance)
    },
  })
}

function useTaskMutation<TInput>(caseId: string, fn: (input: TInput) => Promise<TaskResource>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (task) => {
      qc.setQueryData(qk.task(caseId, task.id), task)
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
      // 手続きが動いたら「止まっています」の知らせは片づく
      void qc.invalidateQueries({ queryKey: qk.insights(caseId) })
    },
  })
}

/** 状態を変える唯一の入口。allowedActions から出したボタンだけが呼ぶ。 */
export function useRunTaskCommand(caseId: string) {
  return useTaskMutation<{ taskId: string; command: TaskCommandResource; expectedVersion: number; note?: string }>(
    caseId,
    ({ taskId, ...body }) => api.post<TaskResource>(`/cases/${caseId}/tasks/${taskId}/commands`, body),
  )
}

/** 説明・担当・持ち物の訂正（status はここから変更できない）。 */
export function useUpdateTask(caseId: string) {
  return useTaskMutation<{
    taskId: string
    expectedVersion: number
    title?: string
    summary?: string
    submitTo?: string | null
    assigneeId?: string | null
    requiredDocuments?: { id: string; label: string; documentId: string | null }[]
  }>(caseId, ({ taskId, ...body }) => api.patch<TaskResource>(`/cases/${caseId}/tasks/${taskId}`, body))
}

/**
 * 持ち物の「用意できた」を付け外しする。
 * 窓口で1つずつ消し込む使い方を想定し、押した瞬間に画面へ反映する（失敗したら元に戻す）。
 *
 * 注: `TaskRequiredDocumentResource` に `collected` は無い（BE ユニット2待ち。§6リスク）。
 * それまでは `documentId != null` を「用意できた」の代わりに使う（呼び出し側の暫定）。
 */
export function useUpdateRequiredDocuments(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      taskId,
      expectedVersion,
      requiredDocuments,
    }: {
      taskId: string
      expectedVersion: number
      requiredDocuments: TaskRequiredDocumentResource[]
    }) =>
      api.patch<TaskResource>(`/cases/${caseId}/tasks/${taskId}`, {
        expectedVersion,
        requiredDocuments: requiredDocuments.map((r) => ({ id: r.id, label: r.label, documentId: r.documentId, collected: r.collected })),
      }),
    scope: { id: `required-documents-${caseId}` },
    onMutate: async ({ taskId, requiredDocuments }) => {
      await qc.cancelQueries({ queryKey: qk.task(caseId, taskId) })
      const before = qc.getQueryData<TaskResource>(qk.task(caseId, taskId))
      if (before) qc.setQueryData<TaskResource>(qk.task(caseId, taskId), { ...before, requiredDocuments })
      return { before }
    },
    onError: (_e, { taskId }, ctx) => {
      if (ctx?.before) qc.setQueryData(qk.task(caseId, taskId), ctx.before)
    },
    onSuccess: (task) => {
      qc.setQueryData(qk.task(caseId, task.id), task)
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
    },
  })
}

export interface CreateTaskInput {
  title: string
  summary?: string
  stage: TaskResource['stage']
  category: string
  submitTo?: string
  evidenceRequired?: boolean
}

export function useCreateTask(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateTaskInput) => api.post<TaskResource>(`/cases/${caseId}/tasks`, input),
    onSuccess: (task) => {
      qc.setQueryData(qk.task(caseId, task.id), task)
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
    },
  })
}

export function useAddEvidence(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      taskId,
      ...body
    }: {
      taskId: string
      label: string
      kind: TaskResource['evidences'][number]['kind']
      note?: string
      documentId?: string
    }) => api.post<TaskResource>(`/cases/${caseId}/tasks/${taskId}/evidences`, body),
    onSuccess: (task) => {
      qc.setQueryData(qk.task(caseId, task.id), task)
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
    },
  })
}

/* ---------- Asset / Liability / Contract / Benefit ---------- */

export function useAssets(caseId: string) {
  return useQuery({
    queryKey: qk.assets(caseId),
    queryFn: () => api.list<Asset>(`/cases/${caseId}/assets`),
    enabled: Boolean(caseId),
  })
}

export function useLiabilities(caseId: string) {
  return useQuery({
    queryKey: qk.liabilities(caseId),
    queryFn: () => api.list<Liability>(`/cases/${caseId}/liabilities`),
    enabled: Boolean(caseId),
  })
}

export function useContracts(caseId: string) {
  return useQuery({
    queryKey: qk.contracts(caseId),
    queryFn: () => api.list<Contract>(`/cases/${caseId}/contracts`),
    enabled: Boolean(caseId),
  })
}

export function useBenefits(caseId: string) {
  return useQuery({
    queryKey: qk.benefits(caseId),
    queryFn: () => api.list<Benefit>(`/cases/${caseId}/benefits`),
    enabled: Boolean(caseId),
  })
}

export function useCreateAsset(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateAssetRequest) => api.post<Asset>(`/cases/${caseId}/assets`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.assets(caseId) }),
  })
}

export function useUpdateAsset(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateAssetRequest & { id: string }) => api.patch<Asset>(`/cases/${caseId}/assets/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.assets(caseId) }),
  })
}

export function useConfirmAsset(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: ConfirmEstateItemRequest & { id: string }) =>
      api.post<Asset>(`/cases/${caseId}/assets/${id}/confirm`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.assets(caseId) }),
  })
}

export function useCreateLiability(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateLiabilityRequest) => api.post<Liability>(`/cases/${caseId}/liabilities`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.liabilities(caseId) }),
  })
}

export function useUpdateLiability(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateLiabilityRequest & { id: string }) =>
      api.patch<Liability>(`/cases/${caseId}/liabilities/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.liabilities(caseId) }),
  })
}

export function useConfirmLiability(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: ConfirmEstateItemRequest & { id: string }) =>
      api.post<Liability>(`/cases/${caseId}/liabilities/${id}/confirm`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.liabilities(caseId) }),
  })
}

export function useCreateContract(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateContractRequest) => api.post<Contract>(`/cases/${caseId}/contracts`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.contracts(caseId) }),
  })
}

export function useUpdateContract(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateContractRequest & { id: string }) =>
      api.patch<Contract>(`/cases/${caseId}/contracts/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.contracts(caseId) }),
  })
}

export function useSetContractPolicy(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, expectedVersion, policy, note }: { id: string; expectedVersion: number; policy: ContractPolicy; note?: string }) =>
      api.post<Contract>(`/cases/${caseId}/contracts/${id}/policy`, { expectedVersion, policy, note }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.contracts(caseId) }),
  })
}

export function useReportContractProgress(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      expectedVersion,
      progress,
      note,
    }: {
      id: string
      expectedVersion: number
      progress: ContractProgress
      note?: string
    }) => api.post<Contract>(`/cases/${caseId}/contracts/${id}/progress`, { expectedVersion, progress, note }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.contracts(caseId) }),
  })
}

export function useCreateBenefit(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateBenefitRequest) => api.post<Benefit>(`/cases/${caseId}/benefits`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.benefits(caseId) }),
  })
}

export function useUpdateBenefit(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateBenefitRequest & { id: string }) =>
      api.patch<Benefit>(`/cases/${caseId}/benefits/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.benefits(caseId) }),
  })
}

export function useReportBenefitProgress(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      expectedVersion,
      progress,
      note,
    }: {
      id: string
      expectedVersion: number
      progress: ContractProgress
      note?: string
    }) => api.post<Benefit>(`/cases/${caseId}/benefits/${id}/progress`, { expectedVersion, progress, note }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.benefits(caseId) }),
  })
}

/* ---------- Proposal / Approval ---------- */

export function useProposals(caseId: string) {
  return useQuery({
    queryKey: qk.proposals(caseId),
    queryFn: () => getAll<ProposalResource>(`/cases/${caseId}/proposals`),
    enabled: Boolean(caseId),
  })
}

export function useProposal(caseId: string, proposalId: string | undefined) {
  return useQuery({
    queryKey: qk.proposal(caseId, proposalId ?? ''),
    queryFn: () => api.get<ProposalResource>(`/cases/${caseId}/proposals/${proposalId}`),
    enabled: Boolean(caseId && proposalId),
  })
}

export function useApprovals(caseId: string) {
  return useQuery({
    queryKey: qk.approvals(caseId),
    queryFn: () => getAll<ApprovalResource>(`/cases/${caseId}/approvals`),
    enabled: Boolean(caseId),
  })
}

export function useApproval(caseId: string, approvalId: string) {
  return useQuery({
    queryKey: qk.approval(caseId, approvalId),
    queryFn: () => api.get<ApprovalResource>(`/cases/${caseId}/approvals/${approvalId}`),
    enabled: Boolean(caseId && approvalId),
  })
}

/** 訂正。既存の版は書き換えず、新しい版（proposalVersion+1）を作る。旧 Approval は EXPIRED になる。 */
export function useReviseProposal(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ proposalId, expectedVersion, payload }: { proposalId: string; expectedVersion: number; payload: Record<string, unknown> }) =>
      api.patch<ProposalResource>(`/cases/${caseId}/proposals/${proposalId}`, { expectedVersion, payload }),
    onSuccess: (proposal) => {
      qc.setQueryData(qk.proposal(caseId, proposal.id), proposal)
      void qc.invalidateQueries({ queryKey: qk.proposals(caseId) })
    },
  })
}

export function useRequestApproval(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ proposalId, expectedVersion }: { proposalId: string; expectedVersion: number }) =>
      api.post<ApprovalResource>(`/cases/${caseId}/proposals/${proposalId}/approval-requests`, { expectedVersion }),
    onSuccess: (approval) => {
      qc.setQueryData(qk.approval(caseId, approval.id), approval)
      void qc.invalidateQueries({ queryKey: qk.approvals(caseId) })
    },
  })
}

/**
 * 承認は「提案内容をケースの情報として反映してよいか」の確認であり、
 * 外部機関への提出・送信・解約の実行許可ではない。
 */
export function useApproveProposal(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      approvalId,
      expectedVersion,
      proposalVersion,
      payloadHash,
      note,
    }: {
      approvalId: string
      expectedVersion: number
      proposalVersion: number
      payloadHash: string
      note?: string
    }) => api.post<ApprovalResource>(`/cases/${caseId}/approvals/${approvalId}/approve`, { expectedVersion, proposalVersion, payloadHash, note }),
    onSuccess: (approval) => {
      qc.setQueryData(qk.approval(caseId, approval.id), approval)
      void qc.invalidateQueries({ queryKey: qk.approvals(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      void qc.invalidateQueries({ queryKey: qk.assets(caseId) })
      void qc.invalidateQueries({ queryKey: qk.liabilities(caseId) })
      void qc.invalidateQueries({ queryKey: qk.contracts(caseId) })
      void qc.invalidateQueries({ queryKey: qk.persons(caseId) })
      void qc.invalidateQueries({ queryKey: qk.documents(caseId) })
    },
  })
}

export function useRejectProposal(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ approvalId, expectedVersion, note }: { approvalId: string; expectedVersion: number; note?: string }) =>
      api.post<ApprovalResource>(`/cases/${caseId}/approvals/${approvalId}/reject`, { expectedVersion, note }),
    onSuccess: (approval) => {
      qc.setQueryData(qk.approval(caseId, approval.id), approval)
      void qc.invalidateQueries({ queryKey: qk.approvals(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
    },
  })
}

/* ---------- Person ---------- */

export function usePersons(caseId: string) {
  return useQuery({
    queryKey: qk.persons(caseId),
    queryFn: () => getAll<Person>(`/cases/${caseId}/persons`),
    enabled: Boolean(caseId),
  })
}

export function useCreatePerson(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreatePersonRequest) => api.post<Person>(`/cases/${caseId}/persons`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.persons(caseId) })
      void qc.invalidateQueries({ queryKey: qk.insights(caseId) })
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
    },
  })
}

export function useUpdatePerson(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdatePersonRequest & { id: string }) => api.patch<Person>(`/cases/${caseId}/persons/${id}`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.persons(caseId) })
      void qc.invalidateQueries({ queryKey: qk.insights(caseId) })
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
    },
  })
}

/** 一覧から外す（記録は残る）。完全削除ではない。 */
export function useExcludePerson(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, expectedVersion, reason }: { id: string; expectedVersion: number; reason?: string }) =>
      api.post<Person>(`/cases/${caseId}/persons/${id}/exclude`, { expectedVersion, reason }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.persons(caseId) })
      void qc.invalidateQueries({ queryKey: qk.insights(caseId) })
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
    },
  })
}

export function useCreateRelationship(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateRelationshipRequest) => api.post(`/cases/${caseId}/relationships`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.persons(caseId) }),
  })
}

/**
 * 相続方法（Decision）。record（下書き・報告）→ confirm（本人による確定）の2段。
 * 放棄前ロックの解除条件になるため、AI からは更新しない。
 */
export function useInheritanceDecisions(caseId: string) {
  return useQuery({
    queryKey: qk.decisions(caseId),
    queryFn: () => getAll<InheritanceDecisionResource>(`/cases/${caseId}/inheritance-decisions`),
    enabled: Boolean(caseId),
  })
}

export function useRecordDecision(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      personId,
      method,
      state,
      note,
    }: {
      personId: string
      method: InheritanceMethod | null
      state: 'DRAFT' | 'REPORTED'
      note?: string
    }) => api.post<InheritanceDecisionResource>(`/cases/${caseId}/inheritance-decisions/${personId}`, { method, state, note }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.decisions(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      void qc.invalidateQueries({ queryKey: qk.insights(caseId) })
    },
  })
}

export function useConfirmDecision(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      personId,
      expectedVersion,
      method,
      note,
    }: {
      personId: string
      expectedVersion: number
      method: InheritanceMethod
      note?: string
    }) =>
      api.post<InheritanceDecisionResource>(`/cases/${caseId}/inheritance-decisions/${personId}/confirm`, {
        expectedVersion,
        method,
        note,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.decisions(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      void qc.invalidateQueries({ queryKey: qk.insights(caseId) })
    },
  })
}

/**
 * 本人が方法を選んだときの1手：record（REPORTED）してから、その版で confirm する。
 * confirm が assertSelf で 403 のときは「本人として確定できません」を呼び出し側が文言化する。
 */
export function useRecordAndConfirmDecision(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ personId, method, note }: { personId: string; method: InheritanceMethod; note?: string }) => {
      const recorded = await api.post<InheritanceDecisionResource>(`/cases/${caseId}/inheritance-decisions/${personId}`, {
        method,
        state: 'REPORTED',
        note,
      })
      return api.post<InheritanceDecisionResource>(`/cases/${caseId}/inheritance-decisions/${personId}/confirm`, {
        expectedVersion: recorded.version,
        method,
        note,
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.decisions(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      void qc.invalidateQueries({ queryKey: qk.insights(caseId) })
    },
  })
}

/* ---------- Insight（AIが気づいたこと） ---------- */

export function useInsights(caseId: string) {
  return useQuery({
    queryKey: qk.insights(caseId),
    queryFn: () => getAll<Insight>(`/cases/${caseId}/insights`),
    enabled: Boolean(caseId),
    refetchInterval: 60_000,
  })
}

export function useAcknowledgeInsight(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      api.post<Insight>(`/cases/${caseId}/insights/${id}/acknowledge`, { note }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.insights(caseId) }),
  })
}

export function useDismissInsight(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<Insight>(`/cases/${caseId}/insights/${id}/dismiss`, { reason }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.insights(caseId) }),
  })
}

/* ---------- AI の接続状況 ---------- */

/**
 * AI機能ごとの利用可否。判定するのは Backend で、AI Server へは問い合わせない。
 *
 * 取れない間（読み込み中・失敗）は「使えない」と決めつけない。接続済みの
 * 環境で入口を消してしまうより、送ったあとの受付結果で理由を示す方が safe。
 */
export function useAiCapabilities() {
  return useQuery({
    queryKey: qk.aiCapabilities,
    queryFn: () => api.get<AiCapabilitiesResource>('/ai/capabilities'),
    staleTime: 5 * 60_000,
  })
}

/* ---------- Chat ---------- */

export function useMessages(caseId: string, opts?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: qk.messages(caseId),
    queryFn: () => getAll<MessageResource>(`/cases/${caseId}/messages`),
    enabled: Boolean(caseId),
    ...opts,
  })
}

/** 202 で受け付ける。回答は履歴の再取得（呼び出し側の refetchInterval）で確認する。 */
export function useSendMessage(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: string) => api.post<MessageAcceptedResource>(`/cases/${caseId}/messages`, { body }),
    onSuccess: (accepted) => {
      qc.setQueryData<MessageResource[]>(qk.messages(caseId), (prev) => [...(prev ?? []), accepted.message])
      void qc.invalidateQueries({ queryKey: qk.approvals(caseId) })
    },
  })
}
