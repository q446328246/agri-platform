<template>
  <div class="page-container">
    <div class="card-container">
      <el-form :inline="true" @submit.prevent="load">
        <el-form-item label="备份范围">
          <el-select v-model="runForm.scope" style="width: 130px">
            <el-option label="全量" value="all" />
            <el-option label="仅代码" value="code" />
            <el-option label="仅数据库" value="db" />
          </el-select>
        </el-form-item>
        <el-form-item label="保留份数">
          <el-input-number v-model="runForm.keep" :min="1" :max="100" />
        </el-form-item>
        <el-form-item label="含敏感配置">
          <el-switch v-model="runForm.includeSecrets" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="running" @click="runBackup">立即备份</el-button>
          <el-button @click="load">刷新</el-button>
        </el-form-item>
      </el-form>

      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="tip"
        title="代码备份基于当前 Git 提交；容器内无 Git 时打包工作区。数据库备份由镜像内置 pg_dump 连接数据库完成，恢复会覆盖目标库。"
      />

      <el-table v-loading="loading" :data="backups" border stripe row-key="id">
        <el-table-column prop="id" label="备份编号" width="170" />
        <el-table-column label="创建时间" width="180">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="提交" width="120">
          <template #default="{ row }">{{ row.commit ? row.commit.slice(0, 12) : '-' }}</template>
        </el-table-column>
        <el-table-column label="代码方式" width="110">
          <template #default="{ row }">{{ row.codeMode === 'tar' ? '工作区' : row.codeMode === 'git' ? 'Git' : '-' }}</template>
        </el-table-column>
        <el-table-column label="内容" min-width="260">
          <template #default="{ row }">
            <el-tag v-for="part in row.parts" :key="part.name" size="small" effect="plain" class="part-tag">
              {{ part.name }}
            </el-tag>
            <span v-if="row.parts.length === 0">-</span>
          </template>
        </el-table-column>
        <el-table-column label="数据库" width="130">
          <template #default="{ row }">{{ row.database ? row.database.name : '-' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="showDetail(row)">详情</el-button>
            <el-button link type="warning" @click="openRestore(row)">恢复</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无备份，点击「立即备份」生成" />
        </template>
      </el-table>
    </div>

    <el-dialog v-model="detailVisible" title="备份详情" width="760px">
      <el-descriptions v-if="detail" :column="2" border>
        <el-descriptions-item label="备份编号">{{ detail.id }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ formatDateTime(detail.createdAt) }}</el-descriptions-item>
        <el-descriptions-item label="提交">{{ detail.commit ? detail.commit.slice(0, 12) : '-' }}</el-descriptions-item>
        <el-descriptions-item label="分支">{{ detail.branch || '-' }}</el-descriptions-item>
        <el-descriptions-item label="数据库">
          {{ detail.database ? detail.database.name + '（' + detail.database.mode + '）' : '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="含敏感配置">{{ detail.includeSecrets ? '是' : '否' }}</el-descriptions-item>
      </el-descriptions>
      <el-table :data="detail ? detail.parts : []" border size="small" style="margin-top: 12px">
        <el-table-column prop="name" label="分片" min-width="220" />
        <el-table-column label="大小" width="110">
          <template #default="{ row }">{{ formatBytes(row.bytes) }}</template>
        </el-table-column>
        <el-table-column prop="sha256" label="SHA-256" min-width="240" show-overflow-tooltip />
      </el-table>
    </el-dialog>

    <el-dialog v-model="restoreVisible" title="从备份恢复" width="560px">
      <el-form v-if="restoreTarget" :model="restoreForm" label-width="90px">
        <el-form-item label="备份编号">{{ restoreTarget.id }}</el-form-item>
        <el-form-item label="恢复内容">
          <el-radio-group v-model="restoreForm.only">
            <el-radio label="db">数据库</el-radio>
            <el-radio label="code">代码</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="restoreForm.only === 'db'" label="目标库">
          <el-input v-model="restoreForm.db" placeholder="留空恢复到 DB_URL 指向的库，可指定测试库名" />
        </el-form-item>
        <el-form-item v-else label="恢复目录">
          <el-input v-model="restoreForm.target" placeholder="留空恢复到 restore/<备份编号>" />
        </el-form-item>
        <el-alert type="warning" :closable="false" show-icon title="数据库恢复会覆盖目标库，请确认目标库名称后再执行。" />
      </el-form>
      <template #footer>
        <el-button @click="restoreVisible = false">取消</el-button>
        <el-button type="primary" :loading="running" @click="doRestore">确认恢复</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { platformApi } from '@/api'
import { formatDateTime } from '@/utils'
import type { BackupRecord } from '@/types'

const loading = ref(false)
const running = ref(false)
const backups = ref<BackupRecord[]>([])

const runForm = reactive({ scope: 'all' as 'all' | 'code' | 'db', keep: 10, includeSecrets: false })

const detailVisible = ref(false)
const detail = ref<BackupRecord | null>(null)

const restoreVisible = ref(false)
const restoreTarget = ref<BackupRecord | null>(null)
const restoreForm = reactive({ only: 'db' as 'code' | 'db', target: '', db: '' })

async function load(): Promise<void> {
  loading.value = true
  try {
    backups.value = (await platformApi.getBackups()) ?? []
  } catch {
    // 请求拦截器已提示错误
  } finally {
    loading.value = false
  }
}

async function runBackup(): Promise<void> {
  const payload: { dbOnly?: boolean; codeOnly?: boolean; includeSecrets: boolean; keep: number } = {
    includeSecrets: runForm.includeSecrets,
    keep: runForm.keep,
  }
  if (runForm.scope === 'db') payload.dbOnly = true
  if (runForm.scope === 'code') payload.codeOnly = true
  running.value = true
  try {
    const result = await platformApi.runBackup(payload)
    if (result.exitCode === 0) {
      ElMessage.success('备份完成')
      if (result.stderr.trim()) ElMessage.warning(result.stderr.trim())
    } else {
      ElMessage.error('备份失败，请查看脚本输出')
    }
    await load()
  } catch {
    // 请求拦截器已提示错误
  } finally {
    running.value = false
  }
}

function showDetail(row: BackupRecord): void {
  detail.value = row
  detailVisible.value = true
}

async function remove(row: BackupRecord): Promise<void> {
  await ElMessageBox.confirm('确认删除备份 ' + row.id + '？删除后不可恢复。', '删除备份', { type: 'warning' })
  await platformApi.deleteBackup(row.id)
  ElMessage.success('备份已删除')
  await load()
}

function openRestore(row: BackupRecord): void {
  restoreTarget.value = row
  restoreForm.only = 'db'
  restoreForm.target = ''
  restoreForm.db = ''
  restoreVisible.value = true
}

async function doRestore(): Promise<void> {
  if (!restoreTarget.value) return
  const payload: { only: 'code' | 'db'; target?: string; db?: string } = { only: restoreForm.only }
  if (restoreForm.only === 'code' && restoreForm.target) payload.target = restoreForm.target
  if (restoreForm.only === 'db' && restoreForm.db) payload.db = restoreForm.db
  running.value = true
  try {
    const result = await platformApi.restoreBackup(restoreTarget.value.id, payload)
    if (result.exitCode === 0) {
      ElMessage.success('恢复完成')
    } else {
      ElMessage.error('恢复失败，请查看脚本输出')
    }
    restoreVisible.value = false
  } catch {
    // 请求拦截器已提示错误
  } finally {
    running.value = false
  }
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let index = 0
  let value = bytes
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return value.toFixed(index === 0 ? 0 : 1) + ' ' + units[index]
}

onMounted(load)
</script>

<style scoped>
.tip {
  margin-bottom: 12px;
}
.part-tag {
  margin: 2px 4px 2px 0;
}
</style>
