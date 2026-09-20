import { z } from 'zod'
import type { InheritanceDecisionService } from '../../../../application/decision/decision-service.js'
import type { ProposalService } from '../../../../application/proposal/proposal-service.js'
import { fingerprintOf } from '../../../../shared/fingerprint.js'
import { requireUser } from '../../../http/authentication.js'
import type { AppContext } from '../../../http/context.js'
import { ok } from '../../../http/envelope.js'
import type { RegisteredRoute, RouteSpec } from '../../../http/route.js'
import { defineRoute } from '../../../http/route.js'
import { caseIdParamsSchema } from '../../../schemas/case.js'
import { listQuerySchema, successEnvelope } from '../../../schemas/common.js'
import {
  approvalIdParamsSchema,
  approvalResourceSchema,
  approveBodySchema,
  confirmDecisionBodySchema,
  inheritanceDecisionResourceSchema,
  personIdParamsSchema,
  proposalIdParamsSchema,
  proposalResourceSchema,
  recordDecisionBodySchema,
  rejectBodySchema,
  requestApprovalBodySchema,
  reviseProposalBodySchema,
  submitProposalBodySchema,
} from '../../../schemas/proposal.js'

const proposalEnvelope = successEnvelope(proposalResourceSchema)
const proposalListEnvelope = successEnvelope(z.array(proposalResourceSchema))
const approvalEnvelope = successEnvelope(approvalResourceSchema)
const approvalListEnvelope = successEnvelope(z.array(approvalResourceSchema))
const decisionEnvelope = successEnvelope(inheritanceDecisionResourceSchema)
const decisionListEnvelope = successEnvelope(z.array(inheritanceDecisionResourceSchema))

const COMMON_FAILURES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONSENT_REQUIRED',
] as const

export const proposalSpecs = {
  submitProposal: {
    operationId: 'submitProposal',
    method: 'post',
    path: '/cases/:caseId/proposals',
    summary: '提案を提出する',
    description:
      '誰が出した提案でも同じ経路を通る。根拠が同じ案件に属し、参照した版のままであることを検証する。',
    tags: ['proposals'],
    auth: 'user',
    request: { params: caseIdParamsSchema, body: submitProposalBodySchema },
    success: { status: 201, description: '提出した提案', schema: proposalEnvelope },
    failures: [...COMMON_FAILURES, 'CONFLICT', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required',
  },
  listProposals: {
    operationId: 'listProposals',
    method: 'get',
    path: '/cases/:caseId/proposals',
    summary: '提案の一覧',
    tags: ['proposals'],
    auth: 'user',
    request: { params: caseIdParamsSchema, query: listQuerySchema },
    success: { status: 200, description: '提案の一覧', schema: proposalListEnvelope },
    failures: [...COMMON_FAILURES],
    list: true,
  },
  getProposal: {
    operationId: 'getProposal',
    method: 'get',
    path: '/cases/:caseId/proposals/:proposalId',
    summary: '提案の詳細',
    tags: ['proposals'],
    auth: 'user',
    request: { params: proposalIdParamsSchema },
    success: { status: 200, description: '提案', schema: proposalEnvelope },
    failures: [...COMMON_FAILURES],
  },
  reviseProposal: {
    operationId: 'reviseProposal',
    method: 'patch',
    path: '/cases/:caseId/proposals/:proposalId',
    summary: '提案の内容を訂正する',
    description:
      '既存の版の内容は書き換えない。新しい版とhashを作り、対象を失った承認は期限切れになる。人は新しい版を承認する。',
    tags: ['proposals'],
    auth: 'user',
    request: { params: proposalIdParamsSchema, body: reviseProposalBodySchema },
    success: { status: 200, description: '訂正後の提案', schema: proposalEnvelope },
    failures: [...COMMON_FAILURES, 'CONFLICT', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED'],
    expectedVersion: 'required',
    idempotency: 'optional',
  },
  requestApproval: {
    operationId: 'requestApproval',
    method: 'post',
    path: '/cases/:caseId/proposals/:proposalId/approval-requests',
    summary: '提案の承認を依頼する',
    tags: ['proposals'],
    auth: 'user',
    request: { params: proposalIdParamsSchema, body: requestApprovalBodySchema },
    success: { status: 201, description: '作成した承認', schema: approvalEnvelope },
    failures: [...COMMON_FAILURES, 'CONFLICT', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'IDEMPOTENCY_KEY_REUSED'],
    expectedVersion: 'required',
    idempotency: 'required',
  },
  listApprovals: {
    operationId: 'listApprovals',
    method: 'get',
    path: '/cases/:caseId/approvals',
    summary: '承認の一覧',
    description: '承認の受付状況と、業務状態への反映状況を別に返す。',
    tags: ['proposals'],
    auth: 'user',
    request: { params: caseIdParamsSchema, query: listQuerySchema },
    success: { status: 200, description: '承認の一覧', schema: approvalListEnvelope },
    failures: [...COMMON_FAILURES],
    list: true,
  },
  getApproval: {
    operationId: 'getApproval',
    method: 'get',
    path: '/cases/:caseId/approvals/:approvalId',
    summary: '承認の詳細',
    tags: ['proposals'],
    auth: 'user',
    request: { params: approvalIdParamsSchema },
    success: { status: 200, description: '承認', schema: approvalEnvelope },
    failures: [...COMMON_FAILURES],
  },
  approve: {
    operationId: 'approveProposal',
    method: 'post',
    path: '/cases/:caseId/approvals/:approvalId/approve',
    summary: '承認して反映する',
    description:
      '見た内容の版とhashを指定する。承認後に最新の状態と根拠を再検証し、同じTransactionで反映する。承認の受付だけで反映済みとは返さない。',
    tags: ['proposals'],
    auth: 'user',
    request: { params: approvalIdParamsSchema, body: approveBodySchema },
    success: { status: 200, description: '承認と反映の結果', schema: approvalEnvelope },
    failures: [
      ...COMMON_FAILURES,
      'CONFLICT',
      'PRECONDITION_REQUIRED',
      'PRECONDITION_FAILED',
      'FEATURE_NOT_CONNECTED',
    ],
    expectedVersion: 'required',
    idempotency: 'optional',
  },
  reject: {
    operationId: 'rejectProposal',
    method: 'post',
    path: '/cases/:caseId/approvals/:approvalId/reject',
    summary: '承認を却下する',
    tags: ['proposals'],
    auth: 'user',
    request: { params: approvalIdParamsSchema, body: rejectBodySchema },
    success: { status: 200, description: '却下後の承認', schema: approvalEnvelope },
    failures: [...COMMON_FAILURES, 'CONFLICT', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED'],
    expectedVersion: 'required',
    idempotency: 'optional',
  },
  listDecisions: {
    operationId: 'listInheritanceDecisions',
    method: 'get',
    path: '/cases/:caseId/inheritance-decisions',
    summary: '相続方法の確定状況',
    description: '下書き・本人以外による報告・本人による確定を区別して返す。',
    tags: ['decisions'],
    auth: 'user',
    request: { params: caseIdParamsSchema },
    success: { status: 200, description: '確定状況', schema: decisionListEnvelope },
    failures: [...COMMON_FAILURES],
  },
  recordDecision: {
    operationId: 'recordInheritanceDecision',
    method: 'post',
    path: '/cases/:caseId/inheritance-decisions/:personId',
    summary: '相続方法の下書きまたは報告を記録する',
    description: '本人の確定ではない。確定は本人だけが行える。',
    tags: ['decisions'],
    auth: 'user',
    request: { params: personIdParamsSchema, body: recordDecisionBodySchema },
    success: { status: 200, description: '記録後の状況', schema: decisionEnvelope },
    failures: [...COMMON_FAILURES, 'CONFLICT', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'IDEMPOTENCY_KEY_REUSED'],
    idempotency: 'required',
  },
  confirmDecision: {
    operationId: 'confirmInheritanceDecision',
    method: 'post',
    path: '/cases/:caseId/inheritance-decisions/:personId/confirm',
    summary: '相続方法を本人として確定する',
    description:
      '本人と紐付くmembershipだけが行える。案件の所有者でも、他の家族の意思を本人として確定できない。',
    tags: ['decisions'],
    auth: 'user',
    request: { params: personIdParamsSchema, body: confirmDecisionBodySchema },
    success: { status: 200, description: '確定後の状況', schema: decisionEnvelope },
    failures: [...COMMON_FAILURES, 'CONFLICT', 'PRECONDITION_REQUIRED'],
    expectedVersion: 'required',
    idempotency: 'optional',
  },
} satisfies Record<string, RouteSpec>

function commandMeta(c: AppContext, idempotencyKey: string | null, body: unknown) {
  return {
    requestId: c.get('requestId') ?? null,
    idempotency: idempotencyKey ? { key: idempotencyKey, fingerprint: fingerprintOf(body) } : null,
  }
}

export function createProposalRoutes(
  proposals: ProposalService,
  decisions: InheritanceDecisionService,
): RegisteredRoute[] {
  return [
    defineRoute(proposalSpecs.submitProposal, async (c, input) =>
      ok(
        c,
        await proposals.submit(
          requireUser(c),
          input.params.caseId,
          input.body,
          commandMeta(c, input.idempotencyKey, input.body),
        ),
        { status: 201 },
      ),
    ),

    defineRoute(proposalSpecs.listProposals, async (c, input) => {
      const page = await proposals.listProposals(requireUser(c), input.params.caseId, {
        limit: input.query.limit,
        cursor: input.query.cursor,
      })
      return ok(c, page.items, page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
    }),

    defineRoute(proposalSpecs.getProposal, async (c, input) =>
      ok(c, await proposals.getProposal(requireUser(c), input.params.caseId, input.params.proposalId)),
    ),

    defineRoute(proposalSpecs.reviseProposal, async (c, input) =>
      ok(
        c,
        await proposals.reviseProposal(
          requireUser(c),
          input.params.caseId,
          input.params.proposalId,
          input.body.expectedVersion,
          input.body.payload,
          commandMeta(c, input.idempotencyKey, input.body),
        ),
      ),
    ),

    defineRoute(proposalSpecs.requestApproval, async (c, input) =>
      ok(
        c,
        await proposals.requestApproval(
          requireUser(c),
          input.params.caseId,
          input.params.proposalId,
          input.body.expectedVersion,
          commandMeta(c, input.idempotencyKey, input.body),
        ),
        { status: 201 },
      ),
    ),

    defineRoute(proposalSpecs.listApprovals, async (c, input) => {
      const page = await proposals.listApprovals(requireUser(c), input.params.caseId, {
        limit: input.query.limit,
        cursor: input.query.cursor,
      })
      return ok(c, page.items, page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
    }),

    defineRoute(proposalSpecs.getApproval, async (c, input) =>
      ok(c, await proposals.getApproval(requireUser(c), input.params.caseId, input.params.approvalId)),
    ),

    defineRoute(proposalSpecs.approve, async (c, input) =>
      ok(
        c,
        await proposals.approve(
          requireUser(c),
          input.params.caseId,
          input.params.approvalId,
          input.body,
          commandMeta(c, input.idempotencyKey, input.body),
        ),
      ),
    ),

    defineRoute(proposalSpecs.reject, async (c, input) =>
      ok(
        c,
        await proposals.reject(
          requireUser(c),
          input.params.caseId,
          input.params.approvalId,
          input.body,
          commandMeta(c, input.idempotencyKey, input.body),
        ),
      ),
    ),

    defineRoute(proposalSpecs.listDecisions, async (c, input) =>
      ok(c, await decisions.list(requireUser(c), input.params.caseId)),
    ),

    defineRoute(proposalSpecs.recordDecision, async (c, input) =>
      ok(
        c,
        await decisions.record(
          requireUser(c),
          input.params.caseId,
          input.params.personId,
          input.body,
          commandMeta(c, input.idempotencyKey, input.body),
        ),
      ),
    ),

    defineRoute(proposalSpecs.confirmDecision, async (c, input) =>
      ok(
        c,
        await decisions.confirm(
          requireUser(c),
          input.params.caseId,
          input.params.personId,
          input.body,
          commandMeta(c, input.idempotencyKey, input.body),
        ),
      ),
    ),
  ]
}
