/**
 * 依存疎通の待ち時間を打ち切る。
 *
 * readiness の検査は本番トラフィックの手前で行うため、依存先が応答しない
 * ときに Cloud Run の起動/切替判定を長時間ブロックしてはいけない。
 * 元の Promise は打ち切れないため、破棄後も裏で終わる可能性がある
 * （下位 SDK は AbortSignal を必ずしも尊重しない）。呼び出し側は結果を
 * 使わず、成否の判定にだけこの関数を使う。
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message = 'timed out'): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, limit])
  } finally {
    clearTimeout(timer!)
  }
}
