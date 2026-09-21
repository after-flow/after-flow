import type {
  CreatePersonRequest,
  CreateRelationshipRequest,
  ExcludePersonRequest,
  ExcludeRelationshipRequest,
  Person as PersonDto,
  Relationship as RelationshipDto,
  UpdatePersonRequest,
  UpdateRelationshipRequest,
} from '@aftercare/public-contracts'
import {
  createPerson,
  createRelationship,
  defaultRoleFor,
  excludePerson,
  excludeRelationship,
  updatePerson,
  updateRelationship,
  type Person,
  type PersonFields,
  type PersonReferences,
  type Relationship,
} from '../../domain/person/person.js'
import { assertVersion, notFound } from '../../domain/shared/errors.js'
import { appendAudit } from '../audit.js'
import { authorizeCase } from '../authorization.js'
import { actorOf, type CommandContext } from '../context.js'
import { runIdempotent, type CommandResult } from '../idempotency.js'
import type {
  AuditLogPort,
  CaseMembershipPort,
  CaseScopedRepository,
  Clock,
  IdGenerator,
  IdempotencyStore,
  ListQuery,
  Page,
} from '../ports.js'

export interface PersonReferencePort {
  countReferences(tenantId: string, caseId: string, personId: string): Promise<PersonReferences>
}

export interface PersonServiceDeps {
  persons: CaseScopedRepository<Person>
  relationships: CaseScopedRepository<Relationship>
  references: PersonReferencePort
  memberships: CaseMembershipPort
  idempotency: IdempotencyStore
  audit: AuditLogPort
  clock: Clock
  ids: IdGenerator
}

export function toPersonDto(p: Person): PersonDto {
  return {
    id: p.id,
    caseId: p.caseId,
    name: p.name,
    ...(p.nameKana !== null && { nameKana: p.nameKana }),
    relationship: p.relationshipLabel,
    role: p.role,
    isHeir: p.isHeir,
    ...(p.dateOfBirth !== null && { dateOfBirth: p.dateOfBirth }),
    specialCircumstance: p.specialCircumstance,
    ...(p.contact !== null && { contact: p.contact }),
    ...(p.note !== null && { note: p.note }),
    version: p.version,
    excludedAt: p.excludedAt,
  }
}

export function toRelationshipDto(r: Relationship): RelationshipDto {
  return {
    id: r.id,
    caseId: r.caseId,
    fromPersonId: r.fromPersonId,
    toPersonId: r.toPersonId,
    kind: r.kind,
    ...(r.note !== null && { note: r.note }),
    version: r.version,
    excludedAt: r.excludedAt,
  }
}

function fieldsFromCreate(req: CreatePersonRequest): PersonFields {
  const isHeir = req.isHeir ?? false
  return {
    name: req.name,
    nameKana: req.nameKana ?? null,
    relationshipLabel: req.relationship,
    role: req.role ?? defaultRoleFor(isHeir),
    isHeir,
    dateOfBirth: req.dateOfBirth ?? null,
    specialCircumstance: req.specialCircumstance ?? null,
    contact: req.contact ?? null,
    note: req.note ?? null,
  }
}

function patchFromUpdate(req: UpdatePersonRequest): Partial<PersonFields> {
  const patch: Partial<PersonFields> = {}
  if (req.name !== undefined) patch.name = req.name
  if (req.nameKana !== undefined) patch.nameKana = req.nameKana
  if (req.relationship !== undefined) patch.relationshipLabel = req.relationship
  if (req.role !== undefined) patch.role = req.role
  if (req.isHeir !== undefined) patch.isHeir = req.isHeir
  if (req.dateOfBirth !== undefined) patch.dateOfBirth = req.dateOfBirth
  if (req.specialCircumstance !== undefined) patch.specialCircumstance = req.specialCircumstance
  if (req.contact !== undefined) patch.contact = req.contact
  if (req.note !== undefined) patch.note = req.note
  return patch
}

export class PersonService {
  constructor(private readonly deps: PersonServiceDeps) {}

  async listPersons(ctx: CommandContext, query: ListQuery): Promise<Page<PersonDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'READ')
    const page = await this.deps.persons.list(ctx.principal.tenantId, ctx.caseId, query)
    return { items: page.items.map(toPersonDto), nextCursor: page.nextCursor }
  }

  async createPerson(ctx: CommandContext, req: CreatePersonRequest): Promise<CommandResult<PersonDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, 'persons.create', req, async () => {
      const now = this.deps.clock.now()
      const person = createPerson(
        {
          id: this.deps.ids.next('person'),
          tenantId: ctx.principal.tenantId,
          caseId: ctx.caseId,
          actor: actorOf(ctx.principal),
          now,
        },
        fieldsFromCreate(req),
      )
      await this.deps.persons.save(person)
      await this.audit(ctx, 'person.created', 'Person', person.id, now)
      return { statusCode: 201, body: toPersonDto(person) }
    })
  }

  async updatePerson(
    ctx: CommandContext,
    personId: string,
    req: UpdatePersonRequest,
  ): Promise<CommandResult<PersonDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, `persons.update:${personId}`, req, async () => {
      const current = await this.loadPerson(ctx, personId)
      assertVersion(current.version, req.expectedVersion)
      const now = this.deps.clock.now()
      const next = updatePerson(current, patchFromUpdate(req), actorOf(ctx.principal), now)
      await this.deps.persons.save(next)
      await this.audit(ctx, 'person.updated', 'Person', personId, now, { fields: Object.keys(patchFromUpdate(req)) })
      return { statusCode: 200, body: toPersonDto(next) }
    })
  }

  async excludePerson(
    ctx: CommandContext,
    personId: string,
    req: ExcludePersonRequest,
  ): Promise<CommandResult<PersonDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, `persons.exclude:${personId}`, req, async () => {
      const current = await this.loadPerson(ctx, personId)
      assertVersion(current.version, req.expectedVersion)
      const refs = await this.deps.references.countReferences(ctx.principal.tenantId, ctx.caseId, personId)
      const now = this.deps.clock.now()
      const next = excludePerson(current, refs, req.reason ?? null, actorOf(ctx.principal), now)
      await this.deps.persons.save(next)
      await this.audit(ctx, 'person.excluded', 'Person', personId, now, { references: refs })
      return { statusCode: 200, body: toPersonDto(next) }
    })
  }

  async listRelationships(ctx: CommandContext, query: ListQuery): Promise<Page<RelationshipDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'READ')
    const page = await this.deps.relationships.list(ctx.principal.tenantId, ctx.caseId, query)
    return { items: page.items.map(toRelationshipDto), nextCursor: page.nextCursor }
  }

  async createRelationship(
    ctx: CommandContext,
    req: CreateRelationshipRequest,
  ): Promise<CommandResult<RelationshipDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, 'relationships.create', req, async () => {
      // 両端は必ず自Case内で解決する。他Caseの personId は「見つからない」として扱う
      const [from, to] = await Promise.all([
        this.loadPerson(ctx, req.fromPersonId),
        this.loadPerson(ctx, req.toPersonId),
      ])
      const now = this.deps.clock.now()
      const rel = createRelationship(
        {
          id: this.deps.ids.next('rel'),
          tenantId: ctx.principal.tenantId,
          caseId: ctx.caseId,
          actor: actorOf(ctx.principal),
          now,
        },
        { fromPersonId: req.fromPersonId, toPersonId: req.toPersonId, kind: req.kind, note: req.note ?? null },
        from,
        to,
      )
      await this.deps.relationships.save(rel)
      await this.audit(ctx, 'relationship.created', 'Relationship', rel.id, now)
      return { statusCode: 201, body: toRelationshipDto(rel) }
    })
  }

  async updateRelationship(
    ctx: CommandContext,
    relationshipId: string,
    req: UpdateRelationshipRequest,
  ): Promise<CommandResult<RelationshipDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, `relationships.update:${relationshipId}`, req, async () => {
      const current = await this.loadRelationship(ctx, relationshipId)
      assertVersion(current.version, req.expectedVersion)
      const now = this.deps.clock.now()
      const patch: Partial<Pick<Relationship, 'kind' | 'note'>> = {}
      if (req.kind !== undefined) patch.kind = req.kind
      if (req.note !== undefined) patch.note = req.note
      const next = updateRelationship(current, patch, actorOf(ctx.principal), now)
      await this.deps.relationships.save(next)
      await this.audit(ctx, 'relationship.updated', 'Relationship', relationshipId, now)
      return { statusCode: 200, body: toRelationshipDto(next) }
    })
  }

  async excludeRelationship(
    ctx: CommandContext,
    relationshipId: string,
    req: ExcludeRelationshipRequest,
  ): Promise<CommandResult<RelationshipDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, `relationships.exclude:${relationshipId}`, req, async () => {
      const current = await this.loadRelationship(ctx, relationshipId)
      assertVersion(current.version, req.expectedVersion)
      const now = this.deps.clock.now()
      const next = excludeRelationship(current, req.reason ?? null, actorOf(ctx.principal), now)
      await this.deps.relationships.save(next)
      await this.audit(ctx, 'relationship.excluded', 'Relationship', relationshipId, now)
      return { statusCode: 200, body: toRelationshipDto(next) }
    })
  }

  private audit(ctx: CommandContext, action: string, targetType: string, targetId: string, occurredAt: string, detail?: unknown) {
    return appendAudit(this.deps.audit, ctx, { action, targetType, targetId, occurredAt, ...(detail !== undefined && { detail }) })
  }

  private async loadPerson(ctx: CommandContext, personId: string): Promise<Person> {
    const p = await this.deps.persons.findById(ctx.principal.tenantId, ctx.caseId, personId)
    if (!p) throw notFound('Person', personId)
    return p
  }

  private async loadRelationship(ctx: CommandContext, id: string): Promise<Relationship> {
    const r = await this.deps.relationships.findById(ctx.principal.tenantId, ctx.caseId, id)
    if (!r) throw notFound('Relationship', id)
    return r
  }
}
