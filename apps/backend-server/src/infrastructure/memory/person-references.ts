import type { PersonReferencePort } from '../../application/persons/person-service.js'
import type { PersonReferences } from '../../domain/person/person.js'

/**
 * Decision / Evidence / Audit からの参照数を返す暫定実装。
 * 各集約の永続化（#5, #15 等）が入るまで、登録された参照だけを数える。
 */
export class InMemoryPersonReferences implements PersonReferencePort {
  private readonly refs = new Map<string, PersonReferences>()

  private key(tenantId: string, caseId: string, personId: string) {
    return `${tenantId}/${caseId}/${personId}`
  }

  register(tenantId: string, caseId: string, personId: string, refs: Partial<PersonReferences>): void {
    const current = this.refs.get(this.key(tenantId, caseId, personId)) ?? {
      inheritanceDecisions: 0,
      evidences: 0,
      auditEntries: 0,
    }
    this.refs.set(this.key(tenantId, caseId, personId), { ...current, ...refs })
  }

  async countReferences(tenantId: string, caseId: string, personId: string): Promise<PersonReferences> {
    return (
      this.refs.get(this.key(tenantId, caseId, personId)) ?? {
        inheritanceDecisions: 0,
        evidences: 0,
        auditEntries: 0,
      }
    )
  }
}
