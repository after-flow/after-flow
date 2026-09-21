import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { internalId } from '@aftercare/internal-contracts'
import { buildInsurancePreparation, insuranceContextSchema, insuranceProcedureSchema, preparationApprovalSchema, preparationReceiptSchema, verifyInsurancePreparation } from '../../../orchestration/playbooks/insurance-preparation.js'
import { proposalDraftSchema } from '../../../orchestration/actions/contracts.js'
import { contentHash } from '../../../orchestration/context/builder.js'

const scopeSchema = z.object({ caseId: internalId, runId: internalId }).strict()
const viewSchema = z.object({ context: insuranceContextSchema, receipt: preparationReceiptSchema.nullable(), approval: preparationApprovalSchema.nullable() }).strict()
const outputSchema = z.object({ state: z.enum(['READY', 'NEEDS_REVIEW', 'WAITING_DOCUMENTS']), externalSubmission: z.literal(false),
  contentHash: z.string(), manifest: z.record(z.string(), z.unknown()), missingFields: z.array(internalId), missingDocuments: z.array(internalId), documentRequest: proposalDraftSchema.nullable() })
export function createInsurancePreparationWorkflow(deps: {
  procedure: z.infer<typeof insuranceProcedureSchema>; signal: AbortSignal; guard(): Promise<void>
  /** Authenticated, live Backend view. It must scope receipt and approval to this case, artifact and actor. */
  load(scope: z.infer<typeof scopeSchema>, signal: AbortSignal): Promise<unknown>
}) {
  const procedure = insuranceProcedureSchema.parse(deps.procedure)
  const loadedSchema = z.object({ scope: scopeSchema, view: viewSchema })
  async function load(scope: z.infer<typeof scopeSchema>) {
    deps.signal.throwIfAborted(); await deps.guard()
    const view = viewSchema.parse(await deps.load(scope, deps.signal))
    deps.signal.throwIfAborted()
    if (view.context.caseId !== scope.caseId || view.context.runId !== scope.runId) throw new Error('Preparation view is outside scope')
    return view
  }
  const prepare = createStep({ id: 'load-insurance-preparation', inputSchema: scopeSchema, outputSchema: loadedSchema,
    execute: async ({ inputData }) => { const view = await load(inputData); buildInsurancePreparation(view.context, procedure); return { scope: inputData, view } } })
  const verify = createStep({ id: 'verify-current-preparation', inputSchema: loadedSchema, outputSchema,
    execute: async ({ inputData }) => {
      const latest = await load(inputData.scope)
      if (contentHash(inputData.view.context) !== contentHash(latest.context)) throw new Error('Preparation basis changed')
      const preparation = buildInsurancePreparation(latest.context, procedure)
      return { ...preparation, ...verifyInsurancePreparation(preparation, latest.receipt, latest.approval) }
    } })
  return createWorkflow({ id: 'insurance-claim-preparation-v1', inputSchema: scopeSchema, outputSchema }).then(prepare).then(verify).commit()
}
