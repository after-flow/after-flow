import { useState } from 'react'
import { useCompleteTask } from '@/lib/api/queries'
import type { Task } from '@aftercare/public-contracts'
import { Checkbox, Confirm } from '@/kit/kit'

/**
 * 手続きを完了として記録する確認。
 *
 * 完了の判定は本人の確認をもって行う。ホーム（「もう済んでいる」）と手続きの詳細の両方から使う。
 * 死亡届のように葬儀社が代わりに出していることも多いので、自分で出していなくても記録できる文言にする。
 */
export function CompleteTaskDialog({
  caseId,
  task,
  open,
  onClose,
  onDone,
}: {
  caseId: string
  task: Task
  open: boolean
  onClose: () => void
  onDone?: () => void
}) {
  const complete = useCompleteTask(caseId)
  const [checked, setChecked] = useState(false)
  const close = () => {
    setChecked(false)
    onClose()
  }

  return (
    <Confirm
      open={open}
      title={`「${task.title}」を完了にしますか？`}
      description="窓口での手続きが済んでいるかを確かめてから記録してください。"
      confirmLabel="完了として記録する"
      busy={complete.isPending}
      disabled={!checked}
      onClose={close}
      onConfirm={async () => {
        await complete.mutateAsync({ taskId: task.id, confirmedBySelf: true })
        setChecked(false)
        onDone?.()
        onClose()
      }}
    >
      <Checkbox checked={checked} onChange={setChecked}>
        この手続きが済んでいることを確かめました（葬儀社や家族が代わりに行った場合も含みます）
      </Checkbox>
    </Confirm>
  )
}
