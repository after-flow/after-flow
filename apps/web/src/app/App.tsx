import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { getToken, setUnauthorizedHandler } from '@/lib/api/client'
import { useConsents } from '@/lib/api/queries'
import { Spinner } from '@/components/ui/Primitives'
import { useLogout } from '@/lib/useLogout'
import { CaseLayout } from '@/components/layout/CaseLayout'
import { LoginPage } from '@/features/auth/LoginPage'
import { CaseListPage } from '@/features/cases/CaseListPage'
import { CaseNewPage } from '@/features/cases/CaseNewPage'
import { DashboardPage } from '@/features/cases/DashboardPage'
import { DocumentsPage } from '@/features/documents/DocumentsPage'
import { DocumentDetailPage } from '@/features/documents/DocumentDetailPage'
import { TasksPage } from '@/features/tasks/TasksPage'
import { TaskDetailPage } from '@/features/tasks/TaskDetailPage'
import { PropertyPage } from '@/features/estate/PropertyPage'
import { ApprovalsPage } from '@/features/approvals/ApprovalsPage'
import { ApprovalDetailPage } from '@/features/approvals/ApprovalDetailPage'
import { ChatPage } from '@/features/chat/ChatPage'
import { InsightsPage } from '@/features/insights/InsightsPage'
import { FamilyPage } from '@/features/family/FamilyPage'
import { ConsentPage } from '@/features/auth/ConsentPage'
import { LegalPage } from '@/features/auth/LegalPage'

const queryClient = new QueryClient({
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
  if (isLoading) return <Spinner label="確認事項を読み込み中" />
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
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route element={<RequireAuth />}>
            <Route path="/consent" element={<ConsentPage />} />
            <Route path="/legal/:docId" element={<LegalPage />} />

            <Route element={<RequireConsent />}>
            <Route path="/cases" element={<CaseListPage />} />
            <Route path="/cases/new" element={<CaseNewPage />} />

            <Route path="/cases/:caseId" element={<CaseLayout />}>
              <Route index element={<DashboardPage />} />
              <Route path="documents" element={<DocumentsPage />} />
              <Route path="documents/:documentId" element={<DocumentDetailPage />} />
              <Route path="tasks" element={<TasksPage />} />
              <Route path="tasks/:taskId" element={<TaskDetailPage />} />
              <Route path="property" element={<PropertyPage />} />
              <Route path="approvals" element={<ApprovalsPage />} />
              <Route path="approvals/:approvalId" element={<ApprovalDetailPage />} />
              <Route path="insights" element={<InsightsPage />} />
              <Route path="chat" element={<ChatPage />} />
              <Route path="family" element={<FamilyPage />} />
            </Route>
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/cases" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
