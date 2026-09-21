/**
 * 画面に出す言葉。
 *
 * 業務用語やカタカナ（タスク・証跡・先方処理待ちなど）を避け、
 * 一瞬で意味が分かる言い方にそろえる。法律用語（単純承認など）は言い換えずに残し、
 * そのかわり平易な説明を添える（言い換えると、窓口や専門家との会話で通じなくなるため）。
 */
import type {
  AgentOperationResource,
  ContractPolicy,
  FlowStageId,
  ProposalKindResource,
  TaskStatusResource,
} from '@aftercare/public-contracts'

export const TASK_STATUS_WORD: Record<TaskStatusResource, string> = {
  NOT_STARTED: '未着手',
  COLLECTING_INFORMATION: '準備中',
  WAITING_DOCUMENTS: '書類を集め中',
  READY: '提出できる状態',
  SUBMITTED: '提出済み',
  WAITING_EXTERNAL: '相手の処理待ち',
  ACTION_REQUIRED: '対応が必要',
  COMPLETED: '完了',
  ESCALATED: '専門家に相談中',
}

export const APPROVAL_KIND_WORD: Record<ProposalKindResource, string> = {
  TASK_PROPOSAL: '手続きの追加',
  ASSET_PROPOSAL: '財産の登録',
  LIABILITY_PROPOSAL: '借金などの登録',
  CONTRACT_PROPOSAL: '契約の登録',
  PERSON_PROPOSAL: '関係者の登録',
  DOCUMENT_REQUEST: '書類のお願い',
  ESCALATION_PROPOSAL: '専門家への相談',
  EVIDENCE_PROPOSAL: '完了の記録',
}

/** 未知の kind が来ても落ちないためのフォールバック。 */
export function approvalKindWord(kind: string): string {
  return APPROVAL_KIND_WORD[kind as ProposalKindResource] ?? '確認'
}

export const CONTRACT_POLICY_WORD: Record<ContractPolicy, string> = {
  UNDECIDED: 'まだ決めていない',
  CONTINUE: 'そのまま使う',
  TRANSFER: '名義を変える',
  CANCEL: '解約する',
}

export const AGENT_RUN_WORD: Record<AgentOperationResource, string> = {
  document_analysis: '書類の読み取り',
  case_planning: '手続きの洗い出し',
  task_guidance: '窓口の下調べ',
  chat_reply: '相談への回答',
}

/**
 * 手続きの流れの段階名。API の名前は長く業務的（「最終確認・ケースクローズ」など）なので、
 * 短く分かりやすい言い方を画面側で持つ。知らない段階が来たら API の名前をそのまま使う。
 */
export const FLOW_STAGE_WORD: Record<FlowStageId, string> = {
  immediate: '亡くなった直後',
  funeral: '葬儀・火葬',
  government: '役所の手続き',
  contracts: '契約の整理',
  // 戸籍を集めて相続人を確かめるのもこの段階。「財産」に限らないので、API の名前（相続の調査）にそろえる
  investigation: '相続の調査',
  decision: '相続の方法を決める',
  division: '遺産の分け方',
  transfer: '名義変更・受け取り',
  tax: '税金の申告',
  closing: '最後の確認',
}

/** 相続の方法の、ひとことの説明 */
export const METHOD_HINT = {
  SIMPLE_ACCEPTANCE: '財産も借金も引き継ぐ',
  LIMITED_ACCEPTANCE: '財産の範囲内で借金を引き継ぐ',
  RENUNCIATION: '財産も借金も引き継がない',
} as const
