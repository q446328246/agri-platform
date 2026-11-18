<template>
  <div class="m-login">
    <div class="m-login__brand">
      <h1>无人农场 AI 平台</h1>
      <p>移动端 · 驾驶舱 / 巡田 / 任务回执</p>
    </div>
    <form class="m-login__card" @submit.prevent="onSubmit">
      <div class="m-field">
        <label class="m-field__label">账号</label>
        <input v-model.trim="username" class="m-input" autocomplete="username" placeholder="请输入账号" />
      </div>
      <div class="m-field">
        <label class="m-field__label">密码</label>
        <input v-model="password" class="m-input" type="password" autocomplete="current-password" placeholder="请输入密码" />
      </div>
      <button class="m-btn m-btn--block" type="submit" :disabled="busy || !username || !password">
        {{ busy ? '登录中…' : '登 录' }}
      </button>
      <p class="m-login__hint">与桌面端同一套账号体系，权限随角色生效</p>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { login } from '../auth'
import { showToast } from '../api'

const router = useRouter()
const username = ref('')
const password = ref('')
const busy = ref(false)

async function onSubmit() {
  busy.value = true
  try {
    await login(username.value, password.value)
    showToast('登录成功', 'ok')
    void router.replace('/cockpit')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '登录失败', 'err')
  } finally {
    busy.value = false
  }
}
</script>