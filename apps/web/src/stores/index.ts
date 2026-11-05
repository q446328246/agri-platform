import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { cachedUserInfo, checkPermission } from '@/utils/permission'

export interface UserInfo {
  id: string
  username: string
  name: string
  avatar?: string
  phone?: string
  email?: string
  roles: string[]
  permissions: string[]
}

export const useUserStore = defineStore('user', () => {
  const token = ref<string>(localStorage.getItem('token') || '')
  // 刷新页面后从缓存恢复，菜单过滤与按钮权限不依赖是否重新请求个人信息
  const userInfo = ref<UserInfo | null>(cachedUserInfo())
  const permissions = computed(() => userInfo.value?.permissions ?? [])

  function setToken(newToken: string) {
    token.value = newToken
    localStorage.setItem('token', newToken)
  }

  function setUserInfo(info: UserInfo) {
    userInfo.value = info
    localStorage.setItem('userInfo', JSON.stringify(info))
  }

  function logout() {
    token.value = ''
    userInfo.value = null
    localStorage.removeItem('token')
    localStorage.removeItem('userInfo')
  }

  /** 是否具备某项权限，未传时视为无需校验 */
  function hasPermission(required?: string): boolean {
    return checkPermission(permissions.value, required)
  }

  return {
    token,
    userInfo,
    permissions,
    setToken,
    setUserInfo,
    logout,
    hasPermission
  }
})

export const useAppStore = defineStore('app', () => {
  const sidebarCollapsed = ref<boolean>(false)
  const isDark = ref<boolean>(false)

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  function toggleDark() {
    isDark.value = !isDark.value
    document.documentElement.classList.toggle('dark', isDark.value)
  }

  return {
    sidebarCollapsed,
    isDark,
    toggleSidebar,
    toggleDark
  }
})
