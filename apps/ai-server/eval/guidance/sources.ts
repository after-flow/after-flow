import { textHash } from '../../src/infrastructure/research/official-catalog.js'
import { BURIAL_CATALOG_ENTRIES } from '../../src/infrastructure/execution/hackathon-config.js'
import type { SourceDocument } from '../../src/orchestration/research/sources.js'

/**
 * 評価用に固定した公式ページの抜粋（2026-09-22に抽出処理を通した主要コンテンツから、案内に関わる区分だけを残したもの）。
 *
 * 実ページの癖も残す。
 * - 申請期限は表を平坦化した文になっている。
 * - 制度ページは「家族埋葬費」、申請書ページは「家族埋葬料」と表記が揺れている。
 * 実ページとの差分は `--web official` で実ページを取得して評価すると確認できる。
 */
const [application, benefit] = BURIAL_CATALOG_ENTRIES
export const FIXTURE_SOURCES_RETRIEVED_AT = '2026-09-22'

const sections = {
  application: [
    { heading: '健康保険埋葬料（費）支給申請書', anchor: null, text: '審査の結果お支払い可能であれば、受付日から10営業日以内にお支払いいたします。' },
    { heading: '申請方法・提出先', anchor: '28cu0nou', text: '埋葬料（費）の申請は、電子申請がおすすめです。 紙の申請書は、ご加入されている協会けんぽ支部へご郵送ください。 ご加入の支部は、「資格情報のお知らせ」または「マイナポータル（健康保険証＞資格情報）」にてご確認いただけます。 電子申請サービスを利用して申請する場合は、提出先をお選びいただく必要はございません（社会保険労務士の方は支部指定が必要です）。' },
    { heading: '添付書類', anchor: '38uhhujf', text: '被保険者が亡くなり、被扶養者が申請する場合 被扶養者が亡くなり、被保険者が申請する場合 ○事業主による死亡の証明 （証明が受けられない方は〔A〕をご参照ください。） 被保険者が亡くなり、被扶養者以外の被保険者により生計維持されていた方が申請する場合 ○住民票（亡くなった被保険者と申請者が記載されているもの） ○住居が別の場合は、定期的な仕送りの事実のわかる預貯金通帳や現金書留のコピーまたは亡くなった被保険者が申請者の公共料金等を支払ったことがわかる領収書など 被保険者が亡くなり、被保険者により生計維持されていた方がいない場合で、実際に埋葬を行った方が申請する場合 ○領収書（支払った方のフルネームおよび埋葬に要した費用額が記載されているもの） ○埋葬に要した費用の明細書（費用の内訳がわかるもの） 事業主の証明を受けられない場合〔A〕 任意継続被保険者（被扶養者）が亡くなった場合 下記に挙げるもののうちいずれか一つ ○埋葬許可証または火葬許可証のコピー ○死亡診断書、死体検案書または検視調書のコピー ○亡くなった方の戸籍（除籍）謄（抄）本 ○住民票など' },
    { heading: '申請期限', anchor: 'a9nepryw', text: '健康保険給付を受ける権利は、受けることができるようになった日の翌日（消滅時効の起算日）から2年で時効になります。消滅時効の起算日は、以下の通りです。 種類 消滅時効の起算日 埋葬料 家族埋葬料 死亡年月日の翌日 埋葬費 埋葬年月日の翌日' },
    { heading: '注意事項', anchor: 'boarzlt4', text: '添付書類について 主に必要とされるものを掲載しております。場合によっては、ここに掲載のない添付書類が必要となることもありますのでご了承ください。' },
  ],
  benefit: [
    { heading: '埋葬料・埋葬費とは?', anchor: 'heading-1', text: '被保険者・被扶養者が業務外の事由により亡くなった場合、埋葬料（費）が支給されます。 「亡くなった方」「申請する方」によって、「埋葬料」「埋葬費」「家族埋葬料」に分かれます' },
    { heading: '被保険者が亡くなったときの支給額', anchor: null, text: '被保険者により生計を維持されていた方※1が申請 埋葬料50,000円が支給される 被保険者と生計維持関係にない「埋葬を行った方」が申請 （埋葬料を申請できる方がいない場合のみ） 50,000円の範囲内で実際に埋葬に要した費用※2が支給される 生計を維持されていた方 被保険者によって生活費の一部でも維持されている方であればよく、民法上の親族や遺族であることは問われません。 実際に埋葬に要した費用 霊柩車代、霊柩運搬代、霊前供物代、火葬料、僧侶の謝礼等の実費額です。' },
    { heading: '被扶養者が亡くなったとき', anchor: null, text: '被保険者が申請 家族埋葬費として50,000円が支給される' },
    { heading: '提出先', anchor: null, text: 'ご加入の協会けんぽ支部にご提出ください。 都道府県支部一覧' },
    { heading: '資格喪失後の支給について', anchor: 'heading-5', text: '被保険者が資格喪失後に亡くなり、次のいずれかに該当する場合は、埋葬料または埋葬費が支給されます。 （1）被保険者だった方が資格喪失後3か月以内に亡くなったとき （2）被保険者だった方が資格喪失後の傷病手当金または出産手当金の継続給付を受けている間に亡くなったとき （3）被保険者だった方が（2）の継続給付を受けなくなってから3か月以内に亡くなったとき' },
  ],
}

/** 区分から本文とハッシュを作り直す。抽出処理と同じく見出しを【】で区切る。 */
export function rebuildDocument(source: SourceDocument): SourceDocument {
  const text = source.sections.map(section => section.heading ? `【${section.heading}】 ${section.text}` : section.text).join('\n')
  return { ...source, text, contentHash: textHash(text) }
}

function document(entry: (typeof BURIAL_CATALOG_ENTRIES)[number], items: typeof sections.application, fetchedAt: string, forms: SourceDocument['forms']): SourceDocument {
  return rebuildDocument({ id: entry.id, catalogId: entry.catalogId, title: entry.title, issuer: entry.issuer, url: entry.url,
    text: '', location: 'HTML本文（主要コンテンツ・見出し単位）', fetchedAt, updatedAt: null, contentHash: '',
    sections: items.map((item, index) => ({ id: `s${index + 1}`, ...item })), forms })
}

/** 取得時刻は実行時に付ける。ワークフローが資料の鮮度を検査するため。 */
export function fixtureSources(fetchedAt = new Date().toISOString()): SourceDocument[] {
  return [
    document(application!, sections.application, fetchedAt, [
      { label: '健康保険埋葬料（費）支給申請書（手書き用）', url: 'https://www.kyoukaikenpo.or.jp/assets/k_maisou2607.pdf', kind: 'FORM' },
      { label: '健康保険埋葬料（費）支給申請書（手書き用記入例）', url: 'https://www.kyoukaikenpo.or.jp/assets/k_maisou_guide2607.pdf', kind: 'EXAMPLE' },
    ]),
    document(benefit!, sections.benefit, fetchedAt, []),
  ]
}
