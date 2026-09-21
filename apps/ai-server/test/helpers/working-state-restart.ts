import { Mastra } from '@mastra/core/mastra'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { createRuntimeFirestore } from '../../src/infrastructure/runtime-storage/firestore.js'
import { createRuntimeStore } from '../../src/infrastructure/runtime-storage/workflows.js'
import { guidanceWorkingStateSchema } from '../../src/orchestration/working-state.js'

const db = createRuntimeFirestore()
const inputSchema = z.object({ runId: z.string() }).strict()
const stateEnvelopeSchema = inputSchema.extend({ workingState: guidanceWorkingStateSchema })
const research = createStep({
  id: 'persist-research-evidence', inputSchema, outputSchema: stateEnvelopeSchema,
  execute: async ({ inputData }) => {
    await db.collection('working_state_restart_receipts').doc(inputData.runId).create({ executed: 1 })
    return { ...inputData, workingState: guidanceWorkingStateSchema.parse({
      goal: '再開試験', plan: [{ action: 'REQUEST_RESEARCH', questionIds: ['q1'] }, { action: 'REPORT', questionIds: [] }],
      knownFacts: [], unknowns: [], evidence: [{ questionId: 'q1', sourceId: 'source-1', sectionId: 's1', quote: '確認済みの引用' }],
      completedActions: ['REQUEST_RESEARCH'], currentStep: 1, nextAction: 'REPORT', replanCount: 0,
    }) }
  },
})
const crash = createStep({
  id: 'crash-after-research', inputSchema: stateEnvelopeSchema, outputSchema: stateEnvelopeSchema,
  execute: async ({ inputData }) => {
    if (process.argv[2] === 'crash') process.kill(process.pid, 'SIGKILL')
    return inputData
  },
})
const finish = createStep({
  id: 'finish', inputSchema: stateEnvelopeSchema, outputSchema: stateEnvelopeSchema,
  execute: async ({ inputData }) => ({
    ...inputData,
    workingState: guidanceWorkingStateSchema.parse({
      ...inputData.workingState,
      completedActions: ['REQUEST_RESEARCH', 'REPORT'],
      currentStep: 2,
      nextAction: 'DONE',
    }),
  }),
})
const workflow = createWorkflow({ id: 'working-state-restart', inputSchema, outputSchema: stateEnvelopeSchema })
  .then(research).then(crash).then(finish).commit()
const mastra = new Mastra({ storage: createRuntimeStore(db), workflows: { workflow } })
const runId = process.argv[3]!
const run = await mastra.getWorkflow('workflow').createRun({ runId })
try {
  const result = process.argv[2] === 'restart' ? await run.restart() : await run.start({ inputData: { runId } })
  console.log(JSON.stringify({ status: result.status, result: result.status === 'success' ? result.result : null }))
} finally { await db.terminate() }
