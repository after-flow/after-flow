import { z } from 'zod'
import { insightEventSchema } from '@aftercare/internal-contracts'
import type { InsightEvent } from '@aftercare/internal-contracts'
import { fingerprintOf } from '../../shared/fingerprint.js'

const taskSchema = z.object({ id: z.string(), version: z.number().int().positive(), title: z.string(), status: z.string(),
  requiredDocuments: z.array(z.object({ id: z.string(), label: z.string(), documentId: z.string().nullable() })) })
const deadlineSchema = z.object({ id: z.string(), version: z.number().int().positive(), taskId: z.string().nullable(),
  dueDate: z.string().nullable(), confirmation: z.string(), critical: z.boolean(), ruleId: z.string().nullable(), ruleVersion: z.string().nullable() })

/** Request-triggered detection over Backend records. No new deadline calculation or autonomous model polling. */
export function detectInsightEvents(caseId: string, caseVersion: number, content: Record<string, unknown>, now = Date.now()): InsightEvent[] {
  const tasks = z.array(taskSchema).parse(content.tasks ?? [])
  const deadlines = z.array(deadlineSchema).parse(content.deadlines ?? [])
  const events: InsightEvent[] = []
  for (const task of tasks) {
    if (task.status === 'COMPLETED') continue
    const base = { caseId, caseVersion, expiresAt: new Date(now + 300000).toISOString(), task: { id: task.id, version: task.version, title: task.title } }
    const add = (detail: Record<string, unknown>) => events.push(insightEventSchema.parse({ ...base, ...detail,
      id: fingerprintOf({ caseId, task: base.task, detail }) }))
    const documents = task.requiredDocuments.filter(ref => ref.documentId === null).map(({ id, label }) => ({ id, label }))
    for (let offset = 0; offset < documents.length; offset += 20) add({ kind: 'DOCUMENTS_MISSING', documents: documents.slice(offset, offset + 20) })
    if (task.status === 'ESCALATED') add({ kind: 'PROFESSIONAL_REVIEW', reason: '専門家への確認が必要な状態で登録されています。保存された手続きの内容を確認してください。' })
    for (const deadline of deadlines.filter(d => d.taskId === task.id && d.critical && d.confirmation === 'CONFIRMED' && d.dueDate && d.ruleId && d.ruleVersion)) {
      add({ kind: 'DEADLINE_REVIEW', deadline: { id: deadline.id, version: deadline.version, dueDate: deadline.dueDate,
        confirmation: 'CONFIRMED', ruleId: deadline.ruleId, ruleVersion: deadline.ruleVersion } })
    }
  }
  if (events.length > 20) throw new Error('Insight event limit exceeded')
  return events
}
