import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOfficialCatalogProvider, extractOfficialDocument, textHash } from '../src/infrastructure/research/official-catalog.js'
import type { OfficialCatalog } from '../src/infrastructure/research/official-catalog.js'
import { guidanceResult, officialForm } from '../src/orchestration/playbooks/guidance-output.js'
import { sourceDocument } from './helpers/source-document.js'

/**
 * 公式ページと同じ構造を持つ合成HTML。
 * 実ページはmain要素の中にローカルナビゲーション（nav）を含み、
 * 見出しにid属性があり、申請書PDFを相対パスで掲載している。
 */
const page = (outside = '') => `<!doctype html><html><head><title>t</title></head><body>
<header><nav>ウェブサイト全体のナビゲーション 給付と手続き 申請書</nav></header>
${outside}
<main class="l-main" id="main-content">
  <div><h1>合成給付の申請書</h1><p>受付日から10営業日以内に支払う。</p></div>
  <h2 id="apply1">申請方法・提出先</h2><p>紙の申請書は加入している支部へ郵送する。</p>
  <h2 id="forms2">申請書様式</h2>
  <p><a href="/assets/print.pdf">申請書の印刷についてのお願い</a></p>
  <p><a href="/assets/form.pdf">手書き用</a> <a href="/assets/example.pdf">手書き用記入例</a></p>
  <p><a href="https://other.example/assets/evil.pdf">手書き用</a> <a href="/assets/form.pdf?x=1">入力用</a> <a href="/assets/page/">様式の一覧</a></p>
  <h2 id="deadline3">申請期限</h2><p>起算日の翌日から2年で時効になる。</p>
  <div class="l-main__foot"><nav aria-labelledby="local"><h2 id="local">健康保険給付の申請書</h2><a href="/a">傷病手当金</a></nav></div>
</main>
<footer>サイトマップ Copyright</footer></body></html>`

const options = { pageUrl: 'https://official.example/application/012/', allowedHosts: ['official.example'] }

test('#165 主要コンテンツだけを見出し単位で抽出し、ナビゲーションを送らない', () => {
  const document = extractOfficialDocument({ body: page(''), contentType: 'text/html' }, options)
  assert.equal(document.scope, 'main')
  for (const leaked of ['ウェブサイト全体のナビゲーション', '傷病手当金', 'サイトマップ', 'Copyright', '健康保険給付の申請書']) {
    assert.ok(!document.text.includes(leaked), `本文へ混入している: ${leaked}`)
  }
  assert.deepEqual(document.sections.map(section => [section.id, section.heading, section.anchor]), [
    ['s1', '合成給付の申請書', null],
    ['s2', '申請方法・提出先', 'apply1'],
    ['s3', '申請書様式', 'forms2'],
    ['s4', '申請期限', 'deadline3'],
  ])
  assert.match(document.sections[1]!.text, /郵送/)
  assert.match(document.sections[3]!.text, /2年/)
})

test('#165 主要コンテンツ領域が無い、または曖昧な場合も除外規則は保つ', () => {
  const noMain = `<html><body><header><nav>全体ナビ</nav></header><h1>見出し</h1><p>本文</p><footer>フッター</footer></body></html>`
  const document = extractOfficialDocument({ body: noMain, contentType: 'text/html' }, options)
  assert.equal(document.scope, 'body')
  assert.ok(!/全体ナビ|フッター/.test(document.text))
  // mainが2つあると本文を取り違える恐れがあるため、主要領域とみなさない。
  const twoMains = `<html><body><main><h1>A</h1><p>一</p></main><main><h1>B</h1><p>二</p></main></body></html>`
  assert.equal(extractOfficialDocument({ body: twoMains, contentType: 'text/html' }, options).scope, 'body')
})

test('#165 申請書と記入例のリンクを許可ホストのPDFだけから抽出する', () => {
  const { forms } = extractOfficialDocument({ body: page(''), contentType: 'text/html' }, options)
  assert.deepEqual(forms, [
    // 「手書き用」だけでは意味が通じないため、ページ見出しを添える。
    { label: '合成給付の申請書（手書き用）', url: 'https://official.example/assets/form.pdf', kind: 'FORM' },
    { label: '合成給付の申請書（手書き用記入例）', url: 'https://official.example/assets/example.pdf', kind: 'EXAMPLE' },
  ])
  // 許可外ホスト・query付き・PDFでないリンク・印刷の案内は採用しない。
  const urls = forms.map(form => form.url).join(' ')
  assert.ok(!/other\.example|\?x=1|print\.pdf|\/page\//.test(urls))
})

test('#165 本文の変更をハッシュで検出し、空白の揺れでは変化しない', () => {
  const base = extractOfficialDocument({ body: page(''), contentType: 'text/html' }, options).text
  const spaced = extractOfficialDocument({ body: page('').replace(/<p>/g, '<p>\n   '), contentType: 'text/html' }, options).text
  const changed = extractOfficialDocument({ body: page('').replace('2年', '3年'), contentType: 'text/html' }, options).text
  assert.equal(textHash(base), textHash(spaced))
  assert.notEqual(textHash(base), textHash(changed))
  assert.match(textHash(base), /^[A-Za-z0-9_-]{43}$/)
})

test('#165 取得した資料にハッシュ・区分・申請書リンクを記録し、既存の制約を保つ', async () => {
  const time = Date.parse('2026-09-20T00:00:00Z')
  const catalog: OfficialCatalog = {
    id: 'synthetic', version: '1', reviewedAt: '2026-09-19T00:00:00Z', expiresAt: '2026-09-21T00:00:00Z', reviewReference: 'fixture-only',
    allowedHosts: ['official.example'], entries: [{ id: 'fixture-source', catalogId: 'synthetic', title: '合成給付の申請書', issuer: '合成機関',
      url: 'https://official.example/application/012/', keywords: ['申請書'] }],
  }
  const provider = createOfficialCatalogProvider([catalog], { now: () => time, fetchText: async () => ({ body: page(''), contentType: 'text/html' }) })
  const signal = new AbortController().signal
  const [candidate] = await provider.search({ query: '申請書', catalogIds: ['synthetic'], signal })
  const document = await provider.read({ candidate: candidate!, signal })
  assert.equal(document.contentHash, textHash(document.text))
  assert.equal(document.sections.length, 4)
  assert.equal(document.forms.length, 2)
  assert.match(document.location, /主要コンテンツ・見出し単位/)
  // 更新時刻はページに明記が無ければnull。HTTPのLast-Modifiedでは埋めない。
  assert.equal(document.updatedAt, null)
  // 巨大本文は従来どおり拒否する。
  const huge = createOfficialCatalogProvider([catalog], { now: () => time,
    fetchText: async () => ({ body: `<main><p>${'あ'.repeat(200000)}</p></main>`, contentType: 'text/html' }) })
  await assert.rejects(huge.read({ candidate: candidate!, signal }))
})

test('#165 引用した資料の申請書リンクだけを案内に載せる', () => {
  const cited = sourceDocument({ id: 'source-1', catalogId: 'c', title: '申請書', issuer: '機関', url: 'https://official.example/a' }, '本文',
    { forms: [{ label: '合成申請書（手書き用記入例）', url: 'https://official.example/assets/example.pdf', kind: 'EXAMPLE' },
      { label: '合成申請書（手書き用）', url: 'https://official.example/assets/form.pdf', kind: 'FORM' }] })
  const uncited = sourceDocument({ id: 'source-2', catalogId: 'c', title: '別資料', issuer: '機関', url: 'https://official.example/b' }, '本文',
    { forms: [{ label: '無関係の申請書', url: 'https://official.example/assets/other.pdf', kind: 'FORM' }] })
  // 申請書そのものを優先し、無い場合に記入例を使う。
  assert.equal(officialForm([cited])?.url, 'https://official.example/assets/form.pdf')

  const claim = (text: string) => ({ text, questionIds: ['documents'] })
  const result = guidanceResult({
    draft: { status: 'partial', where: claim('支部へ郵送する'), bring: [claim('申請書')], steps: [claim('郵送する')], missing: ['加入支部'] },
    sources: [cited, uncited],
    research: { briefs: [{ briefId: 'b', procedure: 'p', institution: 'i', jurisdiction: 'j', sourceCatalogIds: ['c'], questions: [{ id: 'documents', text: '書類' }] }],
      outcomes: [{ briefId: 'b', findings: { status: 'partial', missing: [], conflicts: [], answers: [{ questionId: 'documents', text: '申請書', sourceIds: ['source-1'],
        applicability: 'a', evidence: [{ sourceId: 'source-1', sectionId: 's1', quote: '本文' }] }] } }] },
    proof: { caseVersion: 1, contextSnapshotId: 'snapshot-1', fencingToken: 1, artifactVersion: 1, contentHash: textHash('proof') },
    resultId: 'result-1', target: '合成手続き',
  })
  if (result.kind !== 'task_guidance') assert.fail()
  assert.equal(result.formExampleUrl, 'https://official.example/assets/form.pdf')
  assert.equal(result.formExampleLabel, '合成申請書（手書き用）')
})
