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
        <el-form-item label="当前作物">
          <el-input v-model="form.currentCrop" placeholder="请输入当前种植作物" />
        </el-form-item>
        <el-form-item label="地块边界">
          <div class="coordinate-input">
            <el-button type="primary" plain @click="drawBoundary">
              <el-icon><EditPen /></el-icon>地图绘制
            </el-button>
            <span v-if="form.coordinates && form.coordinates.length > 0" class="ml-10">
              已绘制 {{ form.coordinates.length }} 个坐标点
            </span>
            <span v-else class="text-gray ml-10">暂未绘制</span>
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
import type { Plot, PlotForm } from '@/types'
import { PlotType as PT, SoilType as ST } from '@/types'

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
  areaMu: [{ required: true, message: '请输入面积', trigger: 'blur' }]
}

function handleRegionChange(value: string[]) {
  if (value && value.length > 0) {
    form.regionCode = value[value.length - 1]!
  }
}

function drawBoundary() {
  ElMessage.info('地图绘制功能请接入实际地图组件（如高德/百度地图）后使用')
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
.coordinate-input {
  display: flex;
  align-items: center;
}
.ml-10 {
  margin-left: 10px;
}
.text-gray {
  color: #909399;
}
</style>
