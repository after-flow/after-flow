import type { RuleCatalog } from './rule-engine.js'

/**
 * 開発・試験用の仮ルール。
 *
 * `placeholder: true`（手続き網羅性・文言は未承認、業務レビュー待ち）
 * だが、以下の2ルールは条文だけで一意に定まる `STATUTORY` な期限であり、
 * 実装者が条文原文（`sourceUrl`）と照合して `reviewed: true` にしてある
 * （`reviewed` の意味は `infrastructure/rules/rule-config.ts` を参照）。
 * それ以外の未レビューのルールからは確定した期限を出さない。
 *
 * 業務レビューを経た正式な定義は設定ファイル（`DEADLINE_RULES_PATH`）から
 * 読み込む。本番では `placeholder: true` のカタログを拒否する。
 *
 * このカタログは申し送り3-3のうち死亡届・相続方法の選択（民法915条）だけを
 * 対応する。年金の受給停止（厚生年金10日・国民年金14日）、準確定申告・
 * 相続税・相続登記の起算日を KNOWN_AT にする対応、国外死亡時の戸籍法86条
 * 1項後段（3か月）は未対応（後続ユニット）。
 */
export const PLACEHOLDER_RULE_CATALOG: RuleCatalog = {
  placeholder: true,
  deadlineRules: [
    {
      id: 'death-notification',
      version: '1.0.0',
      label: '死亡届の提出期限',
      // 戸籍法86条1項の起算日は「死亡の事実を知った日」（届出義務者の認識）。
      // Case.knownAt は民法915条の「自己のために相続の開始があったことを
      // 知った時」で、本来は別の事実。両者は多くの場合一致するため、モック
      // （apps/web/src/mocks/rules.ts）と同じ判断でここでも流用するが、
      // 厳密には異なりうる（業務レビューで要確認）。
      basis: 'KNOWN_AT',
      // 戸籍法86条1項「死亡の事実を知った日から7日以内」+ 同法43条1項の初日算入。
      period: { unit: 'DAY', count: 7, includeFirstDay: true },
      basisLabel: '亡くなったことを知った日から7日以内（その日を含めて数えます）',
      legalNature: 'STATUTORY',
      jurisdiction: '全国',
      reviewed: true,
      sourceUrl: 'https://laws.e-gov.go.jp/law/322AC0000000224',
      sourceCheckedAt: '2026-09-21T00:00:00+09:00',
      extendable: false,
      critical: true,
    },
    {
      id: 'inheritance-choice',
      version: '1.0.0',
      label: '相続方法の選択期限',
      basis: 'KNOWN_AT',
      // 民法915条1項「自己のために相続の開始があったことを知った時から3箇月以内」。
      period: { unit: 'MONTH', count: 3, includeFirstDay: false },
      basisLabel: '自分のために相続が始まったと知った日の翌日から数えて3か月以内（家庭裁判所に申し立てて延ばせる場合があります）',
      legalNature: 'STATUTORY',
      jurisdiction: '全国',
      reviewed: true,
      sourceUrl: 'https://laws.e-gov.go.jp/law/129AC0000000089',
      sourceCheckedAt: '2026-09-21T00:00:00+09:00',
      extendable: true,
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
      stage: 'government',
      category: '書類収集',
      submitTo: null,
      evidenceRequired: false,
      assetDisposal: false,
      requiredDocuments: [],
      deadlineRuleId: null,
    },
  ],
  // Task側の期限（inheritance-choice）と同じルールから算定する。
  deliberationDeadlineRuleId: 'inheritance-choice',
}
