<template>
  <div class="page-container flex-center">
    <div class="card-container text-center" style="width: 600px; padding: 60px;">
      <el-result icon="warning" title="404" sub-title="抱歉，您访问的页面不存在">
        <template #extra>
          <el-button type="primary" @click="goHome">返回首页</el-button>
        </template>
      </el-result>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()

function goHome() {
  router.push('/')
}
</script>
