import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { stringify } from 'yaml'
import {
  buildOpenApiDocument,
  PUBLIC_API_BASE_PATH,
  PUBLIC_API_VERSION,
} from '../presentation/openapi/document.js'
import { publicV1Specs } from '../presentation/routes/public/v1/index.js'
import { buildInternalOpenApiDocument } from '../presentation/openapi/internal-document.js'

/**
 * 公開 OpenAPI の生成と検証。
 *
 * `--check` は再生成した内容と commit 済みファイルを比較し、差分があれば
 * 失敗する。実装だけ変えて契約の生成物が古いまま、という状態を CI で止める。
 */
const { values } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
})

// pnpm script は package ディレクトリーで実行されるため、そこからの相対で解決する。
const outputPath = path.resolve(process.cwd(), values.out ?? '../../docs/api/public-openapi.yaml')

const document = buildOpenApiDocument(publicV1Specs, {
  version: PUBLIC_API_VERSION,
  basePath: PUBLIC_API_BASE_PATH,
})

const header = `# 自動生成ファイル。直接編集しない。\n# 生成: pnpm --filter @aftercare/backend-server openapi:generate\n`
const generated = `${header}${stringify(document, { lineWidth: 0 })}`

const internalPath = path.resolve(process.cwd(), '../../docs/api/internal-openapi.yaml')
const internalGenerated = `${header}${stringify(buildInternalOpenApiDocument(), { lineWidth: 0 })}`
if (values.check) {
  const current = await readFile(internalPath, 'utf8').catch(() => null)
  if (current !== internalGenerated) {
    console.error('Internal OpenAPI differs. Run pnpm openapi:generate.')
    process.exit(1)
  }
} else {
  await mkdir(path.dirname(internalPath), { recursive: true })
  await writeFile(internalPath, internalGenerated, 'utf8')
}

if (values.check) {
  let current: string | null = null
  try {
    current = await readFile(outputPath, 'utf8')
  } catch {
    current = null
  }
  if (current !== generated) {
    console.error(
      `${path.relative(process.cwd(), outputPath)} が実装と一致しません。` +
        ' pnpm --filter @aftercare/backend-server openapi:generate を実行して差分を commit してください。',
    )
    process.exit(1)
  }
  console.log('OpenAPI document matches the implemented routes.')
} else {
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, generated, 'utf8')
  console.log(`wrote ${path.relative(process.cwd(), outputPath)}`)
}
