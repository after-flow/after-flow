import { useEffect } from 'react'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { HttpError, getToken, setUnauthorizedHandler } from '@/api/client'
import { useConsents } from '@/api/queries'
import { useLogout } from '@/lib/useLogout'
import { AppShell } from '@/shell/AppShell'
import { ConsentScreen } from '@/screens/ConsentScreen'
import { LegalScreen } from '@/screens/LegalScreen'
import { Toaster, toast } from '@/kit/toast'
import { Loading } from '@/kit/kit'
import { CaseNewScreen, CasesScreen, LoginScreen } from '@/screens/EntryScreens'
import { HomeScreen } from '@/screens/HomeScreen'
import { TasksScreen } from '@/screens/TasksScreen'
import { TaskScreen } from '@/screens/TaskScreen'
import { ApprovalsScreen } from '@/screens/ApprovalsScreen'
import { ApprovalScreen } from '@/screens/ApprovalScreen'
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
      if (error instanceof HttpError && error.status === 401) return
      toast(
        error instanceof HttpError && error.status === 409
          ? 'ほかの方が先に内容を変えたため、保存できませんでした。画面を開き直してから、もう一度お試しください。'
          : '保存できませんでした。通信の状態をご確認のうえ、もう一度お試しください。',
        'error',
      )
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

function RequireAuth() {
  return getToken() ? <Outlet /> : <Navigate to="/login" replace />
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

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionExpiryHandler />
        <Toaster />
        <Routes>
          <Route path="/login" element={<LoginScreen />} />

          <Route element={<RequireAuth />}>
            <Route path="/consent" element={<ConsentScreen />} />
            <Route path="/legal/:docId" element={<LegalScreen />} />

            <Route element={<RequireConsent />}>
              <Route path="/cases" element={<CasesScreen />} />
              <Route path="/cases/new" element={<CaseNewScreen />} />

              <Route path="/cases/:caseId" element={<AppShell />}>
                <Route index element={<HomeScreen />} />
                <Route path="tasks" element={<TasksScreen />} />
                <Route path="tasks/:taskId" element={<TaskScreen />} />
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

          <Route path="*" element={<Navigate to="/cases" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
