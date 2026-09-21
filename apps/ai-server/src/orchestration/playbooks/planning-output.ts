import { z } from 'zod'
import { internalId, planningRestrictionSchema, findProcedureDefinition } from '@aftercare/internal-contracts'
import { contentHash } from '../context/builder.js'
import type { CoreContext } from '../context/builder.js'
import type { SourceDocument } from '../research/sources.js'
import type { ProposalDraft } from '../actions/contracts.js'
import { actionIdFor } from '../actions/contracts.js'

export const reviewedTaskTemplateSchema = z.object({
  id: internalId, version: internalId, reviewedAt: z.string().datetime(), expiresAt: z.string().datetime(), reviewReference: z.string().min(1).max(500),
  /** 生成する Task の手続き定義。既存 Task・過去提案との重複判定と、案内 Context の投影に使う。 */
  procedureId: internalId,
  sourceCatalogIds: z.array(internalId).min(1).max(10),
  task: z.object({ title: z.string().min(1).max(120), summary: z.string().max(2000),
    stage: z.enum(['immediate', 'funeral', 'government', 'contracts', 'investigation', 'decision', 'division', 'transfer', 'tax', 'closing']),
    category: z.string().min(1).max(100), submitTo: z.string().min(1).max(200), evidenceRequired: z.boolean(), assetDisposal: z.literal(false),
  }).strict(),
  requiredDocuments: z.array(z.string().min(1).max(120)).max(20),
  /** Reviewed prerequisites only. Missing/unconfirmed facts never satisfy a prerequisite. */
  prerequisites: z.array(z.object({ group: z.string().min(1).max(40), field: z.string().min(1).max(80),
    value: z.union([z.string().max(200), z.number().finite(), z.boolean()]), state: z.enum(['confirmed', 'user_reported']) }).strict()).max(20),
}).strict().refine(template => findProcedureDefinition(template.procedureId) !== null, 'Unknown procedureId')
export type ReviewedTaskTemplate = z.infer<typeof reviewedTaskTemplateSchema>
export const planningDraftSchema = z.object({
  tasks: z.array(z.object({ templateId: internalId, sourceIds: z.array(internalId).min(1).max(10),
    dependencyTaskIds: z.array(internalId).max(20) }).strict()).max(10),
  questions: z.array(z.string().min(1).max(300)).max(10),
}).strict().refine(value => new Set(value.tasks.map(task => task.templateId)).size === value.tasks.length, 'Duplicate template')
export type PlanningDraft = z.infer<typeof planningDraftSchema>
export interface ValidatedPlan {
  proposals: { actionId: string; draft: ProposalDraft; dependencyTaskIds: string[]; requiredDocuments: string[] }[]
  questions: string[]
  skipped: { templateId: string; reason: 'EXISTING_TASK' | 'PREVIOUS_PROPOSAL' | 'PREREQUISITE_UNKNOWN' }[]
}
const normalize = (value: unknown) => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ja')
export function validatePlan(input: { runId: string; context: CoreContext; draft: PlanningDraft; templates: readonly ReviewedTaskTemplate[]; sources: readonly SourceDocument[] }): ValidatedPlan {
  const history = input.context.modelInput.planningHistory
  if (input.context.operation !== 'case_planning' || !history) throw new Error('Complete planning history is required')
  if (planningRestrictionSchema.parse(input.context.planningRestriction) !== null) {
    return { proposals: [], skipped: [], questions: ['この案件ではAIの手続き提案が停止されています。案件の管理者に停止理由と再開の可否を確認してください。'] }
  }
  const draft = planningDraftSchema.parse(input.draft)
  const templates = new Map(input.templates.map(value => { const template = reviewedTaskTemplateSchema.parse(value); return [template.id, template] }))
  if (templates.size !== input.templates.length) throw new Error('Duplicate reviewed template')
  const sources = new Map(input.sources.map(source => [source.id, source]))
  const tasks = new Map<string, Map<string, unknown>>()
  const versions = new Map<string, number>()
  for (const fact of input.context.modelInput.facts.filter(fact => fact.group === 'tasks')) {
    if (!tasks.has(fact.entityId)) tasks.set(fact.entityId, new Map())
    tasks.get(fact.entityId)!.set(fact.field, fact.value); versions.set(fact.entityId, fact.entityVersion)
  }
  const plan: ValidatedPlan = { proposals: [], skipped: [], questions: [...draft.questions] }
  for (const selection of draft.tasks) {
    const template = templates.get(selection.templateId)
    if (!template || Date.parse(template.reviewedAt) > Date.now() || Date.parse(template.expiresAt) <= Date.now()) throw new Error('Planning template is not current')
    for (const id of selection.sourceIds) {
      const source = sources.get(id)
      if (!source || !template.sourceCatalogIds.includes(source.catalogId) || source.issuer !== template.task.submitTo) throw new Error('Plan source does not match the reviewed procedure')
    }
    // 既存 Task は procedureId で照合する。procedureId を持たない Task にだけ、暫定的に表示名・提出先の一致を使う。
    const existingTask = [...tasks.values()].some(task => {
      const procedureId = task.get('procedureId')
      if (typeof procedureId === 'string') return procedureId === template.procedureId
      return normalize(task.get('title')) === normalize(template.task.title) && (!task.get('submitTo') || normalize(task.get('submitTo')) === normalize(template.task.submitTo))
    })
    if (existingTask) { plan.skipped.push({ templateId: template.id, reason: 'EXISTING_TASK' }); continue }
    const previousTarget = (entry: { targetProcedureId: string | null; targetTitle: string | null }) =>
      entry.targetProcedureId !== null ? entry.targetProcedureId === template.procedureId : normalize(entry.targetTitle) === normalize(template.task.title)
    if (history.proposals.some(proposal => proposal.kind === 'TASK_PROPOSAL' && previousTarget(proposal)) || history.versions.some(previousTarget)) {
      plan.skipped.push({ templateId: template.id, reason: 'PREVIOUS_PROPOSAL' }); continue
    }
    const groups = [...new Set(template.prerequisites.map(required => required.group))]
    const missingPrerequisite = groups.some(group => {
      const required = template.prerequisites.filter(item => item.group === group)
      const facts = input.context.modelInput.facts.filter(fact => fact.group === group)
      return ![...new Set(facts.map(fact => fact.entityId))].some(entityId => required.every(item =>
        facts.some(fact => fact.entityId === entityId && fact.field === item.field && fact.state === item.state && fact.value === item.value)))
    })
    if (missingPrerequisite) {
      plan.skipped.push({ templateId: template.id, reason: 'PREREQUISITE_UNKNOWN' })
      plan.questions.push(`「${template.task.title}」に必要な本人意思・前提情報が確認できません。現在の記録を確認してください。`)
      continue
    }
    if (new Set(selection.dependencyTaskIds).size !== selection.dependencyTaskIds.length || selection.dependencyTaskIds.some(id => !tasks.has(id))) throw new Error('Plan dependency is outside the current case')
    const checked = new Set<string>()
    const checkDependency = (id: string, path: Set<string>) => {
      if (path.has(id)) throw new Error('Plan dependencies contain a cycle')
      if (checked.has(id)) return
      const task = tasks.get(id)
      if (!task || checked.size >= 100) throw new Error('Dependency graph is incomplete')
      checked.add(id); const next = new Set(path); next.add(id)
      for (const dependency of z.array(internalId).max(100).parse(task.get('dependencyTaskIds') ?? [])) checkDependency(dependency, next)
    }
    for (const id of selection.dependencyTaskIds) checkDependency(id, new Set())
    // New-to-new references are not accepted until Backend returns formal Task IDs.
    const basis = selection.dependencyTaskIds.map(id => ({ type: 'TASK' as const, id, version: versions.get(id)!, label: String(tasks.get(id)!.get('procedureId') ?? id).slice(0, 120) }))
    const actionId = actionIdFor(input.runId, `planning-${template.version}`, template.id)
    plan.proposals.push({ actionId,
      draft: { kind: 'TASK_PROPOSAL', title: template.task.title, summary: template.task.summary, payload: { ...template.task, procedureId: template.procedureId, dependencyTaskIds: selection.dependencyTaskIds, requiredDocuments: template.requiredDocuments.map(label => ({ id: contentHash({ actionId, label }), label })) }, basis, assetDisposal: false },
      dependencyTaskIds: selection.dependencyTaskIds, requiredDocuments: template.requiredDocuments })
  }
  return plan
}
