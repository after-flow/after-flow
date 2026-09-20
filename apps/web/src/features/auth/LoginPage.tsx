import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, setToken } from '@/lib/api/client'
import { Button, Card, TextInput } from '@/components/ui/Primitives'
import { Banner } from '@/components/ui/Banner'

/**
 * 認証基盤は要選定（仕様書セクション12・13）。
 * ここでは Public API の /auth/login にメール・パスワードを渡し、
 * 返ってきたアクセストークンを保持するだけの最小構成とする。
 */
export function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await api.post<{ token: string }>('/auth/login', { email, password })
      setToken(res.token)
      navigate('/cases')
    } catch {
      setError('メールアドレスまたはパスワードが正しくありません。入力内容をご確認ください。')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <span
            aria-hidden
            className="mb-3 inline-block h-1 w-10 rounded-full bg-[var(--color-brand)]"
          />
          <h1 className="text-[1.7rem] font-bold tracking-wide text-[var(--color-brand-strong)]">
            after-flow
          </h1>
          <p className="mt-2 text-[var(--color-ink-muted)]">
            ご家族を亡くされたあとの手続きを、
            <wbr />
            期限とあわせて整理するお手伝いをします。
          </p>
        </div>

        <Card bodyClassName="p-5 sm:p-6">
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            {error && (
              <Banner tone="critical" role="alert">
                {error}
              </Banner>
            )}
            <TextInput
              label="メールアドレス"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <TextInput
              label="パスワード"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'ログインしています…' : 'ログイン'}
            </Button>
          </form>
        </Card>

        <p className="mt-5 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface-sunken)] px-4 py-3 text-sm leading-relaxed text-[var(--color-ink-muted)]">
          本サービスは手続きの整理・期限管理をお手伝いするものです。書類の作成や、役所・金融機関への提出・解約の代行は行いません。
        </p>
      </div>
    </div>
  )
}
