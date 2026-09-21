import type { CaseService } from '../../../../application/case/case-service.js'
import type { ConsentService } from '../../../../application/consent/consent-service.js'
import type { DocumentService } from '../../../../application/document/document-service.js'
import type { AgentRunService } from '../../../../application/agent/agent-run-service.js'
import type { InheritanceDecisionService } from '../../../../application/decision/decision-service.js'
import type { MessageService } from '../../../../application/chat/message-service.js'
import type { CaseOverviewService } from '../../../../application/overview/overview-service.js'
import type { ProposalService } from '../../../../application/proposal/proposal-service.js'
import type { TaskService } from '../../../../application/task/task-service.js'
import { errors } from '../../../../shared/app-error.js'
import type { RegisteredRoute, RouteSpec } from '../../../http/route.js'
import { defineRoute } from '../../../http/route.js'
import { caseSpecs, createCaseRoutes } from './cases.js'
import { consentSpecs, createConsentRoutes } from './consents.js'
import { createDocumentRoutes, documentSpecs } from './documents.js'
import { agentRunSpecs, createAgentRunRoutes } from './agent-runs.js'
import { createMessageRoutes, messageSpecs } from './messages.js'
import { createOverviewRoutes, overviewSpecs } from './overview.js'
import { createProposalRoutes, proposalSpecs } from './proposals.js'
import { createTaskRoutes, taskSpecs } from './tasks.js'
import type { PersonService } from '../../../../application/persons/person-service.js'
import { personsSpecs, createPersonRoutes } from './persons.js'
import type { EstateService } from '../../../../application/estate/estate-service.js'
import { estateSpecs, createEstateRoutes } from './estate.js'
import type { ContractService } from '../../../../application/contracts/contract-service.js'
import { contractsSpecs, createContractRoutes } from './contracts.js'
import type { InsightService } from '../../../../application/insights/insight-service.js'
import { insightsSpecs, createInsightRoutes } from './insights.js'
import { healthRoute, healthSpec } from './health.js'

/**
 * 公開 API v1 の契約一覧。
 *
 * OpenAPI の生成と契約試験はこの配列を唯一の入力にする。
 * 実行時の依存を持たないため、Firestore や認証の設定が無くても生成できる。
 */
export const publicV1Specs: RouteSpec[] = [
  healthSpec,
  ...Object.values(personsSpecs),
  ...Object.values(estateSpecs),
  ...Object.values(contractsSpecs),
  ...Object.values(insightsSpecs),
  consentSpecs.getConsents,
  consentSpecs.agreeConsents,
  consentSpecs.revokeConsent,
  caseSpecs.createCase,
  caseSpecs.listCases,
  caseSpecs.getCase,
  caseSpecs.updateCase,
  documentSpecs.registerDocument,
  documentSpecs.listDocuments,
  documentSpecs.getDocument,
  documentSpecs.getDocumentContent,
  documentSpecs.archiveDocument,
  taskSpecs.listTasks,
  taskSpecs.createTask,
  taskSpecs.initializeTasks,
  taskSpecs.getTask,
  taskSpecs.updateTask,
  taskSpecs.runTaskCommand,
  taskSpecs.createEvidence,
  taskSpecs.listDeadlines,
  taskSpecs.reevaluateDeadlines,
  agentRunSpecs.acceptAgentRun,
  agentRunSpecs.listAgentRuns,
  agentRunSpecs.getAgentRun,
  agentRunSpecs.listAgentRunEvents,
  agentRunSpecs.cancelAgentRun,
  agentRunSpecs.retryAgentRun,
  ...Object.values(proposalSpecs),
  messageSpecs.listMessages,
  messageSpecs.postMessage,
  messageSpecs.getTaskGuidance,
  messageSpecs.requestTaskGuidance,
  overviewSpecs.getCaseOverview,
]

export interface PublicRouteDependencies {
  personService: PersonService
  estateService: EstateService
  contractService: ContractService
  insightService: InsightService
  caseService: CaseService
  consentService: ConsentService
  documentService: DocumentService | null
  taskService: TaskService
  agentRunService: AgentRunService
  proposalService: ProposalService
  decisionService: InheritanceDecisionService
  messageService: MessageService
  overviewService: CaseOverviewService
}

/**
 * 業務機能が接続されていない場合の route。
 *
 * 契約には存在するが実機能が無い状態を、404 や空配列で隠さない。
 * 「まだ接続されていない」と理由付きで返す。
 */
function notConnected(specs: RouteSpec[], reason = 'business database is not configured'): RegisteredRoute[] {
  return specs.map((spec) =>
    defineRoute(spec, () => {
      throw errors.featureNotConnected({
        details: { operation: spec.operationId, reason },
      })
    }),
  )
}

export function createPublicV1Routes(
  dependencies: PublicRouteDependencies | null,
): RegisteredRoute[] {
  if (!dependencies) {
    return [healthRoute, ...notConnected(publicV1Specs.filter((spec) => spec !== healthSpec))]
  }
  return [
    healthRoute,
    ...createPersonRoutes(dependencies.personService),
    ...createEstateRoutes(dependencies.estateService),
    ...createContractRoutes(dependencies.contractService),
    ...createInsightRoutes(dependencies.insightService),
    ...createConsentRoutes(dependencies.consentService),
    ...createCaseRoutes(dependencies.caseService),
    ...(dependencies.documentService
      ? createDocumentRoutes(dependencies.documentService)
      : notConnected(Object.values(documentSpecs), 'document storage is not configured')),
    ...createTaskRoutes(dependencies.taskService),
    ...createAgentRunRoutes(dependencies.agentRunService),
    ...createProposalRoutes(dependencies.proposalService, dependencies.decisionService),
    ...createMessageRoutes(dependencies.messageService),
    ...createOverviewRoutes(dependencies.overviewService),
  ]
}
