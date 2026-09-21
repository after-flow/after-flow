import type { Insight, TaskResource, TaskStatusResource } from '@aftercare/public-contracts'
import { db } from './db'

/**
 * 自律監視（モック）。本物は Backend／AI 側で定期的に動き、気づき（Insight）として届ける。
 *
 * ここで作るのは、前回ひらいたときから持ち越している問題の2種類。
 *  1. 止まっている手続き（STALLED_TASK）
 *     - 提出して結果待ち（SUBMITTED／WAITING_EXTERNAL）のまま 14日 動きが無い
 *     - 進めている途中のまま 7日 動きが無い。期限まで7日を切っていれば 3日 で知らせる
 *     手続きが更新されたら、その気づきは片づいたものとして消す。
 *  2. 前提の変化（INCONSISTENCY）
 *     - 相続人が増えた・減った：相続の方法の記録と、遺産分割の話し合いに関わる
 *     - 相続放棄を選んだ方がいる：次の順位の方が相続人になる場合がある（法的判断なので専門家へ）
 *
 * 手続きの一覧や期限そのものは書き換えない。知らせるだけで、判断は利用者に任せる。
 * 本番コードからは参照しない。
 */

const DAY = 86_400_000
const WAITING: TaskStatusResource[] = ['SUBMITTED', 'WAITING_EXTERNAL']
const MOVING: TaskStatusResource[] = ['COLLECTING_INFORMATION', 'WAITING_DOCUMENTS', 'READY', 'ACTION_REQUIRED']

const STATUS_WORD: Partial<Record<TaskStatusResource, string>> = {
  COLLECTING_INFORMATION: '調べている',
  WAITING_DOCUMENTS: '書類を集めている',
  READY: '出せる状態',
  SUBMITTED: '提出した',
  WAITING_EXTERNAL: '結果を待っている',
  ACTION_REQUIRED: '対応が必要',
}

/** ケースごとの、前回見たときの相続人（id → 名前） */
const heirSnapshots = new Map<string, Map<string, string>>()
/** 相続放棄の知らせを出し済みの人 */
const renunciationNotified = new Set<string>()

function dateWord(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

function stalledDays(t: TaskResource, now: number): number | null {
  const idle = Math.floor((now - new Date(t.updatedAt).getTime()) / DAY)
  if (WAITING.includes(t.status)) return idle >= 14 ? idle : null
  if (!MOVING.includes(t.status)) return null
  const near = t.deadline?.daysRemaining != null && t.deadline.daysRemaining <= 7
  return idle >= (near ? 3 : 7) ? idle : null
}

function stalledInsight(t: TaskResource, days: number, key: string): Insight {
  const waiting = WAITING.includes(t.status)
  return {
    id: key,
    caseId: t.caseId,
    kind: 'STALLED_TASK',
    body: waiting
      ? `「${t.title}」は、提出して結果を待つ状態のまま${days}日たちました。通知や書類が届いていないか確かめてください。届いていなければ、窓口に問い合わせると状況が分かります。`
      : `「${t.title}」は${days}日間、動きがありません。書類がそろわない・窓口が分からないなどで止まっているなら、AIに相談することもできます。`,
    evidence: [
      { label: 'いまの状態', value: STATUS_WORD[t.status] ?? t.status, taskId: t.id },
      { label: '最後に更新した日', value: dateWord(t.updatedAt) },
      ...(t.deadline?.dueDate ? [{ label: '期限', value: `${dateWord(t.deadline.dueDate)}（あと${t.deadline.daysRemaining}日）` }] : []),
    ],
    detectedAt: new Date().toISOString(),
    relatedTaskId: t.id,
    relatedTaskTitle: t.title,
    requiresProfessional: false,
    status: 'NEW',
  }
}

function decisionTask(caseId: string) {
  return db.tasks.find((t) => t.caseId === caseId && t.stage === 'decision')
}

export function watchCase(caseId: string) {
  const kase = db.cases.find((c) => c.id === caseId)
  if (!kase) return
  const now = Date.now()

  /* ---- 1. 止まっている手続き ---- */
  const current = new Set<string>()
  for (const t of db.tasks.filter((x) => x.caseId === caseId)) {
    const days = stalledDays(t, now)
    if (days == null) continue
    // 更新日時を鍵に含める。手続きが動けば別の鍵になり、古い知らせは消える
    const key = `ins_w_stalled_${t.id}_${new Date(t.updatedAt).getTime()}`
    current.add(key)
    if (!db.insights.some((i) => i.id === key)) db.insights.push(stalledInsight(t, days, key))
  }
  db.insights = db.insights.filter(
    (i) => i.caseId !== caseId || !i.id.startsWith('ins_w_stalled_') || current.has(i.id),
  )

  /* ---- 2. 相続人が増えた・減った ---- */
  const heirs = new Map(
    db.persons.filter((p) => p.caseId === caseId && p.isHeir && !p.excludedAt).map((p) => [p.id, p.name]),
  )
  const before = heirSnapshots.get(caseId)
  heirSnapshots.set(caseId, heirs)
  // 最初に見たときは比べる相手がいない。ケースを作った直後に本人を登録するのも「変化」ではない
  if (before && before.size > 0) {
    const added = [...heirs].filter(([id, name]) => !before.has(id) && name !== kase.ownerName)
    const removed = [...before].filter(([id]) => !heirs.has(id))
    const decision = decisionTask(caseId)
    for (const [id, name] of added) {
      db.insights.push({
        id: `ins_w_heir_add_${id}_${now}`,
        caseId,
        kind: 'INCONSISTENCY',
        body: `相続人として${name}さんが加わりました。${name}さんの相続の方法（承認・放棄）も記録が必要です。遺産分割の話し合いにも加わっていただくことになります。`,
        evidence: [
          { label: '加わった方', value: name },
          { label: '相続人の人数', value: `${before.size}人 → ${heirs.size}人` },
        ],
        detectedAt: new Date().toISOString(),
        relatedTaskId: decision?.id,
        relatedTaskTitle: decision?.title,
        requiresProfessional: false,
        status: 'NEW',
      })
    }
    for (const [id, name] of removed) {
      db.insights.push({
        id: `ins_w_heir_remove_${id}_${now}`,
        caseId,
        kind: 'INCONSISTENCY',
        body: `${name}さんが相続人の一覧から外れました。これまでに話し合った分け方や、集めた書類に${name}さんの分が含まれていないか確かめてください。`,
        evidence: [
          { label: '外れた方', value: name },
          { label: '相続人の人数', value: `${before.size}人 → ${heirs.size}人` },
        ],
        detectedAt: new Date().toISOString(),
        relatedTaskId: decision?.id,
        relatedTaskTitle: decision?.title,
        requiresProfessional: false,
        status: 'NEW',
      })
    }
  }

  /* ---- 3. 相続放棄を選んだ方がいる ---- */
  for (const [personId, name] of heirs) {
    const method = db.decisions.find((d) => d.personId === personId)?.method
    if (method !== 'RENUNCIATION') {
      // 取り消されたら、次に選び直したときにもう一度知らせる
      renunciationNotified.delete(personId)
      continue
    }
    if (renunciationNotified.has(personId)) continue
    renunciationNotified.add(personId)
    const decision = decisionTask(caseId)
    db.insights.push({
      id: `ins_w_renounce_${personId}_${now}`,
      caseId,
      kind: 'INCONSISTENCY',
      body: `${name}さんが相続放棄を選んだと記録されました。放棄が認められると、その方は初めから相続人でなかったことになり、次の順位の方（故人の親や兄弟姉妹など）が新たに相続人になる場合があります。`,
      evidence: [
        { label: '記録された方法', value: `${name}さん：相続放棄` },
        { label: 'いま登録されている相続人', value: `${heirs.size}人` },
      ],
      detectedAt: new Date().toISOString(),
      relatedTaskId: decision?.id,
      relatedTaskTitle: decision?.title,
      requiresProfessional: true,
      status: 'NEW',
    })
  }
}
