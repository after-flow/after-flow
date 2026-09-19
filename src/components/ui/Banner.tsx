import type { ReactNode } from 'react'
import { Icon } from './Icon'

/**
 * 重要な警告は色だけでなくアイコン・文言でも区別する（仕様書セクション11）。
 */
export function Banner({
  tone = 'info',
  title,
  children,
  action,
  role = 'note',
}: {
  tone?: 'critical' | 'warning' | 'info'
  title?: ReactNode
  children: ReactNode
  action?: ReactNode
  role?: 'alert' | 'note'
}) {
  return (
    <div className={`banner banner-${tone}`} role={role === 'alert' ? 'alert' : undefined}>
      <Icon name={tone === 'info' ? 'info' : 'warning'} size={21} className="mt-0.5" />
      <div className="flex-1">
        {title && <p className="font-bold">{title}</p>}
        <div className={title ? 'mt-1' : ''}>{children}</div>
        {action && <div className="mt-2.5 flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  )
}
