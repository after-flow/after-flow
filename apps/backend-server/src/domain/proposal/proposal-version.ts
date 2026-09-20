import type { EntityBase } from '../shared/entity.js'
import type { ProposalEntity } from './proposal.js'

/** 状態・Entity版とは独立した、承認対象の内容の不変履歴。 */
export interface ProposalVersionEntity extends EntityBase {
  proposalId: string
  content: Omit<ProposalEntity, keyof EntityBase | 'status'>
}
