/**
 * ローカル開発専用の seed。
 *
 * 認証済み利用者が業務 API を使うには、tenant の membership が正本として
 * 保存されている必要がある（ADR 0001: token の tenant 主張は membership で裏取りする）。
 * Firestore Emulator に対してだけ、指定した利用者を tenant member として登録する。
 * Case・同意・Task は公開 API（Swagger UI）から作る。
 *
 *   pnpm --filter @aftercare/backend-server exec tsx scripts/dev-seed.ts --user demo-user --tenant after-flow-demo
 */
import { parseArgs } from 'node:util'
import type { TenantMember } from '../src/application/authorization/case-access.js'
import { collections } from '../src/domain/shared/collections.js'
import { createFirestore, readFirestoreConfig } from '../src/infrastructure/firestore/client.js'
import { assertValidId } from '../src/infrastructure/firestore/paths.js'
import { FirestoreReadRepository } from '../src/infrastructure/firestore/read-repository.js'
import { FirestoreUnitOfWork } from '../src/infrastructure/firestore/unit-of-work.js'

if (process.env.NODE_ENV === 'production' || !process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('dev-seed は Firestore Emulator（FIRESTORE_EMULATOR_HOST）に対してだけ実行できます。')
}

const { values } = parseArgs({ options: { user: { type: 'string' }, tenant: { type: 'string' } } })
if (!values.user || !values.tenant) throw new Error('使い方: dev-seed.ts --user <id> --tenant <id>')
const userId = values.user
const tenantId = values.tenant
assertValidId(userId, 'userId')
assertValidId(tenantId, 'tenantId')

const db = createFirestore(readFirestoreConfig(process.env))
try {
  const read = new FirestoreReadRepository(db)
  const location = { collection: collections.members, caseId: null, id: userId }
  const existing = await read.get<TenantMember>(tenantId, location)
  if (existing?.active) {
    console.log(JSON.stringify({ result: 'unchanged', tenantId, userId }))
  } else {
    await new FirestoreUnitOfWork(db).run(
      { tenantId, actor: { type: 'SYSTEM', userId: null, agentRunId: null }, requestId: `dev-seed-${Date.now()}` },
      async (tx) => {
        if (existing) tx.update<TenantMember>(location, existing.version, { active: true })
        else tx.create<TenantMember>(location, { id: userId, userId, active: true })
      },
    )
    console.log(JSON.stringify({ result: existing ? 'reactivated' : 'created', tenantId, userId }))
  }
} finally {
  await db.terminate()
}
