<template>
  <div class="page-container flex-center">
    <div class="card-container text-center" style="width: 600px; padding: 60px;">
      <el-result icon="error" title="403" sub-title="当前账号没有访问该页面的权限，请联系管理员分配角色">
        <template #extra>
          <el-button type="primary" @click="goHome">返回首页</el-button>
          <el-button @click="switchAccount">切换账号</el-button>
        </template>
      </el-result>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores'

const router = useRouter()
const userStore = useUserStore()

function goHome() {
  router.push('/')
}

function switchAccount() {
  userStore.logout()
  router.replace('/login')
}
</script>
