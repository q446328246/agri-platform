import { defineStore } from 'pinia'
import { ref } from 'vue'

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
  const userInfo = ref<UserInfo | null>(null)

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

  return {
    token,
    userInfo,
    setToken,
    setUserInfo,
    logout
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
