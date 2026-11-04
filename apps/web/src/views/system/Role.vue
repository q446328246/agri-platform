<template>
  <div class="page-container">
    <div class="card-container">
      <el-table v-loading="loading" :data="roles" border stripe>
        <el-table-column prop="name" label="角色名称" />
        <el-table-column prop="code" label="角色编码" />
        <el-table-column label="权限" min-width="360"><template #default="{ row }"><el-tag v-for="permission in row.permissions" :key="permission" class="permission">{{ permission }}</el-tag></template></el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { platformApi } from '@/api'
const loading = ref(false)
const roles = ref<any[]>([])
onMounted(async () => { loading.value = true; try { roles.value = (await platformApi.getRoles()).items } finally { loading.value = false } })
</script>

<style scoped>
.permission { margin: 0 6px 6px 0; }
</style>
