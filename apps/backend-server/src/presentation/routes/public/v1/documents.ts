import { z } from 'zod'
import type { DocumentService } from '../../../../application/document/document-service.js'
import { MAX_DOCUMENT_BYTES } from '../../../../domain/document/content-type.js'
import { errors } from '../../../../shared/app-error.js'
import { fingerprintOf } from '../../../../shared/fingerprint.js'
import { requireUser } from '../../../http/authentication.js'
import type { AppContext } from '../../../http/context.js'
import { ok } from '../../../http/envelope.js'
import type { RegisteredRoute, RouteSpec } from '../../../http/route.js'
import { defineRoute } from '../../../http/route.js'
import { caseIdParamsSchema } from '../../../schemas/case.js'
import { successEnvelope } from '../../../schemas/common.js'
import {
  archiveDocumentBodySchema,
  documentIdParamsSchema,
  documentKindSchema,
  documentListQuerySchema,
  documentResourceSchema,
} from '../../../schemas/document.js'

const documentEnvelope = successEnvelope(documentResourceSchema)
const documentListEnvelope = successEnvelope(z.array(documentResourceSchema))

/** multipart の枠を含めた上限。1 ファイルの上限は実体の検査で別に適用する。 */
const MAX_UPLOAD_BYTES = MAX_DOCUMENT_BYTES + 512 * 1024

export const documentSpecs = {
  registerDocument: {
    operationId: 'registerDocument',
    method: 'post',
    path: '/cases/:caseId/documents',
    summary: '原本を登録する',
    description:
      'PDF・JPEG・PNG、1ファイル10 MiBまで。Content-Typeの申告だけでなく実体を検査する。保存完了と解析受付は別の状態で、検査に合格していない書類は解析対象にしない。',
    tags: ['documents'],
    auth: 'user',
    request: {
      params: caseIdParamsSchema,
      multipart: {
        fields: {
          file: '原本のファイル。PDF・JPEG・PNGのみ。',
          kind: '書類の種別。',
        },
      },
    },
    success: { status: 201, description: '登録した書類', schema: documentEnvelope },
    failures: [
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONSENT_REQUIRED',
      'PRECONDITION_REQUIRED',
      'IDEMPOTENCY_KEY_REUSED',
      'PAYLOAD_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
    ],
    idempotency: 'required',
    maxBodyBytes: MAX_UPLOAD_BYTES,
  },
  listDocuments: {
    operationId: 'listDocuments',
    method: 'get',
    path: '/cases/:caseId/documents',
    summary: '書類の一覧',
    description: '既定では除外済みの書類を含めない。除外は完全消去とは別の扱い。',
    tags: ['documents'],
    auth: 'user',
    request: { params: caseIdParamsSchema, query: documentListQuerySchema },
    success: { status: 200, description: '書類の一覧', schema: documentListEnvelope },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'NOT_FOUND', 'CONSENT_REQUIRED'],
    list: true,
  },
  getDocument: {
    operationId: 'getDocument',
    method: 'get',
    path: '/cases/:caseId/documents/:documentId',
    summary: '書類の詳細',
    tags: ['documents'],
    auth: 'user',
    request: { params: documentIdParamsSchema },
    success: { status: 200, description: '書類', schema: documentEnvelope },
    failures: ['VALIDATION_FAILED', 'UNAUTHENTICATED', 'NOT_FOUND', 'CONSENT_REQUIRED'],
  },
  getDocumentContent: {
    operationId: 'getDocumentContent',
    method: 'get',
    path: '/cases/:caseId/documents/:documentId/content',
    summary: '原本を取得する',
    description:
      '取得のたびにCaseの権限を検証する。WebへStorageの資格情報を渡さないため、Backendが中継する。',
    tags: ['documents'],
    auth: 'user',
    request: { params: documentIdParamsSchema },
    success: { status: 200, description: '原本の内容', mediaType: 'application/octet-stream' },
    failures: [
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'NOT_FOUND',
      'CONSENT_REQUIRED',
      'PRECONDITION_FAILED',
    ],
  },
  archiveDocument: {
    operationId: 'archiveDocument',
    method: 'post',
    path: '/cases/:caseId/documents/:documentId/archive',
    summary: '書類を通常の一覧から除外する',
    description:
      '個人データの完全消去ではない。監査や根拠からの参照は壊さず、表示の対象から外す。',
    tags: ['documents'],
    auth: 'user',
    request: { params: documentIdParamsSchema, body: archiveDocumentBodySchema },
    success: { status: 200, description: '除外後の書類', schema: documentEnvelope },
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
    idempotency: 'optional',
  },
} satisfies Record<string, RouteSpec>

function commandMeta(c: AppContext, idempotencyKey: string | null, body: unknown) {
  return {
    requestId: c.get('requestId') ?? null,
    idempotency: idempotencyKey ? { key: idempotencyKey, fingerprint: fingerprintOf(body) } : null,
  }
}

const uploadFieldsSchema = z.object({ kind: documentKindSchema })

/**
 * multipart から原本と種別を取り出す。
 *
 * 共通の JSON 解析を通さないため、ここで形を確かめる。
 * ファイル名は利用者が付けた表示用の値で、保存先の組み立てには使わない。
 */
async function readUpload(c: AppContext) {
  const form = await c.req.parseBody()
  const file = form.file

  if (!(file instanceof File)) {
    throw errors.validationFailed({
      message: 'ファイルが添付されていません。',
      details: { field: 'file' },
    })
  }

  const fields = uploadFieldsSchema.safeParse({ kind: form.kind })
  if (!fields.success) {
    throw errors.validationFailed({
      details: {
        source: 'body',
        issues: fields.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          code: issue.code,
          message: issue.message,
        })),
      },
    })
  }

  return {
    fileName: file.name.slice(0, 255) || 'document',
    declaredContentType: file.type,
    content: new Uint8Array(await file.arrayBuffer()),
    kind: fields.data.kind,
  }
}

export function createDocumentRoutes(service: DocumentService): RegisteredRoute[] {
  return [
    defineRoute(documentSpecs.registerDocument, async (c, input) => {
      const upload = await readUpload(c)
      const registered = await service.register(
        requireUser(c),
        input.params.caseId,
        upload,
        // 指紋は内容のハッシュではなくファイルの識別情報から作る。
        // 同一性の最終判断は保存側が内容ハッシュで行う。
        commandMeta(c, input.idempotencyKey, {
          fileName: upload.fileName,
          kind: upload.kind,
          sizeBytes: upload.content.byteLength,
        }),
      )
      return ok(c, registered, { status: 201 })
    }),

    defineRoute(documentSpecs.listDocuments, async (c, input) => {
      const page = await service.list(requireUser(c), input.params.caseId, {
        limit: input.query.limit,
        cursor: input.query.cursor,
        includeArchived: input.query.includeArchived,
      })
      return ok(c, page.items, page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
    }),

    defineRoute(documentSpecs.getDocument, async (c, input) =>
      ok(c, await service.get(requireUser(c), input.params.caseId, input.params.documentId)),
    ),

    defineRoute(documentSpecs.getDocumentContent, async (c, input) => {
      const original = await service.content(
        requireUser(c),
        input.params.caseId,
        input.params.documentId,
      )
      // 応答の本体として渡せる形に写す。内容は変えない。
      const body = new Uint8Array(original.content)
      return new Response(new Blob([body], { type: original.contentType }), {
        status: 200,
        headers: {
          'Content-Type': original.contentType,
          // ブラウザーで直接開かせず、保存として扱う。
          'Content-Disposition': 'attachment',
          'Cache-Control': 'private, no-store',
          'X-Request-Id': c.get('requestId') ?? '',
        },
      })
    }),

    defineRoute(documentSpecs.archiveDocument, async (c, input) =>
      ok(
        c,
        await service.archive(
          requireUser(c),
          input.params.caseId,
          input.params.documentId,
          input.body.expectedVersion,
          commandMeta(c, input.idempotencyKey, input.body),
        ),
      ),
    ),
  ]
}
