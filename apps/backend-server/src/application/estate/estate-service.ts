import type {
  Asset as AssetDto,
  ConfirmEstateItemRequest,
  ConfirmationRecord,
  CreateAssetRequest,
  CreateLiabilityRequest,
  Liability as LiabilityDto,
  UpdateAssetRequest,
  UpdateLiabilityRequest,
} from '@aftercare/public-contracts'
import {
  confirmEstateItem,
  createAsset,
  createLiability,
  updateAsset,
  updateLiability,
  type Asset,
  type AssetFields,
  type Confirmation,
  type Liability,
  type LiabilityFields,
} from '../../domain/estate/estate-item.js'
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

export interface EstateServiceDeps {
  assets: CaseScopedRepository<Asset>
  liabilities: CaseScopedRepository<Liability>
  memberships: CaseMembershipPort
  idempotency: IdempotencyStore
  audit: AuditLogPort
  clock: Clock
  ids: IdGenerator
}

function confirmationDto(c: Confirmation): ConfirmationRecord {
  return {
    state: c.state,
    confirmedAt: c.confirmedAt,
    confirmedBy: c.confirmedBy?.id ?? null,
    confirmedVersion: c.confirmedVersion,
  }
}

export function toAssetDto(a: Asset): AssetDto {
  return {
    id: a.id,
    caseId: a.caseId,
    name: a.name,
    kind: a.kind,
    ...(a.institution !== null && { institution: a.institution }),
    ...(a.amount !== null && { amount: a.amount }),
    currency: a.currency,
    source: a.provenance.source,
    confirmation: a.confirmation.state,
    confirmationRecord: confirmationDto(a.confirmation),
    taxAttention: a.taxAttention,
    ...(a.note !== null && { note: a.note }),
    version: a.version,
  }
}

export function toLiabilityDto(l: Liability): LiabilityDto {
  return {
    id: l.id,
    caseId: l.caseId,
    name: l.name,
    kind: l.kind,
    ...(l.creditor !== null && { creditor: l.creditor }),
    ...(l.amount !== null && { amount: l.amount }),
    currency: l.currency,
    source: l.provenance.source,
    confirmation: l.confirmation.state,
    confirmationRecord: confirmationDto(l.confirmation),
    ...(l.note !== null && { note: l.note }),
    version: l.version,
  }
}

function assetPatch(req: Partial<CreateAssetRequest>): Partial<AssetFields> {
  const p: Partial<AssetFields> = {}
  if (req.name !== undefined) p.name = req.name
  if (req.kind !== undefined) p.kind = req.kind
  if (req.institution !== undefined) p.institution = req.institution
  if (req.amount !== undefined) p.amount = req.amount
  if (req.taxAttention !== undefined) p.taxAttention = req.taxAttention
  if (req.note !== undefined) p.note = req.note
  return p
}

function liabilityPatch(req: Partial<CreateLiabilityRequest>): Partial<LiabilityFields> {
  const p: Partial<LiabilityFields> = {}
  if (req.name !== undefined) p.name = req.name
  if (req.kind !== undefined) p.kind = req.kind
  if (req.creditor !== undefined) p.creditor = req.creditor
  if (req.amount !== undefined) p.amount = req.amount
  if (req.note !== undefined) p.note = req.note
  return p
}

export class EstateService {
  constructor(private readonly deps: EstateServiceDeps) {}

  /* ---------- Assets ---------- */

  async listAssets(ctx: CommandContext, query: ListQuery): Promise<Page<AssetDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'READ')
    const page = await this.deps.assets.list(ctx.principal.tenantId, ctx.caseId, query)
    return { items: page.items.map(toAssetDto), nextCursor: page.nextCursor }
  }

  async createAsset(ctx: CommandContext, req: CreateAssetRequest): Promise<CommandResult<AssetDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, 'assets.create', req, async () => {
      const now = this.deps.clock.now()
      const asset = createAsset(this.meta(ctx, 'asset', now), {
        name: req.name,
        kind: req.kind,
        institution: req.institution ?? null,
        amount: req.amount ?? null,
        taxAttention: req.taxAttention ?? false,
        note: req.note ?? null,
      })
      await this.deps.assets.save(asset)
      await this.audit(ctx, 'asset.created', 'Asset', asset.id, now)
      return { statusCode: 201, body: toAssetDto(asset) }
    })
  }

  async updateAsset(ctx: CommandContext, assetId: string, req: UpdateAssetRequest): Promise<CommandResult<AssetDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, `assets.update:${assetId}`, req, async () => {
      const current = await this.loadAsset(ctx, assetId)
      assertVersion(current.version, req.expectedVersion)
      const now = this.deps.clock.now()
      const next = updateAsset(current, assetPatch(req), actorOf(ctx.principal), now)
      await this.deps.assets.save(next)
      await this.audit(ctx, 'asset.updated', 'Asset', assetId, now, {
        confirmationReset: current.confirmation.state === 'CONFIRMED' && next.confirmation.state === 'UNCONFIRMED',
      })
      return { statusCode: 200, body: toAssetDto(next) }
    })
  }

  async confirmAsset(
    ctx: CommandContext,
    assetId: string,
    req: ConfirmEstateItemRequest,
  ): Promise<CommandResult<AssetDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, `assets.confirm:${assetId}`, req, async () => {
      const current = await this.loadAsset(ctx, assetId)
      assertVersion(current.version, req.expectedVersion)
      const now = this.deps.clock.now()
      const next = confirmEstateItem(current, req.note ?? null, actorOf(ctx.principal), now)
      await this.deps.assets.save(next)
      await this.audit(ctx, 'asset.confirmed', 'Asset', assetId, now, { confirmedVersion: current.version })
      return { statusCode: 200, body: toAssetDto(next) }
    })
  }

  /* ---------- Liabilities ---------- */

  async listLiabilities(ctx: CommandContext, query: ListQuery): Promise<Page<LiabilityDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'READ')
    const page = await this.deps.liabilities.list(ctx.principal.tenantId, ctx.caseId, query)
    return { items: page.items.map(toLiabilityDto), nextCursor: page.nextCursor }
  }

  async createLiability(ctx: CommandContext, req: CreateLiabilityRequest): Promise<CommandResult<LiabilityDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, 'liabilities.create', req, async () => {
      const now = this.deps.clock.now()
      const liability = createLiability(this.meta(ctx, 'liab', now), {
        name: req.name,
        kind: req.kind,
        creditor: req.creditor ?? null,
        amount: req.amount ?? null,
        note: req.note ?? null,
      })
      await this.deps.liabilities.save(liability)
      await this.audit(ctx, 'liability.created', 'Liability', liability.id, now)
      return { statusCode: 201, body: toLiabilityDto(liability) }
    })
  }

  async updateLiability(
    ctx: CommandContext,
    liabilityId: string,
    req: UpdateLiabilityRequest,
  ): Promise<CommandResult<LiabilityDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, `liabilities.update:${liabilityId}`, req, async () => {
      const current = await this.loadLiability(ctx, liabilityId)
      assertVersion(current.version, req.expectedVersion)
      const now = this.deps.clock.now()
      const next = updateLiability(current, liabilityPatch(req), actorOf(ctx.principal), now)
      await this.deps.liabilities.save(next)
      await this.audit(ctx, 'liability.updated', 'Liability', liabilityId, now, {
        confirmationReset: current.confirmation.state === 'CONFIRMED' && next.confirmation.state === 'UNCONFIRMED',
      })
      return { statusCode: 200, body: toLiabilityDto(next) }
    })
  }

  async confirmLiability(
    ctx: CommandContext,
    liabilityId: string,
    req: ConfirmEstateItemRequest,
  ): Promise<CommandResult<LiabilityDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, `liabilities.confirm:${liabilityId}`, req, async () => {
      const current = await this.loadLiability(ctx, liabilityId)
      assertVersion(current.version, req.expectedVersion)
      const now = this.deps.clock.now()
      const next = confirmEstateItem(current, req.note ?? null, actorOf(ctx.principal), now)
      await this.deps.liabilities.save(next)
      await this.audit(ctx, 'liability.confirmed', 'Liability', liabilityId, now, {
        confirmedVersion: current.version,
      })
      return { statusCode: 200, body: toLiabilityDto(next) }
    })
  }

  /* ---------- helpers ---------- */

  private meta(ctx: CommandContext, prefix: string, now: string) {
    return {
      id: this.deps.ids.next(prefix),
      tenantId: ctx.principal.tenantId,
      caseId: ctx.caseId,
      actor: actorOf(ctx.principal),
      now,
    }
  }

  private async loadAsset(ctx: CommandContext, id: string): Promise<Asset> {
    const a = await this.deps.assets.findById(ctx.principal.tenantId, ctx.caseId, id)
    if (!a) throw notFound('Asset', id)
    return a
  }

  private async loadLiability(ctx: CommandContext, id: string): Promise<Liability> {
    const l = await this.deps.liabilities.findById(ctx.principal.tenantId, ctx.caseId, id)
    if (!l) throw notFound('Liability', id)
    return l
  }

  private audit(ctx: CommandContext, action: string, targetType: string, targetId: string, occurredAt: string, detail?: unknown) {
    return appendAudit(this.deps.audit, ctx, { action, targetType, targetId, occurredAt, ...(detail !== undefined && { detail }) })
  }
}
