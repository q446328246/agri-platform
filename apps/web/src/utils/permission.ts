import type { UserInfo } from '@/types'

/**
 * 权限判定：与契约层 `hasPermission` 保持一致的匹配规则。
 * `*` 表示全部权限，`领域:*` 表示该领域全部权限，其余为精确匹配。
 */
export function checkPermission(granted: readonly string[] | undefined, required?: string): boolean {
  if (!required) return true
  if (!granted || granted.length === 0) return false
  return granted.some((code) => code === '*' || code === required || (code.endsWith(':*') && required.startsWith(code.slice(0, -1))))
}

/** 从本地缓存读取当前账号，供路由守卫等组件外场景使用 */
export function cachedUserInfo(): UserInfo | null {
  try {
    const raw = localStorage.getItem('userInfo')
    if (!raw) return null
    const info = JSON.parse(raw) as UserInfo
    return info && typeof info === 'object' ? info : null
  } catch {
    return null
  }
}

/** 本地缓存中的权限清单 */
export function cachedPermissions(): string[] {
  const info = cachedUserInfo()
  return Array.isArray(info?.permissions) ? info.permissions : []
}
