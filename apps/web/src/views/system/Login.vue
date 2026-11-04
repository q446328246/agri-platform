<template>
  <div class="login-container">
    <div class="login-box">
      <div class="login-header">
        <el-icon :size="48" color="#409EFF"><Grape /></el-icon>
        <h2>智慧农业管理平台</h2>
        <p>以地块为核心的智慧农业解决方案</p>
      </div>
      <el-form
        ref="formRef"
        :model="loginForm"
        :rules="loginRules"
        class="login-form"
        @submit.prevent="handleLogin"
      >
        <el-form-item prop="username">
          <el-input
            v-model="loginForm.username"
            placeholder="请输入用户名"
            prefix-icon="User"
            size="large"
            @keyup.enter="handleLogin"
          />
        </el-form-item>
        <el-form-item prop="password">
          <el-input
            v-model="loginForm.password"
            type="password"
            placeholder="请输入密码"
            prefix-icon="Lock"
            size="large"
            show-password
            @keyup.enter="handleLogin"
          />
        </el-form-item>
        <el-form-item>
          <el-button
            type="primary"
            size="large"
            class="login-btn"
            :loading="loading"
            @click="handleLogin"
          >
            登录
          </el-button>
        </el-form-item>
      </el-form>
      <div class="login-footer">
        <p>默认账号：admin / admin123</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import router from '@/router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { useUserStore } from '@/stores'
import type { LoginParams } from '@/types'
import { authApi } from '@/api'

const userStore = useUserStore()
const formRef = ref<FormInstance>()
const loading = ref(false)

const loginForm = reactive<LoginParams>({
  username: 'admin',
  password: 'admin123'
})

const loginRules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

const handleLogin = async () => {
  if (!formRef.value) return
  try {
    const valid = await formRef.value.validate()
    if (!valid) return
    loading.value = true
    const result = await authApi.login(loginForm)
    
    // 保存token到localStorage
    userStore.setToken(result.token)
    // 保存用户信息到store
    userStore.setUserInfo(result.user)
    
    ElMessage.success('登录成功')
    
    // 跳转到首页或之前访问的页面
    const currentRoute = router.currentRoute.value
    const redirect = (currentRoute.query.redirect as string) || '/dashboard'
    router.replace(redirect)
  } catch (error) {
    console.error('登录失败:', error)
  } finally {
    loading.value = false
  }
}
</script>

<style scoped lang="scss">
.login-container {
  width: 100%;
  height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  display: flex;
  align-items: center;
  justify-content: center;
}

.login-box {
  width: 400px;
  padding: 40px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.login-header {
  text-align: center;
  margin-bottom: 40px;
  
  h2 {
    margin: 16px 0 8px;
    color: #303133;
    font-size: 24px;
  }
  
  p {
    color: #909399;
    font-size: 14px;
  }
}

.login-form {
  .login-btn {
    width: 100%;
  }
}

.login-footer {
  text-align: center;
  margin-top: 20px;
  
  p {
    color: #909399;
    font-size: 12px;
  }
}
</style>
