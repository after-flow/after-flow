import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { setToken } from '@/lib/api/client'

/**
 * ログアウト処理。
 * トークンを消すだけでなく、キャッシュに残ったケースの個人情報（故人・相続人・財産など）も破棄する。
 * 家族で1台の端末を共有する使われ方を想定しているため、次の利用者に前の情報が見えないようにする。
 */
export function useLogout() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  return () => {
    setToken(null)
    queryClient.clear()
    navigate('/login', { replace: true })
  }
}
