---
kind: frontend_style
name: 赵光农场前端 SCSS + Element Plus 深色主题样式体系
category: frontend_style
scope:
    - '**'
source_files:
    - zhao-guang-farm-master/src/styles/index.scss
    - zhao-guang-farm-master/src/styles/variables.scss
    - zhao-guang-farm-master/src/styles/reset.scss
    - zhao-guang-farm-master/src/styles/animations.scss
    - zhao-guang-farm-master/src/styles/element-plus.scss
    - zhao-guang-farm-master/src/styles/layout.scss
    - zhao-guang-farm-master/vite.config.js
    - zhao-guang-farm-master/src/main.js
---

## 1. 使用的系统与工具

- **框架**：Vue 3（Composition API）+ Vite 8。
- **UI 组件库**：Element Plus 2.7，通过 `unplugin-vue-components` + `ElementPlusResolver` 实现按需自动注册（`vite.config.js` 中配置）。
- **样式预处理**：SCSS（`sass` 1.77），由 Vite 的 `css.preprocessorOptions.scss.additionalData` 注入全局变量。
- **状态与路由**：Pinia + Vue Router（非样式相关，但影响布局结构）。
- **地图/图表**：esri-loader（ArcGIS）、ECharts 5.5（业务可视化，不纳入通用样式体系）。

## 2. 关键文件

- `zhao-guang-farm-master/src/styles/index.scss` — 全局样式入口，仅导入 reset / animations / element-plus 三个模块（layout.scss 被注释掉，说明布局类在组件内自行组织）。
- `zhao-guang-farm-master/src/styles/variables.scss` — 设计令牌中心：背景色、强调色、文字色、边框色、布局尺寸（rem）、过渡、圆角、阴影、z-index。
- `zhao-guang-farm-master/src/styles/reset.scss` — 基础重置（box-sizing、字体、滚动条等）。
- `zhao-guang-farm-master/src/styles/animations.scss` — 发光脉冲、扫描线、数据刷新、滑入、旋转等 keyframes 及 `.anim-*` 工具类。
- `zhao-guang-farm-master/src/styles/element-plus.scss` — Element Plus 深色主题覆盖（CSS 自定义属性 + 组件级覆盖）。
- `zhao-guang-farm-master/vite.config.js` — SCSS `additionalData` 注入 `@use "@/styles/variables.scss" as *;`，使所有组件可直接使用 `$bg-primary` 等变量。
- `zhao-guang-farm-master/src/main.js` — 应用入口，挂载全局样式并初始化 rem 自适应逻辑。

## 3. 架构与约定

### 3.1 设计令牌（Design Tokens）
所有颜色、尺寸、阴影、z-index 集中在 `variables.scss`，以 SCSS 变量形式暴露。命名采用语义化前缀：
- 背景：`$bg-primary` / `$bg-secondary` / `$bg-panel` / `$bg-card` / `$bg-hover`
- 强调色：`$accent-cyan` / `$accent-yellow` / `$accent-green` / `$accent-orange` / `$accent-red`
- 文字：`$text-primary` / `$text-secondary` / `$text-muted`
- 边框：`$border-color` / `$border-glow` / `$border-bright`
- 布局尺寸：`$topnav-height` / `$sidebar-width` / `$sidebar-collapsed` / `$right-panel-width` / `$bottom-panel-height`
- 过渡：`$transition-base` / `$transition-fast` / `$transition-slow`
- 圆角：`$radius-sm` / `$radius-md` / `$radius-lg`
- 阴影：`$shadow-panel` / `$shadow-card` / `$shadow-glow`
- Z 轴：`$z-map` / `$z-overlay` / `$z-panel` / `$z-topnav` / `$z-modal`

### 3.2 响应式策略：rem 等比缩放
`main.js` 中以 1920px 设计稿为基准，动态计算 `document.documentElement.style.fontSize = (clientWidth / 1920) * 100`，即 `1rem = 100px`；所有布局尺寸在 `variables.scss` 中以 rem 书写（如 `$sidebar-width: 2.4rem` ≈ 240px），仅在固定像素场景（边框、阴影）使用 px。

### 3.3 Element Plus 深色主题覆盖
通过 CSS 自定义属性在 `:root` 中重写 Element Plus 的主题变量（`--el-color-primary`、`--el-bg-color-page`、`--el-border-color` 等），再针对 `el-input__wrapper`、`el-select-dropdown`、`el-table`、`el-pagination`、`el-dialog`、`el-button--primary` 等具体类名做二次覆盖，统一为深蓝科技风暗色主题。

### 3.4 布局模式
`layout.scss` 定义了三种网格布局模板（虽未在全局入口引入，但在组件内按需 @use）：
- `.main-layout`：顶部导航 + 侧边栏 + 内容区（grid-template-areas）。
- `.dashboard-layout`：大屏三栏（左面板 + 地图 + 右面板）+ 底部趋势图。
- `.subsystem-layout`：子系统通用布局（地图 + 右侧面板）。
- `.page-wrapper`：通用页面头部 + 主体容器。

### 3.5 动画系统
`animations.scss` 集中定义 keyframes（glow-pulse、scan-line、data-in、slide-in-left/right、spin、marker-ping），并提供 `.anim-glow-pulse`、`.anim-data-in`、`.anim-spin` 等可复用工具类供组件直接调用。

### 3.6 构建期注入
`vite.config.js` 通过 `scss.additionalData` 将 `@use "@/styles/variables.scss" as *;` 注入到每个 SCSS 文件，因此组件无需手动 import variables 即可直接使用 `$bg-primary` 等变量。

## 4. 约定与约束

- **样式语言**：项目统一使用 SCSS（无原生 CSS 或 Tailwind），由 Vite 的 sass 预处理器编译。
- **变量来源唯一**：所有设计令牌来自 `src/styles/variables.scss`，并通过 Vite `additionalData` 全局注入，禁止在组件内硬编码颜色/尺寸值。
- **Element Plus 主题定制方式**：通过 CSS 自定义属性 + 组件类名覆盖，而非修改源码或使用官方主题生成器。
- **响应式单位**：布局尺寸统一使用 rem（基于 1920px 设计稿），px 仅用于边框、阴影等固定像素场景。
- **全局样式入口**：`src/styles/index.scss` 是唯一的样式聚合点，由 `src/main.js` 中的 `import '@/styles/index.scss'` 引入；`layout.scss` 当前被注释，布局样式按需在组件内引入。
- **Element Plus 按需加载**：通过 `unplugin-vue-components` + `ElementPlusResolver` 自动注册组件，避免手动 import。
- **主题风格**：深色科技风（深蓝背景 `#0a1628` + 青色强调 `#f3f4f5` / `rgba(0,212,255,...)` + 发光阴影），贯穿全局 reset、Element Plus 覆盖和业务组件。