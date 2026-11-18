<template>
  <div>
    <header v-if="session.user && route.path !== '/login'" class="m-header">
      <span class="m-header__title">{{ pageTitle }}</span>
      <span class="m-header__user">{{ session.user.name || session.user.username }}</span>
      <button class="m-header__btn" @click="onLogout">退出</button>
    </header>

    <router-view />

    <nav v-if="session.user && route.path !== '/login'" class="m-tabbar">
      <router-link v-for="tab in visibleTabs" :key="tab.path" :to="tab.path" class="m-tabbar__item" :class="{ active: route.path === tab.path }">
        <span class="m-tabbar__icon">{{ tab.icon }}</span>
        {{ tab.label }}
      </router-link>
    </nav>

    <div v-if="toast.visible" class="m-toast" :class="`m-toast--${toast.kind}`">{{ toast.text }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { logout, session, hasPerm } from './auth'
import { toast } from './api'

const route = useRoute()
const router = useRouter()

/** 页签按权限过滤：与桌面端菜单 checkPermission 同口径 */
const tabs = [
  { path: '/cockpit', label: '驾驶舱', icon: '📊', perm: 'plot:read' },
  { path: '/patrol', label: '巡田', icon: '🌾', perm: 'trace:read' },
  { path: '/tasks', label: '任务回执', icon: '✅', perm: 'operation:read' }
]
const visibleTabs = computed(() => tabs.filter((tab) => hasPerm(tab.perm)))
const pageTitle = computed(() => tabs.find((tab) => tab.path === route.path)?.label ?? '无人农场')

function onLogout() {
  logout()
  void router.replace('/login')
}
</script>