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
          <el-sub-menu v-if="item.children && item.children.length" :index="item.path">
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
          <el-menu-item v-else-if="!item.meta?.hidden" :index="item.path">
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
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore, useUserStore } from '@/stores'

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const userStore = useUserStore()

const isCollapsed = computed(() => appStore.sidebarCollapsed)

const menuList = computed(() => {
  const routes = router.getRoutes()
  return routes.find(r => r.path === '/')?.children?.filter(c => c.meta?.title) || []
})

const breadcrumbs = computed(() => {
  return route.matched.filter(item => item.meta?.title)
})

function toggleSidebar() {
  appStore.toggleSidebar()
}

function resolvePath(parent: string, child: string): string {
  if (child.startsWith('/')) return child
  return `${parent}/${child}`.replace(/\/+/g, '/')
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
