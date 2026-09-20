import type {
  Benefit as BenefitDto,
  Contract as ContractDto,
  CreateBenefitRequest,
  CreateContractRequest,
  PolicyRecord,
  ProgressRecord,
  ReportProgressRequest,
  SetContractPolicyRequest,
  UpdateBenefitRequest,
  UpdateContractRequest,
} from '@aftercare/public-contracts'
import {
  createBenefit,
  createContract,
  reportBenefitProgress,
  reportContractProgress,
  setContractPolicy,
  updateBenefit,
  updateContract,
  type Benefit,
  type BenefitFields,
  type Contract,
  type ContractFields,
  type PolicyState,
  type ProgressState,
} from '../../domain/contract/contract.js'
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

export interface ContractServiceDeps {
  contracts: CaseScopedRepository<Contract>
  benefits: CaseScopedRepository<Benefit>
  memberships: CaseMembershipPort
  idempotency: IdempotencyStore
  audit: AuditLogPort
  clock: Clock
  ids: IdGenerator
}

function policyDto(p: PolicyState): PolicyRecord {
  return { decidedAt: p.decidedAt, decidedBy: p.decidedBy?.id ?? null, note: p.note }
}

function progressDto(p: ProgressState): ProgressRecord {
  return { reportedAt: p.reportedAt, reportedBy: p.reportedBy?.id ?? null, source: p.source, note: p.note }
}

export function toContractDto(c: Contract): ContractDto {
  return {
    id: c.id,
    caseId: c.caseId,
    name: c.name,
    kind: c.kind,
    ...(c.provider !== null && { provider: c.provider }),
    policy: c.policyState.policy,
    progress: c.progressState.progress,
    source: c.provenance.source,
    ...(c.guidance !== null && { guidance: c.guidance }),
    ...(c.note !== null && { note: c.note }),
    policyRecord: policyDto(c.policyState),
    progressRecord: progressDto(c.progressState),
    version: c.version,
  }
}

export function toBenefitDto(b: Benefit): BenefitDto {
  return {
    id: b.id,
    caseId: b.caseId,
    name: b.name,
    kind: b.kind,
    ...(b.provider !== null && { provider: b.provider }),
    ...(b.amount !== null && { amount: b.amount }),
    currency: b.currency,
    progress: b.progressState.progress,
    ...(b.note !== null && { note: b.note }),
    progressRecord: progressDto(b.progressState),
    version: b.version,
  }
}

function contractPatch(req: Partial<CreateContractRequest>): Partial<ContractFields> {
  const p: Partial<ContractFields> = {}
  if (req.name !== undefined) p.name = req.name
  if (req.kind !== undefined) p.kind = req.kind
  if (req.provider !== undefined) p.provider = req.provider
  if (req.note !== undefined) p.note = req.note
  return p
}

function benefitPatch(req: Partial<CreateBenefitRequest>): Partial<BenefitFields> {
  const p: Partial<BenefitFields> = {}
  if (req.name !== undefined) p.name = req.name
  if (req.kind !== undefined) p.kind = req.kind
  if (req.provider !== undefined) p.provider = req.provider
  if (req.amount !== undefined) p.amount = req.amount
  if (req.note !== undefined) p.note = req.note
  return p
}

export class ContractService {
  constructor(private readonly deps: ContractServiceDeps) {}

  /* ---------- Contracts ---------- */

  async listContracts(ctx: CommandContext, query: ListQuery): Promise<Page<ContractDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'READ')
    const page = await this.deps.contracts.list(ctx.principal.tenantId, ctx.caseId, query)
    return { items: page.items.map(toContractDto), nextCursor: page.nextCursor }
  }

  async createContract(ctx: CommandContext, req: CreateContractRequest): Promise<CommandResult<ContractDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, 'contracts.create', req, async () => {
      const now = this.deps.clock.now()
      const contract = createContract(this.meta(ctx, 'contract', now), {
        name: req.name,
        kind: req.kind,
        provider: req.provider ?? null,
        note: req.note ?? null,
      })
      await this.deps.contracts.save(contract)
      await this.audit(ctx, 'contract.created', 'Contract', contract.id, now)
      return { statusCode: 201, body: toContractDto(contract) }
    })
  }

  async updateContract(
    ctx: CommandContext,
    contractId: string,
    req: UpdateContractRequest,
  ): Promise<CommandResult<ContractDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, `contracts.update:${contractId}`, req, async () => {
      const current = await this.loadContract(ctx, contractId)
      assertVersion(current.version, req.expectedVersion)
      const now = this.deps.clock.now()
      const next = updateContract(current, contractPatch(req), actorOf(ctx.principal), now)
      await this.deps.contracts.save(next)
      await this.audit(ctx, 'contract.updated', 'Contract', contractId, now)
      return { statusCode: 200, body: toContractDto(next) }
    })
  }

  async setContractPolicy(
    ctx: CommandContext,
    contractId: string,
    req: SetContractPolicyRequest,
  ): Promise<CommandResult<ContractDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, `contracts.policy:${contractId}`, req, async () => {
      const current = await this.loadContract(ctx, contractId)
      assertVersion(current.version, req.expectedVersion)
      const now = this.deps.clock.now()
      const next = setContractPolicy(current, req.policy, req.note ?? null, actorOf(ctx.principal), now)
      await this.deps.contracts.save(next)
      await this.audit(ctx, 'contract.policy_set', 'Contract', contractId, now, {
        from: current.policyState.policy,
        to: req.policy,
      })
      return { statusCode: 200, body: toContractDto(next) }
    })
  }

  async reportContractProgress(
    ctx: CommandContext,
    contractId: string,
    req: ReportProgressRequest,
  ): Promise<CommandResult<ContractDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, `contracts.progress:${contractId}`, req, async () => {
      const current = await this.loadContract(ctx, contractId)
      assertVersion(current.version, req.expectedVersion)
      const now = this.deps.clock.now()
      const next = reportContractProgress(current, req.progress, req.note ?? null, actorOf(ctx.principal), now)
      await this.deps.contracts.save(next)
      await this.audit(ctx, 'contract.progress_reported', 'Contract', contractId, now, {
        from: current.progressState.progress,
        to: req.progress,
        source: 'USER_REPORTED',
      })
      return { statusCode: 200, body: toContractDto(next) }
    })
  }

  /* ---------- Benefits ---------- */

  async listBenefits(ctx: CommandContext, query: ListQuery): Promise<Page<BenefitDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'READ')
    const page = await this.deps.benefits.list(ctx.principal.tenantId, ctx.caseId, query)
    return { items: page.items.map(toBenefitDto), nextCursor: page.nextCursor }
  }

  async createBenefit(ctx: CommandContext, req: CreateBenefitRequest): Promise<CommandResult<BenefitDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, 'benefits.create', req, async () => {
      const now = this.deps.clock.now()
      const benefit = createBenefit(this.meta(ctx, 'benefit', now), {
        name: req.name,
        kind: req.kind,
        provider: req.provider ?? null,
        amount: req.amount ?? null,
        note: req.note ?? null,
      })
      await this.deps.benefits.save(benefit)
      await this.audit(ctx, 'benefit.created', 'Benefit', benefit.id, now)
      return { statusCode: 201, body: toBenefitDto(benefit) }
    })
  }

  async updateBenefit(
    ctx: CommandContext,
    benefitId: string,
    req: UpdateBenefitRequest,
  ): Promise<CommandResult<BenefitDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, `benefits.update:${benefitId}`, req, async () => {
      const current = await this.loadBenefit(ctx, benefitId)
      assertVersion(current.version, req.expectedVersion)
      const now = this.deps.clock.now()
      const next = updateBenefit(current, benefitPatch(req), actorOf(ctx.principal), now)
      await this.deps.benefits.save(next)
      await this.audit(ctx, 'benefit.updated', 'Benefit', benefitId, now)
      return { statusCode: 200, body: toBenefitDto(next) }
    })
  }

  async reportBenefitProgress(
    ctx: CommandContext,
    benefitId: string,
    req: ReportProgressRequest,
  ): Promise<CommandResult<BenefitDto>> {
    await authorizeCase(ctx, this.deps.memberships, 'WRITE')
    return runIdempotent(ctx, this.deps.idempotency, `benefits.progress:${benefitId}`, req, async () => {
      const current = await this.loadBenefit(ctx, benefitId)
      assertVersion(current.version, req.expectedVersion)
      const now = this.deps.clock.now()
      const next = reportBenefitProgress(current, req.progress, req.note ?? null, actorOf(ctx.principal), now)
      await this.deps.benefits.save(next)
      await this.audit(ctx, 'benefit.progress_reported', 'Benefit', benefitId, now, {
        from: current.progressState.progress,
        to: req.progress,
        source: 'USER_REPORTED',
      })
      return { statusCode: 200, body: toBenefitDto(next) }
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

  private async loadContract(ctx: CommandContext, id: string): Promise<Contract> {
    const c = await this.deps.contracts.findById(ctx.principal.tenantId, ctx.caseId, id)
    if (!c) throw notFound('Contract', id)
    return c
  }

  private async loadBenefit(ctx: CommandContext, id: string): Promise<Benefit> {
    const b = await this.deps.benefits.findById(ctx.principal.tenantId, ctx.caseId, id)
    if (!b) throw notFound('Benefit', id)
    return b
  }

  private audit(
    ctx: CommandContext,
    action: string,
    targetType: string,
    targetId: string,
    occurredAt: string,
    detail?: unknown,
  ) {
    return appendAudit(this.deps.audit, ctx, {
      action,
      targetType,
      targetId,
      occurredAt,
      ...(detail !== undefined && { detail }),
    })
  }
}
