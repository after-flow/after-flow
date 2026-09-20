import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useCreateCase } from '@/lib/api/queries'
import { Button, Card, TextInput } from '@/components/ui/Primitives'
import { Banner } from '@/components/ui/Banner'
import { Icon } from '@/components/ui/Icon'

type Errors = Partial<Record<'deceasedName' | 'dateOfDeath' | 'ownerName' | 'relationshipToDeceased', string>>

export function CaseNewPage() {
  const navigate = useNavigate()
  const createCase = useCreateCase()
  const [form, setForm] = useState({
    deceasedName: '',
    deceasedNameKana: '',
    dateOfDeath: '',
    dateOfBirth: '',
    knownAt: '',
    ownerName: '',
    relationshipToDeceased: '',
  })
  const [errors, setErrors] = useState<Errors>({})

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function validate(): Errors {
    const e: Errors = {}
    if (!form.deceasedName.trim()) e.deceasedName = 'お名前を入力してください。'
    if (!form.dateOfDeath) e.dateOfDeath = 'ご逝去日を入力してください。期限の起算日として使用します。'
    if (!form.ownerName.trim()) e.ownerName = 'ご入力者のお名前を入力してください。'
    if (!form.relationshipToDeceased.trim())
      e.relationshipToDeceased = '故人との続柄を入力してください（例：長男、配偶者）。'
    return e
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault()
    const e = validate()
    setErrors(e)
    if (Object.keys(e).length > 0) return

    const created = await createCase.mutateAsync({
      deceasedName: form.deceasedName.trim(),
      deceasedNameKana: form.deceasedNameKana.trim() || undefined,
      dateOfDeath: form.dateOfDeath,
      dateOfBirth: form.dateOfBirth || undefined,
      knownAt: form.knownAt || undefined,
      ownerName: form.ownerName.trim(),
      relationshipToDeceased: form.relationshipToDeceased.trim(),
    })
    navigate(`/cases/${created.id}`)
  }

  return (
    <div className="mx-auto max-w-2xl p-4 py-6">
      <Link to="/cases" className="inline-flex items-center gap-1 text-sm font-bold text-[var(--color-brand)] underline">
        <Icon name="chevron-left" size={16} />
        ケース一覧へ戻る
      </Link>
      <h1 className="mt-2 mb-1 text-2xl font-bold">ケースの新規作成</h1>
      <p className="mb-5 text-[var(--color-ink-muted)]">
        お亡くなりになった方の基本情報を登録します。ここで入力した日付をもとに、手続きの期限が自動で計算されます。
      </p>

      <Card>
        <form className="flex flex-col gap-5" onSubmit={onSubmit}>
          {createCase.isError && (
            <Banner tone="critical" role="alert">
              ケースを作成できませんでした。時間をおいて、もう一度お試しください。
            </Banner>
          )}

          <TextInput
            label="故人のお名前"
            required
            value={form.deceasedName}
            error={errors.deceasedName}
            onChange={(e) => set('deceasedName', e.target.value)}
          />
          <TextInput
            label="ふりがな"
            value={form.deceasedNameKana}
            onChange={(e) => set('deceasedNameKana', e.target.value)}
          />
          <TextInput
            label="ご逝去日"
            type="date"
            required
            hint="死亡届（7日以内）や世帯主変更（14日以内）などの起算日になります。"
            value={form.dateOfDeath}
            error={errors.dateOfDeath}
            onChange={(e) => set('dateOfDeath', e.target.value)}
          />
          <TextInput
            label="相続開始を知った日"
            type="date"
            hint="ご逝去を知った日が異なる場合に入力してください。準確定申告や相続税の起算日になります。空欄の場合はご逝去日を使用します。"
            value={form.knownAt}
            onChange={(e) => set('knownAt', e.target.value)}
          />
          <TextInput
            label="生年月日"
            type="date"
            value={form.dateOfBirth}
            onChange={(e) => set('dateOfBirth', e.target.value)}
          />

          <hr className="border-[var(--color-line)]" />

          <TextInput
            label="ご入力者（ケース責任者）のお名前"
            required
            value={form.ownerName}
            error={errors.ownerName}
            onChange={(e) => set('ownerName', e.target.value)}
          />
          <TextInput
            label="故人との続柄"
            required
            hint="例：長男、配偶者、次女"
            value={form.relationshipToDeceased}
            error={errors.relationshipToDeceased}
            onChange={(e) => set('relationshipToDeceased', e.target.value)}
          />

          <Banner tone="info">
            マイナンバーが記載された書類（住民票の一部、源泉徴収票、マイナンバーカードの写しなど）はお預かりできません。アップロード時に検知した場合はお断りします。
          </Banner>

          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={createCase.isPending}>
              {createCase.isPending ? '作成しています…' : 'ケースを作成する'}
            </Button>
            <Button onClick={() => navigate('/cases')}>キャンセル</Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
