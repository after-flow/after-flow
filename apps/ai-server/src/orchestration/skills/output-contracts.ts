import { z } from 'zod'
import { coreModelInputSchema } from '../context/builder.js'
import { delegationSelectionSchema, researchFindingsSchema } from '../research/contracts.js'
import { guidanceDraftSchema } from '../playbooks/guidance-output.js'
import { chatDraftSchema } from '../playbooks/chat-output.js'
import { planningDraftSchema } from '../playbooks/planning-output.js'
import { extractionSchema } from '../documents/review.js'
import { proposalDraftSchema } from '../actions/contracts.js'

/** These are the actual parsers used at the corresponding workflow/tool boundaries. */
const contracts = {
  'case-assessment': { boundary: 'buildCoreContext (harness output)', schemas: { context: coreModelInputSchema } },
  'research-briefing': { boundary: 'native delegation selection', schemas: { delegation: delegationSelectionSchema } },
  'official-source-research': { boundary: 'research Agent structured output and delegation validation', schemas: { findings: researchFindingsSchema } },
  'evidence-reconciliation': { boundary: 'research Agent structured output and evidence validation', schemas: { findings: researchFindingsSchema } },
  'grounded-guidance': { boundary: 'active guidance/chat workflow structured output', schemas: { guidance: guidanceDraftSchema, chat: chatDraftSchema } },
  'change-proposal': { boundary: 'active planning/document workflow draft, then harness proposal submission', schemas: { planning: planningDraftSchema, extraction: extractionSchema, proposal: proposalDraftSchema } },
} as const

export function skillOutputReference(id: keyof typeof contracts) {
  const contract = contracts[id]
  return {
    boundary: contract.boundary,
    // JSON Schema is documentation; runtime parsers additionally enforce refinements, source membership and authorization.
    reference: JSON.stringify({ schemaVersion: 1, boundary: contract.boundary,
      selection: 'Use only the output requested by the active workflow. Do not output all alternatives or elevate tool permissions.',
      schemas: Object.fromEntries(Object.entries(contract.schemas).map(([name, schema]) => [name, z.toJSONSchema(schema)])),
    }, null, 2),
  }
}
