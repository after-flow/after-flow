import type { DocumentResource } from '@aftercare/public-contracts'
import type { Tone } from '@/kit/kit'

export interface DocumentDisplay {
  label: string
  tone: Tone
  /** 撮り直し・確認などの補足文言 */
  hint?: string
}

const BLOCKED_REASON_LABEL: Record<string, string> = {
  AI_NOT_CONNECTED: 'この環境では自動での読み取りが接続されていません',
  CONSENT_REQUIRED: '外部AIへの提供に同意すると読み取りを依頼できます',
  INSPECTION_NOT_PASSED: '検査に合格していないため読み取れません',
  KIND_NOT_SUPPORTED: 'この種類の書類は、まだ自動での読み取りに対応していません',
}

/**
 * 書類の表示状態を、保存・検査・解析の3軸から1つの言葉に落とす（設計 §3.2）。
 * 上から順に評価し、最初に当てはまったものを返す。
 */
export function documentDisplayStatus(doc: DocumentResource): DocumentDisplay {
  if (doc.storageState === 'UPLOADING') return { label: '保存中', tone: 'gray' }
  if (doc.inspection.status === 'REJECTED' || doc.storageState === 'FAILED') {
    const findings = doc.inspection.findings.map((f) => f.message)
    return {
      label: 'お預かりできませんでした',
      tone: 'red',
      hint: findings.length > 0 ? findings.join('。') : undefined,
    }
  }
  if (doc.inspection.status === 'FAILED') {
    return { label: '確認できませんでした', tone: 'yellow', hint: '明るい場所で、書類全体が入るように撮り直してください。' }
  }
  if (doc.inspection.status === 'PENDING' || doc.inspection.status === 'IN_PROGRESS') {
    return { label: '読み取り前（内容を確認中）', tone: 'gray' }
  }
  if (doc.analysis.state === 'NOT_REQUESTED' && doc.analysis.blockedReasons.includes('KIND_NOT_SUPPORTED')) {
    return { label: '保管済み', tone: 'gray', hint: BLOCKED_REASON_LABEL.KIND_NOT_SUPPORTED }
  }
  if (doc.analysis.state === 'NOT_REQUESTED') return { label: '読み取り前', tone: 'gray' }
  if (doc.analysis.state === 'NOT_CONNECTED') {
    const reasons = doc.analysis.blockedReasons.map((r) => BLOCKED_REASON_LABEL[r] ?? r)
    return { label: '読み取りは準備中（AI未接続）', tone: 'gray', hint: reasons[0] }
  }
  if (doc.analysis.state === 'QUEUED' || doc.analysis.state === 'RUNNING') {
    return { label: '読み取り中', tone: 'blue', hint: doc.analysis.run?.waiting ? `確認待ち：${doc.analysis.run.waitingFor ?? ''}` : undefined }
  }
  if (doc.analysis.state === 'COMPLETED') return { label: '読み取り済み', tone: 'green' }
  if (doc.analysis.state === 'FAILED') return { label: '読み取れませんでした', tone: 'yellow', hint: doc.analysis.run?.failureReason ?? undefined }
  return { label: '読み取り前', tone: 'gray' }
}

/** 一覧・詳細のポーリング対象か（保存中・検査中・解析中）。 */
export function isDocumentInProgress(doc: DocumentResource): boolean {
  return (
    doc.storageState === 'UPLOADING' ||
    doc.inspection.status === 'IN_PROGRESS' ||
    doc.analysis.state === 'QUEUED' ||
    doc.analysis.state === 'RUNNING'
  )
}

/** 承認待ち（PENDING）の件数。読み取り完了の通知に使う。 */
export function pendingApprovalRefCount(doc: DocumentResource): number {
  return doc.approvalRefs.filter((r) => r.status === 'PENDING').length
}
