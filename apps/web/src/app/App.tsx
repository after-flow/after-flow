import { useEffect } from 'react'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom'
import { ApiError, setEmailNotVerifiedHandler, setUnauthorizedHandler } from '@/lib/api/client'
import { useConsents } from '@/lib/api/queries'
import { useLogout } from '@/lib/useLogout'
import { AuthProvider, useAuth } from '@/lib/auth/AuthProvider'
import { AppShell } from '@/shell/AppShell'
import { ConsentScreen } from '@/screens/ConsentScreen'
import { LegalScreen } from '@/screens/LegalScreen'
import { Toaster, toast } from '@/kit/toast'
import { Loading, ErrorState } from '@/kit/kit'
import {
  AccountInactiveScreen,
  LoginScreen,
  ResetPasswordScreen,
  SignupScreen,
  VerifyEmailScreen,
} from '@/screens/AuthScreens'
import { CaseNewScreen, CasesScreen } from '@/screens/EntryScreens'
import { HomeScreen } from '@/screens/HomeScreen'
import { TasksScreen } from '@/screens/TasksScreen'
import { TaskScreen } from '@/screens/TaskScreen'
import { ApprovalsScreen } from '@/screens/ApprovalsScreen'
import { ApprovalScreen } from '@/screens/ApprovalScreen'
import { FlowScreen } from '@/screens/FlowScreen'
import { DocumentScreen, DocumentsScreen } from '@/screens/DocumentsScreen'
import { PropertyScreen } from '@/screens/PropertyScreen'
import { FamilyScreen } from '@/screens/FamilyScreen'
import { ChatScreen } from '@/screens/ChatScreen'
import { SetupScreen } from '@/screens/SetupScreen'

const queryClient = new QueryClient({
  /*
    保存・記録の失敗は、どの画面でも必ず知らせる。
    画面側で独自に文言を出すもの（書類のアップロードなど）は meta.handlesError で除く。
    セッション切れ（401）はログイン画面へ戻すので、ここでは出さない。
  */
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      if (mutation.meta?.handlesError) return
      if (error instanceof ApiError && error.status === 401) return
      if (error instanceof ApiError && error.code === 'CONFLICT') {
        toast('ほかの方が先に内容を変えたため、保存できませんでした。画面を開き直してから、もう一度お試しください。', 'error')
        return
      }
      if (error instanceof ApiError && error.code === 'CONSENT_REQUIRED') return // 画面側（AiConsentNotice）が処理する
      if (error instanceof ApiError && error.code === 'FEATURE_NOT_CONNECTED') {
        toast('この環境ではまだ使えません。', 'error')
        return
      }
      if (error instanceof ApiError && (error.code === 'PRECONDITION_REQUIRED' || error.code === 'IDEMPOTENCY_KEY_REUSED')) {
        console.error('client bug:', error)
        toast('画面の不具合で保存できませんでした。お手数ですが運営までご連絡ください。', 'error')
        return
      }
      toast('保存できませんでした。通信の状態をご確認のうえ、もう一度お試しください。', 'error')
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

/**
 * サインイン状態のガード。
 * `status==='loading'` の間は判定できないので待つ（ADR §1・§2の骨格）。
 * メール確認の要否はここでは判定しない。唯一の判定者は BE で、403 EMAIL_NOT_VERIFIED を
 * 受けたときに `EmailVerificationHandler` が `/verify-email` へ送る（§検討推奨7）。
 */
function RequireAuth() {
  const { status } = useAuth()
  if (status === 'loading') return <Loading label="ログイン状態を確認中" />
  if (status === 'signed-out') return <Navigate to="/login" replace />
  return <Outlet />
}

/**
 * `POST /me` による登録が終わるまで待つ。
 * 停止済みアカウント（MEMBERSHIP_INACTIVE）は専用画面へ、それ以外の失敗はエラー表示にする。
 */
function RequireRegistered() {
  const { registration } = useAuth()
  if (registration.status === 'idle' || registration.status === 'pending') {
    return <Loading label="利用登録を確認中" />
  }
  if (registration.status === 'inactive') return <AccountInactiveScreen />
  if (registration.status === 'error') {
    return <ErrorState message="利用登録を確認できませんでした。時間をおいてもう一度お試しください。" />
  }
  return <Outlet />
}

/**
 * 必須の同意が済むまで、ケースの画面へ入れない。
 * 企画書セクション5の「利用目的の明示・同意取得」に対応する。
 */
function RequireConsent() {
  const { data, isLoading, isError } = useConsents()
  if (isLoading) return <Loading label="確認事項を読み込み中" />
  // 取得できないときに利用を止めてしまうと復旧できないので、通したうえで画面側で扱う
  if (isError) return <Outlet />
  return data?.outstanding ? <Navigate to="/consent" replace /> : <Outlet />
}

/**
 * セッション切れ（Public API が 401 を返した）場合に、
 * キャッシュを破棄してログイン画面へ戻す。
 */
function SessionExpiryHandler() {
  const logout = useLogout()
  useEffect(() => {
    setUnauthorizedHandler(logout)
  }, [logout])
  return null
}

/** BE が 403 EMAIL_NOT_VERIFIED を返したら `/verify-email` へ送る（§検討推奨7）。 */
function EmailVerificationHandler() {
  const navigate = useNavigate()
  useEffect(() => {
    setEmailNotVerifiedHandler(() => navigate('/verify-email', { replace: true }))
  }, [navigate])
  return null
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <SessionExpiryHandler />
          <EmailVerificationHandler />
          <Toaster />
          <Routes>
            <Route path="/login" element={<LoginScreen />} />
            <Route path="/signup" element={<SignupScreen />} />
            <Route path="/reset-password" element={<ResetPasswordScreen />} />
            <Route path="/verify-email" element={<VerifyEmailScreen />} />

            <Route element={<RequireAuth />}>
              <Route path="/legal/:docId" element={<LegalScreen />} />

              <Route element={<RequireRegistered />}>
                <Route path="/consent" element={<ConsentScreen />} />

                <Route element={<RequireConsent />}>
                  <Route path="/cases" element={<CasesScreen />} />
                  <Route path="/cases/new" element={<CaseNewScreen />} />

                  <Route path="/cases/:caseId" element={<AppShell />}>
                    <Route index element={<HomeScreen />} />
                    <Route path="tasks" element={<TasksScreen />} />
                    <Route path="tasks/:taskId" element={<TaskScreen />} />
                    <Route path="flow" element={<FlowScreen />} />
                    <Route path="approvals" element={<ApprovalsScreen />} />
                    <Route path="approvals/:approvalId" element={<ApprovalScreen />} />
                    <Route path="insights" element={<Navigate to="../approvals?tab=insights" replace />} />
                    <Route path="documents" element={<DocumentsScreen />} />
                    <Route path="documents/:documentId" element={<DocumentScreen />} />
                    <Route path="property" element={<PropertyScreen />} />
                    <Route path="family" element={<FamilyScreen />} />
                    <Route path="chat" element={<ChatScreen />} />
                    <Route path="setup" element={<SetupScreen />} />
                  </Route>
                </Route>
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/cases" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
