<template>
  <el-container class="layout-container">
    <el-aside :width="isCollapsed ? '64px' : '240px'" class="sidebar">
      <div class="logo">
        <el-icon :size="28"><Grape /></el-icon>
        <span v-if="!isCollapsed" class="logo-text">智慧农业</span>
      </div>
      <el-menu
        :default-active="route.path"
        :collapse="isCollapsed"
        :collapse-transition="false"
        router
        background-color="#304156"
        text-color="#bfcbd9"
        active-text-color="#409EFF"
      >
        <template v-for="item in menuList" :key="item.path">
          <el-sub-menu v-if="item.children && item.children.length" :index="resolvePath('/', item.path)">
            <template #title>
              <el-icon><component :is="item.meta!.icon" /></el-icon>
              <span>{{ item.meta!.title }}</span>
            </template>
            <el-menu-item
              v-for="child in item.children.filter(c => !c.meta?.hidden)"
              :key="child.path"
              :index="resolvePath(item.path, child.path)"
            >
              {{ child.meta!.title }}
            </el-menu-item>
          </el-sub-menu>
          <el-menu-item v-else-if="!item.meta?.hidden" :index="resolvePath('/', item.path)">
            <el-icon><component :is="item.meta!.icon" /></el-icon>
            <template #title>{{ item.meta!.title }}</template>
          </el-menu-item>
        </template>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <div class="header-left">
          <el-icon class="collapse-btn" :size="20" @click="toggleSidebar">
            <Fold v-if="!isCollapsed" />
            <Expand v-else />
          </el-icon>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item v-for="(item, index) in breadcrumbs" :key="index">
              {{ item.meta!.title }}
            </el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div class="header-right">
          <el-tooltip v-if="userStore.hasPermission('message:read')" content="消息中心" placement="bottom">
            <el-badge :value="unread" :max="99" :hidden="unread === 0" class="message-badge">
              <el-icon class="message-icon" :size="20" @click="router.push('/message')"><Bell /></el-icon>
            </el-badge>
          </el-tooltip>
          <el-dropdown @command="handleCommand">
            <div class="user-info">
              <el-avatar :size="32" src="https://cube.elemecdn.com/3/7c/3ea6beec64369c2642b92c6726f1epng.png" />
              <span class="username">{{ userStore.userInfo?.name || userStore.userInfo?.username || '管理员' }}</span>
              <el-icon><ArrowDown /></el-icon>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="profile">个人中心</el-dropdown-item>
                <el-dropdown-item command="settings">系统设置</el-dropdown-item>
                <el-dropdown-item divided command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>
      <el-main class="main-content">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore, useUserStore } from '@/stores'
import { checkPermission } from '@/utils/permission'
import { messageApi } from '@/api'

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const userStore = useUserStore()

// 未读消息角标：与消息中心共用计数接口，定时轮询保持与事件消费同步
const unread = ref(0)
let unreadTimer: ReturnType<typeof setInterval> | undefined

async function refreshUnread() {
  // 无消息权限的账号不请求未读数，避免轮询一直报 403
  if (!userStore.hasPermission('message:read')) return
  try {
    unread.value = (await messageApi.getUnreadCount()).unread
  } catch {
    // 网关或消息服务暂不可用时保持上一次计数，不打断页面操作
  }
}

onMounted(() => {
  void refreshUnread()
  unreadTimer = setInterval(() => void refreshUnread(), 30000)
})

onUnmounted(() => {
  if (unreadTimer) clearInterval(unreadTimer)
})

const isCollapsed = computed(() => appStore.sidebarCollapsed)

// 菜单按权限过滤：分组下无可见子页时整组隐藏，未声明权限的路由默认展示
const menuList = computed(() => {
  const routes = router.getRoutes()
  const granted = userStore.permissions
  const children = routes.find(r => r.path === '/')?.children?.filter(c => c.meta?.title) || []
  return children
    .map(item => ({
      ...item,
      children: item.children?.filter(child => !child.meta?.hidden && checkPermission(granted, child.meta?.permission as string | undefined))
    }))
    .filter(item => {
      if (item.meta?.hidden) return false
      if (!checkPermission(granted, item.meta?.permission as string | undefined)) return false
      return !item.children || item.children.length > 0
    })
})

const breadcrumbs = computed(() => {
  return route.matched.filter(item => item.meta?.title)
})

function toggleSidebar() {
  appStore.toggleSidebar()
}

// 菜单必须给出绝对地址：getRoutes() 根记录的子项仍是相对 path（如 plot/list），
// el-menu 的 router 模式按当前路由相对跳转，相对地址在深层页面会拼成 /plot/plot/list。
function resolvePath(parent: string, child: string): string {
  if (child.startsWith('/')) return child
  const base = parent.startsWith('/') ? parent : `/${parent}`
  return `${base}/${child}`.replace(/\/{2,}/g, '/')
}

function handleCommand(command: string) {
  if (command === 'logout') {
    userStore.logout()
    router.push('/login')
  }
}
</script>

<style scoped lang="scss">
.layout-container {
  height: 100vh;
}

.sidebar {
  background: #304156;
  transition: width 0.3s;
  overflow-x: hidden;
}

.logo {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 18px;
  font-weight: bold;
  gap: 8px;
  background: #263445;
  
  .logo-text {
    white-space: nowrap;
  }
}

.el-menu {
  border-right: none;
}

.header {
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  box-shadow: 0 1px 4px rgba(0, 21, 41, 0.08);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.collapse-btn {
  cursor: pointer;
  color: #606266;
  &:hover {
    color: #409EFF;
  }
}

.header-right {
  display: flex;
  align-items: center;
  gap: 20px;
}

.message-badge {
  display: flex;
  align-items: center;
}

.message-icon {
  cursor: pointer;
  color: #606266;
  &:hover {
    color: #409EFF;
  }
}

.user-info {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 0 12px;
  height: 60px;
  
  .username {
    color: #606266;
  }
  
  &:hover {
    background: #f5f7fa;
  }
}

.main-content {
  background: #f0f2f5;
  padding: 0;
  overflow-y: auto;
}
</style>
