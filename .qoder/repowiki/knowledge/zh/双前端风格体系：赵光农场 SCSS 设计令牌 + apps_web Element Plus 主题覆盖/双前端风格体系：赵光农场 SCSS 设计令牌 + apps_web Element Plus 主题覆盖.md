---
kind: frontend_style
name: 双前端风格体系：赵光农场 SCSS 设计令牌 + apps/web Element Plus 主题覆盖
category: frontend_style
scope:
    - '**'
source_files:
    - zhao-guang-farm-master/src/styles/variables.scss
    - zhao-guang-farm-master/src/styles/index.scss
    - zhao-guang-farm-master/src/styles/layout.scss
    - zhao-guang-farm-master/src/styles/reset.scss
    - zhao-guang-farm-master/src/styles/animations.scss
    - zhao-guang-farm-master/src/styles/element-plus.scss
    - zhao-guang-farm-master/vite.config.js
    - apps/web/src/assets/styles/main.scss
    - apps/web/vite.config.ts
---

## 1. 总体方案

仓库包含两个独立的前端应用，各自维护一套样式体系：

- **zhao-guang-farm-master**（主业务前端）：Vue3 + Vite + SCSS + Element Plus，采用 SCSS `@use` 模块化的设计令牌系统，通过 Vite `css.preprocessorOptions.additionalData` 全局注入变量。
- **apps/web**（新平台前端）：Vue3 + Vite + SCSS + Element Plus，采用 CSS 自定义属性（`:root` 变量）+ 组件库自动注册（unplugin-vue-components）的方式。

两个应用均使用 Element Plus 作为 UI 组件库，但样式组织方式不同。