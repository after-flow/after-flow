/**
 * ログイン・登録・メール確認・パスワード再設定。
 *
 * サインインそのものは `lib/auth`（AuthPort）に任せ、ここは文言と画面遷移だけを持つ。
 * mock（VITE_USE_MOCK=true）では任意のメール・パスワードで成功する。
 */
import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth/AuthProvider'
import { AuthError, getAuthPort } from '@/lib/auth'
import { Button, ErrorState, Field, Notice, inputClass } from '@/kit/kit'
import { Centered, Logo } from './parts/EntryLayout'

function authErrorMessage(err: unknown): string {
  const code = err instanceof AuthError ? err.code : null
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
      return 'メールアドレスまたはパスワードが正しくありません。'
    case 'auth/too-many-requests':
      return 'しばらく待ってから、もう一度お試しください。'
    case 'auth/network-request-failed':
      return '通信の状態をご確認のうえ、もう一度お試しください。'
    case 'auth/email-already-in-use':
      return 'このメールアドレスはすでに登録されています。ログインしてください。'
    case 'auth/weak-password':
      return 'パスワードは8文字以上にしてください。'
    default:
      return 'うまく進められませんでした。もう一度お試しください。'
  }
}

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
      const port = await getAuthPort()
      await port.signIn(email, password)
      navigate('/cases')
    } catch (err) {
      setError(authErrorMessage(err))
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
        <div className="flex flex-col gap-1 text-center text-[0.9rem]">
          <Link to="/signup" className="font-bold text-rd-primary-text hover:underline">
            はじめての方はこちら（登録）
          </Link>
          <Link to="/reset-password" className="text-rd-text-2 hover:underline">
            パスワードを忘れた方
          </Link>
        </div>
      </form>
    </Centered>
  )
}

/* ---------- 登録 ---------- */

export function SignupScreen() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError('パスワードは8文字以上にしてください。')
      return
    }
    if (password !== confirm) {
      setError('パスワードが一致しません。')
      return
    }
    setBusy(true)
    try {
      const port = await getAuthPort()
      await port.signUp(email, password)
      await port.sendEmailVerification()
      // メール確認が必要かは Backend が判定する（403 EMAIL_NOT_VERIFIED で /verify-email へ戻る）
      navigate('/cases')
    } catch (err) {
      setError(authErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Centered>
      <div className="mt-[8vh] flex flex-col items-center text-center">
        <Logo />
      </div>
      <form onSubmit={(e) => void onSubmit(e)} className="mt-6 flex flex-col gap-4 rounded-lg border border-rd-border bg-rd-card p-6">
        <h1 className="text-[1.05rem] font-bold">はじめてご利用の方</h1>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <Field label="メールアドレス" required>
          {(id) => <input id={id} type="email" autoComplete="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="パスワード" required hint="8文字以上">
          {(id) => <input id={id} type="password" autoComplete="new-password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Field label="パスワード（確認）" required>
          {(id) => <input id={id} type="password" autoComplete="new-password" className={inputClass} value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" size="lg" disabled={busy || !email || !password || !confirm}>
          {busy ? '登録しています…' : '登録する'}
        </Button>
        <Link to="/login" className="text-center text-[0.9rem] font-bold text-rd-primary-text hover:underline">
          すでにアカウントをお持ちの方
        </Link>
      </form>
    </Centered>
  )
}

/* ---------- メール確認 ---------- */

export function VerifyEmailScreen() {
  const { status, emailVerified } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (status === 'signed-out') return <Navigate to="/login" replace />
  if (status === 'signed-in' && emailVerified) return <Navigate to="/consent" replace />

  return (
    <Centered>
      <div className="mt-[8vh] flex flex-col items-center text-center">
        <Logo />
      </div>
      <div className="mt-6 flex flex-col gap-4 rounded-lg border border-rd-border bg-rd-card p-6 text-center">
        <h1 className="text-[1.05rem] font-bold">確認メールを送りました</h1>
        <p className="text-[0.94rem] leading-relaxed text-rd-text-2">
          メールの中のリンクを開いて、メールアドレスの確認を済ませてください。ローカル環境では
          <code className="mx-1 rounded bg-rd-shade px-1 py-0.5 text-[0.86rem]">make dev-verify-email</code>
          でも確認を済ませられます。
        </p>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        {sent && <Notice tone="success">もう一度送りました。</Notice>}
        <Button
          variant="primary"
          size="lg"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              const port = await getAuthPort()
              await port.reload()
              await port.getToken(true)
              navigate('/cases', { replace: true })
            } catch {
              setError('確認できませんでした。もう一度お試しください。')
            } finally {
              setBusy(false)
            }
          }}
        >
          確認しました（再読み込み）
        </Button>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              const port = await getAuthPort()
              await port.sendEmailVerification()
              setSent(true)
            } catch {
              setError('送れませんでした。もう一度お試しください。')
            } finally {
              setBusy(false)
            }
          }}
        >
          もう一度送る
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            const port = await getAuthPort()
            await port.signOut()
            navigate('/login', { replace: true })
          }}
        >
          別のアカウントでログイン
        </Button>
      </div>
    </Centered>
  )
}

/* ---------- パスワード再設定 ---------- */

export function ResetPasswordScreen() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const port = await getAuthPort()
      await port.sendPasswordReset(email)
      setSent(true)
    } catch (err) {
      setError(authErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <Centered>
        <div className="mt-[8vh] flex flex-col items-center text-center">
          <Logo />
        </div>
        <div className="mt-6 rounded-lg border border-rd-border bg-rd-card p-6 text-center">
          <p className="text-[0.97rem] font-bold">再設定用のメールを送りました</p>
          <p className="mt-1 text-[0.9rem] text-rd-text-2">メールの中のリンクからパスワードを再設定してください。</p>
          <Link to="/login" className="mt-4 inline-block text-[0.9rem] font-bold text-rd-primary-text hover:underline">
            ログイン画面へ戻る
          </Link>
        </div>
      </Centered>
    )
  }

  return (
    <Centered>
      <div className="mt-[8vh] flex flex-col items-center text-center">
        <Logo />
      </div>
      <form onSubmit={(e) => void onSubmit(e)} className="mt-6 flex flex-col gap-4 rounded-lg border border-rd-border bg-rd-card p-6">
        <h1 className="text-[1.05rem] font-bold">パスワードを再設定する</h1>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <Field label="メールアドレス" required>
          {(id) => <input id={id} type="email" autoComplete="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" size="lg" disabled={busy || !email}>
          {busy ? '送っています…' : '再設定メールを送る'}
        </Button>
        <Link to="/login" className="text-center text-[0.9rem] font-bold text-rd-primary-text hover:underline">
          ログイン画面へ戻る
        </Link>
      </form>
    </Centered>
  )
}

/** このアカウントは利用を停止されています（membership.active === false） */
export function AccountInactiveScreen() {
  return (
    <Centered>
      <div className="mt-[8vh] flex flex-col items-center text-center">
        <Logo />
      </div>
      <div className="mt-6">
        <ErrorState message="このアカウントは利用を停止されています。心当たりがない場合は運営までお問い合わせください。" />
      </div>
    </Centered>
  )
}
