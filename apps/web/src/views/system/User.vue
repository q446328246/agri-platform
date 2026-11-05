<template>
  <div class="page-container">
    <div class="card-container">
      <el-form :inline="true" :model="query" @submit.prevent="reload">
        <el-form-item label="关键词">
          <el-input v-model="query.keyword" placeholder="用户名 / 姓名 / 手机号" clearable style="width: 200px" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="query.status" placeholder="全部" clearable style="width: 120px">
            <el-option label="启用" value="ACTIVE" />
            <el-option label="停用" value="DISABLED" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="reload">查询</el-button>
          <el-button @click="reset">重置</el-button>
          <el-button type="success" @click="openDialog()">新建用户</el-button>
        </el-form-item>
      </el-form>

      <el-table v-loading="loading" :data="users" border stripe row-key="id">
        <el-table-column prop="username" label="用户名" width="150" />
        <el-table-column prop="name" label="姓名" width="120" />
        <el-table-column prop="phone" label="手机号" width="140">
          <template #default="{ row }">{{ row.phone || '-' }}</template>
        </el-table-column>
        <el-table-column label="角色" min-width="200">
          <template #default="{ row }">
            <el-tag v-for="code in row.roles" :key="code" class="role-tag" size="small" effect="plain">
              {{ roleName(code) }}
            </el-tag>
            <span v-if="row.roles.length === 0">-</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-switch
              :model-value="row.status === 'ACTIVE'"
              :before-change="() => toggleStatus(row)"
            />
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDialog(row)">编辑</el-button>
            <el-button link type="warning" @click="resetPassword(row)">重置密码</el-button>
            <el-button link type="danger" :disabled="row.username === 'admin'" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无用户" />
        </template>
      </el-table>

      <div class="pagination-container">
        <el-pagination
          v-model:current-page="query.page"
          v-model:page-size="query.size"
          :total="total"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next"
          @current-change="load"
          @size-change="reload"
        />
      </div>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑用户' : '新建用户'" width="560px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="用户名" required>
          <el-input v-model="form.username" :disabled="Boolean(editingId)" placeholder="字母开头，3~32 位" maxlength="32" />
        </el-form-item>
        <el-form-item label="姓名" required>
          <el-input v-model="form.name" placeholder="请输入姓名" maxlength="20" />
        </el-form-item>
        <el-form-item label="手机号">
          <el-input v-model="form.phone" placeholder="选填" maxlength="20" />
        </el-form-item>
        <el-form-item v-if="!editingId" label="初始密码">
          <el-input v-model="form.password" placeholder="默认 123456，至少 6 位" maxlength="32" show-password />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.roles" multiple filterable placeholder="请选择角色" style="width: 100%">
            <el-option v-for="role in roles" :key="role.code" :label="role.name" :value="role.code" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="form.status">
            <el-radio value="ACTIVE">启用</el-radio>
            <el-radio value="DISABLED">停用</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { authApi, platformApi } from '@/api'
import type { PlatformRole, SystemUser } from '@/types'
import { formatDateTime } from '@/utils'

const loading = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const editingId = ref('')
const users = ref<SystemUser[]>([])
const roles = ref<PlatformRole[]>([])
const total = ref(0)

const query = reactive({
  page: 1,
  size: 20,
  keyword: '',
  status: '' as '' | 'ACTIVE' | 'DISABLED',
})

const form = reactive({
  username: '',
  name: '',
  phone: '',
  password: '',
  roles: [] as string[],
  status: 'ACTIVE' as 'ACTIVE' | 'DISABLED',
})

function roleName(code: string): string {
  return roles.value.find((role) => role.code === code)?.name ?? code
}

async function loadRoles(): Promise<void> {
  try {
    roles.value = (await platformApi.getRoles({ page: 1, size: 200 })).items ?? []
  } catch {
    // 角色列表失败时用户表格仍可用，角色列回退显示编码
    roles.value = []
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const params: { page: number; size: number; keyword?: string; status?: 'ACTIVE' | 'DISABLED' } = { page: query.page, size: query.size }
    const keyword = query.keyword.trim()
    if (keyword) params.keyword = keyword
    if (query.status) params.status = query.status
    const result = await authApi.getUsers(params)
    users.value = result.items ?? []
    total.value = result.total ?? 0
  } finally {
    loading.value = false
  }
}

function reload(): void {
  query.page = 1
  void load()
}

function reset(): void {
  query.keyword = ''
  query.status = ''
  reload()
}

function openDialog(row?: SystemUser): void {
  editingId.value = row ? row.id : ''
  form.username = row?.username ?? ''
  form.name = row?.name ?? ''
  form.phone = row?.phone ?? ''
  form.password = ''
  form.roles = row ? [...row.roles] : []
  form.status = row?.status ?? 'ACTIVE'
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const name = form.name.trim()
  if (!name) {
    ElMessage.warning('请输入姓名')
    return
  }
  if (!editingId.value && !/^[a-zA-Z][a-zA-Z0-9_-]{2,31}$/.test(form.username.trim())) {
    ElMessage.warning('用户名需以字母开头，3~32 位字母、数字、下划线或短横线')
    return
  }
  submitting.value = true
  try {
    if (editingId.value) {
      await authApi.updateUser(editingId.value, {
        name,
        phone: form.phone.trim(),
        roles: form.roles,
        status: form.status,
      })
      ElMessage.success('用户已更新')
    } else {
      const password = form.password.trim()
      await authApi.createUser({
        username: form.username.trim(),
        name,
        phone: form.phone.trim(),
        roles: form.roles,
        status: form.status,
        ...(password ? { password } : {}),
      })
      ElMessage.success('用户已创建')
    }
    dialogVisible.value = false
    await load()
  } finally {
    submitting.value = false
  }
}

async function toggleStatus(row: SystemUser): Promise<boolean> {
  const next = row.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'
  try {
    await authApi.updateUser(row.id, { status: next })
    row.status = next
    ElMessage.success(next === 'ACTIVE' ? '账号已启用' : '账号已停用')
  } catch {
    return false
  }
  return true
}

async function resetPassword(row: SystemUser): Promise<void> {
  const result = await ElMessageBox.prompt(`为 ${row.name} 设置新密码`, '重置密码', {
    inputPlaceholder: '至少 6 位',
    inputPattern: /^.{6,32}$/,
    inputErrorMessage: '密码长度需为 6~32 位',
  }).catch(() => null)
  if (!result) return
  await authApi.resetPassword(row.id, result.value)
  ElMessage.success('密码已重置')
}

async function remove(row: SystemUser): Promise<void> {
  await ElMessageBox.confirm(`确认删除用户 ${row.name}（${row.username}）？`, '删除用户', { type: 'warning' })
  await authApi.deleteUser(row.id)
  ElMessage.success('用户已删除')
  await load()
}

onMounted(async () => {
  await loadRoles()
  await load()
})
</script>

<style scoped>
.role-tag {
  margin: 0 6px 6px 0;
}
</style>
