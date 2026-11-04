import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router'

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
        meta: { title: '数据看板', icon: 'Odometer' }
      },
      {
        path: 'plot',
        name: 'Plot',
        redirect: '/plot/list',
        meta: { title: '地块管理', icon: 'MapLocation' },
        children: [
          {
            path: 'list',
            name: 'PlotList',
            component: () => import('@/views/plot/List.vue'),
            meta: { title: '地块列表' }
          },
          {
            path: 'create',
            name: 'PlotCreate',
            component: () => import('@/views/plot/Edit.vue'),
            meta: { title: '新增地块', hidden: true }
          },
          {
            path: 'edit/:id',
            name: 'PlotEdit',
            component: () => import('@/views/plot/Edit.vue'),
            meta: { title: '编辑地块', hidden: true }
          },
          {
            path: 'detail/:id',
            name: 'PlotDetail',
            component: () => import('@/views/plot/Detail.vue'),
            meta: { title: '地块详情', hidden: true }
          }
        ]
      },
      {
        path: 'farm',
        name: 'Farm',
        redirect: '/farm/task',
        meta: { title: '农事管理', icon: 'Calendar' },
        children: [
          {
            path: 'task',
            name: 'FarmTask',
            component: () => import('@/views/farm/Task.vue'),
            meta: { title: '农事任务' }
          },
          {
            path: 'record',
            name: 'FarmRecord',
            component: () => import('@/views/farm/Record.vue'),
            meta: { title: '农事记录' }
          }
        ]
      },
      {
        path: 'device',
        name: 'Device',
        redirect: '/device/list',
        meta: { title: '设备管理', icon: 'Monitor' },
        children: [
          {
            path: 'list',
            name: 'DeviceList',
            component: () => import('@/views/device/List.vue'),
            meta: { title: '设备列表' }
          },
          {
            path: 'monitor',
            name: 'DeviceMonitor',
            component: () => import('@/views/device/Monitor.vue'),
            meta: { title: '实时监控' }
          }
        ]
      },
      {
        path: 'finance',
        name: 'Finance',
        component: () => import('@/views/finance/Index.vue'),
        meta: { title: '投入产出', icon: 'Money' }
      },
      {
        path: 'trace',
        name: 'Trace',
        component: () => import('@/views/trace/Index.vue'),
        meta: { title: '生产溯源', icon: 'Tickets' }
      },
      {
        path: 'video',
        name: 'Video',
        component: () => import('@/views/video/Index.vue'),
        meta: { title: '视频监控', icon: 'VideoCamera' }
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
            meta: { title: '用户管理' }
          },
          {
            path: 'role',
            name: 'SystemRole',
            component: () => import('@/views/system/Role.vue'),
            meta: { title: '角色管理' }
          }
        ]
      }
    ]
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
  } else {
    next()
  }
})

export default router
