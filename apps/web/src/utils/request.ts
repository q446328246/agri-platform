import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ApiResponse } from '@/types'

const service: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api/v1',
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json'
  }
})

// 请求拦截器
service.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    const userInfo = localStorage.getItem('userInfo')
    if (userInfo) {
      try {
        config.headers['X-User-Id'] = JSON.parse(userInfo).id
      } catch {
        localStorage.removeItem('userInfo')
      }
    }
    const requestId = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`
    config.headers['X-Request-Id'] = requestId
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 响应拦截器
service.interceptors.response.use(
  (response: AxiosResponse<ApiResponse>) => {
    const res = response.data
    // 兼容不同的API响应格式
    if (res.code !== 0 && res.code !== '0' && res.code !== 'OK' && res.success !== true) {
      ElMessage.error(res.message || '请求失败')
      if (res.code === 401 || res.code === '401' || res.code === 'UNAUTHORIZED') {
        ElMessageBox.confirm('登录已过期，请重新登录', '提示', {
          confirmButtonText: '重新登录',
          cancelButtonText: '取消',
          type: 'warning'
        }).then(() => {
          localStorage.removeItem('token')
          window.location.href = '/login'
        })
      }
      return Promise.reject(new Error(res.message || '请求失败'))
    }
    return (res.data !== undefined ? res.data : res) as any
  },
  (error) => {
    let message = '网络错误'
    if (error.response) {
      switch (error.response.status) {
        case 400:
          message = '请求参数错误'
          break
        case 401:
          message = '未授权，请登录'
          break
        case 403:
          message = '拒绝访问'
          break
        case 404:
          message = '请求资源不存在'
          break
        case 500:
          message = '服务器内部错误'
          break
        default:
          message = `请求错误: ${error.response.status}`
      }
    } else if (error.request) {
      message = '服务器无响应'
    }
    ElMessage.error(message)
    return Promise.reject(error)
  }
)

export function request<T = unknown>(config: AxiosRequestConfig): Promise<T> {
  return service.request(config) as Promise<T>
}

export function get<T = unknown>(url: string, params?: any, config?: AxiosRequestConfig): Promise<T> {
  return request<T>({ method: 'GET', url, params, ...config })
}

export function post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
  return request<T>({ method: 'POST', url, data, ...config })
}

export function put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
  return request<T>({ method: 'PUT', url, data, ...config })
}

export function del<T = unknown>(url: string, params?: Record<string, unknown>, config?: AxiosRequestConfig): Promise<T> {
  return request<T>({ method: 'DELETE', url, params, ...config })
}

export default service
