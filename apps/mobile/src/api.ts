import { reactive } from 'vue'
import type { DeviceItem, FarmTask, LoginResult, OverviewResult, PageResult, PlotItem, PlotStats, TaskResult, TaskStatus, TraceRecord } from './types'

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) || '/api/v1'
export const TOKEN_KEY = 'agri_mobile_token'
export const USER_KEY = 'agri_mobile_user'

/** 轻量提示条：移动端不引 UI 库，全局一条足以覆盖成功/失败反馈 */
export const toast = reactive<{ text: string; kind: 'ok' | 'err' | 'info'; visible: boolean }>({ text: '', kind: 'info', visible: false })
let toastTimer: ReturnType<typeof setTimeout> | undefined
export function showToast(text: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
  toast.text = text
  toast.kind = kind
  toast.visible = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.visible = false }, 2600)
}

/** 会话失效：清本地身份回登录页；登录请求本身的 401 不跳转，保留服务端提示 */
function onUnauthorized(): void {
  const hadToken = Boolean(localStorage.getItem(TOKEN_KEY))
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  if (hadToken && !window.location.hash.startsWith('#/login')) window.location.hash = '#/login'
}

/** 剥掉 undefined/null/空串，与桌面端 cleanParams 同口径，避免发空条件 */
function queryString(params?: Record<string, unknown>): string {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY)
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-request-id': `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  })
  if (response.status === 401) {
    onUnauthorized()
    throw new Error('登录已失效，请重新登录')
  }
  const payload = (await response.json().catch(() => null)) as { code?: string; message?: string; data?: T } | null
  if (!response.ok || !payload || payload.code !== 'OK') {
    throw new Error(payload?.message || `请求失败（${response.status}）`)
  }
  return payload.data as T
}

const get = <T>(path: string, params?: Record<string, unknown>): Promise<T> => request<T>('GET', `${path}${queryString(params)}`)
const post = <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body ?? {})

export const api = {
  login: (username: string, password: string): Promise<LoginResult> => post<LoginResult>('/auth/login', { username, password }),
  logout: (): Promise<void> => post<void>('/auth/logout'),
  plotStats: (): Promise<PlotStats> => get<PlotStats>('/plots/stats'),
  plots: (): Promise<PageResult<PlotItem>> => get<PageResult<PlotItem>>('/plots', { page: 1, size: 100 }),
  devices: (): Promise<PageResult<DeviceItem>> => get<PageResult<DeviceItem>>('/devices', { page: 1, size: 200 }),
  overview: (): Promise<OverviewResult> => get<OverviewResult>('/telemetry/overview'),
  tasks: (params?: { status?: TaskStatus; page?: number; size?: number }): Promise<PageResult<FarmTask>> => get<PageResult<FarmTask>>('/farm-tasks', { page: 1, size: 50, ...params }),
  taskStatus: (id: string, status: TaskStatus, version: number, result?: TaskResult): Promise<FarmTask> =>
    post<FarmTask>(`/farm-tasks/${encodeURIComponent(id)}/status`, { status, version, ...(result ? { result } : {}) }),
  traceRecords: (params?: { plotCode?: string; event?: string; page?: number; size?: number }): Promise<PageResult<TraceRecord>> =>
    get<PageResult<TraceRecord>>('/trace/records', { page: 1, size: 20, ...params }),
  createTrace: (data: { plotCode: string; event: string; detail: string; operator: string }): Promise<TraceRecord> => post<TraceRecord>('/trace/records', data)
}

/** 时间展示：ISO → 本地 MM-DD HH:mm，列表里够用且省宽度 */
export function shortTime(iso?: string): string {
  if (!iso) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}