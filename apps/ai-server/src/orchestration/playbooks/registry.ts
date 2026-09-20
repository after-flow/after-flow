import { createHash } from 'node:crypto'
import { resolveSkills } from '../skills/catalog.js'
import type { AgentMode, SkillId, ToolCapability } from '../skills/catalog.js'

export interface PlaybookDefinition {
  id: string
  version: string
  mode: AgentMode
  jurisdiction: string
  goal: string
  requiredInputs: readonly string[]
  procedure: readonly string[]
  postconditions: readonly string[]
  forbiddenActions: readonly string[]
  coreSkillIds: readonly SkillId[]
  researchSkillIds: readonly SkillId[]
  allowedCapabilities: readonly ToolCapability[]
  ruleRefs: readonly string[]
  approvalPolicyRefs: readonly string[]
  evidenceRequirements: readonly string[]
  escalationConditions: readonly string[]
}

const shared = {
  version: '1', jurisdiction: 'Source Catalogで確認済みの機関・地域に限定',
  forbiddenActions: ['正式状態の直接変更', '本人Decision・承認の代行', '外部提出・送金・解約', '未検査書類の利用'],
  researchSkillIds: ['official-source-research', 'evidence-reconciliation'],
  ruleRefs: ['docs/architecture.md'], approvalPolicyRefs: ['docs/adr/0004-confirmation-path.md'],
  evidenceRequirements: ['回答項目と取得済み出典の対応', '対象機関・地域と適用条件', '取得日時と資料更新日の区別'],
  escalationConditions: ['根拠の矛盾を解消できない', '本人または専門家の判断が必要', '対応外の業務・地域・機関'],
} as const

const definitions: readonly PlaybookDefinition[] = [
  {
    ...shared, id: 'procedure-guidance', mode: 'guidance',
    goal: '一つの手続きの提出先・必要書類・手順と未確認事項を案内する',
    requiredInputs: ['対象手続き', '機関・地域', '最新の認可済みContext', 'Source Catalog'],
    coreSkillIds: ['case-assessment', 'research-briefing', 'grounded-guidance'],
    allowedCapabilities: ['research', 'search', 'read-source'],
    procedure: ['前提と不足情報を確認', '必要な範囲だけ調査', '根拠と適用条件を照合', '案内または確認質問'],
    postconditions: ['回答項目に根拠が対応する', '未確認項目を明示する', '正式状態を変更しない'],
  },
  {
    ...shared, id: 'document-review', mode: 'preparation',
    goal: '配信許可済み書類の抽出候補・矛盾・不足を整理する',
    requiredInputs: ['検査済み加工版と版・hash', '最新Context', '対象書類種別'],
    coreSkillIds: ['case-assessment', 'change-proposal'], allowedCapabilities: ['research', 'search', 'read-source', 'propose'],
    procedure: ['配信許可を確認', '箇所付き抽出候補を整理', '既存情報と照合', '許可された変更候補を提案'],
    postconditions: ['各候補に書類版と位置がある', '候補と確認済みを区別する', '正式反映はBackendで検証する'],
  },
  {
    ...shared, id: 'case-planning', mode: 'planning',
    goal: '既存の手動・Rule由来Taskを尊重して計画・依存関係を提案する',
    requiredInputs: ['最新Context', '既存Task・本人意思・訂正履歴', 'Backend Ruleの検証結果'],
    coreSkillIds: ['case-assessment', 'research-briefing', 'change-proposal'], allowedCapabilities: ['research', 'search', 'read-source', 'propose'],
    procedure: ['既存Taskと不足を照合', '対応範囲内で順序と依存関係を整理', '差分を提案', '承認と反映結果を確認'],
    postconditions: ['重複Taskを作らない', '法定期限をモデルで確定しない', '承認・反映・未反映を区別する'],
  },
  {
    ...shared, id: 'insurance-claim-preparation', mode: 'preparation',
    goal: '一つの確認済み保険手続きのチェックリスト・事実整理・質問事項を準備する',
    requiredInputs: ['確認済み対象機関資料', '契約と本人の方針', '配信許可済み書類', '最新Context'],
    coreSkillIds: ['case-assessment', 'research-briefing', 'grounded-guidance', 'change-proposal'],
    allowedCapabilities: ['research', 'search', 'read-source', 'propose'],
    procedure: ['対象範囲を確認', '必要資料と不足を整理', 'チェックリストと事実整理資料を提案', '人の確認と資料版を照合'],
    postconditions: ['未解決事項を明示する', '承認対象と生成物の版が一致する', '準備完了と外部申請完了を区別する'],
  },
]

// Definitions are not enabled routes. Runtime activation requires adapters and acceptance evidence.
export const playbooks = Object.freeze(definitions.map((definition) => {
  resolveSkills(definition.coreSkillIds, 'core', definition.mode, definition.allowedCapabilities)
  resolveSkills(definition.researchSkillIds, 'research', definition.mode, definition.allowedCapabilities)
  return Object.freeze({ ...definition, hash: createHash('sha256').update(JSON.stringify(definition)).digest('hex') })
}))

export function getPlaybook(id: string, version: string) {
  const playbook = playbooks.find((entry) => entry.id === id && entry.version === version)
  if (!playbook) throw new Error('Unknown playbook version')
  return playbook
}
