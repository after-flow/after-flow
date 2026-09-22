import type { OfficialCatalog } from '../research/official-catalog.js'

export const HACKATHON_CATALOG_VERSION = '2026-09-22'
const REVIEWED_AT = '2026-09-22T00:00:00.000Z'
const EXPIRES_AT = '2027-09-22T00:00:00.000Z'

const catalog = (input: Omit<OfficialCatalog, 'version' | 'reviewedAt' | 'expiresAt'>): OfficialCatalog => ({
  ...input,
  version: HACKATHON_CATALOG_VERSION,
  reviewedAt: REVIEWED_AT,
  expiresAt: EXPIRES_AT,
})

/**
 * ハッカソンで確認済みの公式情報源だけを列挙する。
 * Research Agent はこの一覧を検索し、任意URLや検索結果ページへはアクセスしない。
 */
export const HACKATHON_OFFICIAL_CATALOGS = Object.freeze([
  catalog({
    id: 'kyoukaikenpo-burial-benefit',
    reviewReference: 'https://www.kyoukaikenpo.or.jp/application_form/benefit/012/',
    allowedHosts: ['www.kyoukaikenpo.or.jp'],
    entries: [
      { id: 'burial-application', catalogId: 'kyoukaikenpo-burial-benefit', title: '健康保険埋葬料（費）支給申請書', issuer: '全国健康保険協会',
        url: 'https://www.kyoukaikenpo.or.jp/application_form/benefit/012/', keywords: ['埋葬料', '埋葬費', '必要書類', '申請期限', '死亡', '記入例'] },
      { id: 'burial-benefit', catalogId: 'kyoukaikenpo-burial-benefit', title: '埋葬料・埋葬費', issuer: '全国健康保険協会',
        url: 'https://www.kyoukaikenpo.or.jp/benefit/burial_charges/', keywords: ['埋葬料', '埋葬費', '家族埋葬料', '支給条件', '支給額', '死亡'] },
      { id: 'burial-electronic-application', catalogId: 'kyoukaikenpo-burial-benefit', title: '協会けんぽ電子申請の対象申請', issuer: '全国健康保険協会',
        url: 'https://www.kyoukaikenpo.or.jp/electronic_application/covered_applications/', keywords: ['埋葬料', '埋葬費', '電子申請', '提出方法', '必要書類'] },
    ],
  }),
  catalog({
    id: 'nenkin-death-procedures',
    reviewReference: 'https://www.nenkin.go.jp/service/jukyu/tetsuduki/kyotsu/jukyu/20140731-01.html',
    allowedHosts: ['www.nenkin.go.jp'],
    entries: [
      { id: 'pension-recipient-death', catalogId: 'nenkin-death-procedures', title: '年金を受けている方が亡くなったとき', issuer: '日本年金機構',
        url: 'https://www.nenkin.go.jp/service/jukyu/tetsuduki/kyotsu/jukyu/20140731-01.html', keywords: ['年金の受給停止', '年金受給権者死亡届', '未支給年金', '必要書類', '提出先', '期限', 'マイナンバー'] },
      { id: 'survivor-pension-overview', catalogId: 'nenkin-death-procedures', title: '遺族年金', issuer: '日本年金機構',
        url: 'https://www.nenkin.go.jp/service/jukyu/seido/izokunenkin/jukyu-yoken/20150401-03.html', keywords: ['遺族年金', '遺族基礎年金', '遺族厚生年金', '受給要件', '対象者'] },
      { id: 'survivor-employees-pension-claim', catalogId: 'nenkin-death-procedures', title: '遺族厚生年金を受けられるとき', issuer: '日本年金機構',
        url: 'https://www.nenkin.go.jp/service/jukyu/tetsuduki/izoku/seikyu/20140617-02.html', keywords: ['遺族厚生年金', '請求手続き', '必要書類', '年金事務所', '期限'] },
      { id: 'death-lump-sum', catalogId: 'nenkin-death-procedures', title: '死亡一時金', issuer: '日本年金機構',
        url: 'https://www.nenkin.go.jp/service/jukyu/seido/sonota-kyufu/1go-dokuji/20140422-01.html', keywords: ['死亡一時金', '受給要件', '請求できる遺族', '支給額', '期限'] },
      { id: 'widow-pension-claim', catalogId: 'nenkin-death-procedures', title: '寡婦年金を受けるとき', issuer: '日本年金機構',
        url: 'https://www.nenkin.go.jp/service/jukyu/tetsuduki/sonota-kyufu/20140422.html', keywords: ['寡婦年金', '受給要件', '必要書類', '請求先', '電子申請'] },
    ],
  }),
  catalog({
    id: 'inheritance-renunciation',
    reviewReference: 'https://www.courts.go.jp/saiban/syurui/syurui_kazi/kazi_06_13/index.html',
    allowedHosts: ['www.courts.go.jp'],
    entries: [
      { id: 'inheritance-renunciation-procedure', catalogId: 'inheritance-renunciation', title: '相続の放棄の申述', issuer: '裁判所',
        url: 'https://www.courts.go.jp/saiban/syurui/syurui_kazi/kazi_06_13/index.html', keywords: ['相続放棄', '限定承認', '申述先', '家庭裁判所', '3か月', '必要書類', '申述書', '期間の伸長'] },
    ],
  }),
  catalog({
    id: 'final-income-tax-return',
    reviewReference: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2022.htm',
    allowedHosts: ['www.nta.go.jp'],
    entries: [
      { id: 'final-income-tax-guide', catalogId: 'final-income-tax-return', title: '納税者が死亡したときの確定申告（準確定申告）', issuer: '国税庁',
        url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2022.htm', keywords: ['準確定申告', '申告要否', '4か月', '提出先', '所轄税務署', '付表', 'e-Tax', '相続人'] },
    ],
  }),
  catalog({
    id: 'inheritance-tax-return',
    reviewReference: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4102.htm',
    allowedHosts: ['www.nta.go.jp'],
    entries: [
      { id: 'inheritance-tax-liability', catalogId: 'inheritance-tax-return', title: '相続税がかかる場合', issuer: '国税庁',
        url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4102.htm', keywords: ['相続税', '申告要否', '基礎控除', '正味の遺産額', '債務控除', '10か月'] },
      { id: 'inheritance-tax-filing', catalogId: 'inheritance-tax-return', title: '相続税の申告と納税', issuer: '国税庁',
        url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4205.htm', keywords: ['相続税', '申告', '納税', '提出先', '所轄税務署', '10か月', '未分割'] },
    ],
  }),
  catalog({
    id: 'real-estate-registration',
    reviewReference: 'https://www.moj.go.jp/MINJI/minji05_00599.html',
    allowedHosts: ['www.moj.go.jp', 'houmukyoku.moj.go.jp'],
    entries: [
      { id: 'inheritance-registration-obligation', catalogId: 'real-estate-registration', title: '相続登記の申請義務化について', issuer: '法務省',
        url: 'https://www.moj.go.jp/MINJI/minji05_00599.html', keywords: ['相続登記', '申請義務', '3年以内', '相続人申告登記', '遺産分割', '過料'] },
      { id: 'inheritance-registration-handbook', catalogId: 'real-estate-registration', title: '相続登記・遺贈の登記手続ハンドブック', issuer: '法務局',
        url: 'https://houmukyoku.moj.go.jp/homu/page7_000001_00014.html', keywords: ['相続登記', '登記申請', '必要書類', '登録免許税', '管轄登記所', '申請方法', '遺産分割'] },
    ],
  }),
] satisfies readonly OfficialCatalog[])
