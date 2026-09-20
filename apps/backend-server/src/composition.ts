import { ContractService } from './application/contracts/contract-service.js'
import { EstateService } from './application/estate/estate-service.js'
import { PersonService } from './application/persons/person-service.js'
import type { CaseMembership } from './application/ports.js'
import type { Benefit, Contract } from './domain/contract/contract.js'
import type { Asset, Liability } from './domain/estate/estate-item.js'
import type { Person, Relationship } from './domain/person/person.js'
import {
  InMemoryAuditLog,
  InMemoryCaseRepository,
  InMemoryIdempotencyStore,
  InMemoryMembershipStore,
  SystemClock,
  UuidIdGenerator,
} from './infrastructure/memory/memory-adapters.js'
import { InMemoryPersonReferences } from './infrastructure/memory/person-references.js'
import {
  DevHeaderIdentityVerifier,
  UnconfiguredIdentityVerifier,
  type IdentityVerifier,
} from './presentation/middleware/auth.js'

export interface AppEnv {
  AUTH_MODE?: string
  /** dev-header モード用: "caseId:userId:ROLE,..." */
  DEV_CASE_MEMBERSHIPS?: string
  DEV_TENANT_ID?: string
}

export interface Container {
  identity: IdentityVerifier
  memberships: InMemoryMembershipStore
  audit: InMemoryAuditLog
  personReferences: InMemoryPersonReferences
  persons: InMemoryCaseRepository<Person>
  relationships: InMemoryCaseRepository<Relationship>
  personService: PersonService
  assets: InMemoryCaseRepository<Asset>
  liabilities: InMemoryCaseRepository<Liability>
  estateService: EstateService
  contracts: InMemoryCaseRepository<Contract>
  benefits: InMemoryCaseRepository<Benefit>
  contractService: ContractService
}

export function parseDevMemberships(spec: string | undefined, tenantId: string): CaseMembership[] {
  if (!spec) return []
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [caseId, userId, role] = entry.split(':')
      if (!caseId || !userId || !role || !['OWNER', 'MEMBER', 'PROFESSIONAL', 'VIEWER'].includes(role)) {
        throw new Error(`DEV_CASE_MEMBERSHIPS entry is invalid: ${entry}`)
      }
      return { tenantId, caseId, userId, role: role as CaseMembership['role'] }
    })
}

/**
 * 依存の組み立て。永続化は in-memory（Firestore は #5）、認証は
 * AUTH_MODE=dev-header のときだけ開発用ヘッダーを受け付け、それ以外は 503 で閉じる。
 */
export function createContainer(env: AppEnv = process.env): Container {
  const identity: IdentityVerifier =
    env.AUTH_MODE === 'dev-header' ? new DevHeaderIdentityVerifier() : new UnconfiguredIdentityVerifier()

  const memberships = new InMemoryMembershipStore()
  if (env.AUTH_MODE === 'dev-header') {
    for (const m of parseDevMemberships(env.DEV_CASE_MEMBERSHIPS, env.DEV_TENANT_ID ?? 'dev')) {
      memberships.grant(m)
    }
  }

  const shared = {
    memberships,
    idempotency: new InMemoryIdempotencyStore(),
    audit: new InMemoryAuditLog(),
    clock: new SystemClock(),
    ids: new UuidIdGenerator(),
  }

  const persons = new InMemoryCaseRepository<Person>()
  const relationships = new InMemoryCaseRepository<Relationship>()
  const personReferences = new InMemoryPersonReferences()
  const assets = new InMemoryCaseRepository<Asset>()
  const liabilities = new InMemoryCaseRepository<Liability>()
  const contracts = new InMemoryCaseRepository<Contract>()
  const benefits = new InMemoryCaseRepository<Benefit>()

  return {
    identity,
    memberships,
    audit: shared.audit,
    personReferences,
    persons,
    relationships,
    personService: new PersonService({ ...shared, persons, relationships, references: personReferences }),
    assets,
    liabilities,
    estateService: new EstateService({ ...shared, assets, liabilities }),
    contracts,
    benefits,
    contractService: new ContractService({ ...shared, contracts, benefits }),
  }
}
