import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query'
import { api } from './client'
import type {
  Approval,
  Asset,
  Benefit,
  Case,
  CaseDocument,
  CaseProfile,
  CaseOverview,
  ChatMessage,
  ConsentKind,
  ConsentStatus,
  Contract,
  DeadlineSummary,
  Evidence,
  InheritanceMethod,
  Insight,
  Liability,
  Paginated,
  Person,
  RequiredDocument,
  Task,
  TaskStatus,
} from '@aftercare/public-contracts'

export const qk = {
  consents: ['consents'] as const,
  cases: ['cases'] as const,
  case: (id: string) => ['cases', id] as const,
  overview: (id: string) => ['cases', id, 'overview'] as const,
  documents: (id: string) => ['cases', id, 'documents'] as const,
  document: (id: string) => ['documents', id] as const,
  // ['documents'] の下に置かない。読み取りが終わるたびに ['documents'] ごと取り直すため、原本まで再取得されてしまう
  documentContent: (id: string) => ['document-content', id] as const,
  tasks: (id: string) => ['cases', id, 'tasks'] as const,
  task: (id: string) => ['tasks', id] as const,
  deadlines: (id: string) => ['cases', id, 'deadlines'] as const,
  assets: (id: string) => ['cases', id, 'assets'] as const,
  liabilities: (id: string) => ['cases', id, 'liabilities'] as const,
  contracts: (id: string) => ['cases', id, 'contracts'] as const,
  benefits: (id: string) => ['cases', id, 'benefits'] as const,
  approvals: (id: string) => ['cases', id, 'approvals'] as const,
  approval: (id: string) => ['approvals', id] as const,
  persons: (id: string) => ['cases', id, 'persons'] as const,
  messages: (id: string) => ['cases', id, 'messages'] as const,
  insights: (id: string) => ['cases', id, 'insights'] as const,
  agentRuns: (id: string) => ['cases', id, 'agent-runs'] as const,
}

type ListOpts<T> = Omit<UseQueryOptions<Paginated<T>>, 'queryKey' | 'queryFn'>

/** 自律調査の結果を待つ上限。これを過ぎたら追いかけるのをやめる。 */
export const RESEARCH_POLL_TIMEOUT_MS = 5 * 60_000

/* ---------- 同意 ---------- */

export function useConsents() {
  return useQuery({
    queryKey: qk.consents,
    queryFn: () => api.get<ConsentStatus>('/consents'),
    staleTime: 5 * 60_000,
  })
}

export function useAgreeConsents() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (agreements: { kind: ConsentKind; version: string }[]) =>
      api.post<ConsentStatus>('/consents', { agreements }),
    onSuccess: (status) => {
      qc.setQueryData(qk.consents, status)
    },
  })
}

/* ---------- Case ---------- */

export function useCases() {
  return useQuery({
    queryKey: qk.cases,
    queryFn: () => api.get<Paginated<Case>>('/cases'),
  })
}

export function useCase(caseId: string) {
  return useQuery({
    queryKey: qk.case(caseId),
    queryFn: () => api.get<Case>(`/cases/${caseId}`),
    enabled: Boolean(caseId),
  })
}

export function useCaseOverview(caseId: string) {
  return useQuery({
    queryKey: qk.overview(caseId),
    queryFn: () => api.get<CaseOverview>(`/cases/${caseId}/overview`),
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
}

export function useCreateCase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateCaseInput) => api.post<Case>('/cases', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.cases })
    },
  })
}

/** 市区町村・生年月日・故人の状況の登録。市区町村は自治体ごとの案内を調べる前提、状況は手続きの洗い出しの前提になる。 */
export function useUpdateCase(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    // dateOfBirth は null で「消す」。undefined だと送られず、前の値が残ってしまう
    mutationFn: (patch: { municipality?: string; dateOfBirth?: string | null; profile?: CaseProfile }) =>
      api.patch<Case>(`/cases/${caseId}`, patch),
    onSuccess: () => {
      // 故人の状況が変わると、Rule Engine があてはまる手続きを洗い出し直す
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      void qc.invalidateQueries({ queryKey: qk.deadlines(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
      void qc.invalidateQueries({ queryKey: qk.case(caseId) })
      void qc.invalidateQueries({ queryKey: qk.cases })
    },
  })
}

/**
 * 手順案内の自律調査を依頼する。
 *
 * 実行するのはエージェント側で、ここでは起動を伝えるだけ。
 * 結果は Task.guidance に反映されるため、完了まで対象タスクを再取得する。
 */
export function useRequestGuidanceResearch(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) =>
      api.post<Task>(`/tasks/${taskId}/guidance/research`, {}),
    onSuccess: (task) => {
      qc.setQueryData(qk.task(task.id), task)
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
    },
  })
}

/* ---------- Document ---------- */

export function useDocuments(caseId: string, opts?: ListOpts<CaseDocument>) {
  return useQuery({
    queryKey: qk.documents(caseId),
    queryFn: () => api.get<Paginated<CaseDocument>>(`/cases/${caseId}/documents`),
    enabled: Boolean(caseId),
    ...opts,
  })
}

export function useDocument(documentId: string) {
  return useQuery({
    queryKey: qk.document(documentId),
    queryFn: () => api.get<CaseDocument>(`/documents/${documentId}`),
    enabled: Boolean(documentId),
    // 読み取り中に開いた詳細画面が「読み取っています」のまま止まらないよう、終わるまで追いかける
    refetchInterval: (q) => (q.state.data?.analysisStatus === 'ANALYZING' ? 3_000 : false),
  })
}

/**
 * 書類の原本（PDF・画像）。
 * 死亡診断書や戸籍などの個人情報そのものなので、画面を離れたらすぐ手放す（gcTime を短く）。
 * 見つからない・保存されていないなどの失敗は、何度叩いても変わらないため再試行しない。
 */
export function useDocumentContent(caseId: string, documentId: string | undefined) {
  return useQuery({
    queryKey: qk.documentContent(documentId ?? ''),
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
    mutationFn: (file: File) => {
      const fd = new FormData()
      fd.append('file', file)
      return api.upload<CaseDocument>(`/cases/${caseId}/documents`, fd)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.documents(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
    },
  })
}

export function useDeleteDocument(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (documentId: string) => api.delete<void>(`/documents/${documentId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.documents(caseId) })
    },
  })
}

/* ---------- Task / Deadline ---------- */

export function useTasks(caseId: string) {
  return useQuery({
    queryKey: qk.tasks(caseId),
    queryFn: () => api.get<Paginated<Task>>(`/cases/${caseId}/tasks`),
    enabled: Boolean(caseId),
  })
}

export function useTask(taskId: string) {
  return useQuery({
    queryKey: qk.task(taskId),
    queryFn: () => api.get<Task>(`/tasks/${taskId}`),
    enabled: Boolean(taskId),
    /*
      自律調査が走っている間は結果を追いかける。
      ただしサーバー側が状態を更新できずに終わった場合、
      画面を開いたままだと永久に叩き続けてしまうため、開始からの経過で打ち切る。
    */
    refetchInterval: (q) => {
      const research = q.state.data?.guidance?.research
      if (research?.status !== 'RESEARCHING') return false
      const startedAt = research.startedAt ? new Date(research.startedAt).getTime() : null
      if (startedAt && Date.now() - startedAt > RESEARCH_POLL_TIMEOUT_MS) return false
      return 2_000
    },
  })
}

export function useDeadlines(caseId: string) {
  return useQuery({
    queryKey: qk.deadlines(caseId),
    queryFn: () => api.get<Paginated<DeadlineSummary>>(`/cases/${caseId}/deadlines`),
    enabled: Boolean(caseId),
  })
}

function useTaskMutation<TInput>(
  caseId: string,
  fn: (input: TInput) => Promise<Task>,
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (task) => {
      qc.setQueryData(qk.task(task.id), task)
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
      void qc.invalidateQueries({ queryKey: qk.deadlines(caseId) })
      // 手続きが動いたら「止まっています」の知らせは片づく
      void qc.invalidateQueries({ queryKey: qk.insights(caseId) })
    },
  })
}

export function useUpdateTaskStatus(caseId: string) {
  return useTaskMutation<{ taskId: string; status: TaskStatus }>(caseId, ({ taskId, status }) =>
    api.patch<Task>(`/tasks/${taskId}`, { status }),
  )
}

export function useCompleteTask(caseId: string) {
  return useTaskMutation<{ taskId: string; confirmedBySelf: true }>(caseId, ({ taskId }) =>
    api.post<Task>(`/tasks/${taskId}/complete`, { confirmedBySelf: true }),
  )
}

export function useReopenTask(caseId: string) {
  return useTaskMutation<{ taskId: string }>(caseId, ({ taskId }) =>
    api.post<Task>(`/tasks/${taskId}/reopen`),
  )
}

/**
 * 持ち物の「用意できた」を付け外しする。
 * 窓口で1つずつ消し込む使い方を想定し、押した瞬間に画面へ反映する（失敗したら元に戻す）。
 */
export function useUpdateRequiredDocuments(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, requiredDocuments }: { taskId: string; requiredDocuments: RequiredDocument[] }) =>
      api.patch<Task>(`/tasks/${taskId}`, { requiredDocuments }),
    // 続けて押しても、送る順番と画面の状態が入れ違わないよう1つずつ送る
    scope: { id: `required-documents-${caseId}` },
    onMutate: async ({ taskId, requiredDocuments }) => {
      await qc.cancelQueries({ queryKey: qk.task(taskId) })
      const before = qc.getQueryData<Task>(qk.task(taskId))
      if (before) qc.setQueryData<Task>(qk.task(taskId), { ...before, requiredDocuments })
      return { before }
    },
    onError: (_e, { taskId }, ctx) => {
      if (ctx?.before) qc.setQueryData(qk.task(taskId), ctx.before)
    },
    onSuccess: (task) => {
      qc.setQueryData(qk.task(task.id), task)
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      void qc.invalidateQueries({ queryKey: qk.insights(caseId) })
    },
  })
}

/** 担当者を決める。家族で手分けするときに使う。null で「未定」に戻す。 */
export function useAssignTask(caseId: string) {
  return useTaskMutation<{ taskId: string; assigneeId: string | null }>(caseId, ({ taskId, assigneeId }) =>
    api.patch<Task>(`/tasks/${taskId}`, { assigneeId }),
  )
}

export interface CreateTaskInput {
  title: string
  summary: string
  category: string
  submitTo?: string
}

export function useCreateTask(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateTaskInput) => api.post<Task>(`/cases/${caseId}/tasks`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
    },
  })
}

export function useAddEvidence(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, ...body }: { taskId: string; label: string; kind: Evidence['kind']; note?: string }) =>
      api.post<Evidence>(`/tasks/${taskId}/evidences`, body),
    onSuccess: (_e, vars) => {
      void qc.invalidateQueries({ queryKey: qk.task(vars.taskId) })
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
    },
  })
}

/* ---------- Asset / Liability / Contract / Benefit ---------- */

export function useAssets(caseId: string) {
  return useQuery({
    queryKey: qk.assets(caseId),
    queryFn: () => api.get<Paginated<Asset>>(`/cases/${caseId}/assets`),
    enabled: Boolean(caseId),
  })
}

export function useLiabilities(caseId: string) {
  return useQuery({
    queryKey: qk.liabilities(caseId),
    queryFn: () => api.get<Paginated<Liability>>(`/cases/${caseId}/liabilities`),
    enabled: Boolean(caseId),
  })
}

export function useContracts(caseId: string) {
  return useQuery({
    queryKey: qk.contracts(caseId),
    queryFn: () => api.get<Paginated<Contract>>(`/cases/${caseId}/contracts`),
    enabled: Boolean(caseId),
  })
}

export function useBenefits(caseId: string) {
  return useQuery({
    queryKey: qk.benefits(caseId),
    queryFn: () => api.get<Paginated<Benefit>>(`/cases/${caseId}/benefits`),
    enabled: Boolean(caseId),
  })
}

export function useCreateAsset(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Partial<Asset>) => api.post<Asset>(`/cases/${caseId}/assets`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.assets(caseId) }),
  })
}

export function useUpdateAsset(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    // amount は null で「消す」（分からなくなった・間違えて入れた場合）
    mutationFn: ({
      id,
      ...patch
    }: Omit<Partial<Asset>, 'amount' | 'institution'> & { id: string; amount?: number | null; institution?: string | null }) =>
      api.patch<Asset>(`/assets/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.assets(caseId) }),
  })
}

export function useCreateLiability(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Partial<Liability>) =>
      api.post<Liability>(`/cases/${caseId}/liabilities`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.liabilities(caseId) }),
  })
}

export function useUpdateLiability(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: Omit<Partial<Liability>, 'amount' | 'creditor'> & { id: string; amount?: number | null; creditor?: string | null }) =>
      api.patch<Liability>(`/liabilities/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.liabilities(caseId) }),
  })
}

export function useCreateContract(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Partial<Contract>) =>
      api.post<Contract>(`/cases/${caseId}/contracts`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.contracts(caseId) }),
  })
}

export function useUpdateContract(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    // provider は null で「消す」
    mutationFn: ({ id, ...patch }: Omit<Partial<Contract>, 'provider'> & { id: string; provider?: string | null }) =>
      api.patch<Contract>(`/contracts/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.contracts(caseId) }),
  })
}

export function useUpdateBenefit(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: Partial<Benefit> & { id: string }) =>
      api.patch<Benefit>(`/benefits/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.benefits(caseId) }),
  })
}

/* ---------- Approval ---------- */

export function useApprovals(caseId: string) {
  return useQuery({
    queryKey: qk.approvals(caseId),
    queryFn: () => api.get<Paginated<Approval>>(`/cases/${caseId}/approvals`),
    enabled: Boolean(caseId),
  })
}

export function useApproval(approvalId: string) {
  return useQuery({
    queryKey: qk.approval(approvalId),
    queryFn: () => api.get<Approval>(`/approvals/${approvalId}`),
    enabled: Boolean(approvalId),
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
      edits,
      note,
    }: {
      approvalId: string
      edits?: Record<string, string>
      note?: string
    }) => api.post<Approval>(`/approvals/${approvalId}/approve`, { edits, note }),
    onSuccess: (approval) => {
      qc.setQueryData(qk.approval(approval.id), approval)
      void qc.invalidateQueries({ queryKey: qk.approvals(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      void qc.invalidateQueries({ queryKey: qk.assets(caseId) })
      void qc.invalidateQueries({ queryKey: qk.liabilities(caseId) })
      void qc.invalidateQueries({ queryKey: qk.contracts(caseId) })
    },
  })
}

export function useRejectProposal(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ approvalId, note }: { approvalId: string; note?: string }) =>
      api.post<Approval>(`/approvals/${approvalId}/reject`, { note }),
    onSuccess: (approval) => {
      qc.setQueryData(qk.approval(approval.id), approval)
      void qc.invalidateQueries({ queryKey: qk.approvals(caseId) })
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
    },
  })
}

/* ---------- Person ---------- */

export function usePersons(caseId: string) {
  return useQuery({
    queryKey: qk.persons(caseId),
    queryFn: () => api.get<Paginated<Person>>(`/cases/${caseId}/persons`),
    enabled: Boolean(caseId),
  })
}

export function useCreatePerson(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Partial<Person>) => api.post<Person>(`/cases/${caseId}/persons`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.persons(caseId) })
      // 相続人が増えた・減ったなどの前提の変化は、気づきとして届く。担当者の表示も変わりうる
      void qc.invalidateQueries({ queryKey: qk.insights(caseId) })
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
    },
  })
}

export function useUpdatePerson(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: Partial<Person> & { id: string }) =>
      api.patch<Person>(`/persons/${id}`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.persons(caseId) })
      // 相続人が増えた・減ったなどの前提の変化は、気づきとして届く。担当者の表示も変わりうる
      void qc.invalidateQueries({ queryKey: qk.insights(caseId) })
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
    },
  })
}

export function useDeletePerson(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/persons/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.persons(caseId) })
      // 相続人が増えた・減ったなどの前提の変化は、気づきとして届く。担当者の表示も変わりうる
      void qc.invalidateQueries({ queryKey: qk.insights(caseId) })
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
    },
  })
}

/**
 * 相続方法（Decision）の記録。
 * 「確定」の判定は利用者の入力によって持つ（企画書セクション5）。
 * 放棄前ロックの解除条件になるため、AI からは更新しない。
 */
export function useSetInheritanceDecision(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      personId,
      method,
    }: {
      personId: string
      method: InheritanceMethod | null
    }) => api.post<void>(`/cases/${caseId}/inheritance-decisions`, { personId, method }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.overview(caseId) })
      void qc.invalidateQueries({ queryKey: qk.tasks(caseId) })
      // 相続放棄があると、次の順位の方が相続人になる場合がある。その知らせを取りに行く
      void qc.invalidateQueries({ queryKey: qk.insights(caseId) })
    },
  })
}

/* ---------- Insight（AIが気づいたこと） ---------- */

export function useInsights(caseId: string) {
  return useQuery({
    queryKey: qk.insights(caseId),
    queryFn: () => api.get<Paginated<Insight>>(`/cases/${caseId}/insights`),
    enabled: Boolean(caseId),
    refetchInterval: 60_000,
  })
}

/** 気づきは操作を伴わない。読んだ／閉じるの記録だけを持つ。 */
export function useUpdateInsightStatus(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: Insight['status'] }) =>
      api.patch<Insight>(`/insights/${id}`, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.insights(caseId) }),
  })
}

/* ---------- Chat ---------- */

export function useMessages(caseId: string) {
  return useQuery({
    queryKey: qk.messages(caseId),
    queryFn: () => api.get<Paginated<ChatMessage>>(`/cases/${caseId}/messages`),
    enabled: Boolean(caseId),
  })
}

export function useSendMessage(caseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: string) => api.post<ChatMessage>(`/cases/${caseId}/messages`, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.messages(caseId) })
      void qc.invalidateQueries({ queryKey: qk.approvals(caseId) })
    },
  })
}
