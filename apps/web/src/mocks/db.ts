/**
 * モックAPI用のインメモリデータ。
 *
 * Backend の Public API を呼ばずに画面を試せるようにするためのもので、
 * 本番コードからは参照しない。フィクスチャの型は contracts の `*Resource` を直接使うため、
 * 「MSW が返す JSON」が Backend の契約と同じ形であることを typecheck で保証できる。
 */
import type {
  AgentRunResource,
  Asset,
  Benefit,
  CaseResource,
  ConsentDocumentResource,
  Contract,
  DocumentResource,
  GuidanceResource,
  InheritanceDecisionResource,
  Insight,
  Liability,
  MessageResource,
  Person,
  ProposalResource,
  ApprovalResource,
  TaskResource,
} from '@aftercare/public-contracts'
import { FLOW_STAGE_LABELS, makeDeadline, shift, taskActions, todayISO, unresolvedDeadline } from './rules'
import { makeProposalAndApproval } from './proposals'

let seq = 100
export const nextId = (prefix: string) => `${prefix}_${++seq}`

const DEATH = shift(todayISO(), -5)
const CASE_ID = 'case_1'
const SELF_PERSON_ID = 'person_1'
const NOW = new Date().toISOString()

interface Store {
  cases: CaseResource[]
  persons: Person[]
  documents: DocumentResource[]
  tasks: TaskResource[]
  assets: Asset[]
  liabilities: Liability[]
  contracts: Contract[]
  benefits: Benefit[]
  proposals: ProposalResource[]
  approvals: ApprovalResource[]
  decisions: InheritanceDecisionResource[]
  messages: MessageResource[]
  insights: Insight[]
  consents: ConsentDocumentResource[]
  guidance: Record<string, GuidanceResource>
  agentRuns: AgentRunResource[]
}

/**
 * タスクを既定値で組み立て、いまの状態から `allowedActions`/`blockedActions` を計算する。
 * 初期フィクスチャの構築時点では相続方法の記録がまだ無い（`decided` は常に false）ため、
 * `db` 自体（構築中でまだ参照できない）は見ない。
 */
function task(
  t: Pick<TaskResource, 'id' | 'title' | 'summary' | 'status' | 'stage' | 'category' | 'source'> &
    Partial<TaskResource>,
): TaskResource {
  const assetDisposal = t.assetDisposal ?? false
  const evidenceRequired = t.evidenceRequired ?? false
  const { allowed, blocked } = taskActions(t.status, {
    assetDisposal,
    decided: false,
    evidenceRequired,
    hasEvidence: (t.evidences ?? []).length > 0,
  })
  return {
    caseId: CASE_ID,
    conditional: t.conditional ?? false,
    submitToSource: t.submitToSource ?? null,
    targetDate: t.targetDate ?? null,
    submitTo: null,
    assigneeId: null,
    dependencyTaskIds: [],
    escalation: null,
    evidenceRequired,
    assetDisposal,
    requiredDocuments: [],
    completionReportedBy: null,
    completionReportedAt: null,
    deadline: null,
    evidences: [],
    allowedActions: allowed,
    blockedActions: blocked,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...t,
  }
}

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
      municipality: '○○市',
      ownerPersonId: SELF_PERSON_ID,
      selfPersonId: SELF_PERSON_ID,
      funeralCompletedAt: null,
      aiPlanningRestriction: null,
      status: 'ACTIVE',
      version: 1,
      caseVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
      allowedActions: ['UPDATE_BASIC_INFO', 'ADMINISTER'],
    },
  ],

  persons: [
    {
      id: SELF_PERSON_ID,
      caseId: CASE_ID,
      name: '山田 花子',
      nameKana: 'やまだ はなこ',
      relationship: '配偶者',
      role: 'HEIR_CANDIDATE',
      isHeir: true,
      specialCircumstance: null,
      version: 1,
    },
    {
      id: 'person_2',
      caseId: CASE_ID,
      name: '山田 一郎',
      relationship: '長男',
      role: 'HEIR_CANDIDATE',
      isHeir: true,
      specialCircumstance: null,
      version: 1,
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
      version: 1,
    },
  ],

  documents: [],

  tasks: [
    task({
      id: 'task_1',
      title: '死亡届を提出する',
      // 説明・持ち物・期限は Backend の手続きの定義（rule-catalog.ts の death-notification）と同じにする
      summary:
        '死亡届の用紙は、病院などで受け取る死亡診断書（死体検案書）と1枚になっています。左側の死亡届に記入し、市区町村の窓口へ出します。火葬許可の申請も同時に行い、火葬許可証を受け取ります（許可証がないと火葬できません）。葬儀社が代わりに出すことも多いので、済んでいるか確かめてください。国外で亡くなった場合は3か月以内です。',
      submitTo: '○○市役所 市民課',
      status: 'READY',
      // 死亡届と一緒に火葬許可を申請し、許可証がないと火葬できない。葬儀より前の「亡くなった直後」に置く（Backend の定義と同じ）
      stage: 'immediate',
      category: '役所手続き',
      source: 'RULE_ENGINE',
      deadline: makeDeadline({
        id: 'dl_1',
        taskId: 'task_1',
        label: '死亡届の提出期限',
        startDate: DEATH,
        // 知った日を含めて7日（初日算入）。含めずに数えると1日遅い期限になる
        period: { unit: 'DAY', count: 7, includeFirstDay: true },
        basisLabel: '亡くなったことを知った日から7日以内（その日を含めて数えます）',
        ruleId: 'death-notification',
        critical: true,
      }),
      requiredDocuments: [
        { id: 'rd_1', label: '死亡診断書（原本）', documentId: null, source: 'AI', collected: false },
        // 2021年9月から戸籍の届出への押印は任意。印鑑ではなく本人確認書類（Backend の定義と同じ）
        { id: 'rd_2', label: '届出人の本人確認書類', documentId: null, source: 'AI', collected: false },
      ],
      assigneeId: SELF_PERSON_ID,
      // 準備ができたまま数日たっている（「止まっている手続き」の見本）
      updatedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    }),
    task({
      id: 'task_2',
      title: '世帯主変更届を出す',
      summary:
        '故人が世帯主で、同じ世帯に残る方が2人以上いる場合に必要です。残る方が1人のときや、残るのが親1人とその15歳未満の子だけのときなど、次の世帯主が明らかな場合は不要です。',
      submitTo: '○○市役所 市民課',
      status: 'NOT_STARTED',
      stage: 'government',
      category: '役所手続き',
      source: 'RULE_ENGINE',
      deadline: makeDeadline({
        id: 'dl_2',
        taskId: 'task_2',
        label: '世帯主変更届の提出期限',
        startDate: DEATH,
        period: { unit: 'DAY', count: 14 },
        basisLabel: '亡くなった日の翌日から数えて14日以内',
        ruleId: 'household-change-notification',
        critical: true,
      }),
      requiredDocuments: [{ id: 'rd_3', label: '届出人の本人確認書類', documentId: null, source: 'AI', collected: false }],
    }),
    task({
      id: 'task_3',
      title: '国民健康保険の資格喪失届を出す',
      summary:
        '保険証（または資格確認書）を返します。加入していた保険によって窓口が違います（国民健康保険・後期高齢者医療は市区町村、会社の健康保険は勤務先）。',
      submitTo: '○○市役所 保険年金課',
      status: 'COLLECTING_INFORMATION',
      stage: 'government',
      category: '年金・保険',
      source: 'RULE_ENGINE',
      /*
        期限を出せない表示（「期限は確認中」）の見本。
        このケースは死亡日が入っているので「日付が未入力」（MISSING_BASIS_DATE）にはならない。
        期限の決まりが業務の確認待ち（RULE_UNCONFIRMED）という扱いにする
      */
      deadline: unresolvedDeadline({
        id: 'dl_3',
        taskId: 'task_3',
        label: '国民健康保険の資格喪失届の提出期限',
        basisLabel: '亡くなった日の翌日から数えて14日以内',
        ruleId: 'national-health-insurance-loss',
        reason: 'RULE_UNCONFIRMED',
      }),
      // 2024年12月から保険証の新規発行は止まり、資格確認書が送られている人もいる
      requiredDocuments: [{ id: 'rd_4', label: '故人の保険証または資格確認書', documentId: null, source: 'AI', collected: false }],
    }),
    task({
      id: 'task_4',
      title: '相続人を調べる（戸籍の収集）',
      summary:
        '故人の出生から死亡までの戸籍をそろえて、相続人を確定します。相続の方法を決める期限（3か月）に間に合うよう、早めに始めます。2024年3月から、配偶者・子・父母などは、最寄りの市区町村の窓口で、本籍地が遠い戸籍もまとめて請求できます（広域交付。兄弟姉妹は使えず、郵送では請求できません）。そろったら法務局で「法定相続情報一覧図」の写しを作ると、ほかの手続きで戸籍の束を何度も出さずに済みます。',
      status: 'COLLECTING_INFORMATION',
      stage: 'investigation',
      category: '相続',
      source: 'AI',
      requiredDocuments: [
        { id: 'rd_5', label: '故人の出生から死亡までの戸籍謄本', documentId: null, source: 'AI', collected: false },
        { id: 'rd_6', label: '相続人全員の戸籍謄本', documentId: null, source: 'AI', collected: false },
      ],
    }),
    task({
      id: 'task_5',
      title: '相続の方法を決める（承認・放棄の判断）',
      summary:
        '単純承認・限定承認・相続放棄のいずれかを決めます。相続放棄は相続人ごとに、限定承認は相続人全員がそろって、家庭裁判所に申し立てます。期限までに何もしないと、単純承認したものとみなされます。判断は法的な内容を含むため、迷う場合は弁護士にご相談ください。',
      status: 'ACTION_REQUIRED',
      stage: 'decision',
      category: '相続',
      source: 'RULE_ENGINE',
      deadline: makeDeadline({
        id: 'dl_4',
        taskId: 'task_5',
        label: '相続方法の選択期限',
        startDate: DEATH,
        // 3か月は暦で数える（90日で近似しない）
        period: { unit: 'MONTH', count: 3 },
        basisLabel: '自分のために相続が始まったと知った日の翌日から数えて3か月以内（家庭裁判所に申し立てて延ばせる場合があります）',
        ruleId: 'inheritance-choice',
        critical: true,
        extendable: true,
      }),
      dependencyTaskIds: ['task_4'],
    }),
    task({
      id: 'task_6',
      title: '故人の預金口座を解約して払い戻しを受ける',
      summary: '相続の方法が決まったあとに行う手続きです。財産の処分にあたるため、全員の相続の方法が決まるまで進められません。',
      status: 'NOT_STARTED',
      stage: 'transfer',
      category: '金融機関',
      source: 'AI',
      assetDisposal: true,
    }),
    task({
      id: 'task_7',
      title: '準確定申告をする',
      summary:
        '故人のその年の所得について、相続人が代わりに確定申告をします。所得や年金の額によっては不要な場合もあるので、税務署で確かめてください。',
      submitTo: '○○税務署',
      status: 'NOT_STARTED',
      stage: 'tax',
      category: '税務',
      source: 'RULE_ENGINE',
      deadline: makeDeadline({
        id: 'dl_5',
        taskId: 'task_7',
        label: '準確定申告の提出期限',
        startDate: DEATH,
        period: { unit: 'MONTH', count: 4 },
        basisLabel: '相続の開始を知った日の翌日から数えて4か月以内',
        ruleId: 'final-income-tax-return',
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
      currency: 'JPY',
      source: 'AI',
      confirmation: 'UNCONFIRMED',
      version: 1,
    },
    {
      id: 'asset_2',
      caseId: CASE_ID,
      name: '自宅（○○市××町）',
      kind: 'REAL_ESTATE',
      source: 'MANUAL',
      confirmation: 'CONFIRMED',
      confirmationRecord: { state: 'CONFIRMED', confirmedAt: NOW, confirmedBy: SELF_PERSON_ID, confirmedVersion: 1 },
      taxAttention: true,
      note: '土地・建物とも故人名義',
      version: 1,
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
      currency: 'JPY',
      source: 'AI',
      confirmation: 'UNCONFIRMED',
      version: 1,
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
      version: 1,
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
      version: 1,
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
      currency: 'JPY',
      progress: 'NOT_STARTED',
      version: 1,
    },
    {
      id: 'benefit_2',
      caseId: CASE_ID,
      name: '遺族年金',
      kind: 'PENSION',
      provider: '日本年金機構',
      progress: 'NOT_STARTED',
      version: 1,
    },
  ],

  proposals: [],
  approvals: [],

  decisions: [],

  messages: [],

  /*
    AIが監視・解析の中で自分で見つけた気づき。
    いずれも事実の指摘までに留め、法的・税務的な性質の断定はしない。
    判断を伴うものは requiresProfessional を立てる。
  */
  insights: [
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
      requiresProfessional: true,
      status: 'NEW',
    },
  ],

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
      satisfied: false,
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
      satisfied: false,
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
      satisfied: false,
    },
  ],

  guidance: {},

  agentRuns: [],
}

/* ---------- 初期の書類・確認待ち（見本） ---------- */

const RUN_2_STARTED = new Date(Date.now() - 20 * 3600_000).toISOString()
const RUN_2_FINISHED = new Date(Date.now() - 20 * 3600_000 + 25_000).toISOString()

db.agentRuns.push({
  id: 'run_2',
  caseId: CASE_ID,
  operation: 'document_analysis',
  status: 'SUCCEEDED',
  targetType: 'DOCUMENT',
  targetId: 'doc_2',
  attempt: 1,
  waiting: false,
  waitingFor: null,
  failureReason: null,
  outcome: {
    resultId: 'result_2',
    attemptId: 'attempt_2',
    caseVersion: 1,
    summary: '「預金通帳_表紙.jpg」を解析し、2件の提案を作成しました。',
    completed: ['金融機関名の読み取り', '口座種別の読み取り'],
    questions: [],
    remaining: [],
  },
  caseVersionAtAccept: 1,
  startedAt: RUN_2_STARTED,
  finishedAt: RUN_2_FINISHED,
  allowedActions: [],
  version: 1,
  createdAt: RUN_2_STARTED,
  updatedAt: RUN_2_FINISHED,
})

const { proposal: assetProposal, approval: assetApproval } = makeProposalAndApproval({
  id: 'prop_1',
  caseId: CASE_ID,
  kind: 'ASSET_PROPOSAL',
  title: '預金口座を財産として登録する',
  summary: '預金通帳の画像から、○○銀行の普通預金口座を見つけました。',
  payload: { fields: { name: '○○銀行 △△支店 普通預金', kind: 'BANK', institution: '○○銀行', amount: 3_240_000 } },
  basis: [{ type: 'DOCUMENT', id: 'doc_2', version: 1, label: '預金通帳_表紙.jpg' }],
  agentRunId: 'run_2',
  createdAt: new Date(Date.now() - 19 * 3600_000).toISOString(),
})
const { proposal: taskProposal, approval: taskApproval } = makeProposalAndApproval({
  id: 'prop_2',
  caseId: CASE_ID,
  kind: 'TASK_PROPOSAL',
  title: '預金口座の解約・払い戻しを手続きとして追加する',
  summary: '見つかった預金口座について、解約と払い戻しの手続きを追加する提案です。財産の処分にあたる可能性があります。',
  payload: {
    title: '故人の預金口座を解約して払い戻しを受ける',
    summary: '相続の方法が決まったあとに行う手続きです。',
    stage: 'transfer',
    category: '金融機関',
    submitTo: '○○銀行 △△支店',
    assetDisposal: true,
  },
  basis: [{ type: 'DOCUMENT', id: 'doc_2', version: 1, label: '預金通帳_表紙.jpg' }],
  agentRunId: 'run_2',
  assetDisposal: true,
  createdAt: new Date(Date.now() - 18 * 3600_000).toISOString(),
})
const { proposal: docRequestProposal, approval: docRequestApproval } = makeProposalAndApproval({
  id: 'prop_3',
  caseId: CASE_ID,
  kind: 'DOCUMENT_REQUEST',
  title: '戸籍謄本の追加をお願いしたい',
  summary: '相続人を確定するため、故人の出生から死亡までの戸籍が必要です。',
  payload: { documents: [{ label: '故人の出生から死亡までの戸籍謄本' }] },
  basis: [{ type: 'TASK', id: 'task_4', version: 1, label: '相続人を調べる（戸籍の収集）' }],
  createdAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
})

db.proposals.push(assetProposal, taskProposal, docRequestProposal)
db.approvals.push(assetApproval, taskApproval, docRequestApproval)

db.documents.push(
  {
    id: 'doc_1',
    caseId: CASE_ID,
    fileName: '死亡診断書.pdf',
    contentType: 'application/pdf',
    sizeBytes: 482_112,
    sha256: 'seed_doc_1',
    kind: 'DEATH_CERTIFICATE',
    kindSource: 'AI',
    storageState: 'STORED',
    inspection: { status: 'PASSED', completed: true, findings: [] },
    analysis: { state: 'COMPLETED', agentRunId: null, canRequest: false, blockedReasons: [], run: null },
    extractionCandidates: [],
    proposalRefs: [],
    approvalRefs: [],
    evidenceRefs: [],
    archived: false,
    archivedAt: null,
    version: 1,
    createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  },
  {
    id: 'doc_2',
    caseId: CASE_ID,
    fileName: '預金通帳_表紙.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1_204_233,
    sha256: 'seed_doc_2',
    kind: 'BANK_STATEMENT',
    kindSource: 'AI',
    storageState: 'STORED',
    inspection: { status: 'PASSED', completed: true, findings: [] },
    analysis: { state: 'COMPLETED', agentRunId: 'run_2', canRequest: false, blockedReasons: [], run: null },
    extractionCandidates: [
      {
        id: assetProposal.id,
        proposalVersion: assetProposal.proposalVersion,
        kind: assetProposal.kind,
        title: assetProposal.title,
        payload: assetProposal.payload,
        status: assetProposal.status,
        basis: assetProposal.basis,
      },
      {
        id: taskProposal.id,
        proposalVersion: taskProposal.proposalVersion,
        kind: taskProposal.kind,
        title: taskProposal.title,
        payload: taskProposal.payload,
        status: taskProposal.status,
        basis: taskProposal.basis,
      },
    ],
    proposalRefs: [
      { id: assetProposal.id, proposalVersion: assetProposal.proposalVersion, kind: assetProposal.kind, status: assetProposal.status, source: assetProposal.source },
      { id: taskProposal.id, proposalVersion: taskProposal.proposalVersion, kind: taskProposal.kind, status: taskProposal.status, source: taskProposal.source },
    ],
    approvalRefs: [
      { id: assetApproval.id, proposalId: assetApproval.proposalId, proposalVersion: assetApproval.proposalVersion, status: assetApproval.status, applicationStatus: assetApproval.applicationStatus },
      { id: taskApproval.id, proposalId: taskApproval.proposalId, proposalVersion: taskApproval.proposalVersion, status: taskApproval.status, applicationStatus: taskApproval.applicationStatus },
    ],
    evidenceRefs: [],
    archived: false,
    archivedAt: null,
    version: 1,
    createdAt: new Date(Date.now() - 1 * 86_400_000).toISOString(),
    updatedAt: RUN_2_FINISHED,
  },
)

export { CASE_ID, DEATH, SELF_PERSON_ID, FLOW_STAGE_LABELS }
