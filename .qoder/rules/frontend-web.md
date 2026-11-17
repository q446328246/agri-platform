---
trigger: glob
glob: apps/web/**
---

# 前端（apps/web）专项规范

Vue3 + Vite + Element Plus + Pinia + Leaflet。样式走 Element Plus 亮色主题覆盖，不引入 zhao-guang-farm-master 的 SCSS 暗色令牌。

## 首页「一张图驾驶舱」布局

- MainLayout.vue 为全屏 `position:fixed` 容器仅渲染 router-view，无 el-aside/el-header；不得恢复整页跳转式导航。
- 业务页面在地图右侧多标签浮层面板内就地打开：dashboard/Index.vue 的 `panelComps`（路由路径 → `markRaw(defineAsyncComponent(...))`）内嵌目标顶级页组件；新增业务页须同步登记 panelComps 与左侧菜单树（menuGroups 7 组），菜单项带 `perm` 经 `checkPermission` 过滤，点击调 `openPanel(key, title)`。
- 面板支持切换/关闭/最大化/展开为完整页（`router.push(activePanel)`，仅路由型面板可展开）；面板打开时隐藏右上图层面板与右下天气卡；仅非 /dashboard 且非 / 路由显示「返回一张图」入口。
- 内嵌页面须适配面板宽度：表格/图表过宽显示不全时，调整面板默认宽度或默认最大化。

## 列表页条件查询

- 统一查询条结构：关键词 + 枚举下拉 + 时间区间 + 重置 + 分页，各模块交互一致。
- 筛选参数命名与后端严格一致；后端对非法枚举返回 400，前端下拉选项须与后端白名单同步（如任务类型六码）。

## 路由与请求

- 路由跳转一律用绝对路径（以 `/` 开头，如 `router.push('/plot/detail/' + encodeURIComponent(code))`），避免深层路由下相对跳转 404。（历史侧边栏时代的 `resolvePath` 修复已随一张图改造移除，不再适用。）
- API 请求统一走 `@/utils/request` 的 axios 封装（get/post/put/del），查询参数以 params 对象传入并经 `cleanParams` 剥掉 undefined/null/空串；禁止手工拼接查询串（防双问号与空条件）。

## 地图交互

- 地块边界绘制：点击地图逐点加顶点，至少 3 点才可闭合为多边形，闭合后自动计算面积并回填表单。
- 地图初始化坐标走既有配置，禁止在组件内硬编码地理位置。