import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router'
import { cachedPermissions, checkPermission } from '@/utils/permission'

/**
 * 路由与权限的对应关系：父级看守菜单是否展示，子级看守具体页面。
 * 权限码与 packages/contracts 的权限目录一致，缺省表示仅需登录。
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/system/Login.vue'),
    meta: { title: '登录', requiresAuth: false }
  },
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('@/views/dashboard/Index.vue'),
        meta: { title: '数据看板', icon: 'Odometer', permission: 'dashboard:read' }
      },
      {
        path: 'plot',
        name: 'Plot',
        redirect: '/plot/list',
        meta: { title: '地块管理', icon: 'MapLocation', permission: 'plot:read' },
        children: [
          {
            path: 'list',
            name: 'PlotList',
            component: () => import('@/views/plot/List.vue'),
            meta: { title: '地块列表', permission: 'plot:read' }
          },
          {
            path: 'zone',
            name: 'PlotZone',
            component: () => import('@/views/zone/Index.vue'),
            meta: { title: '片区管理', permission: 'plot:read' }
          },
          {
            path: 'season',
            name: 'PlotSeason',
            component: () => import('@/views/plot/Season.vue'),
            meta: { title: '种植季档案', permission: 'plot:read' }
          },
          {
            path: 'create',
            name: 'PlotCreate',
            component: () => import('@/views/plot/Edit.vue'),
            meta: { title: '新增地块', hidden: true, permission: 'plot:write' }
          },
          {
            path: 'edit/:id',
            name: 'PlotEdit',
            component: () => import('@/views/plot/Edit.vue'),
            meta: { title: '编辑地块', hidden: true, permission: 'plot:write' }
          },
          {
            path: 'detail/:id',
            name: 'PlotDetail',
            component: () => import('@/views/plot/Detail.vue'),
            meta: { title: '地块详情', hidden: true, permission: 'plot:read' }
          },
          {
            path: 'split/:id',
            name: 'PlotSplit',
            component: () => import('@/views/plot/Split.vue'),
            meta: { title: '拆分地块', hidden: true, permission: 'plot:write' }
          }
        ]
      },
      {
        path: 'farm',
        name: 'Farm',
        redirect: '/farm/task',
        meta: { title: '农事管理', icon: 'Calendar', permission: 'operation:read' },
        children: [
          {
            path: 'task',
            name: 'FarmTask',
            component: () => import('@/views/farm/Task.vue'),
            meta: { title: '农事任务', permission: 'operation:read' }
          },
          {
            path: 'record',
            name: 'FarmRecord',
            component: () => import('@/views/farm/Record.vue'),
            meta: { title: '农事记录', permission: 'operation:read' }
          },
          {
            path: 'navigation',
            name: 'FarmNavigation',
            component: () => import('@/views/farm/Navigation.vue'),
            meta: { title: '田间导航', permission: 'operation:read' }
          }
        ]
      },
      {
        path: 'device',
        name: 'Device',
        redirect: '/device/list',
        meta: { title: '设备管理', icon: 'Monitor', permission: 'device:read' },
        children: [
          {
            path: 'list',
            name: 'DeviceList',
            component: () => import('@/views/device/List.vue'),
            meta: { title: '设备列表', permission: 'device:read' }
          },
          {
            path: 'monitor',
            name: 'DeviceMonitor',
            component: () => import('@/views/device/Monitor.vue'),
            meta: { title: '实时监控', permission: 'device:read' }
          },
          {
            path: 'commands',
            name: 'DeviceCommands',
            component: () => import('@/views/device/Commands.vue'),
            meta: { title: '控制指令', permission: 'device:read' }
          },
          {
            path: 'irrigation',
            name: 'DeviceIrrigation',
            component: () => import('@/views/irrigation/Index.vue'),
            meta: { title: '水肥灌溉', permission: 'device:control' }
          }
        ]
      },
      {
        path: 'agro',
        name: 'Agro',
        component: () => import('@/views/agro/Index.vue'),
        meta: { title: '四情监控', icon: 'Sunny', permission: 'telemetry:read' }
      },
      {
        path: 'weather',
        name: 'Weather',
        component: () => import('@/views/weather/Index.vue'),
        meta: { title: '气象服务', icon: 'PartlyCloudy', permission: 'weather:read' }
      },
      {
        path: 'finance',
        name: 'Finance',
        component: () => import('@/views/finance/Index.vue'),
        meta: { title: '投入产出', icon: 'Money', permission: 'finance:read' }
      },
      {
        path: 'trace',
        name: 'Trace',
        component: () => import('@/views/trace/Index.vue'),
        meta: { title: '生产溯源', icon: 'Tickets', permission: 'trace:read' }
      },
      {
        path: 'video',
        name: 'Video',
        component: () => import('@/views/video/Index.vue'),
        meta: { title: '视频监控', icon: 'VideoCamera', permission: 'device:read' }
      },
      {
        path: 'message',
        name: 'Message',
        component: () => import('@/views/message/Index.vue'),
        meta: { title: '消息中心', icon: 'Bell', permission: 'message:read' }
      },
      {
        path: 'system',
        name: 'System',
        redirect: '/system/user',
        meta: { title: '系统管理', icon: 'Setting' },
        children: [
          {
            path: 'user',
            name: 'SystemUser',
            component: () => import('@/views/system/User.vue'),
            meta: { title: '用户管理', permission: 'system:user' }
          },
          {
            path: 'role',
            name: 'SystemRole',
            component: () => import('@/views/system/Role.vue'),
            meta: { title: '角色管理', permission: 'system:role' }
          },
          {
            path: 'backup',
            name: 'SystemBackup',
            component: () => import('@/views/system/Backup.vue'),
            meta: { title: '系统备份', permission: 'system:backup' }
          }
        ]
      }
    ]
  },
  {
    path: '/403',
    name: 'Forbidden',
    component: () => import('@/views/system/403.vue'),
    meta: { title: '无访问权限' }
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: () => import('@/views/system/404.vue'),
    meta: { title: '页面未找到', requiresAuth: false }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach((to, _from, next) => {
  document.title = `${to.meta.title || '智慧农业'} - 智慧农业管理平台`
  const token = localStorage.getItem('token')
  if (to.meta.requiresAuth !== false && !token) {
    next('/login')
    return
  }
  // 页面级权限：未授予时直接进 403，避免页面先渲染再被接口拒绝
  const required = to.meta.permission as string | undefined
  if (required && !checkPermission(cachedPermissions(), required)) {
    next({ path: '/403', replace: true })
    return
  }
  next()
})

export default router
