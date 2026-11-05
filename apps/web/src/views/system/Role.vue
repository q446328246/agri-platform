<template>
  <div class="page-container">
    <div class="card-container">
      <el-form :inline="true" :model="query" @submit.prevent="reload">
        <el-form-item label="关键词">
          <el-input v-model="query.keyword" placeholder="角色名称或编码" clearable style="width: 200px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="reload">查询</el-button>
          <el-button @click="reset">重置</el-button>
          <el-button type="success" @click="openDialog()">新建角色</el-button>
        </el-form-item>
      </el-form>

      <el-table v-loading="loading" :data="roles" border stripe row-key="id">
        <el-table-column prop="name" label="角色名称" width="140" />
        <el-table-column prop="code" label="角色编码" width="130" />
        <el-table-column prop="description" label="说明" min-width="180" show-overflow-tooltip />
        <el-table-column label="权限" min-width="360">
          <template #default="{ row }">
            <el-tag v-if="row.permissions.includes('*')" type="danger" size="small" effect="plain">全部权限</el-tag>
            <el-tag v-for="permission in row.permissions.filter((item: string) => item !== '*')" :key="permission" class="permission" size="small" effect="plain">
              {{ permissionName(permission) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'" size="small">
              {{ row.status === 'ACTIVE' ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDialog(row)">编辑</el-button>
            <el-button link type="danger" :disabled="row.code === 'admin'" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无角色" />
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

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑角色' : '新建角色'" width="640px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="角色名称" required>
          <el-input v-model="form.name" placeholder="如：灌溉管理员" maxlength="20" />
        </el-form-item>
        <el-form-item label="角色编码" required>
          <el-input v-model="form.code" :disabled="Boolean(editingId)" placeholder="小写字母开头，3~32 位" maxlength="32" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="form.description" placeholder="选填" maxlength="60" />
        </el-form-item>
        <el-form-item label="权限">
          <div class="permission-panel">
            <el-alert v-if="isAdminRole" type="warning" :closable="false" show-icon title="内置管理员角色固定拥有全部权限，无需调整" />
            <div v-for="group in permissionGroups" :key="group.group" class="permission-group">
              <div class="permission-group__title">{{ group.group }}</div>
              <el-checkbox-group v-model="form.permissions" :disabled="isAdminRole">
                <el-checkbox v-for="item in group.items" :key="item.code" :value="item.code" :label="item.name" />
              </el-checkbox-group>
            </div>
            <span v-if="permissionGroups.length === 0" class="permission-empty">权限目录加载失败，请刷新页面重试</span>
          </div>
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
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { platformApi } from '@/api'
import type { PermissionGroup, PlatformRole } from '@/types'
import { formatDateTime } from '@/utils'

const loading = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const editingId = ref('')
const roles = ref<PlatformRole[]>([])
const permissionGroups = ref<PermissionGroup[]>([])
const total = ref(0)

const query = reactive({ page: 1, size: 20, keyword: '' })

const form = reactive({
  name: '',
  code: '',
  description: '',
  permissions: [] as string[],
  status: 'ACTIVE' as 'ACTIVE' | 'DISABLED',
})

const isAdminRole = computed(() => form.code === 'admin')

function permissionName(code: string): string {
  for (const group of permissionGroups.value) {
    const item = group.items.find((entry) => entry.code === code)
    if (item) return item.name
  }
  return code
}

async function loadPermissions(): Promise<void> {
  try {
    permissionGroups.value = (await platformApi.getPermissions()) ?? []
  } catch {
    permissionGroups.value = []
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const params: { page: number; size: number; keyword?: string } = { page: query.page, size: query.size }
    const keyword = query.keyword.trim()
    if (keyword) params.keyword = keyword
    const result = await platformApi.getRoles(params)
    roles.value = result.items ?? []
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
  reload()
}

function openDialog(row?: PlatformRole): void {
  editingId.value = row ? row.id : ''
  form.name = row?.name ?? ''
  form.code = row?.code ?? ''
  form.description = row?.description ?? ''
  form.permissions = row && !row.permissions.includes('*') ? [...row.permissions] : []
  form.status = row?.status ?? 'ACTIVE'
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const name = form.name.trim()
  const code = form.code.trim()
  if (!name) {
    ElMessage.warning('请输入角色名称')
    return
  }
  if (!editingId.value && !/^[a-z][a-z0-9_-]{2,31}$/.test(code)) {
    ElMessage.warning('角色编码需以小写字母开头，3~32 位小写字母、数字、下划线或短横线')
    return
  }
  if (!isAdminRole.value && form.permissions.length === 0) {
    ElMessage.warning('请至少选择一项权限')
    return
  }
  submitting.value = true
  try {
    if (editingId.value) {
      await platformApi.updateRole(editingId.value, {
        name,
        description: form.description.trim(),
        status: form.status,
        ...(isAdminRole.value ? {} : { permissions: form.permissions }),
      })
      ElMessage.success('角色已更新')
    } else {
      await platformApi.createRole({
        name,
        code,
        description: form.description.trim(),
        permissions: form.permissions,
      })
      ElMessage.success('角色已创建')
    }
    dialogVisible.value = false
    await load()
  } finally {
    submitting.value = false
  }
}

async function remove(row: PlatformRole): Promise<void> {
  await ElMessageBox.confirm(`确认删除角色 ${row.name}（${row.code}）？已分配该角色的用户需重新分配。`, '删除角色', { type: 'warning' })
  await platformApi.deleteRole(row.id)
  ElMessage.success('角色已删除')
  await load()
}

onMounted(async () => {
  await loadPermissions()
  await load()
})
</script>

<style scoped>
.permission { margin: 0 6px 6px 0; }

.permission-panel { width: 100%; }

.permission-group { margin-bottom: 12px; }

.permission-group__title { margin-bottom: 4px; color: #606266; font-size: 13px; font-weight: 600; }

.permission-empty { color: #909399; font-size: 13px; }
</style>
