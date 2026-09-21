/**
 * ケースに入る前の画面（ログイン・ケース一覧・ケース作成）。
 * サイドバーは出さず、中央にひとつのことだけを置く。
 */
import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { api, setToken } from '@/api/client'
import { useCases, useCreateCase } from '@/api/queries'
import { Icon } from '@/kit/Icon'
import { formatDate } from '@/lib/format'
import { useLogout } from '@/lib/useLogout'
import { Button, Checkbox, ErrorState, Field, Loading, Notice, inputClass } from '@/kit/kit'
import { Centered, Logo } from './parts/EntryLayout'

/* ---------- ログイン ---------- */

export function LoginScreen() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await api.post<{ token: string }>('/auth/login', { email, password })
      setToken(res.token)
      navigate('/cases')
    } catch {
      setError('メールアドレスまたはパスワードが正しくありません。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Centered>
      <div className="mt-[8vh] flex flex-col items-center text-center">
        <Logo />
        <p className="mt-3 text-[0.94rem] leading-relaxed text-rd-text-2">
          ご家族を亡くされたあとの手続きを、期限とあわせて整理します。
        </p>
      </div>
      <form onSubmit={(e) => void onSubmit(e)} className="mt-6 flex flex-col gap-4 rounded-lg border border-rd-border bg-rd-card p-6">
        <h1 className="text-[1.05rem] font-bold">ログイン</h1>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <Field label="メールアドレス" required>
          {(id) => <input id={id} type="email" autoComplete="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="パスワード" required>
          {(id) => <input id={id} type="password" autoComplete="current-password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" size="lg" disabled={busy || !email || !password}>
          {busy ? 'ログインしています…' : 'ログイン'}
        </Button>
      </form>
    </Centered>
  )
}

/* ---------- ケース一覧 ---------- */

/**
 * ケースが1件だけなら、一覧を見せずにそのまま開く。
 * ほとんどの利用者にとってケースは1件で、選ぶ画面は手間でしかない。
 */
export function CasesScreen() {
  const cases = useCases()
  const logout = useLogout()
  const navigate = useNavigate()
  const items = cases.data?.items ?? []
  const [autoOpened] = useState(() => sessionStorageGet('af.autoOpened') === '1')

  useEffect(() => {
    const list = cases.data?.items
    if (list?.length === 1 && !autoOpened) {
      sessionStorageSet('af.autoOpened', '1')
      navigate(`/cases/${list[0].id}`, { replace: true })
    }
  }, [cases.data, autoOpened, navigate])

  if (cases.isError) return <ErrorState message="手続きの一覧を読み込めませんでした。" onRetry={() => void cases.refetch()} />
  if (!cases.data) return <Loading />
  if (items.length === 0) return <Navigate to="/cases/new" replace />

  return (
    <Centered wide>
      <div className="flex items-center justify-between">
        <Logo />
        <Button size="sm" variant="ghost" icon="power" onClick={logout}>ログアウト</Button>
      </div>
      <h1 className="mt-8 text-[1.25rem] font-bold">どなたの手続きを進めますか？</h1>
      <ul className="mt-4 flex flex-col gap-2">
        {items.map((c) => (
          <li key={c.id}>
            <Link to={`/cases/${c.id}`} className="flex items-center gap-3 rounded-lg border border-rd-border bg-rd-card px-4 py-3.5 hover:border-rd-primary-line hover:bg-rd-primary-soft">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-rd-shade font-bold text-rd-text-2">
                {c.deceasedName.replace(/\s/g, '').slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-bold">故 {c.deceasedName} 様</span>
                <span className="block text-[0.86rem] text-rd-text-2">
                  ご逝去 {formatDate(c.dateOfDeath)}・あなたは{c.relationshipToDeceased}
                </span>
              </span>
              {c.status === 'CLOSED' && <span className="text-[0.82rem] text-rd-text-3">完了</span>}
              <Icon name="chevron-right" size={18} className="text-rd-text-3" />
            </Link>
          </li>
        ))}
      </ul>
      <Link to="/cases/new" className="mt-4 inline-flex items-center gap-1 text-[0.94rem] font-bold text-rd-primary-text hover:underline">
        <Icon name="plus" size={16} />
        別の方の手続きをはじめる
      </Link>
    </Centered>
  )
}

function sessionStorageGet(k: string) {
  try {
    return sessionStorage.getItem(k)
  } catch {
    return null
  }
}
function sessionStorageSet(k: string, v: string) {
  try {
    sessionStorage.setItem(k, v)
  } catch {
    /* 使えない環境では何もしない */
  }
}

/* ---------- ケース作成 ---------- */

/**
 * はじめの一歩。
 * 聞くのは期限の計算に要る最小限だけ（故人のお名前・ご逝去日・あなたのこと）。
 * ご逝去日が入れば、死亡届7日などの法定の期限はこの時点で確定する。
 */
export function CaseNewScreen() {
  const create = useCreateCase()
  const navigate = useNavigate()
  const cases = useCases()
  const [f, setF] = useState({ deceasedName: '', dateOfDeath: '', knownAt: '', ownerName: '', relationshipToDeceased: '' })
  const [errors, setErrors] = useState<Partial<Record<keyof typeof f, string>>>({})
  // 本人を相続人の一覧に入れておく。相続の方法の記録や、財産への制限の判定に使う
  const [isHeir, setIsHeir] = useState(true)
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }))

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const next: typeof errors = {}
    if (!f.deceasedName.trim()) next.deceasedName = 'お名前を入れてください'
    const today = new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD（端末の暦日）
    // 期限はすべてこの日から数えるので、打ち間違い（未来の日付など）はここで止める
    if (!f.dateOfDeath) next.dateOfDeath = 'ご逝去日を入れてください'
    else if (f.dateOfDeath > today) next.dateOfDeath = 'ご逝去日が今日より後になっています。日付をお確かめください'
    if (f.knownAt && f.dateOfDeath && f.knownAt < f.dateOfDeath)
      next.knownAt = '亡くなったことを知った日が、ご逝去日より前になっています'
    else if (f.knownAt && f.knownAt > today) next.knownAt = '今日より後の日付になっています'
    if (!f.ownerName.trim()) next.ownerName = 'あなたのお名前を入れてください'
    if (!f.relationshipToDeceased.trim()) next.relationshipToDeceased = '続柄を入れてください'
    setErrors(next)
    if (Object.keys(next).length > 0) return
    const created = await create.mutateAsync({
      deceasedName: f.deceasedName.trim(),
      dateOfDeath: f.dateOfDeath,
      knownAt: f.knownAt || undefined,
      ownerName: f.ownerName.trim(),
      relationshipToDeceased: f.relationshipToDeceased.trim(),
    })
    try {
      await api.post(`/cases/${created.id}/persons`, {
        name: f.ownerName.trim(),
        relationship: f.relationshipToDeceased.trim(),
        role: isHeir ? 'HEIR_CANDIDATE' : 'RELATED',
        isHeir,
      })
    } catch {
      // ケースはできているので先へ進む。家族画面からあとで登録できる
    }
    // 続けて、あてはまる手続きを洗い出すための質問へ
    navigate(`/cases/${created.id}/setup`)
  }

  return (
    <Centered>
      <Logo />
      <h1 className="mt-8 text-[1.25rem] font-bold">手続きをはじめる</h1>
      <p className="mt-1 text-[0.94rem] leading-relaxed text-rd-text-2">
        まずはこれだけ教えてください。ご逝去日から、死亡届などの期限をすぐに洗い出します。
      </p>
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="mt-5 flex flex-col gap-5 rounded-lg border border-rd-border bg-rd-card p-6">
        <fieldset className="flex flex-col gap-3.5">
          <legend className="mb-2 text-[0.86rem] font-bold text-rd-text-2">1. 亡くなった方</legend>
          <Field label="お名前" required error={errors.deceasedName}>
            {(id) => <input id={id} className={inputClass} aria-invalid={Boolean(errors.deceasedName)} placeholder="例：山田 太郎" value={f.deceasedName} onChange={(e) => set('deceasedName', e.target.value)} />}
          </Field>
          <Field label="ご逝去日" required error={errors.dateOfDeath}>
            {(id) => <input id={id} type="date" max={new Date().toLocaleDateString('sv-SE')} className={inputClass} aria-invalid={Boolean(errors.dateOfDeath)} value={f.dateOfDeath} onChange={(e) => set('dateOfDeath', e.target.value)} />}
          </Field>
          <Field label="亡くなったことを知った日" error={errors.knownAt} hint="ご逝去日と違う場合だけ入れてください。期限の数え始めが変わることがあります。">
            {(id) => <input id={id} type="date" max={new Date().toLocaleDateString('sv-SE')} className={inputClass} aria-invalid={Boolean(errors.knownAt)} value={f.knownAt} onChange={(e) => set('knownAt', e.target.value)} />}
          </Field>
        </fieldset>
        <fieldset className="flex flex-col gap-3.5">
          <legend className="mb-2 text-[0.86rem] font-bold text-rd-text-2">2. あなた</legend>
          <Field label="あなたのお名前" required error={errors.ownerName}>
            {(id) => <input id={id} className={inputClass} aria-invalid={Boolean(errors.ownerName)} value={f.ownerName} onChange={(e) => set('ownerName', e.target.value)} />}
          </Field>
          <Field label="亡くなった方との続柄" required error={errors.relationshipToDeceased} hint="例：配偶者、長男、長女">
            {(id) => <input id={id} className={inputClass} aria-invalid={Boolean(errors.relationshipToDeceased)} value={f.relationshipToDeceased} onChange={(e) => set('relationshipToDeceased', e.target.value)} />}
          </Field>
          <Checkbox checked={isHeir} onChange={setIsHeir}>
            私は相続人です（またはその可能性があります）
          </Checkbox>
          <p className="-mt-2 pl-6 text-[0.86rem] text-rd-text-2">配偶者・子・親・兄弟姉妹などが相続人になります。分からなければチェックしたままで構いません。</p>
        </fieldset>
        {create.isError && <Notice tone="danger" role="alert">作成できませんでした。もう一度お試しください。</Notice>}
        <div className="flex gap-2">
          {(cases.data?.items.length ?? 0) > 0 && (
            <Button onClick={() => navigate('/cases')}>戻る</Button>
          )}
          <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={create.isPending}>
            {create.isPending ? '準備しています…' : 'はじめる'}
          </Button>
        </div>
      </form>
    </Centered>
  )
}
