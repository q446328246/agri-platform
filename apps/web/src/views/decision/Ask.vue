<template>
  <div class="ask-page">
    <el-card shadow="never">
      <template #header>
        <span class="card-title">智能问答</span>
        <span class="card-sub">检索农艺知识库，AI 生成回答并附依据来源（未配置 AI 时降级规则式回答）</span>
      </template>
      <el-input
        v-model="question"
        type="textarea"
        :rows="3"
        maxlength="200"
        show-word-limit
        placeholder="输入农艺或作业问题，如：灌溉定额是多少？料液密度怎么换算？越限怎么补灌？"
        @keydown.enter.exact.prevent="submit"
      />
      <div class="ask-examples">
        <span class="examples-label">试试：</span>
        <el-tag
          v-for="example in examples"
          :key="example"
          class="example-tag"
          @click="askExample(example)"
        >{{ example }}</el-tag>
      </div>
      <div class="ask-actions">
        <el-button type="primary" :loading="loading" :disabled="!question.trim()" @click="submit">提问</el-button>
      </div>
    </el-card>

    <el-card v-if="result" shadow="never" class="ask-result">
      <template #header>
        <span class="card-title">回答</span>
        <el-tag size="small" :type="result.mode === 'ai' ? 'success' : 'info'" class="mode-tag">{{ result.mode === 'ai' ? 'AI 回答' : '规则回答' }}</el-tag>
        <span class="card-sub">置信度 {{ (result.confidence * 100).toFixed(0) }}%</span>
      </template>
      <div class="answer">{{ result.answer }}</div>
      <div class="sources">
        <span class="source-label">依据来源：</span>
        <el-tag v-for="source in result.sources" :key="source" size="small" effect="plain">{{ source }}</el-tag>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { decisionApi, type AskResult } from '@/api'

const question = ref('')
const result = ref<AskResult | null>(null)
const loading = ref(false)

const examples = ['灌溉定额是多少', '料液密度怎么换算', '越限怎么补灌', '多明细面积怎么分摊', '土壤含水率阈值']

function askExample(example: string) {
  question.value = example
}

async function submit() {
  const text = question.value.trim()
  if (!text) return
  loading.value = true
  try {
    result.value = await decisionApi.ask(text)
  } catch (error) {
    ElMessage.error(`问答失败：${(error as Error).message}`)
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.ask-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.card-title {
  font-weight: 600;
}
.card-sub {
  margin-left: 8px;
  font-size: 12px;
  color: #909399;
}
.mode-tag {
  margin-left: 8px;
}
.ask-examples {
  margin-top: 12px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.examples-label {
  font-size: 12px;
  color: #909399;
}
.example-tag {
  cursor: pointer;
}
.ask-actions {
  margin-top: 12px;
}
.ask-result .answer {
  white-space: pre-wrap;
  line-height: 1.7;
}
.sources {
  margin-top: 12px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.source-label {
  font-size: 12px;
  color: #909399;
}
</style>
