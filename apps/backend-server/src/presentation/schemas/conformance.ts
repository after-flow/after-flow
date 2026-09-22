import type {
  ApiErrorBody,
  ApiErrorCode,
  ApiFailure,
  CaseResource,
  ConsentStatusResource,
  AgentRunResource,
  AiCapabilitiesResource,
  CaseOverviewResource,
  GuidanceResource,
  MessageAcceptedResource,
  ApprovalResource,
  InheritanceDecisionResource,
  ProposalResource,
  DeadlineResource,
  DocumentResource,
  ResponseMeta,
  TaskResource,
} from '@aftercare/public-contracts'
import type { z } from 'zod'
import { apiErrorBodySchema, apiErrorCodeSchema, apiFailureSchema, responseMetaSchema } from './common.js'
import { aiCapabilitiesResourceSchema } from './ai-capability.js'
import { caseResourceSchema } from './case.js'
import { consentStatusResourceSchema } from './consent.js'
import { documentResourceSchema } from './document.js'
import { agentRunResourceSchema } from './agent.js'
import { caseOverviewResourceSchema } from './overview.js'
import { guidanceResourceSchema, messageAcceptedResourceSchema } from './chat.js'
import {
  approvalResourceSchema,
  inheritanceDecisionResourceSchema,
  proposalResourceSchema,
} from './proposal.js'
import { deadlineResourceSchema, taskResourceSchema } from './task.js'

/**
 * Zod スキーマの出力型が公開契約の型と一致することを、型検査で保証する。
 *
 * スキーマと DTO を別々に書くと、OpenAPI の生成物だけが正しく、実際の応答が
 * 契約からずれた状態になりうる。ここが壊れたら `pnpm typecheck` が落ちる。
 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

export type Assert<T extends true> = T

export type ErrorCodeMatches = Assert<Equals<z.infer<typeof apiErrorCodeSchema>, ApiErrorCode>>
export type ErrorBodyMatches = Assert<Equals<z.infer<typeof apiErrorBodySchema>, ApiErrorBody>>
export type ResponseMetaMatches = Assert<Equals<z.infer<typeof responseMetaSchema>, ResponseMeta>>
export type FailureMatches = Assert<Equals<z.infer<typeof apiFailureSchema>, ApiFailure>>
export type CaseResourceMatches = Assert<Equals<z.infer<typeof caseResourceSchema>, CaseResource>>
export type ConsentStatusMatches = Assert<
  Equals<z.infer<typeof consentStatusResourceSchema>, ConsentStatusResource>
>
export type DocumentResourceMatches = Assert<
  Equals<z.infer<typeof documentResourceSchema>, DocumentResource>
>
export type TaskResourceMatches = Assert<Equals<z.infer<typeof taskResourceSchema>, TaskResource>>
export type DeadlineResourceMatches = Assert<
  Equals<z.infer<typeof deadlineResourceSchema>, DeadlineResource>
>
export type AgentRunResourceMatches = Assert<
  Equals<z.infer<typeof agentRunResourceSchema>, AgentRunResource>
>
export type ProposalResourceMatches = Assert<
  Equals<z.infer<typeof proposalResourceSchema>, ProposalResource>
>
export type ApprovalResourceMatches = Assert<
  Equals<z.infer<typeof approvalResourceSchema>, ApprovalResource>
>
export type InheritanceDecisionMatches = Assert<
  Equals<z.infer<typeof inheritanceDecisionResourceSchema>, InheritanceDecisionResource>
>
export type MessageAcceptedMatches = Assert<
  Equals<z.infer<typeof messageAcceptedResourceSchema>, MessageAcceptedResource>
>
export type GuidanceResourceMatches = Assert<
  Equals<z.infer<typeof guidanceResourceSchema>, GuidanceResource>
>
export type CaseOverviewMatches = Assert<
  Equals<z.infer<typeof caseOverviewResourceSchema>, CaseOverviewResource>
>
export type AiCapabilitiesMatches = Assert<
  Equals<z.infer<typeof aiCapabilitiesResourceSchema>, AiCapabilitiesResource>
>
