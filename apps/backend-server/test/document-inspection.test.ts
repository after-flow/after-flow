import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { InspectionStatus } from '../src/domain/document/inspection.js'
import { isDeliverableToAi, isInspectionComplete } from '../src/domain/document/inspection.js'

const ALL_STATUSES: InspectionStatus[] = ['PENDING', 'IN_PROGRESS', 'PASSED', 'REJECTED', 'FAILED']

describe('書類検査の状態', () => {
  it('外部AIへ配信できるのは検査に合格したものだけ', () => {
    for (const status of ALL_STATUSES) {
      assert.equal(isDeliverableToAi(status), status === 'PASSED', `${status} の判定が違う`)
    }
  })

  it('未検査と検査失敗を配信可能にしない', () => {
    // 「拒否でなければ配信してよい」という書き方だと、ここが通ってしまう。
    assert.equal(isDeliverableToAi('PENDING'), false)
    assert.equal(isDeliverableToAi('IN_PROGRESS'), false)
    assert.equal(isDeliverableToAi('FAILED'), false)
  })

  it('検査の完了と合格を区別する', () => {
    assert.equal(isInspectionComplete('PENDING'), false)
    assert.equal(isInspectionComplete('IN_PROGRESS'), false)
    // 拒否も失敗も「検査は終わった」。合格ではない。
    assert.equal(isInspectionComplete('REJECTED'), true)
    assert.equal(isInspectionComplete('FAILED'), true)
    assert.equal(isInspectionComplete('PASSED'), true)
  })
})
