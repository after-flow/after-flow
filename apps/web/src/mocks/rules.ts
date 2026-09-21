/**
 * 手続きの洗い出しと期限の計算（Backend の Rule Engine の代役）。
 *
 * 本番ではこの処理はすべて Rule Engine が行い、フロントエンドは結果を表示するだけ。
 * ここは「Rule Engine が満たすべき仕様」を動く形で示すためのもので、README の
 * 「Rule Engine への依頼：あてはまる手続きを漏れなく洗い出す」と対応している。
 *
 * 期限の数え方（民法の原則）：
 *  - 期間の初日は数えない（民法140条）。例：9月15日から「14日以内」→ 9月29日まで
 *  - 月・年で決まった期間は暦で数え、起算日に応答する日の前日で終わる（民法143条）。
 *    初日を数えないので、結果として「同じ日付」になる。例：9月15日から3か月 → 12月15日
 *    応答する日が無い月（例：11月30日から3か月）は、その月の末日で終わる
 *  - 例外として、戸籍の届出（死亡届）は届出事件の発生日を含めて数える（戸籍法43条）
 *
 * 期限の日が土日祝日でも、ここでは延ばさない（延びる手続きもあるが、早めに知らせる方が安全なため）。
 *
 * 本番コードからは参照しない。
 */
import type { Case, CaseProfile, DeadlineSummary, FlowStageId, Task } from '@aftercare/public-contracts'

/* ---------- 日付（YYYY-MM-DD を暦日として扱う。時差で1日ずれないよう UTC で計算する） ---------- */

function parse(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return { y, m, d }
}
function fmt(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
function lastDay(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function addDays(iso: string, n: number) {
  const { y, m, d } = parse(iso)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

/** 民法143条：月で定めた期間は暦で数える。応答日が無ければ末日 */
export function addMonthsLegal(iso: string, months: number) {
  const { y, m, d } = parse(iso)
  const total = m - 1 + months
  const ny = y + Math.floor(total / 12)
  const nm = (total % 12) + 1
  return fmt(ny, nm, Math.min(d, lastDay(ny, nm)))
}

export function todayLocal() {
  return new Date().toLocaleDateString('sv-SE')
}

function daysBetween(from: string, to: string) {
  const a = parse(from)
  const b = parse(to)
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000)
}

/** 期限日から残日数と重大度を決める（3日前＝黄、当日・超過＝赤） */
export function deadlineAt(args: {
  id: string
  taskId?: string
  taskTitle?: string
  label: string
  startDate: string
  dueDate: string
  basisLabel: string
  critical?: boolean
  extendable?: boolean
}): DeadlineSummary {
  const remaining = daysBetween(todayLocal(), args.dueDate)
  return {
    id: args.id,
    taskId: args.taskId,
    taskTitle: args.taskTitle,
    label: args.label,
    dueDate: args.dueDate,
    basisLabel: args.basisLabel,
    startDate: args.startDate,
    daysRemaining: remaining,
    severity: remaining < 0 ? 'OVERDUE' : remaining === 0 ? 'URGENT' : remaining <= 3 ? 'SOON' : 'NORMAL',
    extendable: args.extendable ?? false,
    critical: args.critical ?? false,
  }
}

/* ---------- 規則 ---------- */

type Include = 'yes' | 'maybe' | 'no'

type DeadlineRule = {
  /** 起算日：死亡日か、亡くなったことを知った日か */
  from: 'death' | 'known'
  unit: 'day' | 'month' | 'year'
  n: number
  /** 初日を含めて数える（戸籍の届出） */
  includeFirstDay?: boolean
  basis: string
  critical?: boolean
  extendable?: boolean
}

type Rule = {
  key: string
  title: string | ((c: Case) => string)
  summary: string | ((c: Case) => string)
  submitTo?: string | ((c: Case) => string | undefined)
  stage: FlowStageId
  category: string
  include: (c: Case) => Include
  deadline?: DeadlineRule | ((c: Case) => DeadlineRule | undefined)
  required?: string[]
  assetDisposal?: boolean
}

const p = (c: Case): CaseProfile => c.profile ?? {}
const unknown = (v?: string) => v == null || v === 'UNKNOWN'

/** 死亡時の年齢。生年月日が無ければ null */
export function ageAtDeath(c: Case): number | null {
  if (!c.dateOfBirth) return null // 未登録・消された（null）とき
  const b = parse(c.dateOfBirth)
  const d = parse(c.dateOfDeath)
  return d.y - b.y - (d.m < b.m || (d.m === b.m && d.d < b.d) ? 1 : 0)
}

export const RULES: Rule[] = [
  {
    key: 'death_notice',
    title: '死亡届を提出する',
    summary:
      '死亡診断書と一緒に市区町村の窓口へ出します。火葬許可の申請も同時に行い、火葬許可証を受け取ります。葬儀社が代わりに出すことも多いので、済んでいるか確かめてください。国外で亡くなった場合は3か月以内です。',
    submitTo: '市区町村役場の戸籍の窓口',
    stage: 'funeral',
    category: '役所手続き',
    include: () => 'yes',
    deadline: { from: 'known', unit: 'day', n: 7, includeFirstDay: true, basis: '亡くなったことを知った日から7日以内（その日を含めて数えます）', critical: true },
    required: ['死亡診断書（原本）', '届出人の印鑑', '本人確認書類'],
  },
  {
    key: 'household',
    title: '世帯主変更届を出す',
    summary: '故人が世帯主で、同じ世帯に残る方が2人以上いる場合に必要です（残る方が1人なら不要です）。',
    submitTo: '市区町村役場の住民票の窓口',
    stage: 'government',
    category: '役所手続き',
    include: () => 'maybe',
    deadline: { from: 'death', unit: 'day', n: 14, basis: '亡くなった日の翌日から数えて14日以内', critical: true },
    required: ['届出人の本人確認書類'],
  },
  {
    key: 'health_insurance',
    title: (c) =>
      p(c).healthInsurance === 'NATIONAL'
        ? '国民健康保険の資格喪失届を出す'
        : p(c).healthInsurance === 'LATE_ELDERLY' || (ageAtDeath(c) ?? 0) >= 75
          ? '後期高齢者医療の資格喪失届を出す'
          : p(c).healthInsurance === 'EMPLOYEE'
            ? '勤務先に連絡し、健康保険証を返す'
            : '健康保険の資格喪失の手続きをする',
    summary: (c) =>
      p(c).healthInsurance === 'EMPLOYEE'
        ? '会社の健康保険は、勤務先が手続きをします。勤務先に亡くなったことを伝え、保険証を返してください。'
        : '保険証を返します。加入していた保険によって窓口が違います（国民健康保険・後期高齢者医療は市区町村、会社の健康保険は勤務先）。',
    submitTo: (c) => (p(c).healthInsurance === 'EMPLOYEE' ? '勤務先' : '市区町村役場の保険年金の窓口'),
    stage: 'government',
    category: '年金・保険',
    include: () => 'yes',
    deadline: (c) =>
      p(c).healthInsurance === 'EMPLOYEE'
        ? undefined
        : { from: 'death', unit: 'day', n: 14, basis: '亡くなった日の翌日から数えて14日以内', critical: true },
    required: ['故人の保険証'],
  },
  {
    key: 'long_term_care',
    title: '介護保険の資格喪失届を出す',
    summary:
      `介護保険の保険証を返します。65歳以上の方、または要介護・要支援の認定を受けていた方が対象です。`,
    submitTo: '市区町村役場の介護保険の窓口',
    stage: 'government',
    category: '年金・保険',
    // 65歳以上なら必要。65歳未満でも要介護認定を受けていれば必要なので、外さず「あてはまる場合」とする
    include: (c) => {
      const age = ageAtDeath(c)
      return age != null && age >= 65 ? 'yes' : 'maybe'
    },
    deadline: { from: 'death', unit: 'day', n: 14, basis: '亡くなった日の翌日から数えて14日以内', critical: true },
    required: ['介護保険の保険証'],
  },
  {
    key: 'pension_stop',
    title: '年金の受給停止の手続きをする',
    summary: (c) =>
      p(c).pension === 'EMPLOYEES'
        ? '厚生年金を受け取っていた場合、10日以内に届け出ます。日本年金機構にマイナンバーが登録されていれば、原則として届出は不要です（年金事務所で確かめてください）。'
        : p(c).pension === 'NATIONAL_ONLY'
          ? '国民年金を受け取っていた場合、14日以内に届け出ます。日本年金機構にマイナンバーが登録されていれば、原則として届出は不要です（年金事務所で確かめてください）。'
          : `年金を受け取っていた場合に必要です。厚生年金は10日以内、国民年金は14日以内です。日本年金機構にマイナンバーが登録されていれば、原則として届出は不要です。`,
    submitTo: '年金事務所または街角の年金相談センター',
    stage: 'government',
    category: '年金・保険',
    include: (c) => (p(c).pension === 'NONE' ? 'no' : unknown(p(c).pension) ? 'maybe' : 'yes'),
    deadline: (c) =>
      p(c).pension === 'NATIONAL_ONLY'
        ? { from: 'death', unit: 'day', n: 14, basis: '亡くなった日の翌日から数えて14日以内（国民年金）', critical: true }
        : // わからないときは、早い方（厚生年金の10日）に合わせる
          { from: 'death', unit: 'day', n: 10, basis: '亡くなった日の翌日から数えて10日以内（厚生年金。国民年金は14日）', critical: true },
    required: ['年金証書', '死亡の事実がわかる書類'],
  },
  {
    key: 'unpaid_pension',
    title: '未支給年金を請求する',
    summary: `亡くなった月の分までの年金で、まだ受け取っていない分を、生計を同じくしていたご家族が請求できます。`,
    submitTo: '年金事務所または街角の年金相談センター',
    stage: 'transfer',
    category: '年金・保険',
    include: (c) => (p(c).pension === 'NONE' ? 'no' : unknown(p(c).pension) ? 'maybe' : 'yes'),
    deadline: { from: 'death', unit: 'year', n: 5, basis: '原則5年（時効）' },
  },
  {
    key: 'survivor_pension',
    title: '遺族年金を受け取れるか確かめる',
    summary: `故人が年金に加入していた、または受け取っていた場合、条件を満たすご家族は遺族基礎年金・遺族厚生年金を受け取れることがあります。`,
    submitTo: '年金事務所または市区町村役場',
    stage: 'transfer',
    category: '年金・保険',
    include: () => 'maybe',
    deadline: { from: 'death', unit: 'year', n: 5, basis: '原則5年（時効）' },
  },
  {
    key: 'death_lump_sum',
    title: '死亡一時金・寡婦年金を受け取れるか確かめる',
    summary: `国民年金だけに加入して保険料を納めていた方（自営業の方など）が、年金を受け取らずに亡くなった場合に対象になることがあります。死亡一時金は2年、寡婦年金は5年が請求の期限です。`,
    submitTo: '市区町村役場の国民年金の窓口または年金事務所',
    stage: 'transfer',
    category: '年金・保険',
    include: (c) => {
      const pr = p(c)
      if (pr.pension === 'EMPLOYEES' || pr.pension === 'NATIONAL_ONLY') return 'no'
      if (pr.occupation === 'EMPLOYEE') return 'no'
      return 'maybe'
    },
    deadline: { from: 'death', unit: 'year', n: 2, basis: '死亡一時金は亡くなった日の翌日から2年（寡婦年金は5年）' },
  },
  {
    key: 'funeral_benefit',
    title: (c) =>
      p(c).healthInsurance === 'EMPLOYEE'
        ? '埋葬料を請求する'
        : p(c).healthInsurance === 'NATIONAL' || p(c).healthInsurance === 'LATE_ELDERLY'
          ? '葬祭費を請求する'
          : '葬祭費・埋葬料を請求する',
    summary: (c) =>
      p(c).healthInsurance === 'EMPLOYEE'
        ? '会社の健康保険から、埋葬を行った方に埋葬料が支給されます。'
        : '葬儀を行った方に、加入していた健康保険から葬祭費（国民健康保険・後期高齢者医療）または埋葬料（会社の健康保険）が支給されます。',
    submitTo: (c) =>
      p(c).healthInsurance === 'EMPLOYEE' ? '勤務先の健康保険組合または協会けんぽ' : '市区町村役場の保険年金の窓口',
    stage: 'transfer',
    category: '年金・保険',
    include: () => 'yes',
    deadline: { from: 'death', unit: 'year', n: 2, basis: '葬儀を行った日の翌日から2年（埋葬料は亡くなった日の翌日から2年）' },
    required: ['葬儀の領収書または会葬礼状'],
  },
  {
    key: 'high_cost_medical',
    title: '高額療養費の払い戻しを確かめる',
    summary: `入院などで医療費の自己負担が高額だった場合、上限を超えた分が払い戻されることがあります。期限は診療を受けた月の翌月1日から2年です。`,
    submitTo: '加入していた健康保険の窓口',
    stage: 'transfer',
    category: '年金・保険',
    include: () => 'maybe',
  },
  {
    key: 'will_check',
    title: '遺言書があるか確かめる',
    summary:
      '遺言書の有無で、相続人や遺産の分け方が変わります。公正証書遺言は公証役場で検索でき、自筆の遺言書は法務局に預けられていないかも確かめます。自筆の遺言書が見つかったら、開封する前に家庭裁判所での検認が必要です（法務局に預けられていたものは不要です）。',
    submitTo: '公証役場・法務局',
    stage: 'investigation',
    category: '相続',
    include: () => 'yes',
  },
  {
    key: 'heirs',
    title: '相続人を調べる（戸籍の収集）',
    summary: '故人の出生から死亡までの戸籍をそろえて、相続人を確定します。相続の方法を決める期限（3か月）に間に合うよう、早めに始めます。',
    submitTo: '本籍地の市区町村（郵送でも請求できます）',
    stage: 'investigation',
    category: '相続',
    include: () => 'yes',
    required: ['故人の出生から死亡までの戸籍謄本', '相続人全員の戸籍謄本'],
  },
  {
    key: 'estate_survey',
    title: '財産と借金を調べる',
    summary:
      '預貯金・不動産・株式や投資信託・保険と、借金やローンを調べます。借金は信用情報機関に開示を請求すると分かることがあります。相続の方法を決める前に、できるだけ把握しておきます。',
    stage: 'investigation',
    category: '相続',
    include: () => 'yes',
  },
  {
    key: 'decision',
    title: '相続の方法を決める（承認・放棄の判断）',
    summary:
      '単純承認・限定承認・相続放棄のいずれかを、相続人ごとに決めます。相続放棄・限定承認は家庭裁判所への申し立てが必要です。判断は法的な内容を含むため、迷う場合は弁護士にご相談ください。',
    submitTo: '故人の最後の住所地の家庭裁判所（相続放棄・限定承認の場合）',
    stage: 'decision',
    category: '相続',
    include: () => 'yes',
    deadline: { from: 'known', unit: 'month', n: 3, basis: '自分が相続人になったと知った日から3か月以内（家庭裁判所に申し立てて延ばせる場合があります）', critical: true, extendable: true },
  },
  {
    key: 'final_tax',
    title: '準確定申告をする',
    summary: '故人のその年の所得について、相続人が代わりに確定申告をします。所得や年金の額によっては不要な場合もあるので、税務署で確かめてください。',
    submitTo: '故人の住所地を管轄する税務署',
    stage: 'tax',
    category: '税務',
    include: () => 'yes',
    deadline: { from: 'known', unit: 'month', n: 4, basis: '相続の開始を知った日の翌日から4か月以内', critical: true },
  },
  {
    key: 'inheritance_tax',
    title: '相続税の申告が必要か確かめる',
    summary:
      '財産の総額が基礎控除額以下なら、申告は不要です。ただし、配偶者の税額軽減や小規模宅地等の特例を使って税額が0円になる場合は、申告が必要です。判断は税務署または税理士にご確認ください。',
    submitTo: '故人の住所地を管轄する税務署',
    stage: 'tax',
    category: '税務',
    include: () => 'yes',
    deadline: { from: 'known', unit: 'month', n: 10, basis: '相続の開始を知った日の翌日から10か月以内', critical: true },
  },
  {
    key: 'division',
    title: '遺産の分け方を話し合う（遺産分割協議）',
    summary: '相続人全員で遺産の分け方を話し合い、まとまったら遺産分割協議書を作ります。遺言書がある場合は、その内容が基本になります。',
    stage: 'division',
    category: '相続',
    include: () => 'yes',
  },
  {
    key: 'bank_accounts',
    title: '預貯金の相続手続きをする',
    summary:
      '口座のある金融機関に亡くなったことを伝え、相続の手続きをします。遺産分割の前でも、一定額までは引き出せる制度（仮払い）があります。相続の方法を決めたあとに行う手続きです。',
    submitTo: '口座のある金融機関',
    stage: 'transfer',
    category: '金融機関',
    include: () => 'yes',
    assetDisposal: true,
  },
  {
    key: 'real_estate_registration',
    title: '不動産の相続登記をする',
    summary:
      `家や土地の名義を相続人に変えます。2024年4月から義務になり、正当な理由なく怠ると過料の対象になります。遺産分割がまとまらない場合は、相続人であることを申し出る制度（相続人申告登記）もあります。`,
    submitTo: '不動産の所在地を管轄する法務局',
    stage: 'transfer',
    category: '相続',
    include: (c) => (p(c).realEstate === 'NO' ? 'no' : p(c).realEstate === 'YES' ? 'yes' : 'maybe'),
    deadline: { from: 'known', unit: 'year', n: 3, basis: '相続で取得したことを知った日から3年以内（遺産分割で取得した場合は分割の日から3年）', critical: true },
  },
  {
    key: 'property_tax_rep',
    title: '固定資産税の相続人代表者を届け出る',
    summary: '家や土地がある場合、固定資産税の書類を受け取る相続人の代表者を市区町村に届け出ます。期限は自治体によって違います。',
    submitTo: '不動産のある市区町村の税務の窓口',
    stage: 'tax',
    category: '税務',
    include: (c) => (p(c).realEstate === 'YES' ? 'yes' : 'no'),
  },
  {
    key: 'car',
    title: '自動車の名義を変える',
    summary: '車を引き継ぐ場合は名義変更、手放す場合は廃車などの手続きをします。軽自動車は窓口が違います。',
    submitTo: '運輸支局（軽自動車は軽自動車検査協会）',
    stage: 'transfer',
    category: '契約',
    include: (c) => (p(c).car === 'YES' ? 'yes' : 'no'),
    assetDisposal: true,
  },
  {
    key: 'mortgage',
    title: '住宅ローンの団体信用生命保険を確かめる',
    summary: '住宅ローンに団体信用生命保険が付いていれば、残りのローンが保険で返済されることがあります。ローンを組んでいる金融機関に連絡します。',
    submitTo: '住宅ローンを組んでいる金融機関',
    stage: 'transfer',
    category: '金融機関',
    include: (c) => (p(c).mortgage === 'YES' ? 'yes' : 'no'),
  },
  {
    key: 'employer',
    title: '勤務先の手続きをする',
    summary: '勤務先に亡くなったことを伝え、最後の給与・死亡退職金・社員証や保険証の返却などを確かめます。',
    submitTo: '勤務先',
    stage: 'transfer',
    category: 'その他',
    include: (c) => (p(c).occupation === 'EMPLOYEE' ? 'yes' : 'no'),
  },
  {
    key: 'self_employed',
    title: '個人事業の届出をする',
    summary: '個人事業をしていた場合、税務署に廃業などの届出をします。事業を引き継ぐ場合は、別の届出が必要なことがあります。',
    submitTo: '故人の住所地を管轄する税務署',
    stage: 'tax',
    category: '税務',
    include: (c) => (p(c).occupation === 'SELF_EMPLOYED' ? 'yes' : 'no'),
  },
  {
    key: 'life_insurance',
    title: '生命保険・共済に入っていたか確かめる',
    summary: '保険証券や通帳の引き落としから、保険や共済を探します。保険金の請求には期限（多くは3年の時効）があります。',
    submitTo: '保険会社・共済',
    stage: 'transfer',
    category: '年金・保険',
    include: () => 'yes',
  },
  {
    key: 'utilities',
    title: '公共料金・携帯電話・カードなどの契約を整理する',
    summary: '電気・ガス・水道・携帯電話・インターネット・NHK・クレジットカード・サブスク（定額サービス）・賃貸住宅などの契約を、名義変更か解約します。',
    stage: 'contracts',
    category: '契約',
    include: () => 'yes',
  },
  {
    key: 'id_returns',
    title: '運転免許証・パスポートなどを返す',
    summary: '運転免許証・パスポート・マイナンバーカード・障害者手帳など、持っていたものを返します。期限の決まりが無いものも多いので、落ち着いてからで構いません。',
    stage: 'closing',
    category: '役所手続き',
    include: () => 'yes',
  },
]

/* ---------- 洗い出し ---------- */

const val = <T,>(v: T | ((c: Case) => T), c: Case): T => (typeof v === 'function' ? (v as (c: Case) => T)(c) : v)

/** 規則ごとの期限を計算する */
export function deadlineFor(rule: Rule, c: Case, id: string, taskId: string): DeadlineSummary | undefined {
  const d = val(rule.deadline, c)
  if (!d) return undefined
  const start = d.from === 'known' ? (c.knownAt ?? c.dateOfDeath) : c.dateOfDeath
  const due =
    d.unit === 'day'
      ? addDays(start, d.includeFirstDay ? d.n - 1 : d.n)
      : addMonthsLegal(start, d.unit === 'month' ? d.n : d.n * 12)
  const title = val(rule.title, c)
  return deadlineAt({
    id,
    taskId,
    taskTitle: title,
    label: title,
    startDate: start,
    dueDate: due,
    basisLabel: d.basis,
    critical: d.critical,
    extendable: d.extendable,
  })
}

/**
 * 規則が最後に書いた窓口（submitTo）。
 * 窓口は、エージェントの自律調査や利用者の入力で「○○市役所 市民課」のように具体的になっていく。
 * 規則が書いたままのものだけを答えに合わせて書き換え、具体的になったものは上書きしない。
 */
const generatedSubmitTo = new Map<string, string | undefined>()

/**
 * ケースの手続きを、規則に合わせてそろえる。
 *  - あてはまる（yes / maybe）のに無い手続きは作る
 *  - あてはまらなくなった手続きは、まだ手を付けていなければ消す（着手・完了したものは残す）
 *  - 残っている規則の手続きは、名前・説明・期限を最新の答えに合わせて直す（状態や記録はそのまま）。
 *    窓口は、規則が書いたままのときだけ直す（調べて具体的になった窓口は残す）
 */
export function syncRuleTasks(
  c: Case,
  tasks: Task[],
  ruleKeys: Map<string, string>,
  nextId: (prefix: string) => string,
): Task[] {
  const byKey = new Map<string, Task>()
  for (const t of tasks) {
    const k = ruleKeys.get(t.id)
    if (t.caseId === c.id && k) byKey.set(k, t)
  }
  const removed = new Set<string>()

  for (const rule of RULES) {
    const inc = rule.include(c)
    const existing = byKey.get(rule.key)

    if (inc === 'no') {
      if (existing && existing.status === 'NOT_STARTED' && (existing.evidences?.length ?? 0) === 0) {
        removed.add(existing.id)
        ruleKeys.delete(existing.id)
      }
      continue
    }

    if (existing) {
      existing.title = val(rule.title, c)
      existing.summary = val(rule.summary, c)
      if (existing.submitTo == null || existing.submitTo === generatedSubmitTo.get(existing.id)) {
        existing.submitTo = val(rule.submitTo, c)
        generatedSubmitTo.set(existing.id, existing.submitTo)
      }
      existing.deadline = deadlineFor(rule, c, existing.deadline?.id ?? nextId('dl'), existing.id)
      existing.conditional = inc === 'maybe'
      continue
    }

    const id = nextId('task')
    ruleKeys.set(id, rule.key)
    generatedSubmitTo.set(id, val(rule.submitTo, c))
    tasks.push({
      id,
      caseId: c.id,
      title: val(rule.title, c),
      summary: val(rule.summary, c),
      submitTo: val(rule.submitTo, c),
      status: 'NOT_STARTED',
      stage: rule.stage,
      category: rule.category,
      source: 'RULE_ENGINE',
      conditional: inc === 'maybe',
      assetDisposal: rule.assetDisposal ?? false,
      evidences: [],
      updatedAt: new Date().toISOString(),
      deadline: deadlineFor(rule, c, nextId('dl'), id),
      requiredDocuments: rule.required?.map((label) => ({
        id: nextId('rd'),
        label,
        collected: false,
        source: 'RULE_ENGINE' as const,
      })),
    })
  }

  return removed.size ? tasks.filter((t) => !removed.has(t.id)) : tasks
}

/** 熟慮期間（相続の方法を決める期限）の日付 */
export function deliberationDue(c: Case) {
  return addMonthsLegal(c.knownAt ?? c.dateOfDeath, 3)
}
