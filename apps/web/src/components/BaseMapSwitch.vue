<template>
  <div class="basemap-switch">
    <button
      v-for="opt in BASE_MAP_OPTIONS"
      :key="opt.key"
      type="button"
      class="basemap-switch__chip"
      :class="{ 'basemap-switch__chip--active': modelValue === opt.key }"
      :title="opt.hint"
      @click="emit('update:modelValue', opt.key)"
    >{{ opt.label }}</button>
  </div>
</template>

<script setup lang="ts">
import { BASE_MAP_OPTIONS, type BaseMapKey } from '@/utils/basemap'

/** 亮色主题底图切换条：绝对定位浮于地图容器右上，父容器须 position: relative。
 *  与地图容器互为兄弟节点，点击不会落到 Leaflet 画布上（绘制态不会误加顶点）。 */
defineProps<{ modelValue: BaseMapKey }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: BaseMapKey): void }>()
</script>

<style scoped lang="scss">
.basemap-switch {
  position: absolute;
  z-index: 500;
  top: 12px;
  right: 12px;
  display: flex;
  gap: 4px;
  padding: 4px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid #dcdfe6;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}

.basemap-switch__chip {
  padding: 4px 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #606266;
  font-size: 12px;
  cursor: pointer;
}

.basemap-switch__chip--active {
  background: #409eff;
  color: #fff;
}
</style>