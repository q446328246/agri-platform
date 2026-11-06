<template>
  <div class="page-container">
    <div class="card-container zone-layout">
      <aside class="zone-aside">
        <div class="zone-aside__head">
          <span>片区台账 · {{ zones.length }} 个</span>
          <el-button type="primary" size="small" @click="openCreate">
            <el-icon><Plus /></el-icon>新建
          </el-button>
        </div>
        <div v-loading="loading" class="zone-aside__list">
          <el-empty v-if="!zones.length && !loading" description="暂无片区，可先新建一个" :image-size="60" />
          <div
            v-for="zone in zones"
            :key="zone.zoneCode"
            class="zone-card"
            :class="{ 'zone-card--active': zone.zoneCode === activeCode }"
            @click="selectZone(zone.zoneCode)"
          >
            <div class="zone-card__title">
              <i class="zone-card__swatch" :style="{ background: zone.color }"></i>
              <strong>{{ zone.zoneName }}</strong>
              <span>{{ zone.zoneCode }}</span>
            </div>
            <div class="zone-card__meta">{{ zone.plotCount }} 块地块 · {{ zone.areaMu.toFixed(2) }} 亩</div>
            <div v-if="zone.description" class="zone-card__desc">{{ zone.description }}</div>
          </div>
        </div>
      </aside>

      <section class="zone-body">
        <template v-if="active">
          <div class="zone-body__head">
            <div>
              <h3>{{ active.zoneName }}</h3>
              <p>{{ active.zoneCode }} · {{ active.plotCount }} 块地块 · {{ active.areaMu.toFixed(2) }} 亩（边界为成员地块凸包）</p>
            </div>
            <div class="zone-body__actions">
              <el-button size="small" @click="openAssign">划入地块</el-button>
              <el-button size="small" @click="openEdit">编辑</el-button>
              <el-popconfirm title="确定删除该片区吗？" @confirm="removeZone">
                <template #reference>
                  <el-button size="small" type="danger" :disabled="active.plotCount > 0">删除</el-button>
                </template>
              </el-popconfirm>
            </div>
          </div>
          <div ref="mapEl" class="zone-map"></div>
          <el-table :data="members" size="small" border empty-text="片区下暂无地块，可点「划入地块」分配">
            <el-table-column prop="parcelCode" label="地块编码" width="240" />
            <el-table-column prop="name" label="地块名称" min-width="160" />
            <el-table-column label="面积(亩)" width="110" align="right">
              <template #default="{ row }">{{ Number(row.areaMu ?? 0).toFixed(2) }}</template>
            </el-table-column>
            <el-table-column label="土壤类型" width="140">
              <template #default="{ row }">{{ row.soilType || '-' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="90" align="center">
              <template #default="{ row }">
                <el-popconfirm title="将该地块移出本片区？" @confirm="removePlot(row.parcelCode)">
                  <template #reference>
                    <el-button link type="danger" size="small">移出</el-button>
                  </template>
                </el-popconfirm>
              </template>
            </el-table-column>
          </el-table>
        </template>
        <el-empty v-else description="从左侧选择一个片区查看成员地块与边界" />
      </section>
    </div>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑片区' : '新建片区'" width="460px">
      <el-form :model="form" label-width="88px">
        <el-form-item label="片区名称" required>
          <el-input v-model="form.zoneName" placeholder="如 东片区" maxlength="30" />
        </el-form-item>
        <el-form-item label="片区编码">
          <el-input v-model="form.zoneCode" :disabled="editing" placeholder="留空按 ZONE-XXXXXX 自动生成" />
        </el-form-item>
        <el-form-item label="标识颜色">
          <el-color-picker v-model="form.color" />
        </el-form-item>
        <el-form-item label="片区说明">
          <el-input v-model="form.description" type="textarea" :rows="2" placeholder="作物结构、地力等补充说明" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="assignVisible" title="划入地块" width="520px">
      <p class="assign-tip">
        选择要划入「{{ active?.zoneName }}」的地块；已归属其他片区的地块会被重新划分，地块编码中的地区段不会改变。
      </p>
      <el-select v-model="assignCode" filterable clearable placeholder="按编码或名称搜索地块" style="width: 100%">
        <el-option
          v-for="plot in assignCandidates"
          :key="plot.parcelCode"
          :label="`${plot.name}（${plot.parcelCode}）`"
          :value="plot.parcelCode"
        />
      </el-select>
      <p v-if="!assignCandidates.length" class="assign-tip assign-tip--empty">全部地块都已在本片区，或还没有地块档案。</p>
      <template #footer>
        <el-button @click="assignVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!assignCode" @click="confirmAssign">划入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { plotApi, zoneApi } from '@/api'
import type { ZoneSummary } from '@/api'
import type { Plot } from '@/types'
import { parsePlotBoundaries } from '@/utils/geo'

/**
 * 片区台账：左侧列表 + 右侧成员地块与一张图。
 * 片区边界优先用成员地块凸包现算，避免要求用户先测绘片区多边形。
 */
const CENTER: [number, number] = [30.982425, 107.421325]

const zones = ref<ZoneSummary[]>([])
const activeCode = ref('')
const members = ref<Plot[]>([])
const allPlots = ref<Plot[]>([])
const loading = ref(false)
const saving = ref(false)

const active = computed<ZoneSummary | null>(() => zones.value.find((item) => item.zoneCode === activeCode.value) ?? null)

const dialogVisible = ref(false)
const editing = ref(false)
const form = reactive({ zoneCode: '', zoneName: '', color: '#00d4ff', description: '' })

const assignVisible = ref(false)
const assignCode = ref('')
const assignCandidates = computed(() => allPlots.value.filter((plot) => plot.zoneCode !== activeCode.value))

const mapEl = ref<HTMLElement | null>(null)
let map: any = null
let tiles: any[] = []
let zoneLayer: any = null

function tianditu(layerName: string) {
  const key = import.meta.env.VITE_TIANDITU_KEY
  return L.tileLayer(
    'https://t{s}.tianditu.gov.cn/' + layerName + '_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=' + layerName +
      '&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=' + key,
    { subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maxZoom: 18 },
  )
}

/** 画成员地块与片区凸包；坐标入库是 [经度, 纬度]，Leaflet 需要 [纬度, 经度]。 */
function renderZoneMap() {
  if (!map) return
  if (zoneLayer) map.removeLayer(zoneLayer)
  zoneLayer = L.layerGroup()
  const current = active.value
  const color = current?.color || '#00d4ff'
  const bounds = L.latLngBounds([])
  for (const boundary of parsePlotBoundaries(members.value as any[])) {
    for (const ring of boundary.rings) {
      L.polygon(ring, { color, weight: 1.5, fillColor: color, fillOpacity: 0.18 })
        .bindTooltip(`<strong>${boundary.name}</strong><br>${boundary.areaMu.toFixed(2)} 亩`)
        .addTo(zoneLayer)
      for (const point of ring) bounds.extend(point)
    }
  }
  // 有成员地块时用凸包，否则退回片区自带的实测边界
  const ring = (current?.hull ?? current?.geom)?.coordinates?.[0]
  if (ring && ring.length >= 4) {
    const hull = ring.map((point) => [Number(point[1]), Number(point[0])] as [number, number])
    for (const point of hull) bounds.extend(point)
    L.polygon(hull, { color, weight: 2, dashArray: '8 6', fill: false })
      .bindTooltip(`<strong>${current?.zoneName ?? '片区'}</strong><br>${current?.plotCount ?? 0} 块 · ${(current?.areaMu ?? 0).toFixed(2)} 亩`)
      .addTo(zoneLayer)
  }
  zoneLayer.addTo(map)
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] })
  else map.setView(CENTER, 15)
}

async function fetchZones(keepActive = true) {
  loading.value = true
  try {
    zones.value = await zoneApi.getMap()
    const exists = zones.value.some((item) => item.zoneCode === activeCode.value)
    if (!keepActive || !exists) activeCode.value = zones.value[0]?.zoneCode ?? ''
  } catch (error) {
    console.error('获取片区列表失败', error)
  } finally {
    loading.value = false
  }
}

async function selectZone(zoneCode: string) {
  activeCode.value = zoneCode
  members.value = []
  try {
    const detail = await zoneApi.getDetail(zoneCode)
    members.value = (detail.plots ?? []) as Plot[]
  } catch (error) {
    console.error('获取片区详情失败', error)
  }
  renderZoneMap()
}

async function fetchAllPlots() {
  try {
    const result = await plotApi.getList({ page: 1, pageSize: 200 })
    allPlots.value = result.items
  } catch (error) {
    console.error('获取地块列表失败', error)
  }
}

function openCreate() {
  editing.value = false
  form.zoneCode = ''
  form.zoneName = ''
  form.color = '#00d4ff'
  form.description = ''
  dialogVisible.value = true
}

function openEdit() {
  if (!active.value) return
  editing.value = true
  form.zoneCode = active.value.zoneCode
  form.zoneName = active.value.zoneName
  form.color = active.value.color
  form.description = active.value.description ?? ''
  dialogVisible.value = true
}

async function submitForm() {
  const zoneName = form.zoneName.trim()
  if (!zoneName) {
    ElMessage.warning('请填写片区名称')
    return
  }
  saving.value = true
  try {
    if (editing.value && active.value) {
      await zoneApi.update(active.value.zoneCode, { zoneName, color: form.color, description: form.description })
      ElMessage.success('片区已更新')
    } else {
      const created = await zoneApi.create({
        zoneName,
        color: form.color,
        description: form.description,
        ...(form.zoneCode.trim() ? { zoneCode: form.zoneCode.trim() } : {}),
      })
      activeCode.value = created.zoneCode
      ElMessage.success(`片区 ${created.zoneCode} 已创建`)
    }
    dialogVisible.value = false
    await fetchZones()
    if (activeCode.value) await selectZone(activeCode.value)
  } catch (error) {
    // 编码重复等冲突已由请求拦截器提示，这里只保留日志
    console.error('保存片区失败', error)
  } finally {
    saving.value = false
  }
}

async function removeZone() {
  if (!active.value) return
  try {
    await zoneApi.remove(active.value.zoneCode)
    ElMessage.success('片区已删除')
    activeCode.value = ''
    members.value = []
    await fetchZones(false)
    if (activeCode.value) await selectZone(activeCode.value)
    else renderZoneMap()
  } catch (error) {
    console.error('删除片区失败', error)
  }
}

function openAssign() {
  assignCode.value = ''
  assignVisible.value = true
  void fetchAllPlots()
}

async function confirmAssign() {
  if (!active.value || !assignCode.value) return
  saving.value = true
  try {
    await zoneApi.assignPlot(active.value.zoneCode, assignCode.value)
    assignVisible.value = false
    ElMessage.success('地块已划入片区')
    await fetchZones()
    await selectZone(active.value.zoneCode)
    await fetchAllPlots()
  } catch (error) {
    console.error('划入地块失败', error)
  } finally {
    saving.value = false
  }
}

async function removePlot(parcelCode: string) {
  if (!active.value) return
  try {
    await zoneApi.removePlot(active.value.zoneCode, parcelCode)
    ElMessage.success('地块已移出片区')
    await fetchZones()
    await selectZone(active.value.zoneCode)
    await fetchAllPlots()
  } catch (error) {
    console.error('移出地块失败', error)
  }
}

onMounted(async () => {
  if (mapEl.value) {
    map = L.map(mapEl.value, { center: CENTER, zoom: 15, attributionControl: false })
    tiles = [tianditu('img'), tianditu('cia')]
    tiles.forEach((tile) => tile.addTo(map))
  }
  await fetchZones(false)
  if (activeCode.value) await selectZone(activeCode.value)
  void fetchAllPlots()
})

onBeforeUnmount(() => {
  tiles.forEach((tile) => tile.remove())
  tiles = []
  if (zoneLayer && map) map.removeLayer(zoneLayer)
  zoneLayer = null
  map?.remove()
  map = null
})
</script>

<style scoped lang="scss">
.zone-layout { display: flex; gap: 16px; align-items: stretch; }
.zone-aside { flex: 0 0 280px; display: flex; flex-direction: column; border-right: 1px solid var(--el-border-color-lighter); padding-right: 14px; }
.zone-aside__head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 10px; font-size: 13px; color: var(--el-text-color-regular); }
.zone-aside__list { flex: 1; max-height: 620px; overflow-y: auto; }
.zone-card { padding: 10px 12px; margin-bottom: 8px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; cursor: pointer; transition: all .2s; }
.zone-card:hover { border-color: var(--el-color-primary-light-5); }
.zone-card--active { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.zone-card__title { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.zone-card__title strong { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zone-card__title span { color: var(--el-text-color-secondary); font-size: 11px; }
.zone-card__swatch { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.zone-card__meta { margin-top: 6px; font-size: 12px; color: var(--el-text-color-secondary); }
.zone-card__desc { margin-top: 4px; font-size: 12px; color: var(--el-text-color-placeholder); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zone-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.zone-body__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.zone-body__head h3 { margin: 0; font-size: 16px; }
.zone-body__head p { margin: 4px 0 0; font-size: 12px; color: var(--el-text-color-secondary); }
.zone-body__actions { display: flex; gap: 8px; flex: none; }
.zone-map { height: 360px; border-radius: 6px; overflow: hidden; }
.assign-tip { margin: 0 0 12px; font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.6; }
.assign-tip--empty { margin: 10px 0 0; color: var(--el-color-warning); }
</style>
