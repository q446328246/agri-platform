<template>
  <div class="page-container">
    <div class="card-container">
      <el-table :data="tableData" border stripe>
        <el-table-column prop="username" label="用户名" width="150" />
        <el-table-column prop="realName" label="姓名" width="120" />
        <el-table-column prop="phone" label="手机号" width="150" />
        <el-table-column prop="roleName" label="角色" width="120" />
        <el-table-column prop="status" label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status ? 'success' : 'danger'" size="small">
              {{ row.status ? '启用' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { formatDateTime } from '@/utils'
import { authApi } from '@/api'

const tableData = ref<any[]>([])

onMounted(async () => {
  try {
    const user = await authApi.getUserInfo()
    tableData.value = [{ id: user.id, username: user.username, realName: user.name, phone: '-', roleName: user.roles?.join(', ') || '-', status: true, createdAt: '-' }]
  } catch (error) { console.error('用户信息加载失败', error) }
})
</script>
