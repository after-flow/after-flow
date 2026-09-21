import { Mastra } from '@mastra/core/mastra'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { createRuntimeFirestore } from '../../src/infrastructure/runtime-storage/firestore.js'
import { createRuntimeStore } from '../../src/infrastructure/runtime-storage/workflows.js'

const db = createRuntimeFirestore()
const input = z.object({ count: z.number() })
const once = createStep({ id: 'first', inputSchema: input, outputSchema: input,
  execute: async ({ inputData }) => {
    await db.collection('restart_test_receipts').doc(process.argv[3]!).create({ count: inputData.count })
    return { count: inputData.count + 1 }
  },
})
const wait = createStep({ id: 'wait', inputSchema: input, outputSchema: input,
  resumeSchema: z.object({ continue: z.literal(true) }), suspendSchema: z.object({ waiting: z.literal(true) }),
  execute: async ({ inputData, resumeData, suspend }) => resumeData?.continue ? inputData : suspend({ waiting: true }),
})
const workflow = createWorkflow({ id: 'restart-test', inputSchema: input, outputSchema: input }).then(once).then(wait).commit()
const mastra = new Mastra({ storage: createRuntimeStore(db), workflows: { workflow } })
const run = await mastra.getWorkflow('workflow').createRun({ runId: process.argv[3]! })
try {
  const result = process.argv[2] === 'resume' ? await run.resume({ resumeData: { continue: true } }) : await run.start({ inputData: { count: 40 } })
  console.log(JSON.stringify({ status: result.status, result: 'result' in result ? result.result : null }))
  if (process.argv[2] === 'crash') process.kill(process.pid, 'SIGKILL')
} finally { await db.terminate() }
