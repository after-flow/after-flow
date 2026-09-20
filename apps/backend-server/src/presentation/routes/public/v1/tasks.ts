import { z } from 'zod'
import type { TaskService } from '../../../../application/task/task-service.js'
import { fingerprintOf } from '../../../../shared/fingerprint.js'
import { requireUser } from '../../../http/authentication.js'
import type { AppContext } from '../../../http/context.js'
import { ok } from '../../../http/envelope.js'
import type { RegisteredRoute, RouteSpec } from '../../../http/route.js'
import { defineRoute } from '../../../http/route.js'
import { caseIdParamsSchema } from '../../../schemas/case.js'
import { listQuerySchema, successEnvelope } from '../../../schemas/common.js'
import {
  createEvidenceBodySchema,
  createTaskBodySchema,
  deadlineResourceSchema,
  taskCommandBodySchema,
  taskIdParamsSchema,
  taskResourceSchema,
  updateTaskBodySchema,
} from '../../../schemas/task.js'

const taskEnvelope = successEnvelope(taskResourceSchema)
const taskListEnvelope = successEnvelope(z.array(taskResourceSchema))
const deadlineListEnvelope = successEnvelope(z.array(deadlineResourceSchema))
const initializeEnvelope = successEnvelope(z.object({ created: z.array(z.string()) }))

export const taskSpecs = {
  listTasks: {
    operationId: 'listTasks',
    method: 'get',
    path: '/cases/:caseId/tasks',
    summary: '手続きの一覧',
    tags: ['tasks'],
    auth: 'user',
    request: { params: caseIdParamsSchema, query: listQuerySchema },
    success: { status: 200, description: '手続きの一覧', schema: taskListEnvelope },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'NOT_FOUND', 'CONSENT_REQUIRED'],
    list: true,
  },
  createTask: {
    operationId: 'createTask',
    method: 'post',
    path: '/cases/:caseId/tasks',
    summary: '手続きを手動で追加する',
    tags: ['tasks'],
    auth: 'user',
    request: { params: caseIdParamsSchema, body: createTaskBodySchema },
    success: { status: 201, description: '追加した手続き', schema: taskEnvelope },
    failures: [
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONSENT_REQUIRED',
      'PRECONDITION_REQUIRED',
      'IDEMPOTENCY_KEY_REUSED',
    ],
    idempotency: 'required',
  },
  getTask: {
    operationId: 'getTask',
    method: 'get',
    path: '/cases/:caseId/tasks/:taskId',
    summary: '手続きの詳細',
    tags: ['tasks'],
    auth: 'user',
    request: { params: taskIdParamsSchema },
    success: { status: 200, description: '手続き', schema: taskEnvelope },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'NOT_FOUND', 'CONSENT_REQUIRED'],
  },
  updateTask: {
    operationId: 'updateTask',
    method: 'patch',
    path: '/cases/:caseId/tasks/:taskId',
    summary: '手続きの説明を訂正する',
    description: 'statusは変更できない。状態を変えるには commands を使う。',
    tags: ['tasks'],
    auth: 'user',
    request: { params: taskIdParamsSchema, body: updateTaskBodySchema },
    success: { status: 200, description: '訂正後の手続き', schema: taskEnvelope },
    failures: [
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'CONSENT_REQUIRED',
      'PRECONDITION_REQUIRED',
    ],
    expectedVersion: 'required',
    idempotency: 'required',
  },
  runTaskCommand: {
    operationId: 'runTaskCommand',
    method: 'post',
    path: '/cases/:caseId/tasks/:taskId/commands',
    summary: '手続きの状態を変える',
    description:
      'statusの直接指定は受け付けない。遷移表と完了条件を必ず通す。準備完了・本人による提出報告・完了は別の状態として扱う。',
    tags: ['tasks'],
    auth: 'user',
    request: { params: taskIdParamsSchema, body: taskCommandBodySchema },
    success: { status: 200, description: '操作後の手続き', schema: taskEnvelope },
    failures: [
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'CONSENT_REQUIRED',
      'PRECONDITION_REQUIRED',
      'PRECONDITION_FAILED',
    ],
    expectedVersion: 'required',
    idempotency: 'required',
  },
  createEvidence: {
    operationId: 'createEvidence',
    method: 'post',
    path: '/cases/:caseId/tasks/:taskId/evidences',
    summary: '手続きの根拠を記録する',
    tags: ['tasks'],
    auth: 'user',
    request: { params: taskIdParamsSchema, body: createEvidenceBodySchema },
    success: { status: 201, description: '記録後の手続き', schema: taskEnvelope },
    failures: [
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONSENT_REQUIRED',
      'PRECONDITION_REQUIRED',
    ],
    idempotency: 'required',
  },
  listDeadlines: {
    operationId: 'listDeadlines',
    method: 'get',
    path: '/cases/:caseId/deadlines',
    summary: '期限の一覧',
    description:
      '業務レビュー未了のルールから算定した期限は日付を返さず、要確認として返す。推測した日付を確定した期限として表示させない。',
    tags: ['tasks'],
    auth: 'user',
    request: { params: caseIdParamsSchema, query: listQuerySchema },
    success: { status: 200, description: '期限の一覧', schema: deadlineListEnvelope },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'NOT_FOUND', 'CONSENT_REQUIRED'],
    list: true,
  },
  initializeTasks: {
    operationId: 'initializeTasks',
    method: 'post',
    path: '/cases/:caseId/tasks/initialize',
    summary: '初期手続きを生成する',
    description:
      '同じ定義から二度作らない。Outboxによる自動起動が入るまでの明示的な入口で、#10 の配送が接続された後もこのAPIは冪等に動く。',
    tags: ['tasks'],
    auth: 'user',
    request: { params: caseIdParamsSchema },
    success: { status: 200, description: '生成した手続きのID', schema: initializeEnvelope },
    failures: [
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONSENT_REQUIRED',
      'PRECONDITION_REQUIRED',
    ],
    idempotency: 'required',
  },
  reevaluateDeadlines: {
    operationId: 'reevaluateDeadlines',
    method: 'post',
    path: '/cases/:caseId/deadlines/reevaluate',
    summary: '起算日の変更を期限へ反映する',
    description: '死亡日や「知った日」の訂正後に、影響する期限を版付きで作り直す。',
    tags: ['tasks'],
    auth: 'user',
    request: { params: caseIdParamsSchema },
    success: {
      status: 200,
      description: '更新した期限のID',
      schema: successEnvelope(z.object({ updated: z.array(z.string()) })),
    },
    failures: [
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONSENT_REQUIRED',
      'PRECONDITION_REQUIRED',
    ],
    idempotency: 'required',
  },
} satisfies Record<string, RouteSpec>

function commandMeta(c: AppContext, idempotencyKey: string | null, body: unknown) {
  return {
    requestId: c.get('requestId') ?? null,
    idempotency: idempotencyKey ? { key: idempotencyKey, fingerprint: fingerprintOf({ method: c.req.method, path: c.req.path, body }) } : null,
  }
}

export function createTaskRoutes(service: TaskService): RegisteredRoute[] {
  return [
    defineRoute(taskSpecs.listTasks, async (c, input) => {
      const page = await service.list(requireUser(c), input.params.caseId, {
        limit: input.query.limit,
        cursor: input.query.cursor,
      })
      return ok(c, page.items, page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
    }),

    defineRoute(taskSpecs.createTask, async (c, input) =>
      ok(
        c,
        await service.create(
          requireUser(c),
          input.params.caseId,
          input.body,
          commandMeta(c, input.idempotencyKey, input.body),
        ),
        { status: 201 },
      ),
    ),

    defineRoute(taskSpecs.getTask, async (c, input) =>
      ok(c, await service.get(requireUser(c), input.params.caseId, input.params.taskId)),
    ),

    defineRoute(taskSpecs.updateTask, async (c, input) => {
      const { expectedVersion, ...patch } = input.body
      return ok(
        c,
        await service.update(
          requireUser(c),
          input.params.caseId,
          input.params.taskId,
          expectedVersion,
          patch,
          commandMeta(c, input.idempotencyKey, input.body),
        ),
      )
    }),

    defineRoute(taskSpecs.runTaskCommand, async (c, input) =>
      ok(
        c,
        await service.runCommand(
          requireUser(c),
          input.params.caseId,
          input.params.taskId,
          input.body.command,
          input.body.expectedVersion,
          commandMeta(c, input.idempotencyKey, input.body),
          { note: input.body.note ?? null },
        ),
      ),
    ),

    defineRoute(taskSpecs.createEvidence, async (c, input) =>
      ok(
        c,
        await service.addEvidence(
          requireUser(c),
          input.params.caseId,
          input.params.taskId,
          input.body,
          commandMeta(c, input.idempotencyKey, input.body),
        ),
        { status: 201 },
      ),
    ),

    defineRoute(taskSpecs.listDeadlines, async (c, input) => {
      const page = await service.listDeadlines(requireUser(c), input.params.caseId, {
        limit: input.query.limit,
        cursor: input.query.cursor,
      })
      return ok(c, page.items, page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
    }),

    defineRoute(taskSpecs.initializeTasks, async (c, input) =>
      ok(
        c,
        await service.generateInitialTasks(
          requireUser(c),
          input.params.caseId,
          commandMeta(c, input.idempotencyKey, { caseId: input.params.caseId }),
        ),
      ),
    ),

    defineRoute(taskSpecs.reevaluateDeadlines, async (c, input) =>
      ok(
        c,
        await service.reevaluateDeadlines(
          requireUser(c),
          input.params.caseId,
          commandMeta(c, input.idempotencyKey, { caseId: input.params.caseId }),
        ),
      ),
    ),
  ]
}
