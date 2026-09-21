import type { RequiredDocument } from '@aftercare/public-contracts'

export interface BringRow {
  label: string
  doc?: RequiredDocument
}

/** 末尾の補足（「（原本）」など）を外した名前 */
function baseName(label: string): string {
  return label.replace(/\s*[（(][^（）()]*[）)]\s*$/, '').trim()
}

/**
 * 同じ持ち物か。
 * 片方が「死亡診断書」、もう片方が「死亡診断書（原本）」のように、補足の有無だけが違うものは同じとみなす。
 * 「戸籍謄本（故人のもの）」と「戸籍謄本（相続人全員分）」のように補足どうしが違うものは、別の持ち物として残す。
 */
function sameItem(a: string, b: string): boolean {
  return a === b || a === baseName(b) || baseName(a) === b
}

/** 補足が付いているほうが、窓口で迷わない */
function detailed(a: string, b: string): string {
  return a.length >= b.length ? a : b
}

/**
 * 持ち物の一覧と、案内に載っている持ち物を1つの一覧にまとめる。
 *
 * 並びは「持ち物の一覧 → 案内にだけある持ち物」。案内の持ち物は、押して記録した後も案内の位置に出す
 * （窓口で消し込んでいる最中に行が動くと押し間違える）。
 *
 * 案内の持ち物をすでに押して記録している（bring_ の記録がある）ときは、表記が近い持ち物があっても
 * まとめずに別の行に残す。まとめると、その記録が一覧から消え、付けた印が見えなくなるため。
 */
export function mergeBringRows(docs: RequiredDocument[], bring: string[]): BringRow[] {
  const fromBring = (r: RequiredDocument) => r.id.startsWith('bring_') && bring.includes(r.label)
  const listed = docs.filter((r) => !fromBring(r))
  const recorded = (b: string) => docs.find((r) => r.label === b && fromBring(r))
  // 一覧の持ち物にまとめる案内の持ち物（記録が別にあるものは除く）
  const absorbed = (r: RequiredDocument) => bring.find((b) => !recorded(b) && sameItem(r.label, b))
  return [
    ...listed.map((r) => {
      const match = absorbed(r)
      return { label: match ? detailed(r.label, match) : r.label, doc: r }
    }),
    ...bring
      .filter((b) => recorded(b) || !listed.some((r) => sameItem(r.label, b)))
      .map((b) => ({ label: b, doc: recorded(b) })),
  ]
}
