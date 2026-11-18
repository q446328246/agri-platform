import { reactive } from 'vue'
import { api, TOKEN_KEY, USER_KEY } from './api'
import type { MobileUser } from './types'

/** 移动端会话：与桌面端同一套认证接口，本地存储键独立，互不踢线 */
export const session = reactive<{ user: MobileUser | null }>({ user: null })

function restore(): void {
  const token = localStorage.getItem(TOKEN_KEY)
  const raw = localStorage.getItem(USER_KEY)
  if (!token || !raw) return
  try {
    session.user = JSON.parse(raw) as MobileUser
  } catch {
    localStorage.removeItem(USER_KEY)
  }
}
restore()

export async function login(username: string, password: string): Promise<void> {
  const result = await api.login(username, password)
  localStorage.setItem(TOKEN_KEY, result.token)
  localStorage.setItem(USER_KEY, JSON.stringify(result.user))
  session.user = result.user
}

export function logout(): void {
  void api.logout().catch(() => undefined)
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  session.user = null
}

/** 权限判定与桌面端 checkPermission 同口径：* 通配或精确命中 */
export function hasPerm(code: string): boolean {
  const permissions = session.user?.permissions ?? []
  return permissions.includes('*') || permissions.includes(code)
}