/**
 * 書類の読み取り（document_analysis）の代役。
 *
 * 実物の死亡診断書や通帳を使わずに「書類を追加 → AIが読み取る → AIからの確認に届く → 登録する」
 * の流れを一通り試せるよう、ファイル名に含まれる言葉で結果を出し分ける。
 * 使える言葉は README の「モックで書類の流れを試す」を参照。
 *
 * 本番コードからは参照しない。
 */
import type { AgentRunSummary, Approval, CaseDocument, DocumentKind, Insight } from '@/api/types'
import { db, nextId } from './db'

/** 読み取りにかかる時間（実際はもっと長い） */
const ANALYSIS_MS = 5000

/** 読み取り中・読み取り済みの実行記録。overview の recentAgentRuns に混ぜて返す */
export const analysisRuns: AgentRunSummary[] = []

const KIND_RULES: { kind: DocumentKind; words: string[] }[] = [
  { kind: 'DEATH_CERTIFICATE', words: ['死亡診断書', '死体検案書', 'death'] },
  { kind: 'BANK_STATEMENT', words: ['通帳', '預金', '残高', 'bank'] },
  { kind: 'INSURANCE_POLICY', words: ['保険', 'insurance'] },
  { kind: 'FAMILY_REGISTER', words: ['戸籍', 'koseki'] },
  { kind: 'WILL', words: ['遺言', 'will'] },
  { kind: 'CONTRACT', words: ['契約', '請求書', 'ローン', '借入', 'contract', 'loan'] },
]

export function guessKind(fileName: string): DocumentKind {
  const name = fileName.toLowerCase()
  return KIND_RULES.find((r) => r.words.some((w) => name.includes(w)))?.kind ?? 'OTHER'
}

/** マイナンバーらしき記載を隠して保存したことにする（ファイル名に「マスク」を含むとき） */
export function isMaskedCase(fileName: string) {
  return fileName.includes('マスク') || fileName.toLowerCase().includes('masked')
}

const today = () => new Date().toISOString().slice(0, 10)

function approval(caseId: string, doc: CaseDocument, runId: string, a: Omit<Approval, 'id' | 'caseId' | 'status' | 'createdAt' | 'sourceDocumentId' | 'sourceDocumentName' | 'agentRunId'>): Approval {
  return {
    id: nextId('apr'),
    caseId,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    sourceDocumentId: doc.id,
    sourceDocumentName: doc.fileName,
    agentRunId: runId,
    ...a,
  }
}

/**
 * 必要書類のうち、名前が合うものを「そろった」にする（例：死亡届の「死亡診断書（原本）」）。
 * 1通の書類で満たせるのは、手続きごとに1つだけ（故人の戸籍1通で「相続人全員の戸籍」まで埋めない）。
 */
function markCollected(caseId: string, word: string, documentId: string) {
  for (const t of db.tasks.filter((x) => x.caseId === caseId)) {
    const r = (t.requiredDocuments ?? []).find((x) => !x.collected && x.label.includes(word))
    if (r) {
      r.collected = true
      r.documentId = documentId
    }
  }
}

/**
 * 読み取りを始める。一定時間後に書類の種類・読み取り結果・確認（Approval）・気づき（Insight）を作る。
 */
export function startAnalysis(doc: CaseDocument) {
  const caseId = doc.caseId
  const run: AgentRunSummary = {
    id: nextId('run'),
    caseId,
    type: 'document_analysis',
    status: 'RUNNING',
    summary: `「${doc.fileName}」を読み取っています`,
    startedAt: new Date().toISOString(),
  }
  analysisRuns.unshift(run)
  doc.agentRunId = run.id

  setTimeout(() => {
    // 読み取り中に削除された書類は何もしない
    if (!db.documents.includes(doc)) {
      run.status = 'CANCELLED'
      run.finishedAt = new Date().toISOString()
      return
    }

    const kind = guessKind(doc.fileName)
    const approvals: Approval[] = []
    const insights: Insight[] = []
    // 同じ種類の書類がすでにあれば、二重取り込みの可能性を知らせる
    const earlier = db.documents.find((d) => d !== doc && d.caseId === caseId && d.kind === kind && kind !== 'OTHER')
    const duplicate = earlier ? { documentName: earlier.fileName, takenInAt: earlier.uploadedAt } : undefined

    doc.kind = kind

    switch (kind) {
      case 'DEATH_CERTIFICATE': {
        doc.extractions = [
          { id: nextId('ex'), label: '氏名', value: db.cases.find((c) => c.id === caseId)?.deceasedName ?? '（読み取れませんでした）' },
          { id: nextId('ex'), label: '死亡日', value: db.cases.find((c) => c.id === caseId)?.dateOfDeath ?? today() },
          { id: nextId('ex'), label: '死亡場所', value: '○○市立病院' },
        ]
        const a = approval(caseId, doc, run.id, {
          kind: 'TASK_PROPOSAL',
          title: '死亡診断書のコピーをとっておく',
          summary: '死亡診断書は多くの手続きで提出を求められます。死亡届を出す前に、コピーを数部とっておくことをおすすめします。',
          possibleDuplicate: duplicate,
          assetDisposal: false,
          diff: [
            { field: '手続き名', before: null, after: '死亡診断書のコピーを5〜10部とる', editable: true, confidence: 'HIGH' },
            { field: '提出先', before: null, after: 'コンビニ等のコピー機', editable: true, confidence: 'MEDIUM' },
          ],
        })
        approvals.push(a)
        doc.extractions[0].approvalId = a.id
        markCollected(caseId, '死亡診断書', doc.id)
        break
      }

      case 'BANK_STATEMENT': {
        const asset = approval(caseId, doc, run.id, {
          kind: 'ASSET_PROPOSAL',
          title: '預金口座を財産として登録する',
          summary: '通帳の表紙と最終ページから、普通預金口座と残高を読み取りました。',
          possibleDuplicate: duplicate,
          assetDisposal: false,
          diff: [
            { field: '名称', before: null, after: '△△銀行 本店 普通預金', editable: true, confidence: 'HIGH', sourceBox: { x: 0.18, y: 0.18, w: 0.55, h: 0.05 } },
            { field: '種別', before: null, after: '預金', confidence: 'HIGH' },
            { field: '金融機関', before: null, after: '△△銀行', editable: true, confidence: 'HIGH', sourceBox: { x: 0.18, y: 0.3, w: 0.3, h: 0.05 } },
            // 手書きの記帳や薄い印字は読み違えやすい。自信のない値として出す
            { field: '残高', before: null, after: '1,234,567円', editable: true, confidence: 'LOW', sourceBox: { x: 0.52, y: 0.72, w: 0.3, h: 0.05 } },
          ],
        })
        const cancel = approval(caseId, doc, run.id, {
          kind: 'TASK_PROPOSAL',
          title: 'この口座の解約・払い戻しを手続きに加える',
          summary: '見つかった口座について、解約と払い戻しの手続きを加える提案です。財産の処分にあたる可能性があります。',
          assetDisposal: true,
          diff: [
            { field: '手続き名', before: null, after: '△△銀行の口座を解約して払い戻しを受ける' },
            { field: '提出先', before: null, after: '△△銀行 本店' },
          ],
        })
        approvals.push(asset, cancel)
        doc.extractions = [
          { id: nextId('ex'), label: '金融機関', value: '△△銀行 本店', approvalId: asset.id, targetType: 'ASSET' },
          { id: nextId('ex'), label: '残高', value: '1,234,567円（読み取りに自信なし）', approvalId: asset.id, targetType: 'ASSET' },
        ]
        insights.push({
          id: nextId('ins'),
          caseId,
          kind: 'POSSIBLE_CONTRACT',
          body: '毎月同じ金額の引き落としがあります。まだ登録されていない契約かもしれません。',
          evidence: [{ label: '引き落とし', value: '毎月10日・2,200円・摘要「ｸﾚｼﾞｯﾄ」', documentId: doc.id, documentName: doc.fileName }],
          detectedAt: new Date().toISOString(),
          agentRunId: run.id,
          requiresProfessional: false,
          status: 'NEW',
        })
        break
      }

      case 'INSURANCE_POLICY': {
        const contract = approval(caseId, doc, run.id, {
          kind: 'CONTRACT_PROPOSAL',
          title: '生命保険の契約を登録する',
          summary: '保険証券から、契約者・被保険者が故人の生命保険を見つけました。',
          possibleDuplicate: duplicate,
          assetDisposal: false,
          diff: [
            { field: '名称', before: null, after: '終身保険', editable: true, confidence: 'HIGH' },
            { field: '契約先', before: null, after: '□□生命', editable: true, confidence: 'HIGH' },
            { field: '証券番号', before: null, after: 'A-1234-5678', editable: true, confidence: 'MEDIUM' },
          ],
        })
        const claim = approval(caseId, doc, run.id, {
          kind: 'TASK_PROPOSAL',
          title: '保険金の請求を手続きに加える',
          summary: '受取人が請求する手続きです。請求には期限（時効）があります。',
          assetDisposal: false,
          diff: [
            { field: '手続き名', before: null, after: '□□生命に保険金を請求する' },
            { field: '提出先', before: null, after: '□□生命 お客様窓口' },
          ],
        })
        approvals.push(contract, claim)
        doc.extractions = [
          { id: nextId('ex'), label: '保険会社', value: '□□生命', approvalId: contract.id, targetType: 'CONTRACT' },
          { id: nextId('ex'), label: '証券番号', value: 'A-1234-5678', approvalId: contract.id, targetType: 'CONTRACT' },
        ]
        break
      }

      case 'FAMILY_REGISTER': {
        const req = approval(caseId, doc, run.id, {
          kind: 'DOCUMENT_REQUEST',
          title: 'つながる前の戸籍もお願いしたい',
          summary: 'この戸籍は昭和60年からのものです。相続人を確定するには、出生までさかのぼる戸籍が必要です。',
          possibleDuplicate: duplicate,
          assetDisposal: false,
          diff: [{ field: '必要書類', before: null, after: '故人の昭和60年以前の戸籍（除籍・改製原戸籍）' }],
        })
        approvals.push(req)
        doc.extractions = [
          { id: nextId('ex'), label: '本籍', value: '○○県○○市' },
          { id: nextId('ex'), label: '記載の始まり', value: '昭和60年', approvalId: req.id },
        ]
        markCollected(caseId, '戸籍', doc.id)
        break
      }

      case 'WILL': {
        const esc = approval(caseId, doc, run.id, {
          kind: 'ESCALATION_PROPOSAL',
          title: '遺言書の扱いを専門家に相談する',
          summary: '自筆の遺言書のように見えます。扱い方には決まりがあるため、専門家への相談を手続きに加える提案です。',
          possibleDuplicate: duplicate,
          assetDisposal: false,
          diff: [
            { field: '手続き名', before: null, after: '遺言書の扱いについて専門家に相談する' },
            { field: '状態', before: null, after: '専門家に相談中' },
          ],
        })
        approvals.push(esc)
        doc.extractions = [{ id: nextId('ex'), label: '書かれ方', value: '手書き（自筆）のように見えます', approvalId: esc.id }]
        insights.push({
          id: nextId('ins'),
          caseId,
          kind: 'PROFESSIONAL_NEEDED',
          body: '自筆の遺言書は、開封する前に家庭裁判所での手続き（検認）が必要な場合があります。',
          evidence: [{ label: '読み取った書類', value: '手書きの遺言書のように見えます', documentId: doc.id, documentName: doc.fileName }],
          detectedAt: new Date().toISOString(),
          agentRunId: run.id,
          requiresProfessional: true,
          status: 'NEW',
        })
        break
      }

      case 'CONTRACT': {
        const isLoan = /ローン|借入|loan/i.test(doc.fileName)
        const a = isLoan
          ? approval(caseId, doc, run.id, {
              kind: 'LIABILITY_PROPOSAL',
              title: '借入を借金などとして登録する',
              summary: '書類から、故人名義の借入が見つかりました。',
              possibleDuplicate: duplicate,
              assetDisposal: false,
              diff: [
                { field: '名称', before: null, after: 'カードローン', editable: true, confidence: 'HIGH' },
                { field: '借りている先', before: null, after: '○○カード', editable: true, confidence: 'HIGH' },
                { field: '金額', before: null, after: '150,000円', editable: true, confidence: 'MEDIUM' },
              ],
            })
          : approval(caseId, doc, run.id, {
              kind: 'CONTRACT_PROPOSAL',
              title: '契約を登録する',
              summary: '請求書から、故人名義の契約が見つかりました。',
              possibleDuplicate: duplicate,
              assetDisposal: false,
              diff: [
                { field: '名称', before: null, after: 'インターネット回線', editable: true, confidence: 'HIGH' },
                { field: '契約先', before: null, after: '◇◇ネット', editable: true, confidence: 'HIGH' },
              ],
            })
        approvals.push(a)
        doc.extractions = [{ id: nextId('ex'), label: '契約先', value: isLoan ? '○○カード' : '◇◇ネット', approvalId: a.id }]
        break
      }

      default: {
        // 何の書類か分からない・写真がぼやけている、など
        doc.analysisStatus = 'NEEDS_REVIEW'
        doc.extractions = []
        run.status = 'SUCCEEDED'
        run.finishedAt = new Date().toISOString()
        run.summary = `「${doc.fileName}」は読み取れませんでした`
        return
      }
    }

    db.approvals.push(...approvals)
    db.insights.push(...insights)
    doc.analysisStatus = 'ANALYZED'
    run.status = 'SUCCEEDED'
    run.finishedAt = new Date().toISOString()
    run.producedApprovalIds = approvals.map((x) => x.id)
    run.summary = `「${doc.fileName}」を読み取り、${approvals.length}件の確認を作りました`
  }, ANALYSIS_MS)
}
