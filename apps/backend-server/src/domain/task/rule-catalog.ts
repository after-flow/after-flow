import type { RuleCatalog } from './rule-engine.js'

/**
 * 開発・試験用の仮ルール。
 *
 * すべて `reviewed: false` にしてある。仕様書や旧モックに書かれた日数を
 * そのまま本番の法定期限として扱わないため。この状態で算定される期限は
 * 日付を持たず、「要確認」として返る。
 *
 * 業務レビューを経た定義は設定ファイルから読み込む。
 */
export const PLACEHOLDER_RULE_CATALOG: RuleCatalog = {
  placeholder: true,
  deadlineRules: [
    {
      id: 'death-notification',
      version: '0.0.0-draft',
      label: '死亡届の提出期限',
      basis: 'KNOWN_AT',
      offsetDays: 7,
      jurisdiction: '市区町村',
      reviewed: false,
      sourceUrl: null,
      sourceCheckedAt: null,
      extendable: null,
      critical: true,
    },
    {
      id: 'inheritance-choice',
      version: '0.0.0-draft',
      label: '相続方法の選択期限',
      basis: 'KNOWN_AT',
      offsetMonths: 3,
      jurisdiction: '家庭裁判所',
      reviewed: false,
      sourceUrl: null,
      sourceCheckedAt: null,
      extendable: null,
      critical: true,
    },
  ],
  initialProcedures: [
    {
      id: 'death-notification',
      title: '死亡届を提出する',
      summary: '市区町村の窓口へ死亡届を提出します。必要書類と受付時間は自治体ごとに異なります。',
      stage: 'immediate',
      category: '行政手続き',
      submitTo: null,
      evidenceRequired: false,
      assetDisposal: false,
      requiredDocuments: [{ id: 'death-certificate', label: '死亡診断書' }],
      deadlineRuleId: 'death-notification',
    },
    {
      id: 'inheritance-choice',
      title: '相続方法を検討する',
      summary: '単純承認・限定承認・相続放棄のいずれにするかを相続人ごとに決めます。',
      stage: 'decision',
      category: '相続手続き',
      submitTo: null,
      evidenceRequired: false,
      assetDisposal: false,
      requiredDocuments: [],
      deadlineRuleId: 'inheritance-choice',
    },
    {
      id: 'collect-family-register',
      title: '戸籍謄本を収集する',
      summary: '相続人を確定するために、必要な範囲の戸籍を集めます。',
      // 窓口は役所だが、目的は相続人の調査。流れの上では「相続の調査」の段階に置く
      stage: 'investigation',
      category: '書類収集',
      submitTo: null,
      evidenceRequired: false,
      assetDisposal: false,
      requiredDocuments: [],
      deadlineRuleId: null,
    },
    {
      id: 'kyoukaikenpo-burial-benefit',
      title: '健康保険の埋葬料（費）を確認する',
      summary: '協会けんぽの埋葬料（費）について、加入状況と申請者の関係に応じた必要書類を確認します。',
      stage: 'government',
      category: 'insurance-benefit',
      submitTo: '全国健康保険協会',
      evidenceRequired: true,
      assetDisposal: false,
      requiredDocuments: [],
      deadlineRuleId: null,
    },
  ],
}
