import type { Context } from 'hono'
import type { Principal } from '../../application/context.js'

export type AppBindings = {
  Variables: {
    requestId: string
    principal: Principal
  }
}

export type AppContext = Context<AppBindings>
