import { z } from 'zod'
import { createAsset, createLiability, updateAsset, updateLiability, UNCONFIRMED } from '../../domain/estate/estate-item.js'
import type { Asset, Liability } from '../../domain/estate/estate-item.js'
import { createContract, updateContract, type Contract } from '../../domain/contract/contract.js'
import { createPerson, updatePerson, type Person } from '../../domain/person/person.js'
import type { CaseEntity } from '../../domain/shared/types.js'
import type { EntityBase } from '../../domain/shared/entity.js'
import { collections, type CollectionDescriptor } from '../../domain/shared/collections.js'
import { errors } from '../../shared/app-error.js'
import type { Tx } from '../ports/persistence.js'
import type { ProposalApplier } from './proposal-service.js'

const text = z.string().min(1).max(200).refine(value => value.trim().length > 0)
const nullableText = z.string().max(200).nullable()
const note = z.string().max(2000).nullable()
const amount = z.number().int().min(0).lt(1_000_000_000_000_000).nullable()
const assetFields = z.object({ name: text, kind: z.enum(['BANK', 'REAL_ESTATE', 'SECURITIES', 'CRYPTO', 'VEHICLE', 'OTHER']),
  institution: nullableText, amount, taxAttention: z.boolean(), note }).strict()
const liabilityFields = z.object({ name: text, kind: z.enum(['LOAN', 'CREDIT', 'TAX', 'GUARANTEE', 'OTHER']),
  creditor: nullableText, amount, note }).strict()
const contractFields = z.object({ name: text, kind: z.enum(['UTILITY', 'TELECOM', 'SUBSCRIPTION', 'INSURANCE', 'PENSION', 'OTHER']),
  provider: nullableText, note }).strict()
const personFields = z.object({ name: text, nameKana: nullableText, relationshipLabel: z.string().max(200),
  role: z.enum(['HEIR_CANDIDATE', 'DECEASED', 'RELATED', 'PROFESSIONAL']), isHeir: z.boolean(),
  dateOfBirth: z.iso.date().nullable(), specialCircumstance: z.enum(['MINOR', 'MISSING', 'CAPACITY_CONCERN']).nullable(),
  contact: nullableText, note }).strict().refine(value => value.role !== 'DECEASED' || !value.isHeir)

/** 省略からの推測をしない。CREATE/UPDATEとも承認対象の全入力値を明示する。 */
function payloadSchema<T extends z.ZodType>(fields: T) {
  return z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('CREATE'), fields }).strict(),
    z.object({ operation: z.literal('UPDATE'), targetId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
      expectedVersion: z.number().int().positive(), fields }).strict(),
  ])
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw errors.validationFailed({ details: { reason: 'INVALID_PROPOSAL_PAYLOAD' } })
  return result.data
}

function writeEntity<T extends CaseEntity>(tx: Tx, collection: CollectionDescriptor, entity: T, creating: boolean): void {
  const { id, tenantId: _tenant, caseId, version, createdAt: _created, updatedAt: _updated, ...fields } = entity
  delete (fields as { schemaVersion?: number }).schemaVersion
  const location = { collection, caseId, id }
  // 版・所属・時刻はUnitOfWorkが管理する。Domainで検証された業務フィールドだけを渡す。
  if (creating) tx.create<T & EntityBase>(location, { id, ...fields } as Omit<T & EntityBase, keyof EntityBase> & { id: string })
  else tx.update<T & EntityBase>(location, version - 1, fields as Partial<Omit<T & EntityBase, keyof EntityBase>>)
}

type Context = Parameters<ProposalApplier['apply']>[1]
function metadata(context: Context) {
  return { id: `proposal-${context.proposal.id}-${context.proposal.proposalVersion}`,
    tenantId: context.proposal.tenantId, caseId: context.caseId,
    actor: { kind: 'USER' as const, id: context.userId }, now: new Date().toISOString() }
}

async function current<T extends CaseEntity>(tx: Tx, context: Context, collection: CollectionDescriptor,
  target: { targetId: string; expectedVersion: number }): Promise<T> {
  const entity = await tx.require<T & EntityBase>({ collection, caseId: context.caseId, id: target.targetId })
  if (entity.version !== target.expectedVersion) {
    throw errors.conflict({ details: { reason: 'TARGET_VERSION_CHANGED' },
      internal: { staleProposalId: context.proposal.id, staleProposalEntityVersion: context.proposal.version } })
  }
  return entity
}

function provenance(context: Context) {
  return { source: context.proposal.source === 'AI' ? 'AI' as const : 'MANUAL' as const,
    agentRunId: context.proposal.agentRunId, proposalId: context.proposal.id }
}

function audited(tx: Tx, context: Context, collection: CollectionDescriptor, entity: CaseEntity) {
  tx.audit({ caseId: context.caseId, type: `${collection.name}.applied_from_proposal`,
    target: { collection: collection.name, id: entity.id, version: entity.version },
    detail: { proposalId: context.proposal.id, proposalVersion: context.proposal.proposalVersion,
      payloadHash: context.proposal.payloadHash, source: context.proposal.source } })
}

const assetSchema = payloadSchema(assetFields)
const liabilitySchema = payloadSchema(liabilityFields)
const contractSchema = payloadSchema(contractFields)
const personSchema = payloadSchema(personFields)

export const entityProposalAppliers: ProposalApplier[] = [
  { kind: 'ASSET_PROPOSAL', validate: value => { parse(assetSchema, value) }, async apply(tx, context) {
    const p = parse(assetSchema, context.proposal.payload)
    const meta = metadata(context)
    const entity = p.operation === 'CREATE' ? createAsset(meta, p.fields)
      : updateAsset(await current<Asset>(tx, context, collections.assets, p), p.fields, meta.actor, meta.now)
    entity.provenance = provenance(context)
    entity.confirmation = UNCONFIRMED
    writeEntity(tx, collections.assets, entity, p.operation === 'CREATE')
    audited(tx, context, collections.assets, entity)
  } },
  { kind: 'LIABILITY_PROPOSAL', validate: value => { parse(liabilitySchema, value) }, async apply(tx, context) {
    const p = parse(liabilitySchema, context.proposal.payload)
    const meta = metadata(context)
    const entity = p.operation === 'CREATE' ? createLiability(meta, p.fields)
      : updateLiability(await current<Liability>(tx, context, collections.liabilities, p), p.fields, meta.actor, meta.now)
    entity.provenance = provenance(context)
    entity.confirmation = UNCONFIRMED
    writeEntity(tx, collections.liabilities, entity, p.operation === 'CREATE')
    audited(tx, context, collections.liabilities, entity)
  } },
  { kind: 'CONTRACT_PROPOSAL', validate: value => { parse(contractSchema, value) }, async apply(tx, context) {
    const p = parse(contractSchema, context.proposal.payload)
    const meta = metadata(context)
    const entity = p.operation === 'CREATE' ? createContract(meta, p.fields)
      : updateContract(await current<Contract>(tx, context, collections.contracts, p), p.fields, meta.actor, meta.now)
    entity.provenance = provenance(context)
    writeEntity(tx, collections.contracts, entity, p.operation === 'CREATE')
    audited(tx, context, collections.contracts, entity)
  } },
  { kind: 'PERSON_PROPOSAL', validate: value => { parse(personSchema, value) }, async apply(tx, context) {
    const p = parse(personSchema, context.proposal.payload)
    const meta = metadata(context)
    const entity = p.operation === 'CREATE' ? createPerson(meta, p.fields)
      : updatePerson(await current<Person>(tx, context, collections.persons, p), p.fields, meta.actor, meta.now)
    writeEntity(tx, collections.persons, entity, p.operation === 'CREATE')
    audited(tx, context, collections.persons, entity)
  } },
]
