import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth/AuthProvider.js'

/**
 * ログアウト処理。
 * サインアウトだけでなく、キャッシュに残ったケースの個人情報（故人・相続人・財産など）も破棄する。
 * 家族で1台の端末を共有する使われ方を想定しているため、次の利用者に前の情報が見えないようにする。
 */
export function useLogout() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { signOut } = useAuth()

  return () => {
    void signOut()
    queryClient.clear()
    // 「ケースを自動で開いた」印も消す。次にログインした人の最初の画面が変わらないように
    try {
      sessionStorage.clear()
    } catch {
      /* 使えない環境では何もしない */
    }
    navigate('/login', { replace: true })
  }
}
