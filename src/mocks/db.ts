/**
 * モックAPI用のインメモリデータ。
 * Go / Echo の Public API が用意できるまでの開発用で、本番コードからは参照しない。
 * 期限計算は本来 Go の Rule Engine が行うため、ここでは「Rule Engine の代役」として
 * 同じ形のレスポンスを組み立てるだけにとどめる。
 */
import type {
  Approval,
  Asset,
  Benefit,
  Case,
  CaseDocument,
  ChatMessage,
  Contract,
  DeadlineSummary,
  Evidence,
  FlowStage,
  ConsentDocument,
  InheritanceMethod,
  Insight,
  Liability,
  Person,
  Task,
} from '@/api/types'

const DAY = 86_400_000

export function todayISO(): string {
  return toISO(new Date())
}

function toISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function shift(base: string, days: number): string {
  return toISO(new Date(new Date(`${base}T00:00:00`).getTime() + days * DAY))
}

function daysFromToday(iso: string): number {
  const today = new Date(`${todayISO()}T00:00:00`).getTime()
  const due = new Date(`${iso}T00:00:00`).getTime()
  return Math.round((due - today) / DAY)
}

/** Rule Engine 相当：残日数から重大度を決める（3日前＝黄、当日・超過＝赤） */
export function makeDeadline(
  args: {
    id: string
    taskId?: string
    taskTitle?: string
    label: string
    startDate: string
    days: number
    basisLabel: string
    critical?: boolean
    extendable?: boolean
  },
): DeadlineSummary {
  const dueDate = shift(args.startDate, args.days)
  const remaining = daysFromToday(dueDate)
  const severity =
    remaining < 0 ? 'OVERDUE' : remaining === 0 ? 'URGENT' : remaining <= 3 ? 'SOON' : 'NORMAL'
  return {
    id: args.id,
    taskId: args.taskId,
    taskTitle: args.taskTitle,
    label: args.label,
    dueDate,
    basisLabel: args.basisLabel,
    startDate: args.startDate,
    daysRemaining: remaining,
    severity,
    extendable: args.extendable ?? false,
    critical: args.critical ?? false,
  }
}

export const FLOW_STAGE_LABELS: { id: FlowStage['id']; label: string }[] = [
  { id: 'immediate', label: '死亡直後の対応' },
  { id: 'funeral', label: '葬儀・火葬（死亡届7日以内）' },
  { id: 'government', label: '役所・公的手続（目安14日以内）' },
  { id: 'contracts', label: '契約・生活の整理' },
  { id: 'investigation', label: '相続の調査' },
  { id: 'decision', label: '相続方法の判断（3か月以内）' },
  { id: 'division', label: '遺産分割' },
  { id: 'transfer', label: '名義変更・受け取り' },
  { id: 'tax', label: '税務（準確定申告4か月・相続税10か月）' },
  { id: 'closing', label: '最終確認・ケースクローズ' },
]

/* ---------- ストア ---------- */

interface Store {
  cases: Case[]
  persons: Person[]
  documents: CaseDocument[]
  tasks: Task[]
  assets: Asset[]
  liabilities: Liability[]
  contracts: Contract[]
  benefits: Benefit[]
  approvals: Approval[]
  messages: ChatMessage[]
  decisions: Record<string, InheritanceMethod | null>
  evidences: Evidence[]
  insights: Insight[]
  consents: ConsentDocument[]
}

let seq = 100
export const nextId = (prefix: string) => `${prefix}_${++seq}`

const DEATH = shift(todayISO(), -5)
const CASE_ID = 'case_1'

export const db: Store = {
  cases: [
    {
      id: CASE_ID,
      deceasedName: '山田 太郎',
      deceasedNameKana: 'やまだ たろう',
      dateOfDeath: DEATH,
      dateOfBirth: '1945-04-02',
      knownAt: DEATH,
      ownerName: '山田 花子',
      relationshipToDeceased: '配偶者',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
    },
  ],

  persons: [
    {
      id: 'person_1',
      caseId: CASE_ID,
      name: '山田 花子',
      nameKana: 'やまだ はなこ',
      relationship: '配偶者',
      role: 'HEIR_CANDIDATE',
      isHeir: true,
      specialCircumstance: null,
    },
    {
      id: 'person_2',
      caseId: CASE_ID,
      name: '山田 一郎',
      relationship: '長男',
      role: 'HEIR_CANDIDATE',
      isHeir: true,
      specialCircumstance: null,
    },
    {
      id: 'person_3',
      caseId: CASE_ID,
      name: '山田 みどり',
      relationship: '長女',
      role: 'HEIR_CANDIDATE',
      isHeir: true,
      specialCircumstance: 'MINOR',
      note: '17歳',
    },
  ],

  documents: [
    {
      id: 'doc_1',
      caseId: CASE_ID,
      fileName: '死亡診断書.pdf',
      kind: 'DEATH_CERTIFICATE',
      kindSource: 'AI',
      analysisStatus: 'ANALYZED',
      sizeBytes: 482_112,
      uploadedAt: new Date(Date.now() - 2 * DAY).toISOString(),
      myNumberScan: 'CLEAN',
      agentRunId: 'run_1',
      extractions: [
        { id: 'ex_1', label: '氏名', value: '山田 太郎' },
        { id: 'ex_2', label: '死亡日', value: DEATH },
        { id: 'ex_3', label: '死亡場所', value: '○○市立病院' },
      ],
    },
    {
      id: 'doc_2',
      caseId: CASE_ID,
      fileName: '預金通帳_表紙.jpg',
      kind: 'BANK_STATEMENT',
      kindSource: 'AI',
      analysisStatus: 'ANALYZED',
      sizeBytes: 1_204_233,
      uploadedAt: new Date(Date.now() - 1 * DAY).toISOString(),
      myNumberScan: 'CLEAN',
      agentRunId: 'run_2',
      extractions: [
        {
          id: 'ex_4',
          label: '金融機関',
          value: '○○銀行 △△支店',
          approvalId: 'apr_1',
          targetType: 'ASSET',
        },
        { id: 'ex_5', label: '口座種別', value: '普通預金' },
      ],
    },
  ],

  tasks: [
    task({
      id: 'task_1',
      title: '死亡届を提出する',
      summary:
        '死亡診断書と一緒に、市区町村の窓口へ提出します。火葬許可証の交付もあわせて受け取ります。',
      submitTo: '○○市役所 市民課',
      status: 'READY',
      stage: 'funeral',
      category: '役所手続き',
      source: 'RULE_ENGINE',
      deadline: makeDeadline({
        id: 'dl_1',
        taskId: 'task_1',
        taskTitle: '死亡届を提出する',
        label: '死亡届',
        startDate: DEATH,
        days: 7,
        basisLabel: '死亡を知った日 ＋ 7日',
        critical: true,
      }),
      requiredDocuments: [
        { id: 'rd_1', label: '死亡診断書', collected: true, source: 'AI', documentId: 'doc_1' },
        { id: 'rd_2', label: '届出人の印鑑', collected: false, source: 'AI' },
      ],
      guidance: {
        where: '○○市役所 市民課（本庁舎1階）',
        bring: ['死亡診断書（原本）', '届出人の印鑑', '本人確認書類'],
        steps: [
          '市民課の窓口で死亡届の用紙を受け取ります。',
          '死亡診断書と一緒に窓口へ提出します。',
          '火葬許可証を受け取ります。',
        ],
        note: '窓口の受付時間は自治体によって異なります。夜間・休日窓口の有無は事前にご確認ください。',
        researchedBy: 'MANUAL',
        // 自治体未登録の状態から始め、調査を依頼できることを示す
        research: { status: 'NOT_REQUESTED' },
      },
      assigneeName: '山田 花子',
    }),
    task({
      id: 'task_2',
      title: '世帯主変更届を出す',
      summary: '世帯主が亡くなり、残る世帯員が2人以上いる場合に必要です。',
      submitTo: '○○市役所 市民課',
      status: 'NOT_STARTED',
      stage: 'government',
      category: '役所手続き',
      source: 'RULE_ENGINE',
      deadline: makeDeadline({
        id: 'dl_2',
        taskId: 'task_2',
        taskTitle: '世帯主変更届を出す',
        label: '世帯主変更',
        startDate: DEATH,
        days: 14,
        basisLabel: '死亡日 ＋ 14日',
        critical: true,
      }),
      requiredDocuments: [{ id: 'rd_3', label: '本人確認書類', collected: false, source: 'AI' }],
      guidance: {
        where: '○○市役所 市民課',
        bring: ['届出人の本人確認書類', '印鑑'],
      },
    }),
    task({
      id: 'task_3',
      title: '国民健康保険の資格喪失届を出す',
      summary: '保険証の返却もあわせて行います。',
      submitTo: '○○市役所 保険年金課',
      status: 'COLLECTING_INFORMATION',
      stage: 'government',
      category: '年金・保険',
      source: 'RULE_ENGINE',
      deadline: makeDeadline({
        id: 'dl_3',
        taskId: 'task_3',
        taskTitle: '国民健康保険の資格喪失届を出す',
        label: '資格喪失届',
        startDate: DEATH,
        days: 14,
        basisLabel: '死亡日 ＋ 14日',
      }),
      requiredDocuments: [
        { id: 'rd_4', label: '故人の保険証', collected: false, source: 'AI' },
      ],
    }),
    task({
      id: 'task_4',
      title: '相続人を調べる（戸籍の収集）',
      summary:
        '故人の出生から死亡までの戸籍をそろえて、相続人を確定します。相続方法の判断（3か月以内）に間に合うよう、早めに着手します。',
      status: 'COLLECTING_INFORMATION',
      stage: 'investigation',
      category: '相続',
      source: 'AI',
      requiredDocuments: [
        { id: 'rd_5', label: '故人の出生から死亡までの戸籍謄本', collected: false, source: 'AI' },
        { id: 'rd_6', label: '相続人全員の戸籍謄本', collected: false, source: 'AI' },
      ],
      guidance: {
        where: '本籍地の市区町村（郵送でも請求できます）',
        steps: [
          '故人の本籍地の役所で、死亡の記載がある戸籍を請求します。',
          'さかのぼって出生までの戸籍をそろえます。',
          '相続人になる方の戸籍もそろえます。',
        ],
        note: 'マイナンバーが記載された書類（住民票の一部など）はアップロードできません。',
      },
    }),
    task({
      id: 'task_5',
      title: '相続の方法を決める（承認・放棄の判断）',
      summary:
        '単純承認・限定承認・相続放棄のいずれかを、相続人ごとに判断します。判断は法的な内容を含むため、迷われる場合は弁護士へご相談ください。',
      status: 'ACTION_REQUIRED',
      stage: 'decision',
      category: '相続',
      source: 'RULE_ENGINE',
      deadline: makeDeadline({
        id: 'dl_4',
        taskId: 'task_5',
        taskTitle: '相続の方法を決める（承認・放棄の判断）',
        label: '相続放棄・限定承認',
        startDate: DEATH,
        days: 90,
        basisLabel: '自分が相続人になったと知った時 ＋ 3か月',
        critical: true,
        extendable: true,
      }),
      dependencies: [
        { type: 'TASK', label: '相続人を調べる（戸籍の収集）が完了していること', satisfied: false, taskId: 'task_4' },
      ],
    }),
    task({
      id: 'task_6',
      title: '故人の預金口座を解約して払い戻しを受ける',
      summary: '相続方法が確定したあとに行う手続きです。',
      status: 'NOT_STARTED',
      stage: 'transfer',
      category: '金融機関',
      source: 'AI',
      assetDisposal: true,
      dependencies: [
        { type: 'DECISION', label: '相続方法が相続人全員について確定していること', satisfied: false },
      ],
    }),
    task({
      id: 'task_7',
      title: '準確定申告を行う',
      summary: '故人のその年の所得について、相続人が代わりに申告します。',
      submitTo: '○○税務署',
      status: 'NOT_STARTED',
      stage: 'tax',
      category: '税務',
      source: 'RULE_ENGINE',
      deadline: makeDeadline({
        id: 'dl_5',
        taskId: 'task_7',
        taskTitle: '準確定申告を行う',
        label: '準確定申告',
        startDate: DEATH,
        days: 120,
        basisLabel: '相続開始を知った日の翌日 ＋ 4か月',
        critical: true,
      }),
    }),
    task({
      id: 'task_8',
      title: '電気の契約を確認する',
      summary: '契約者の変更または解約が必要かを確認します。',
      status: 'NOT_STARTED',
      stage: 'contracts',
      category: '契約',
      source: 'AI',
    }),
  ],

  assets: [
    {
      id: 'asset_1',
      caseId: CASE_ID,
      name: '○○銀行 △△支店 普通預金',
      kind: 'BANK',
      institution: '○○銀行',
      amount: 3_240_000,
      source: 'AI',
      confirmation: 'UNCONFIRMED',
    },
    {
      id: 'asset_2',
      caseId: CASE_ID,
      name: '自宅（○○市××町）',
      kind: 'REAL_ESTATE',
      source: 'MANUAL',
      confirmation: 'CONFIRMED',
      taxAttention: true,
      note: '土地・建物とも故人名義',
    },
  ],

  liabilities: [
    {
      id: 'liab_1',
      caseId: CASE_ID,
      name: 'クレジットカード未払い分',
      kind: 'CREDIT',
      creditor: '××カード',
      amount: 68_000,
      source: 'AI',
      confirmation: 'UNCONFIRMED',
    },
  ],

  contracts: [
    {
      id: 'contract_1',
      caseId: CASE_ID,
      name: '電気（従量電灯B）',
      kind: 'UTILITY',
      provider: '○○電力',
      policy: 'UNDECIDED',
      progress: 'NOT_STARTED',
      source: 'AI',
      guidance: {
        where: '○○電力 カスタマーセンター（0120-XXX-XXX）',
        bring: ['お客様番号がわかるもの（検針票など）', '手続きをする方の本人確認書類'],
      },
    },
    {
      id: 'contract_2',
      caseId: CASE_ID,
      name: '携帯電話',
      kind: 'TELECOM',
      provider: '△△モバイル',
      policy: 'UNDECIDED',
      progress: 'NOT_STARTED',
      source: 'AI',
    },
  ],

  benefits: [
    {
      id: 'benefit_1',
      caseId: CASE_ID,
      name: '生命保険金',
      kind: 'INSURANCE_PAYOUT',
      provider: '□□生命',
      amount: 5_000_000,
      progress: 'NOT_STARTED',
      deadline: makeDeadline({
        id: 'dl_6',
        label: '生命保険金の請求',
        startDate: DEATH,
        days: 1095,
        basisLabel: '保険事故発生時 ＋ 3年（時効）',
      }),
    },
    {
      id: 'benefit_2',
      caseId: CASE_ID,
      name: '遺族年金',
      kind: 'PENSION',
      provider: '日本年金機構',
      progress: 'NOT_STARTED',
      deadline: makeDeadline({
        id: 'dl_7',
        label: '遺族年金の請求',
        startDate: DEATH,
        days: 1825,
        basisLabel: '受給権発生時 ＋ 原則5年',
      }),
    },
  ],

  approvals: [
    {
      id: 'apr_1',
      caseId: CASE_ID,
      kind: 'ASSET_PROPOSAL',
      status: 'PENDING',
      title: '預金口座を財産として登録する',
      summary: '預金通帳の画像から、○○銀行の普通預金口座を見つけました。',
      createdAt: new Date(Date.now() - 20 * 3600_000).toISOString(),
      sourceDocumentId: 'doc_2',
      sourceDocumentName: '預金通帳_表紙.jpg',
      agentRunId: 'run_2',
      assetDisposal: false,
      diff: [
        { field: '名称', before: null, after: '○○銀行 △△支店 普通預金', editable: true },
        { field: '種別', before: null, after: '預金' },
        { field: '金融機関', before: null, after: '○○銀行', editable: true },
      ],
    },
    {
      id: 'apr_2',
      caseId: CASE_ID,
      kind: 'TASK_PROPOSAL',
      status: 'PENDING',
      title: '預金口座の解約・払い戻しを手続きとして追加する',
      summary:
        '見つかった預金口座について、解約と払い戻しの手続きを追加する提案です。財産の処分にあたる可能性があります。',
      createdAt: new Date(Date.now() - 19 * 3600_000).toISOString(),
      sourceDocumentId: 'doc_2',
      sourceDocumentName: '預金通帳_表紙.jpg',
      agentRunId: 'run_2',
      assetDisposal: true,
      diff: [
        { field: '手続き名', before: null, after: '故人の預金口座を解約して払い戻しを受ける' },
        { field: '提出先', before: null, after: '○○銀行 △△支店' },
      ],
    },
    {
      id: 'apr_3',
      caseId: CASE_ID,
      kind: 'DOCUMENT_REQUEST',
      status: 'PENDING',
      title: '戸籍謄本の追加をお願いしたい',
      summary: '相続人を確定するため、故人の出生から死亡までの戸籍が必要です。',
      createdAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
      agentRunId: 'run_3',
      assetDisposal: false,
      diff: [{ field: '必要書類', before: null, after: '故人の出生から死亡までの戸籍謄本' }],
    },
  ],

  messages: [],

  decisions: {},

  evidences: [],

  /*
    AIが監視・解析の中で自分で見つけた気づき。
    いずれも事実の指摘までに留め、法的・税務的な性質の断定はしない。
    判断を伴うものは requiresProfessional を立てる。
  */
  /* 文面は仮置き。弁護士確認後に差し替える前提。 */
  consents: [
    {
      kind: 'TERMS',
      version: '0.1',
      title: '利用規約',
      summary: [
        '手続きの整理・期限の管理・提出先や持ち物のご案内を行います。',
        '役所や金融機関への提出・解約・お支払いは、ご本人に行っていただきます。',
        '法律・税務の判断や、書類の作成は行いません。',
      ],
      url: '/legal/terms',
      required: true,
      agreedVersion: null,
      agreedAt: null,
    },
    {
      kind: 'PRIVACY',
      version: '0.1',
      title: '個人情報の取扱いについて',
      summary: [
        'お名前、ご逝去日、手続き先の市区町村、アップロードいただいた書類をお預かりします。',
        'マイナンバーが記載された書類はお預かりしません。',
        '相続人など関係者の情報を登録される場合は、あらかじめご本人の了解を得てください。',
      ],
      url: '/legal/privacy',
      required: true,
      agreedVersion: null,
      agreedAt: null,
    },
    {
      kind: 'CROSS_BORDER_AI',
      version: '0.1',
      title: '外部のAI事業者への情報の提供',
      summary: [
        '書類の解析とご案内の作成のため、外部のAI事業者に情報を提供します。',
        '提供先が外国にある場合、その国名と個人情報保護制度についてお知らせします。',
        '同意されない場合、書類の解析はご利用いただけませんが、手続きと期限の管理はご利用いただけます。',
      ],
      url: '/legal/privacy',
      // 越境移転の同意は個別に取る。任意にして、断っても使える設計にしている。
      required: false,
      agreedVersion: null,
      agreedAt: null,
    },
  ],

  insights: [
    {
      id: 'ins_1',
      caseId: CASE_ID,
      kind: 'POSSIBLE_CONTRACT',
      body: '通帳に毎月同じ金額の引き落としが続いています。まだ登録されていない契約があるかもしれません。心当たりがあれば、契約の一覧に追加しておくと漏れを防げます。',
      evidence: [
        {
          label: '引き落とし',
          value: '毎月27日 ・ 4,980円 ・ 摘要「ＮＴＴセキュリティ」',
          documentId: 'doc_2',
          documentName: '預金通帳_表紙.jpg',
        },
        { label: '登録済みの契約', value: '電気・携帯電話の2件のみ' },
      ],
      detectedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      agentRunId: 'run_4',
      requiresProfessional: false,
      status: 'NEW',
    },
    {
      id: 'ins_2',
      caseId: CASE_ID,
      kind: 'DEADLINE_RISK',
      body: '戸籍の取り寄せは郵送だと2〜3週間かかることがあります。相続方法を決める期限から逆算すると、今月中に請求を始めないと間に合わなくなるおそれがあります。',
      evidence: [
        { label: '相続方法の判断期限', value: '2026年12月11日' },
        { label: '戸籍の収集', value: '未着手（必要書類 2件が未取得）', taskId: 'task_4' },
      ],
      detectedAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
      agentRunId: 'run_4',
      relatedTaskId: 'task_4',
      relatedTaskTitle: '相続人を調べる（戸籍の収集）',
      requiresProfessional: false,
      status: 'NEW',
    },
    {
      id: 'ins_3',
      caseId: CASE_ID,
      kind: 'PROFESSIONAL_NEEDED',
      body: '相続人に未成年の方が含まれています。遺産分割を進める場面では、通常とは異なる手続きが必要になる場合があります。',
      evidence: [
        { label: '登録されている相続人', value: '山田 みどり 様（長女・17歳）' },
        { label: '該当する手続き', value: '遺産分割' },
      ],
      detectedAt: new Date(Date.now() - 30 * 3600_000).toISOString(),
      agentRunId: 'run_4',
      // 未成年者がいる場合の取り扱いは法的判断を伴うため、断定せず専門家へ回す
      requiresProfessional: true,
      status: 'NEW',
    },
  ],
}

function task(
  t: Omit<Task, 'caseId' | 'updatedAt' | 'assetDisposal' | 'evidences'> & {
    assetDisposal?: boolean
  },
): Task {
  return {
    caseId: CASE_ID,
    updatedAt: new Date().toISOString(),
    assetDisposal: false,
    evidences: [],
    ...t,
  }
}

/**
 * ケース作成時点で確定する法定手続きを生成する。
 *
 * ご逝去日が分かれば、死亡届7日・世帯主変更14日・相続方法の判断3か月などの期限は
 * 書類を待たずに確定する。本来これは Go の Rule Engine が Case 作成時に行う処理で、
 * ここではその挙動を再現している。
 */
export function createStatutoryTasks(caseId: string, deathDate: string): Task[] {
  const defs: {
    key: string
    title: string
    summary: string
    submitTo?: string
    stage: Task['stage']
    category: string
    days: number
    basis: string
    critical?: boolean
    extendable?: boolean
    required?: string[]
  }[] = [
    {
      key: 'death_notice',
      title: '死亡届を提出する',
      summary:
        '死亡診断書と一緒に、市区町村の窓口へ提出します。火葬許可証の交付もあわせて受け取ります。',
      submitTo: '市区町村役場の戸籍・住民登録の窓口',
      stage: 'funeral',
      category: '役所手続き',
      days: 7,
      basis: '死亡を知った日 ＋ 7日',
      critical: true,
      required: ['死亡診断書（原本）', '届出人の印鑑', '本人確認書類'],
    },
    {
      key: 'household',
      title: '世帯主変更届を出す',
      summary: '世帯主が亡くなり、残る世帯員が2人以上いる場合に必要です。',
      submitTo: '市区町村役場の市民窓口',
      stage: 'government',
      category: '役所手続き',
      days: 14,
      basis: '死亡日 ＋ 14日',
      critical: true,
      required: ['届出人の本人確認書類', '印鑑'],
    },
    {
      key: 'insurance',
      title: '健康保険の資格喪失届を出す',
      summary: '保険証の返却もあわせて行います。加入していた保険の種類によって窓口が異なります。',
      submitTo: '市区町村役場の保険年金窓口（勤務先の健康保険の場合は勤務先）',
      stage: 'government',
      category: '年金・保険',
      days: 14,
      basis: '死亡日 ＋ 14日',
      required: ['故人の保険証'],
    },
    {
      key: 'pension',
      title: '年金の受給停止の手続きをする',
      summary: '年金を受け取っていた場合、受給を止める手続きが必要です。',
      submitTo: '年金事務所または年金相談センター',
      stage: 'government',
      category: '年金・保険',
      days: 14,
      basis: '死亡日 ＋ 14日',
      required: ['年金証書', '死亡の事実がわかる書類'],
    },
    {
      key: 'decision',
      title: '相続の方法を決める（承認・放棄の判断）',
      summary:
        '単純承認・限定承認・相続放棄のいずれかを、相続人ごとに判断します。判断は法的な内容を含むため、迷われる場合は弁護士へご相談ください。',
      stage: 'decision',
      category: '相続',
      days: 90,
      basis: '自分が相続人になったと知った時 ＋ 3か月',
      critical: true,
      extendable: true,
    },
    {
      key: 'final_tax',
      title: '準確定申告を行う',
      summary: '故人のその年の所得について、相続人が代わりに申告します。',
      submitTo: '故人の住所地を管轄する税務署',
      stage: 'tax',
      category: '税務',
      days: 120,
      basis: '相続開始を知った日の翌日 ＋ 4か月',
      critical: true,
    },
    {
      key: 'inheritance_tax',
      title: '相続税の申告・納税を行う',
      summary:
        '相続税がかかるかどうかは財産の総額によります。かからない場合は申告が不要なこともあります。',
      submitTo: '故人の住所地を管轄する税務署',
      stage: 'tax',
      category: '税務',
      days: 300,
      basis: '相続開始を知った日の翌日 ＋ 10か月',
      critical: true,
    },
  ]

  return defs.map((d) => {
    const id = nextId('task')
    return {
      id,
      caseId,
      title: d.title,
      summary: d.summary,
      submitTo: d.submitTo,
      status: 'NOT_STARTED',
      stage: d.stage,
      category: d.category,
      source: 'RULE_ENGINE',
      assetDisposal: false,
      evidences: [],
      updatedAt: new Date().toISOString(),
      deadline: makeDeadline({
        id: nextId('dl'),
        taskId: id,
        taskTitle: d.title,
        label: d.title,
        startDate: deathDate,
        days: d.days,
        basisLabel: d.basis,
        critical: d.critical,
        extendable: d.extendable,
      }),
      requiredDocuments: d.required?.map((label) => ({
        id: nextId('rd'),
        label,
        collected: false,
        source: 'RULE_ENGINE' as const,
      })),
    }
  })
}

export { CASE_ID, DEATH, DAY }
