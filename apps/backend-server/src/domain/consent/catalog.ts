import type { ConsentCatalog } from './consent.js'

/**
 * 開発・試験用の仮カタログ。
 *
 * 文面と提供先は未確定のため、具体的な移転先・国名・事業者名を書かない。
 * `placeholder: true` により、この内容のまま本番で起動することはできない。
 * 本番では承認済みの文書を設定ファイルから読み込む。
 */
export const PLACEHOLDER_CATALOG: ConsentCatalog = {
  placeholder: true,
  documents: [
    {
      kind: 'TERMS',
      version: '0.0.0-draft',
      title: '利用規約（未確定の仮文面）',
      summary: ['本番の文面は未確定です。', '確定前の同意取得を本番の同意として扱いません。'],
      url: '/legal/terms',
      required: true,
    },
    {
      kind: 'PRIVACY',
      version: '0.0.0-draft',
      title: '個人情報の取扱い（未確定の仮文面）',
      summary: ['本番の文面は未確定です。', '取得項目と利用目的は業務側の承認後に確定します。'],
      url: '/legal/privacy',
      required: true,
    },
    {
      kind: 'CROSS_BORDER_AI',
      version: '0.0.0-draft',
      title: '外部AIへの提供（未確定の仮文面）',
      summary: [
        '提供先の事業者と所在国は未確定です。',
        'この同意が無くても、手続きと期限の管理は利用できます。書類の追加・AIへの相談・窓口の自動調査には同意が必要です。',
      ],
      url: '/legal/cross-border-ai',
      required: false,
    },
  ],
}
