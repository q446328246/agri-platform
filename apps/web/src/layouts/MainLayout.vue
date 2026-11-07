<template>
  <div class="layout-root">
    <router-view />
    <button v-if="showBack" class="detach-back" type="button" @click="goMap">‹ 返回一张图</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

// 全局一张图：不再渲染外围侧边栏与顶栏，业务功能统一在首页地图的浮层面板内就地打开。
// 消息未读、用户名与退出等原顶栏能力已下沉到首页右上控制簇。
// 仅当通过面板的“展开为完整页”进入独立路由时，浮一个返回一张图的入口，保证可回退。
const showBack = computed(() => route.path !== '/dashboard' && route.path !== '/')
function goMap() {
  void router.push('/dashboard')
}
</script>

<style scoped>
.layout-root {
  position: fixed;
  inset: 0;
  overflow: auto;
  background: #f0f2f5;
}
.detach-back {
  position: fixed;
  top: 14px;
  left: 14px;
  z-index: 2000;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 7px 12px;
  border: 1px solid rgba(0, 212, 255, .34);
  border-radius: 4px;
  background: rgba(7, 25, 48, .9);
  color: #cdeeff;
  cursor: pointer;
  font-size: 12px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, .3);
}
.detach-back:hover {
  background: rgba(0, 98, 133, .7);
}
</style>
