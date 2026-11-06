<template>
  <div class="page-container">
    <div class="card-container form-container">
      <h3 class="mb-20">{{ isEdit ? '编辑地块' : '新增地块' }}</h3>
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="100px"
      >
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="地块名称" prop="name">
              <el-input v-model="form.name" placeholder="请输入地块名称" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="地块类型" prop="type">
              <el-select v-model="form.type" placeholder="请选择地块类型" style="width: 100%">
                <el-option
                  v-for="item in plotTypeOptions"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="行政区" prop="regionCode">
              <el-cascader
                v-model="regionPath"
                :options="regionOptions"
                :props="{ label: 'name', value: 'code', children: 'children' }"
                placeholder="请选择行政区"
                style="width: 100%"
                @change="handleRegionChange"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="村组" prop="villageCode">
              <el-select v-model="form.villageCode" placeholder="请选择村组" style="width: 100%">
                <el-option
                  v-for="item in villageOptions"
                  :key="item.code"
                  :label="item.name"
                  :value="item.code"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="面积(亩)" prop="areaMu">
              <el-input-number v-model="form.areaMu" :min="0.01" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="土壤类型">
              <el-select v-model="form.soilType" placeholder="请选择土壤类型" style="width: 100%">
                <el-option
                  v-for="item in soilTypeOptions"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="负责人姓名">
              <el-input v-model="form.ownerName" placeholder="请输入负责人姓名" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="联系电话">
              <el-input v-model="form.ownerPhone" placeholder="请输入联系电话" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="当前作物">
              <el-input v-model="form.currentCrop" placeholder="请输入当前种植作物" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="地块状态">
              <el-select v-model="form.status" placeholder="请选择地块状态" style="width: 100%">
                <el-option
                  v-for="item in plotStatusOptions"
                  :key="item.value"
                  :label="item.label"
                  :value="item.value"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="地块边界" prop="coordinates">
          <div class="boundary-editor">
            <PlotPolygonEditor v-model="form.coordinates" @area-change="handleBoundaryArea" />
            <div class="boundary-editor__hint">单击地图逐个添加顶点，至少 3 个点自动闭合成不规则多边形；面积会按边界自动回填，可再手动修正。</div>
          </div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input
            v-model="form.remark"
            type="textarea"
            :rows="4"
            placeholder="请输入备注信息"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSubmit" :loading="submitting">
            保存
          </el-button>
          <el-button @click="handleCancel">取消</el-button>
        </el-form-item>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { plotApi } from '@/api'
import PlotPolygonEditor from '@/components/PlotPolygonEditor.vue'
import { parsePlotBoundary, type PlotBoundarySource } from '@/utils/geo'
import type { Plot, PlotForm } from '@/types'
import { PlotStatus as PS, PlotType as PT, SoilType as ST } from '@/types'

const route = useRoute()
const router = useRouter()
const formRef = ref<FormInstance>()
const submitting = ref(false)
const isEdit = computed(() => !!route.params.id)

const form = reactive<PlotForm & { id?: string }>({
  name: '',
  regionCode: '',
  villageCode: '',
  type: PT.FIELD,
  status: PS.ACTIVE,
  areaMu: 1,
  soilType: undefined,
  ownerName: '',
  ownerPhone: '',
  currentCrop: '',
  coordinates: [],
  remark: ''
})

const regionPath = ref<string[]>([])
const regionOptions = ref([
  {
    code: '510000',
    name: '四川省',
    children: [
      {
        code: '511700',
        name: '达州市',
        children: [
          { code: '511723', name: '开江县' }
        ]
      }
    ]
  }
])
const villageOptions = ref([
  { code: '511723-000001', name: '示例村1' },
  { code: '511723-000002', name: '示例村2' }
])

const plotTypeOptions = [
  { label: '大田', value: PT.FIELD },
  { label: '大棚', value: PT.GREENHOUSE },
  { label: '果园', value: PT.ORCHARD },
  { label: '水产养殖', value: PT.AQUACULTURE }
]

const plotStatusOptions = [
  { label: '草稿', value: PS.DRAFT },
  { label: '种植中', value: PS.ACTIVE },
  { label: '休耕', value: PS.FALLOW },
  { label: '已归档', value: PS.ARCHIVED }
]

const soilTypeOptions = [
  { label: '壤土', value: ST.LOAM },
  { label: '黏土', value: ST.CLAY },
  { label: '沙土', value: ST.SAND },
  { label: '淤土', value: ST.SILT },
  { label: '泥炭土', value: ST.PEAT }
]

const rules: FormRules = {
  name: [{ required: true, message: '请输入地块名称', trigger: 'blur' }],
  type: [{ required: true, message: '请选择地块类型', trigger: 'change' }],
  regionCode: [{ required: true, message: '请选择行政区', trigger: 'change' }],
  villageCode: [{ required: true, message: '请选择村组', trigger: 'change' }],
  areaMu: [{ required: true, message: '请输入面积', trigger: 'blur' }],
  coordinates: [{
    validator: (_rule, value, callback) => {
      const count = Array.isArray(value) ? value.length : 0
      // 编辑旧数据时允许尚未补全边界，但已绘制的边界不能退化成线段/点
      if (count > 0 && count < 3) callback(new Error('多边形至少需要 3 个顶点'))
      else if (!isEdit.value && count < 3) callback(new Error('请在地图上绘制地块边界'))
      else callback()
    },
    trigger: 'change'
  }]
}

function handleRegionChange(value: string[]) {
  if (value && value.length > 0) {
    form.regionCode = value[value.length - 1]!
  }
}

function handleBoundaryArea(area: number) {
  if (area > 0) form.areaMu = Number(area.toFixed(2))
}

async function handleSubmit() {
  if (!formRef.value) return
  await formRef.value.validate(async (valid) => {
    if (valid) {
      submitting.value = true
      try {
        if (isEdit.value) {
          await plotApi.update(route.params.id as string, form as PlotForm)
          ElMessage.success('更新成功')
        } else {
          await plotApi.create(form as PlotForm)
          ElMessage.success('创建成功')
        }
        router.back()
      } catch (error) {
        console.error('保存失败', error)
      } finally {
        submitting.value = false
      }
    }
  })
}

function handleCancel() {
  router.back()
}

async function loadDetail() {
  if (!isEdit.value) return
  try {
    const res: Plot = await plotApi.getById(route.params.id as string)
    Object.assign(form, res)
    const boundary = parsePlotBoundary(res as unknown as PlotBoundarySource)
    if (boundary?.rings[0]?.length) {
      // 服务端存的是 GeoJSON [经度, 纬度]，转回表单坐标后可直接继续编辑
      form.coordinates = boundary.rings[0].map(([lat, lng]) => [Number(lng.toFixed(6)), Number(lat.toFixed(6))] as [number, number])
    }
    if (res.regionCode) {
      regionPath.value = ['510000', '511700', res.regionCode]
    }
  } catch (error) {
    console.error('加载地块详情失败', error)
  }
}

onMounted(() => {
  loadDetail()
})
</script>

<style scoped>
.boundary-editor {
  width: 100%;
}
.boundary-editor__hint {
  margin-top: 6px;
  color: #909399;
  font-size: 12px;
  line-height: 1.6;
}
</style>
