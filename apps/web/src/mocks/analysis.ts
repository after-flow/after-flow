/**
 * 書類の読み取り（document_analysis）の代役。
 *
 * 実物の死亡診断書や通帳を使わずに「書類を追加 → AIが読み取る → AIからの確認に届く → 登録する」
 * の流れを一通り試せるよう、ファイル名に含まれる言葉で結果を出し分ける。
 * 本番コードからは参照しない。
 */
import type { AgentRunResource, DocumentKindResource, DocumentResource } from '@aftercare/public-contracts'
import { CASE_ID, db, nextId } from './db'
import { makeProposalAndApproval } from './proposals'

/** 読み取りにかかる時間（実際はもっと長い） */
const QUEUED_MS = 1200
const RUNNING_MS = 2800

const KIND_RULES: { kind: DocumentKindResource; words: string[] }[] = [
  { kind: 'DEATH_CERTIFICATE', words: ['死亡診断書', '死体検案書', 'death'] },
  { kind: 'BANK_STATEMENT', words: ['通帳', '預金', '残高', 'bank'] },
  { kind: 'INSURANCE_POLICY', words: ['保険', 'insurance'] },
  { kind: 'FAMILY_REGISTER', words: ['戸籍', 'koseki'] },
  { kind: 'WILL', words: ['遺言', 'will'] },
  { kind: 'CONTRACT', words: ['契約', '請求書', 'ローン', '借入', 'contract', 'loan'] },
]

export function guessKind(fileName: string): DocumentKindResource {
  const name = fileName.toLowerCase()
  return KIND_RULES.find((r) => r.words.some((w) => name.includes(w)))?.kind ?? 'OTHER'
}

function runSnapshot(run: AgentRunResource): Pick<AgentRunResource, 'id' | 'status' | 'waiting' | 'waitingFor' | 'failureReason' | 'version'> {
  return { id: run.id, status: run.status, waiting: run.waiting, waitingFor: run.waitingFor, failureReason: run.failureReason, version: run.version }
}

/** 必要書類のうち、名前が合うものを「そろった」にする（手続きごとに1つだけ埋める）。 */
function markCollected(word: string, documentId: string) {
  for (const t of db.tasks) {
    const r = t.requiredDocuments.find((x) => x.documentId == null && x.label.includes(word))
    if (r) r.documentId = documentId
  }
}

/**
 * 読み取りを始める。QUEUED → RUNNING → COMPLETED/FAILED と進み、完了時に
 * 提案（Proposal＋Approval）と気づき（Insight）を作る。
 */
export function startAnalysis(doc: DocumentResource) {
  const run: AgentRunResource = {
    id: nextId('run'),
    caseId: CASE_ID,
    operation: 'document_analysis',
    status: 'QUEUED',
    targetType: 'DOCUMENT',
    targetId: doc.id,
    attempt: 1,
    waiting: false,
    waitingFor: null,
    failureReason: null,
    guidanceOutcome: null,
    outcome: null,
    caseVersionAtAccept: db.cases.find((c) => c.id === CASE_ID)?.caseVersion ?? 1,
    startedAt: null,
    finishedAt: null,
    allowedActions: ['cancel'],
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  db.agentRuns.unshift(run)
  doc.analysis = { state: 'QUEUED', agentRunId: run.id, canRequest: false, blockedReasons: [], run: runSnapshot(run) }

  setTimeout(() => {
    if (!db.documents.includes(doc)) return // 読み取り中に削除された
    run.status = 'RUNNING'
    run.startedAt = new Date().toISOString()
    run.updatedAt = run.startedAt
    doc.analysis = { ...doc.analysis, state: 'RUNNING', run: runSnapshot(run) }

    setTimeout(() => {
      if (!db.documents.includes(doc)) return
      finishAnalysis(doc, run)
    }, RUNNING_MS)
  }, QUEUED_MS)
}

function finishAnalysis(doc: DocumentResource, run: AgentRunResource) {
  const kind = guessKind(doc.fileName)
  doc.kind = kind
  const now = new Date().toISOString()

  if (kind === 'OTHER') {
    run.status = 'FAILED'
    run.failureReason = '書類の種類を判別できませんでした。'
    run.finishedAt = now
    run.updatedAt = now
    doc.analysis = { state: 'FAILED', agentRunId: run.id, canRequest: true, blockedReasons: [], run: runSnapshot(run) }
    return
  }

  const created: ReturnType<typeof makeProposalAndApproval>[] = []
  const push = (args: Parameters<typeof makeProposalAndApproval>[0]) => {
    const pair = makeProposalAndApproval({ ...args, agentRunId: run.id, createdAt: now })
    created.push(pair)
    return pair
  }

  switch (kind) {
    case 'DEATH_CERTIFICATE':
      push({
        id: nextId('prop'),
        caseId: CASE_ID,
        kind: 'TASK_PROPOSAL',
        title: '死亡診断書のコピーをとっておく',
        summary: '死亡診断書は多くの手続きで提出を求められます。死亡届を出す前に、コピーを数部とっておくことをおすすめします。',
        payload: { title: '死亡診断書のコピーを5〜10部とる', summary: '各種手続きの提出用にコピーを準備します。', stage: 'immediate', category: '準備' },
        basis: [{ type: 'DOCUMENT', id: doc.id, version: doc.version, label: doc.fileName }],
      })
      markCollected('死亡診断書', doc.id)
      break

    case 'BANK_STATEMENT':
      push({
        id: nextId('prop'),
        caseId: CASE_ID,
        kind: 'ASSET_PROPOSAL',
        title: '預金口座を財産として登録する',
        summary: '通帳の表紙と最終ページから、普通預金口座を読み取りました。',
        payload: { fields: { name: '△△銀行 本店 普通預金', kind: 'BANK', institution: '△△銀行' } },
        basis: [{ type: 'DOCUMENT', id: doc.id, version: doc.version, label: doc.fileName }],
      })
      db.insights.push({
        id: nextId('ins'),
        caseId: CASE_ID,
        kind: 'POSSIBLE_CONTRACT',
        body: '毎月同じ金額の引き落としがあります。まだ登録されていない契約かもしれません。',
        evidence: [{ label: '引き落とし', value: '毎月10日・2,200円・摘要「ｸﾚｼﾞｯﾄ」', documentId: doc.id, documentName: doc.fileName }],
        detectedAt: now,
        agentRunId: run.id,
        requiresProfessional: false,
        status: 'NEW',
      })
      break

    case 'INSURANCE_POLICY':
      push({
        id: nextId('prop'),
        caseId: CASE_ID,
        kind: 'CONTRACT_PROPOSAL',
        title: '生命保険の契約を登録する',
        summary: '保険証券から、故人の生命保険を見つけました。',
        payload: { fields: { name: '終身保険', kind: 'INSURANCE', provider: '□□生命' } },
        basis: [{ type: 'DOCUMENT', id: doc.id, version: doc.version, label: doc.fileName }],
      })
      break

    case 'FAMILY_REGISTER':
      push({
        id: nextId('prop'),
        caseId: CASE_ID,
        kind: 'DOCUMENT_REQUEST',
        title: 'つながる前の戸籍もお願いしたい',
        summary: 'この戸籍からだけでは相続人を確定できません。出生までさかのぼる戸籍が必要です。',
        payload: { documents: [{ label: '故人のこれ以前の戸籍（除籍・改製原戸籍）' }] },
        basis: [{ type: 'DOCUMENT', id: doc.id, version: doc.version, label: doc.fileName }],
      })
      markCollected('戸籍', doc.id)
      break

    case 'WILL':
      push({
        id: nextId('prop'),
        caseId: CASE_ID,
        kind: 'ESCALATION_PROPOSAL',
        title: '遺言書の扱いを専門家に相談する',
        summary: '自筆の遺言書のように見えます。扱い方には決まりがあるため、専門家への相談を提案します。',
        payload: { reason: '自筆証書遺言の検認手続きの要否を確認する必要があります。', documents: [{ id: doc.id, version: doc.version }] },
        basis: [{ type: 'DOCUMENT', id: doc.id, version: doc.version, label: doc.fileName }],
      })
      db.insights.push({
        id: nextId('ins'),
        caseId: CASE_ID,
        kind: 'PROFESSIONAL_NEEDED',
        body: '自筆の遺言書は、開封する前に家庭裁判所での手続き（検認）が必要な場合があります。',
        evidence: [{ label: '読み取った書類', value: '手書きの遺言書のように見えます', documentId: doc.id, documentName: doc.fileName }],
        detectedAt: now,
        agentRunId: run.id,
        requiresProfessional: true,
        status: 'NEW',
      })
      break

    case 'CONTRACT': {
      const isLoan = /ローン|借入|loan/i.test(doc.fileName)
      if (isLoan) {
        push({
          id: nextId('prop'),
          caseId: CASE_ID,
          kind: 'LIABILITY_PROPOSAL',
          title: '借入を借金などとして登録する',
          summary: '書類から、故人名義の借入が見つかりました。',
          payload: { fields: { name: 'カードローン', kind: 'LOAN', creditor: '○○カード' } },
          basis: [{ type: 'DOCUMENT', id: doc.id, version: doc.version, label: doc.fileName }],
        })
      } else {
        push({
          id: nextId('prop'),
          caseId: CASE_ID,
          kind: 'CONTRACT_PROPOSAL',
          title: '契約を登録する',
          summary: '請求書から、故人名義の契約が見つかりました。',
          payload: { fields: { name: 'インターネット回線', kind: 'TELECOM', provider: '◇◇ネット' } },
          basis: [{ type: 'DOCUMENT', id: doc.id, version: doc.version, label: doc.fileName }],
        })
      }
      break
    }
  }

  db.proposals.push(...created.map((c) => c.proposal))
  db.approvals.push(...created.map((c) => c.approval))

  doc.extractionCandidates = created.map(({ proposal }) => ({
    id: proposal.id,
    proposalVersion: proposal.proposalVersion,
    kind: proposal.kind,
    title: proposal.title,
    payload: proposal.payload,
    status: proposal.status,
    basis: proposal.basis,
  }))
  doc.proposalRefs = created.map(({ proposal }) => ({
    id: proposal.id,
    proposalVersion: proposal.proposalVersion,
    kind: proposal.kind,
    status: proposal.status,
    source: proposal.source,
  }))
  doc.approvalRefs = created.map(({ approval }) => ({
    id: approval.id,
    proposalId: approval.proposalId,
    proposalVersion: approval.proposalVersion,
    status: approval.status,
    applicationStatus: approval.applicationStatus,
  }))

  run.status = 'SUCCEEDED'
  run.finishedAt = now
  run.updatedAt = now
  run.outcome = {
    resultId: nextId('result'),
    attemptId: nextId('attempt'),
    caseVersion: db.cases.find((c) => c.id === CASE_ID)?.caseVersion ?? 1,
    summary: `「${doc.fileName}」を読み取り、${created.length}件の確認を作りました。`,
    completed: [`${doc.fileName} の読み取り`],
    questions: [],
    remaining: [],
  }
  doc.analysis = { state: 'COMPLETED', agentRunId: run.id, canRequest: false, blockedReasons: [], run: runSnapshot(run) }
}
