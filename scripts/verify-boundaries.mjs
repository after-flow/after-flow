import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parse as parseYaml } from 'yaml'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const units = ['apps', 'packages'].flatMap((group) =>
  readdirSync(path.join(root, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, group, entry.name)
      return { dir, manifest: JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) }
    }),
)
const errors = []
const allowed = {
  '@aftercare/web': ['@aftercare/public-contracts'],
  '@aftercare/backend-server': ['@aftercare/public-contracts', '@aftercare/internal-contracts', '@aftercare/observability'],
  '@aftercare/ai-server': ['@aftercare/internal-contracts', '@aftercare/observability'],
}

function mayDepend(from, to) {
  return from === to || (allowed[from] ?? []).includes(to)
}

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist'].includes(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(file)
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) yield file
  }
}

for (const unit of units) {
  const name = unit.manifest.name
  for (const dep of Object.keys({ ...unit.manifest.dependencies, ...unit.manifest.devDependencies })) {
    if (dep.startsWith('@aftercare/') && !mayDepend(name, dep)) {
      errors.push(`${name}: forbidden workspace dependency ${dep}`)
    }
  }
  for (const file of sources(unit.dir)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    function visit(node) {
      let specifier
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) specifier = node.arguments[0]
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const ref = specifier.text
        const target = ref.startsWith('.') ? path.resolve(path.dirname(file), ref)
          : ref.startsWith('@/') ? path.join(unit.dir, 'src', ref.slice(2)) : null
        const owner = target && units.find((other) => target.startsWith(other.dir + path.sep))
        const dep = ref.startsWith('@aftercare/') ? ref.split('/').slice(0, 2).join('/') : owner?.manifest.name
        if (dep && !mayDepend(name, dep)) errors.push(`${path.relative(root, file)}: forbidden import ${ref}`)
        if (target && !owner) errors.push(`${path.relative(root, file)}: import escapes workspace package: ${ref}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
}

/**
 * AI Serverへ業務データの接続設定を渡していないことを検証する。
 *
 * 仕様書17.4の受入条件。importの検査だけでは、環境変数やネットワーク経由で
 * AIに業務Firestoreを触らせる構成を防げない。
 */
const compose = parseYaml(readFileSync(path.join(root, 'compose.yaml'), 'utf8'))
const aiService = compose?.services?.['ai-server'] ?? {}
const businessDataEnv = /^(FIRESTORE_|GOOGLE_APPLICATION_CREDENTIALS|STORAGE_|BACKEND_EXECUTION_SIGNING_KEY)/
for (const key of Object.keys(aiService.environment ?? {})) {
  if (businessDataEnv.test(key)) {
    errors.push(`compose.yaml: ai-server must not receive business data settings (${key})`)
  }
}
const dataNetworkServices = Object.entries(compose?.services ?? {})
  .filter(([, service]) => (service?.networks ?? []).includes('data'))
  .map(([name]) => name)
if (dataNetworkServices.includes('ai-server')) {
  errors.push('compose.yaml: ai-server must not join the data network')
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log('Workspace dependency boundaries verified.')
}
