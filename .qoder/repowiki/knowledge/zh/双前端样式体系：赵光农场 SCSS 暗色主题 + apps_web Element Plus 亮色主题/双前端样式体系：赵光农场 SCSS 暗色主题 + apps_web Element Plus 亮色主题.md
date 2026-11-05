---
kind: frontend_style
name: 双前端样式体系：赵光农场 SCSS 暗色主题 + apps/web Element Plus 亮色主题
category: frontend_style
scope:
    - '**'
source_files:
    - zhao-guang-farm-master/src/styles/index.scss
    - zhao-guang-farm-master/src/styles/variables.scss
    - zhao-guang-farm-master/src/styles/layout.scss
    - zhao-guang-farm-master/src/styles/reset.scss
    - zhao-guang-farm-master/src/styles/animations.scss
    - zhao-guang-farm-master/src/styles/element-plus.scss
    - zhao-guang-farm-master/vite.config.js
    - apps/web/src/assets/styles/main.scss
---

## 1. 总体情况

仓库包含两个独立的前端应用，各自有一套完整的样式系统，彼此不共享。

- `zhao-guang-farm-master/`：基于 Vue3 + Vite + Element Plus + SCSS 的「赵光农场智慧农业平台」，采用深蓝色科技风暗色主题，使用 SCSS 变量集中管理设计令牌。
- `apps/web/`：基于 Vue3 + Vite + Pinia + Element Plus 的新版微服务 Web 控制台，采用浅色主题，通过 CSS 自定义属性（`:root`）定义主题变量。

两个应用都使用 Vite 作为构建工具，并引入 Element Plus 组件库；但样式方案、主题风格和设计令牌完全独立。

## 2. 赵光农场前端样式体系（`zhao-guang-farm-master/src/styles/`）

### 2.1 入口与预处理

- 全局入口 `src/styles/index.scss` 仅导入 `reset.scss`、`animations.scss`、`element-plus.scss`，布局样式 `layout.scss` 默认被注释掉（`// @use './layout.scss';`），由各个页面按需引入。
- Vite 配置在 `vite.config.js` 中通过 `css.preprocessorOptions.scss.additionalData` 自动注入 `@use "@/styles/variables.scss" as *;`，使所有 `.scss` 文件无需显式 import 即可直接使用全局变量。

### 2.2 设计令牌（Design Tokens）

核心令牌集中在 `src/styles/variables.scss`，按语义分组：

| 类别 | 示例变量 | 说明 |
|---|---|---|
| 背景色 | `$bg-primary: #0a1628` / `$bg-secondary: #0d1f3c` / `$bg-panel: #0f2744` / `$bg-card: #112a4a` | 深蓝科技风暗色渐变 |
| 强调色 | `$accent-cyan: #f3f4f5` / `$accent-yellow: #ffd700` / `$accent-green: #00ff88` / `$accent-orange: #ff8c00` / `$accent-red: #ff4757` | 高对比度业务状态色 |
| 文字色 | `$text-primary: #e8f4ff` / `$text-secondary: #f3f4f5` / `$text-muted: #f3f4f5` | 浅灰白文本 |
| 边框色 | `$border-color: rgba(0, 212, 255, 0.2)` / `$border-glow: rgba(0, 212, 255, 0.4)` / `$border-bright: rgba(0, 212, 255, 0.8)` | 青色发光边框 |
| 布局尺寸 | `$topnav-height: 0.6rem` / `$sidebar-width: 2.4rem` / `$right-panel-width: 3.2rem` / `$bottom-panel-height: 1.8rem` | 以 rem 为单位，基准为 1rem = 100px |
| 过渡 | `$transition-base/fast/slow` | 统一动画时长 |
| 圆角 | `$radius-sm/md/lg` | 0.04~0.12rem |
| 阴影 | `$shadow-panel/card/glow` | 面板阴影与青色辉光 |
| Z 轴 | `$z-map/z-overlay/z-panel/z-topnav/z-modal` | 分层 z-index |

### 2.3 响应式策略

- 基准：`main.js` 动态设置根字体大小，约定 `1rem = 100px`（见 `variables.scss` 注释），所有布局尺寸以 rem 表达，实现按比例缩放。
- 固定像素仅用于边框、阴影等不需要缩放的场景。

### 2.4 布局架构

`layout.scss` 定义了三种网格布局模式（均未被 index.scss 全局引入，需按需 use）：

- `.main-layout`：顶部导航 + 左侧边栏 + 内容区的两行两列 Grid。
- `.dashboard-layout`：大屏三栏（左面板 + 地图 + 右面板）+ 底部趋势图区域。
- `.subsystem-layout`：子系统通用布局（地图 + 右侧数据面板）。
- `.page-wrapper`：通用页面头部 + 内容区容器。

### 2.5 组件库集成

- 通过 `unplugin-vue-components` + `ElementPlusResolver` 自动注册 Element Plus 组件。
- 通过 `src/styles/element-plus.scss` 覆盖 Element Plus 默认样式以适配暗色主题。

## 3. apps/web 前端样式体系（`apps/web/src/assets/styles/main.scss`）

### 3.1 主题变量

使用 CSS 自定义属性定义在 `:root` 中，包括 `--primary-color`、`--success-color`、`--warning-color`、`--danger-color`、`--info-color`、`--text-*`、`--border-color`、`--bg-color`、`--sidebar-bg`、`--sidebar-text`、`--sidebar-active-bg`、`--header-height`、`--sidebar-width`、`--sidebar-collapsed-width` 等。

### 3.2 全局重置与基础样式

- 引入 `element-plus/dist/index.css` 作为组件库基础样式。
- 对 `*`、`html`、`body`、`#app` 做基础 reset，设置字体栈 `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`，字号 14px。

### 3.3 布局结构

- `.layout-container`：Flex 横向布局（侧边栏 + 主内容）。
- `.sidebar`：可折叠侧边栏，支持 `.collapsed` 类切换宽度（220px ↔ 64px）。
- `.header`：60px 高的白色顶栏，含左侧操作区和右侧用户信息。
- `.tags-view`：标签页栏。
- `.main-content`：滚动的主内容区。

### 3.4 通用组件样式

- `.page-card`：白色卡片容器。
- `.stats-cards`：统计卡片网格（`repeat(auto-fit, minmax(240px, 1fr))`）。
- `.chart-container`：ECharts 图表容器，固定高度 320px。
- `.query-form`、`.table-operations`、`.pagination-container`：表单与表格操作区。
- `.status-tag`：状态标签，按 active/offline/fault/pending/in-progress/archived/maintenance 等状态类名着色。
- `.login-container`、`.error-page`：登录页与 404 页专用样式。

### 3.5 Element Plus 覆盖

直接选择器覆盖 `.el-form-item`、`.el-table`、`.el-button + .el-button` 等默认样式，并通过 `!important` 强制侧边栏菜单项颜色。

## 4. 关键文件

- `zhao-guang-farm-master/src/styles/index.scss` — 全局样式入口
- `zhao-guang-farm-master/src/styles/variables.scss` — SCSS 设计令牌中心
- `zhao-guang-farm-master/src/styles/layout.scss` — 网格布局模板
- `zhao-guang-farm-master/src/styles/reset.scss` — 全局重置
- `zhao-guang-farm-master/src/styles/animations.scss` — 动画
- `zhao-guang-farm-master/src/styles/element-plus.scss` — Element Plus 暗色主题覆盖
- `zhao-guang-farm-master/vite.config.js` — SCSS 全局变量注入配置
- `apps/web/src/assets/styles/main.scss` — apps/web 全局样式（CSS 变量 + Element Plus 覆盖）

## 5. 观察到的约定与约束

- **SCSS 变量集中管理**：赵光农场将所有设计令牌放在 `variables.scss`，并通过 Vite 的 `additionalData` 自动注入，组件无需手动 import 即可使用。
- **rem 为主、px 为辅**：布局尺寸统一用 rem，基准 1rem = 100px，由运行时 JS 动态设置根字体大小以实现响应式缩放。
- **BEM-like 命名**：布局类使用 `__` 子元素命名（如 `.main-layout__topnav`、`.page-wrapper__header`）。
- **布局按模块按需引入**：`index.scss` 默认不引入 `layout.scss`，由各页面自行 `@use`，避免全局污染。
- **Element Plus 通过 unplugin 自动注册**：组件无需手动 import，样式通过单独的 SCSS/CSS 文件覆盖。
- **两套前端互不共享样式**：`zhao-guang-farm-master` 与 `apps/web` 是独立项目，分别维护自己的主题变量和样式入口。