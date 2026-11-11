<template>
  <div class="page-container">
    <el-row :gutter="16" class="summary-row">
      <el-col :span="6">
        <div class="summary-card"><span>苗情覆盖度</span><strong>{{ seedlingCoverage }}</strong><small>{{ seedlingCaption }}</small></div>
      </el-col>
      <el-col :span="6">
        <div class="summary-card summary-card--pest"><span>虫情待处置</span><strong>{{ pendingPests.length }}</strong><small>条识别记录</small></div>
      </el-col>
      <el-col :span="6">
        <div class="summary-card summary-card--alert"><span>灾情告警</span><strong>{{ alerts.length }}</strong><small>条待处理越限</small></div>
      </el-col>
      <el-col :span="6">
        <div class="summary-card"><span>阈值规则</span><strong>{{ rules.length }}</strong><small>{{ enabledRuleCount }} 条启用</small></div>
      </el-col>
    </el-row>

    <div class="card-container mt-16">
      <div class="agro-filter">
        <el-form :inline="true" :model="query" @submit.prevent="applyFilter">
          <el-form-item label="地块编码"><el-input v-model="query.plotCode" placeholder="苗情/灾情按地块" clearable style="width: 180px" /></el-form-item>
          <el-form-item label="监测指标">
            <el-select v-model="query.metric" placeholder="全部" clearable style="width: 150px">
              <el-option v-for="item in metricOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="告警级别">
            <el-select v-model="query.level" placeholder="全部" clearable style="width: 120px">
              <el-option label="提示" value="INFO" />
              <el-option label="预警" value="WARNING" />
              <el-option label="严重" value="CRITICAL" />
            </el-select>
          </el-form-item>
          <el-form-item label="虫害类型"><el-input v-model="query.pestType" placeholder="如：稻飞虱" clearable style="width: 140px" /></el-form-item>
          <el-form-item>
            <el-button type="primary" @click="applyFilter">查询</el-button>
            <el-button @click="resetFilter">重置</el-button>
          </el-form-item>
        </el-form>
      </div>
      <el-tabs v-model="activeTab" @tab-change="onTabChange">
        <el-tab-pane label="苗情" name="seedling">
          <div class="toolbar">
            <div class="history-controls">
              <el-select v-model="growthPlotCode" filterable placeholder="选择地块" style="width: 240px" @change="reloadSeedling">
                <el-option v-for="plot in plotOptions" :key="plot.parcelCode" :label="`${plot.parcelName}（${plot.parcelCode}）`" :value="plot.parcelCode" />
              </el-select>
              <el-button v-if="canWrite" type="primary" :disabled="!growthPlotCode" @click="openGrowthCreate">登记生育期</el-button>
              <el-button @click="goPestGovernance">虫情治理</el-button>
            </div>
            <span class="rule-hint">对比计划与实际生育期节点，判断长势提前或滞后；异常可跳虫情页治理</span>
          </div>

          <el-table v-loading="loading" :data="seedlingRows" border stripe>
            <el-table-column prop="label" label="监测指标" width="180" />
            <el-table-column prop="value" label="最新读数" width="150" />
            <el-table-column prop="unit" label="单位" width="90" />
            <el-table-column prop="plotCode" label="地块编码" min-width="200" />
            <el-table-column label="采集时间" width="180"><template #default="{ row }">{{ formatTime(row.recordedAt) }}</template></el-table-column>
          </el-table>
          <el-empty v-if="!loading && seedlingRows.length === 0" description="暂无苗情读数，等待遥感或田间设备上报" />

          <div class="growth-block">
            <div class="flex-between mb-16">
              <h4>生育期时间轴</h4>
              <span v-if="growthPlotCode" class="rule-hint">{{ growthPlotCode }}</span>
            </div>
            <el-empty v-if="!growthLoading && growthTimeline.length === 0" description="该地块暂无生育期档案，点「登记生育期」建档" />
            <el-timeline v-else>
              <el-timeline-item
                v-for="stage in growthTimeline"
                :key="stage.id"
                :type="stage.status === 'done' ? 'success' : stage.status === 'active' ? 'primary' : 'info'"
                :hollow="stage.status === 'pending'"
              >
                <div class="growth-item">
                  <div class="growth-item__head">
                    <strong>{{ stage.label }}</strong>
                    <el-tag size="small" :type="stage.status === 'done' ? 'success' : stage.status === 'active' ? 'warning' : 'info'">
                      {{ stage.status === 'done' ? '已完成' : stage.status === 'active' ? '进行中' : '未开始' }}
                    </el-tag>
                    <el-tag v-if="stage.deviation" size="small" :type="stage.deviation.startsWith('滞后') ? 'danger' : 'success'">{{ stage.deviation }}</el-tag>
                    <span class="growth-item__actions">
                      <el-button v-if="canWrite" link type="primary" @click="openGrowthEdit(stage)">编辑</el-button>
                      <el-button v-if="canWrite" link type="danger" @click="removeGrowth(stage)">删除</el-button>
                    </span>
                  </div>
                  <div class="growth-item__meta">
                    <span>计划：{{ stage.plannedStartAt ? `${isoToFarmDate(stage.plannedStartAt)} ~ ${isoToFarmDate(stage.plannedEndAt) || '—'}` : '未排' }}</span>
                    <span>实际：{{ stage.actualStartAt ? `${isoToFarmDate(stage.actualStartAt)} ~ ${isoToFarmDate(stage.actualEndAt) || '—'}` : '未记录' }}</span>
                  </div>
                  <div v-if="stage.note" class="growth-item__note">{{ stage.note }}</div>
                </div>
              </el-timeline-item>
            </el-timeline>
          </div>

          <div class="soil-history">
            <div class="flex-between mb-16">
              <h4>长势历史曲线</h4>
              <div class="history-controls">
                <el-select v-model="seedlingMetric" style="width: 150px" @change="loadSeedlingHistory">
                  <el-option v-for="m in seedlingMetricOptions" :key="m.value" :label="m.label" :value="m.value" />
                </el-select>
                <el-date-picker v-model="seedlingRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" style="width: 260px" @change="loadSeedlingHistory" />
              </div>
            </div>
            <el-empty v-if="!seedlingHistoryLoaded" description="所选指标/地块暂无历史读数" />
            <v-chart v-else class="chart" :option="seedlingChartOption" autoresize />
          </div>
        </el-tab-pane>

        <el-tab-pane label="土壤墒情" name="soil">
          <div class="toolbar">
            <div class="history-controls">
              <el-select v-model="soilDepthFilter" placeholder="全部深度" clearable style="width: 150px">
                <el-option v-for="d in soilDepthColumns" :key="d.value" :label="d.label" :value="d.value" />
              </el-select>
              <el-button @click="loadSoil">刷新分层读数</el-button>
            </div>
            <span class="rule-hint">按深度分层展示最新墒情，下方可选指标与时间范围查看历史曲线</span>
          </div>
          <el-table v-loading="soilLoading" :data="soilRows" border stripe>
            <el-table-column prop="label" label="土壤指标" width="150" />
            <el-table-column prop="unit" label="单位" width="90" />
            <el-table-column v-for="d in soilDepthColumns" :key="d.value" :label="d.label" width="120">
              <template #default="{ row }">{{ soilCell(row, d.value) }}</template>
            </el-table-column>
            <el-table-column prop="plotCode" label="地块编码" min-width="200" />
            <el-table-column label="采集时间" width="180"><template #default="{ row }">{{ formatTime(row.recordedAt) }}</template></el-table-column>
          </el-table>
          <el-empty v-if="!soilLoading && soilRows.length === 0" description="暂无分层土壤读数，等待墒情设备上报" />

          <div class="soil-history">
            <div class="flex-between mb-16">
              <h4>历史曲线</h4>
              <div class="history-controls">
                <el-select v-model="soilMetric" style="width: 150px" @change="loadSoilHistory">
                  <el-option v-for="m in soilMetricOptions" :key="m.value" :label="m.label" :value="m.value" />
                </el-select>
                <el-select v-model="soilHistoryDepth" placeholder="全部深度" clearable style="width: 140px" @change="loadSoilHistory">
                  <el-option v-for="d in soilDepthColumns" :key="d.value" :label="d.label" :value="d.value" />
                </el-select>
                <el-date-picker v-model="soilRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" style="width: 260px" @change="loadSoilHistory" />
              </div>
            </div>
            <el-empty v-if="!soilHistoryLoaded" description="所选指标/深度暂无历史读数" />
            <v-chart v-else class="chart" :option="soilChartOption" autoresize />
          </div>
        </el-tab-pane>

        <el-tab-pane label="虫情" name="pest">
          <div class="toolbar">
            <el-checkbox v-model="pestPendingOnly" @change="loadPests">只看未处置</el-checkbox>
            <el-button type="primary" @click="pestDialogVisible = true">登记识别结果</el-button>
          </div>

          <div class="growth-block">
            <div class="flex-between mb-16">
              <h4>区域统计</h4>
              <span class="rule-hint">{{ query.plotCode || '全农场' }}{{ query.pestType ? ` · ${query.pestType}` : '' }}</span>
            </div>
            <el-empty v-if="pestStatsEmpty" description="所选范围内暂无虫情记录" />
            <template v-else-if="pestStats">
              <div class="pest-stat-cards">
                <div class="pest-stat"><span>累计识别</span><strong>{{ pestStats.total }}</strong></div>
                <div class="pest-stat"><span>待处置</span><strong>{{ pestStats.pending }}</strong></div>
                <div v-for="item in pestStats.byLevel" :key="`level-${item.level}`" class="pest-stat">
                  <span>{{ pestLevelText(item.level) }}</span><strong>{{ item.count }}</strong>
                </div>
              </div>
              <div class="pest-stat-tables">
                <el-table :data="pestStats.byType" size="small" border>
                  <el-table-column prop="pestType" label="虫害类型" min-width="120" />
                  <el-table-column prop="count" label="识别数" width="90" />
                </el-table>
                <el-table :data="pestStats.byPlot" size="small" border>
                  <el-table-column prop="plotCode" label="地块编码" min-width="160" />
                  <el-table-column prop="count" label="识别数" width="90" />
                </el-table>
              </div>
            </template>
          </div>

          <div class="soil-history">
            <div class="flex-between mb-16">
              <h4>识别趋势</h4>
              <div class="history-controls">
                <el-select v-model="pestTrendDays" style="width: 130px" @change="loadPestAnalytics">
                  <el-option label="近 7 天" :value="7" />
                  <el-option label="近 14 天" :value="14" />
                  <el-option label="近 30 天" :value="30" />
                </el-select>
              </div>
            </div>
            <el-empty v-if="pestTrend.length === 0" description="所选范围内暂无趋势数据" />
            <v-chart v-else class="chart" :option="pestTrendChartOption" autoresize />
          </div>

          <el-table v-loading="loading" :data="pests" border stripe>
            <el-table-column prop="pestType" label="虫害类型" width="140" />
            <el-table-column label="发生等级" width="120">
              <template #default="{ row }">
                <el-tag :type="pestLevelTag(row.level)" size="small">{{ pestLevelText(row.level) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="置信度" width="110"><template #default="{ row }">{{ (row.confidence * 100).toFixed(1) }}%</template></el-table-column>
            <el-table-column prop="plotCode" label="地块编码" min-width="200" />
            <el-table-column prop="deviceId" label="识别来源" width="150" />
            <el-table-column label="识别时间" width="180"><template #default="{ row }">{{ formatTime(row.detectedAt) }}</template></el-table-column>
            <el-table-column label="治理状态" width="110">
              <template #default="{ row }">
                <el-tag :type="governanceTag(row.governanceStatus)" size="small">{{ governanceText(row.governanceStatus) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button v-if="canWrite" link type="primary" @click="openPestGovern(row)">治理</el-button>
                <el-button v-if="!row.handled" link type="success" @click="handlePest(row)">标记处置</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="灾情" name="disaster">
          <div class="toolbar">
            <div class="history-controls">
              <el-select v-model="disasterStatusFilter" placeholder="全部状态" clearable style="width: 150px" @change="loadDisasters">
                <el-option label="已上报" value="REPORTED" />
                <el-option label="已核查" value="ASSESSED" />
                <el-option label="已处置" value="HANDLED" />
                <el-option label="已归档" value="ARCHIVED" />
              </el-select>
              <el-button @click="loadDisasters">刷新档案</el-button>
            </div>
            <el-button v-if="canWrite" type="primary" @click="openDisasterReport">上报灾情</el-button>
          </div>

          <div class="growth-block">
            <div class="flex-between mb-16">
              <h4>灾情概览</h4>
              <span class="rule-hint">{{ query.plotCode || '全农场' }}</span>
            </div>
            <el-empty v-if="disasterStatsEmpty" description="所选范围内暂无灾情档案" />
            <template v-else-if="disasterStats">
              <div class="pest-stat-cards">
                <div class="pest-stat"><span>档案总数</span><strong>{{ disasterStats.total }}</strong></div>
                <div class="pest-stat"><span>未归档</span><strong>{{ disasterStats.open }}</strong></div>
                <div class="pest-stat"><span>未归档受灾面积</span><strong>{{ disasterStats.affectedAreaMu.toFixed(2) }}</strong><small>亩</small></div>
              </div>
              <div class="pest-stat-tables">
                <el-table :data="disasterStats.byType" size="small" border>
                  <el-table-column label="灾种" min-width="120"><template #default="{ row }">{{ disasterTypeLabel(row.disasterType) }}</template></el-table-column>
                  <el-table-column prop="count" label="次数" width="80" />
                  <el-table-column label="受灾面积(亩)" width="130"><template #default="{ row }">{{ row.affectedAreaMu.toFixed(2) }}</template></el-table-column>
                </el-table>
                <el-table :data="disasterStats.bySeverity" size="small" border>
                  <el-table-column label="灾害分级" min-width="120"><template #default="{ row }">{{ disasterSeverityLabel(row.severity) }}</template></el-table-column>
                  <el-table-column prop="count" label="次数" width="90" />
                </el-table>
              </div>
            </template>
          </div>

          <el-table v-loading="disasterLoading" :data="disasters" border stripe>
            <el-table-column label="灾种" width="120"><template #default="{ row }">{{ disasterTypeLabel(row.disasterType) }}</template></el-table-column>
            <el-table-column label="灾害分级" width="110"><template #default="{ row }"><el-tag :type="disasterSeverityTag(row.severity)" size="small">{{ disasterSeverityLabel(row.severity) }}</el-tag></template></el-table-column>
            <el-table-column label="受灾面积" width="120"><template #default="{ row }">{{ Number(row.affectedAreaMu).toFixed(2) }} 亩</template></el-table-column>
            <el-table-column prop="plotCode" label="地块编码" min-width="180" />
            <el-table-column label="发生时间" width="170"><template #default="{ row }">{{ formatTime(row.occurredAt) }}</template></el-table-column>
            <el-table-column label="处置状态" width="110"><template #default="{ row }"><el-tag :type="disasterStatusTag(row.status)" size="small">{{ disasterStatusText(row.status) }}</el-tag></template></el-table-column>
            <el-table-column prop="suggestion" label="处置建议" min-width="180" show-overflow-tooltip />
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button v-if="canWrite && row.status !== 'ARCHIVED'" link type="primary" @click="openDisasterSupplement(row)">补充处置</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!disasterLoading && disasters.length === 0" description="暂无灾情档案，点「上报灾情」建立台账" />

          <div class="growth-block">
            <div class="flex-between mb-16"><h4>阈值灾情告警</h4></div>
            <el-table v-loading="loading" :data="alerts" border stripe>
              <el-table-column label="级别" width="100">
                <template #default="{ row }"><el-tag :type="alertLevelTag(row.level)" size="small">{{ row.level }}</el-tag></template>
              </el-table-column>
              <el-table-column prop="metric" label="指标" width="160" />
              <el-table-column prop="message" label="告警内容" min-width="240" />
              <el-table-column prop="plotCode" label="地块编码" min-width="200" />
              <el-table-column prop="deviceId" label="设备" width="150" />
              <el-table-column label="发生时间" width="180"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
              <el-table-column label="操作" width="110">
                <template #default="{ row }"><el-button link type="primary" @click="handleAlert(row)">标记处理</el-button></template>
              </el-table-column>
            </el-table>
            <el-empty v-if="!loading && alerts.length === 0" description="暂无待处理阈值告警" />
          </div>
        </el-tab-pane>

        <el-tab-pane label="阈值规则" name="rules">
          <div class="table-toolbar">
            <div>
              <el-button v-if="canWrite" type="primary" @click="openRuleCreate">
                <el-icon><Plus /></el-icon>新增规则
              </el-button>
            </div>
            <div class="rule-hint">每个地块可配「提示—预警—告警」三级阈值，地块专属优先于全局；命中多级按最严重一级告警</div>
          </div>
          <el-table v-loading="loading" :data="rules" border stripe>
            <el-table-column label="指标" width="150"><template #default="{ row }">{{ metricLabel(row.metric) }}</template></el-table-column>
            <el-table-column label="适用地块" width="180"><template #default="{ row }">{{ row.plotCode || '全局默认' }}</template></el-table-column>
            <el-table-column label="判定" width="150"><template #default="{ row }">{{ row.direction === 'above' ? '高于' : '低于' }} {{ row.threshold }}</template></el-table-column>
            <el-table-column label="级别" width="100"><template #default="{ row }"><el-tag :type="alertLevelTag(row.level)" size="small">{{ ruleLevelText(row.level) }}</el-tag></template></el-table-column>
            <el-table-column prop="message" label="告警文案" min-width="220" />
            <el-table-column label="启用" width="90">
              <template #default="{ row }"><el-switch :model-value="row.enabled" @change="(value: boolean) => toggleRule(row, value)" /></template>
            </el-table-column>
            <el-table-column label="操作" width="140">
              <template #default="{ row }">
                <el-button v-if="canWrite" link type="primary" @click="openRuleEdit(row)">编辑</el-button>
                <el-button v-if="canWrite" link type="danger" @click="removeRule(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>

    <el-dialog v-model="pestDialogVisible" title="登记虫情识别结果" width="520px">
      <el-form :model="pestForm" label-width="96px">
        <el-form-item label="地块编码"><el-input v-model="pestForm.plotCode" placeholder="选填，留空表示未绑定地块" /></el-form-item>
        <el-form-item label="识别来源"><el-input v-model="pestForm.deviceId" placeholder="摄像头或算法节点标识" /></el-form-item>
        <el-form-item label="虫害类型"><el-input v-model="pestForm.pestType" placeholder="如：稻飞虱" /></el-form-item>
        <el-form-item label="发生等级">
          <el-select v-model="pestForm.level" style="width: 100%">
            <el-option label="轻微" :value="1" /><el-option label="中等" :value="2" /><el-option label="严重" :value="3" />
          </el-select>
        </el-form-item>
        <el-form-item label="置信度"><el-input-number v-model="pestForm.confidence" :min="0" :max="1" :step="0.01" /></el-form-item>
        <el-form-item label="影像编号"><el-input v-model="pestForm.imageFileId" placeholder="选填，文件服务返回的影像标识" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pestDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitPest">提交并生成告警</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="ruleDialogVisible" :title="ruleEditing ? '编辑阈值规则' : '新增阈值规则'" width="520px">
      <el-form :model="ruleForm" label-width="96px" @submit.prevent="saveRule">
        <el-form-item label="监测指标">
          <el-select v-model="ruleForm.metric" :disabled="ruleEditing" style="width: 100%">
            <el-option v-for="item in metricOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="适用地块">
          <el-select v-model="ruleForm.plotCode" :disabled="ruleEditing" clearable filterable placeholder="全局默认（所有地块）" style="width: 100%">
            <el-option label="全局默认（所有地块）" value="" />
            <el-option v-for="plot in plotOptions" :key="plot.parcelCode" :label="`${plot.parcelName}（${plot.parcelCode}）`" :value="plot.parcelCode" />
          </el-select>
          <span class="rule-hint">留空为全局默认；地块专属规则优先于全局</span>
        </el-form-item>
        <el-form-item label="判定方向">
          <el-radio-group v-model="ruleForm.direction">
            <el-radio value="above">高于上限</el-radio>
            <el-radio value="below">低于下限</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="阈值">
          <el-input-number v-model="ruleForm.threshold" :min="0" :max="1000" :step="1" />
          <span class="rule-hint">{{ ruleUnit }}</span>
        </el-form-item>
        <el-form-item label="告警级别">
          <el-select v-model="ruleForm.level" :disabled="ruleEditing" style="width: 160px">
            <el-option label="提示" value="INFO" /><el-option label="预警" value="WARNING" /><el-option label="告警" value="CRITICAL" />
          </el-select>
          <span v-if="ruleEditing" class="rule-hint">指标 + 地块 + 级别是唯一键，需要更换请新建一条</span>
        </el-form-item>
        <el-form-item label="告警文案">
          <el-input v-model="ruleForm.message" type="textarea" :rows="2" placeholder="留空则按「指标 越限告警」自动生成" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="ruleForm.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ruleDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="ruleSaving" @click="saveRule">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="growthDialogVisible" :title="growthEditing ? '编辑生育期档案' : '登记生育期'" width="520px">
      <el-form :model="growthForm" label-width="96px" @submit.prevent="saveGrowth">
        <el-form-item label="地块编码">
          <el-select v-model="growthForm.plotCode" filterable placeholder="选择建档地块" style="width: 100%">
            <el-option v-for="plot in plotOptions" :key="plot.parcelCode" :label="`${plot.parcelName}（${plot.parcelCode}）`" :value="plot.parcelCode" />
          </el-select>
          <span class="rule-hint">同地块同生育期只保留一条，重复登记为更新</span>
        </el-form-item>
        <el-form-item label="生育期">
          <el-select v-model="growthForm.stage" :disabled="growthEditing" style="width: 100%">
            <el-option v-for="item in growthStageOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="计划开始"><el-date-picker v-model="growthForm.plannedStart" type="date" value-format="YYYY-MM-DD" placeholder="计划节点" style="width: 100%" /></el-form-item>
        <el-form-item label="计划结束"><el-date-picker v-model="growthForm.plannedEnd" type="date" value-format="YYYY-MM-DD" placeholder="计划节点" style="width: 100%" /></el-form-item>
        <el-form-item label="实际开始"><el-date-picker v-model="growthForm.actualStart" type="date" value-format="YYYY-MM-DD" placeholder="田间实测" style="width: 100%" /></el-form-item>
        <el-form-item label="实际结束"><el-date-picker v-model="growthForm.actualEnd" type="date" value-format="YYYY-MM-DD" placeholder="田间实测" style="width: 100%" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="growthForm.note" type="textarea" :rows="2" placeholder="长势描述、异常说明等" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="growthDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="growthSaving" @click="saveGrowth">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pestGovernVisible" :title="`虫情治理 · ${pestGovernForm.pestType}`" width="560px">
      <el-form :model="pestGovernForm" label-width="110px">
        <el-form-item label="地块编码"><span class="rule-hint">{{ pestGovernForm.plotCode || '未绑定地块' }}</span></el-form-item>
        <el-form-item label="治理状态">
          <el-select v-model="pestGovernForm.status" :disabled="pestGovernForm.dispatch" style="width: 160px">
            <el-option label="已定方案" value="planned" />
            <el-option label="已归档" value="archived" />
          </el-select>
        </el-form-item>
        <el-form-item label="治理措施" required><el-input v-model="pestGovernForm.measure" type="textarea" :rows="2" placeholder="如：每亩喷施吡蚜虫剂，田间排水降湿" /></el-form-item>
        <el-form-item label="药剂名称"><el-input v-model="pestGovernForm.pesticide" placeholder="选填，登记实际用药" /></el-form-item>
        <el-form-item label="用量"><el-input v-model="pestGovernForm.dosage" placeholder="选填，如 20g/亩" /></el-form-item>
        <el-form-item label="负责人"><el-input v-model="pestGovernForm.governedBy" placeholder="选填，处置人/机手" /></el-form-item>
        <el-form-item label="派单说明"><el-input v-model="pestGovernForm.dispatchNote" type="textarea" :rows="2" placeholder="选填，作业要求、时段等" /></el-form-item>
        <el-form-item label="同时派单">
          <el-checkbox v-model="pestGovernForm.dispatch">生成植保喷防农事任务</el-checkbox>
        </el-form-item>
        <el-form-item>
          <span class="rule-hint">派单仅在系统内建植保喷防任务并回写治理状态；无人机/喷杆机的实际出勤与作业回执仍依赖现场设备接入。</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pestGovernVisible = false">取消</el-button>
        <el-button type="primary" :loading="pestGovernSaving" @click="submitPestGovern">保存治理</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="disasterReportVisible" title="上报灾情" width="540px">
      <el-form :model="disasterReportForm" label-width="104px">
        <el-form-item label="灾种" required>
          <el-select v-model="disasterReportForm.disasterType" style="width: 100%">
            <el-option v-for="item in disasterTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="灾害分级" required>
          <el-select v-model="disasterReportForm.severity" style="width: 100%">
            <el-option v-for="item in disasterSeverityOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="发生日期" required><el-date-picker v-model="disasterReportForm.occurredDate" type="date" value-format="YYYY-MM-DD" placeholder="灾情发生日" style="width: 100%" /></el-form-item>
        <el-form-item label="受灾地块">
          <el-select v-model="disasterReportForm.plotCode" clearable filterable placeholder="选填，留空表示未绑定地块" style="width: 100%">
            <el-option v-for="plot in plotOptions" :key="plot.parcelCode" :label="`${plot.parcelName}（${plot.parcelCode}）`" :value="plot.parcelCode" />
          </el-select>
        </el-form-item>
        <el-form-item label="受灾面积"><el-input-number v-model="disasterReportForm.affectedAreaMu" :min="0" :step="0.5" :precision="2" /><span class="rule-hint">亩，按田块实测填报</span></el-form-item>
        <el-form-item label="处置建议"><el-input v-model="disasterReportForm.suggestion" type="textarea" :rows="2" placeholder="如：启动应急灌溉 / 排水降渍" /></el-form-item>
        <el-form-item label="上报人"><el-input v-model="disasterReportForm.reportedBy" placeholder="选填，田间巡查员" /></el-form-item>
        <el-form-item label="影像编号"><el-input v-model="disasterReportForm.imageFileIds" placeholder="选填，多个用逗号分隔" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="disasterReportVisible = false">取消</el-button>
        <el-button type="primary" :loading="disasterSaving" @click="submitDisasterReport">提交上报</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="disasterSupplementVisible" :title="`灾情处置 · ${disasterTypeLabel(disasterSupplementForm.disasterType)} ${disasterSupplementForm.plotCode}`" width="540px">
      <el-form :model="disasterSupplementForm" label-width="104px">
        <el-form-item label="推进状态">
          <el-select v-model="disasterSupplementForm.status" style="width: 100%">
            <el-option v-for="item in disasterStatusOptions(disasterSupplementForm.currentStatus)" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="处置人"><el-input v-model="disasterSupplementForm.handledBy" placeholder="核查/处置负责人" /></el-form-item>
        <el-form-item label="处置建议"><el-input v-model="disasterSupplementForm.suggestion" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="损失评估"><el-input v-model="disasterSupplementForm.lossAssessment" type="textarea" :rows="2" placeholder="定损说明；卫星遥感定损与保险理赔需外部系统对接" /></el-form-item>
        <el-form-item label="受灾面积"><el-input-number v-model="disasterSupplementForm.affectedAreaMu" :min="0" :step="0.5" :precision="2" /><span class="rule-hint">亩</span></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="disasterSupplementVisible = false">取消</el-button>
        <el-button type="primary" :loading="disasterSaving" @click="submitDisasterSupplement">保存处置</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import { TooltipComponent, LegendComponent, GridComponent } from 'echarts/components'
import { operationApi, plotApi, telemetryApi } from '@/api'
import { useUserStore } from '@/stores'
import { formatDateTime } from '@/utils'
import type { PestEvent, TelemetryAlert, TelemetryHistoryPoint, TelemetryRule, TelemetryRuleInput, GrowthStage, GrowthStageInput, PestStats, PestTrendPoint, GovernanceStatus, DisasterRecord, DisasterStats, DisasterType, DisasterStatus, DisasterSeverity } from '@/api'

use([CanvasRenderer, LineChart, TooltipComponent, LegendComponent, GridComponent])

/**
 * 四情（苗情/虫情/灾情）监控页。
 *
 * 数据全部来自遥测服务：总览一次拉齐读数、待处置告警、虫情记录与阈值规则，
 * 阈值规则在这里维护，田间上报与视频 AI 识别共用同一套判定口径。
 * 土壤墒情按深度分层展示最新读数，并可按指标/深度/时间范围回看历史曲线。
 */

/** 土壤指标目录（开发方案 6.1）：温度/湿度/EC/pH 与氮磷钾有机质养分 */
const soilMetricOptions = [
  { label: '土壤温度', value: 'soilTemperature', unit: '°C' },
  { label: '土壤湿度', value: 'soilMoisture', unit: '%' },
  { label: '土壤EC', value: 'soilEc', unit: 'μS/cm' },
  { label: '土壤pH', value: 'soilPh', unit: '' },
  { label: '氮含量', value: 'soilNitrogen', unit: 'mg/kg' },
  { label: '磷含量', value: 'soilPhosphorus', unit: 'mg/kg' },
  { label: '钾含量', value: 'soilPotassium', unit: 'mg/kg' },
  { label: '有机质', value: 'soilOrganicMatter', unit: 'mg/kg' },
]
const soilMetricValues = new Set(soilMetricOptions.map((item) => item.value))
const soilUnit = (metric: string): string => soilMetricOptions.find((item) => item.value === metric)?.unit ?? ''

const metricOptions = [
  ...soilMetricOptions,
  { label: '空气温度', value: 'airTemperature', unit: '°C' },
  { label: '空气湿度', value: 'airHumidity', unit: '%' },
  { label: '风速', value: 'windSpeed', unit: 'm/s' },
  { label: '降雨量', value: 'rainfall', unit: 'mm' },
  { label: '苗情覆盖度', value: 'canopyCoverage', unit: '%' },
  { label: '株高', value: 'plantHeight', unit: 'cm' },
  { label: '叶色', value: 'leafColor', unit: 'SPAD' },
  { label: '均匀度', value: 'uniformity', unit: '%' },
  { label: '虫口密度', value: 'pestCount', unit: '头/百株' },
  { label: '病情指数', value: 'diseaseIndex', unit: '' },
]
/** 苗情长势指标（开发方案 6.2）：株高/叶色/覆盖度/均匀度 */
const seedlingMetricOptions = [
  { label: '株高', value: 'plantHeight', unit: 'cm' },
  { label: '叶色', value: 'leafColor', unit: 'SPAD' },
  { label: '覆盖度', value: 'canopyCoverage', unit: '%' },
  { label: '均匀度', value: 'uniformity', unit: '%' },
]
const seedlingMetrics = seedlingMetricOptions.map((item) => item.value)
const metricLabel = (metric: string): string => metricOptions.find((item) => item.value === metric)?.label ?? metric

/** 生育期目录（开发方案 6.2）：出苗→分蘖→拔节→抽穗→灌浆→成熟，stage 存编码，顺序即时间轴顺序 */
const growthStageOptions = [
  { value: 'seedling', label: '出苗期' },
  { value: 'tillering', label: '分蘖期' },
  { value: 'jointing', label: '拔节期' },
  { value: 'heading', label: '抽穗期' },
  { value: 'filling', label: '灌浆期' },
  { value: 'maturity', label: '成熟期' },
]
const growthStageLabel = (stage: string): string => growthStageOptions.find((item) => item.value === stage)?.label ?? stage
const growthStageOrder = (stage: string): number => {
  const index = growthStageOptions.findIndex((item) => item.value === stage)
  return index < 0 ? growthStageOptions.length : index
}

const userStore = useUserStore()
const loading = ref(false)
const activeTab = ref('seedling')
const query = reactive<{ plotCode: string; metric: string; level: string; pestType: string }>({ plotCode: '', metric: '', level: '', pestType: '' })
const latest = ref<Array<{ deviceId: string; plotCode: string; metric: string; value: number; unit: string; recordedAt: string; depthCm?: number }>>([])
const alerts = ref<TelemetryAlert[]>([])
const pests = ref<PestEvent[]>([])
const rules = ref<TelemetryRule[]>([])
const pestPendingOnly = ref(true)
const pestDialogVisible = ref(false)

/** 土壤墒情：分层最新读数 + 历史曲线，独立于全局指标筛选，按地块拉取全部土壤指标 */
type SoilReading = { deviceId: string; plotCode: string; metric: string; value: number; unit: string; recordedAt: string; depthCm?: number }
const soilLoading = ref(false)
const soilLatest = ref<SoilReading[]>([])
const soilDepthFilter = ref<number | ''>('')
const soilMetric = ref('soilMoisture')
const soilHistoryDepth = ref<number | ''>('')
const soilRange = ref<[string, string] | null>(null)
const soilHistoryLoaded = ref(false)
const soilTimes = ref<string[]>([])
const soilValues = ref<number[]>([])

/** 深度列由实际读数推导（不写死分层），未带深度的读数归入「未分层」列，键 -1 */
const soilDepthColumns = computed(() => {
  const depths = new Set<number>()
  let hasUnlayered = false
  for (const row of soilLatest.value) {
    if (typeof row.depthCm === 'number') depths.add(row.depthCm)
    else hasUnlayered = true
  }
  const columns = [...depths].sort((a, b) => a - b).map((value) => ({ value, label: `${value}cm` }))
  if (hasUnlayered) columns.push({ value: -1, label: '未分层' })
  return columns
})

/** 按地块+指标分组，各深度读数落到对应列；同一组取最近采集时间 */
const soilRows = computed(() => {
  const groups = new Map<string, { label: string; unit: string; plotCode: string; recordedAt: string; depths: Record<number, number> }>()
  for (const row of soilLatest.value) {
    const key = `${row.plotCode}::${row.metric}`
    let group = groups.get(key)
    if (!group) {
      group = { label: metricLabel(row.metric), unit: row.unit || soilUnit(row.metric), plotCode: row.plotCode, recordedAt: row.recordedAt, depths: {} }
      groups.set(key, group)
    }
    group.depths[typeof row.depthCm === 'number' ? row.depthCm : -1] = row.value
    if (row.recordedAt > group.recordedAt) group.recordedAt = row.recordedAt
  }
  return [...groups.values()]
})

function soilCell(row: { depths: Record<number, number> }, depth: number): string {
  if (soilDepthFilter.value !== '' && soilDepthFilter.value !== depth) return '—'
  const value = row.depths[depth]
  return value === undefined ? '—' : String(value)
}

const soilChartOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  legend: { data: [metricLabel(soilMetric.value)], bottom: 0 },
  grid: { left: '3%', right: '4%', bottom: '15%', containLabel: true },
  xAxis: { type: 'category', boundaryGap: false, data: soilTimes.value },
  yAxis: { type: 'value' },
  series: [{ name: metricLabel(soilMetric.value), type: 'line', smooth: true, data: soilValues.value }],
}))

const seedlingRows = computed(() => latest.value
  .filter((reading) => seedlingMetrics.includes(reading.metric))
  .map((reading) => ({ ...reading, label: metricLabel(reading.metric) })))
const seedlingCoverage = computed(() => {
  const reading = latest.value.find((item) => item.metric === 'canopyCoverage')
  return reading ? `${reading.value}%` : '—'
})
const seedlingCaption = computed(() => (latest.value.some((item) => item.metric === 'canopyCoverage') ? '遥感反演覆盖度' : '暂无遥感读数'))
const pendingPests = computed(() => pests.value.filter((item) => !item.handled))
const enabledRuleCount = computed(() => rules.value.filter((item) => item.enabled).length)

/** 苗情生育期档案 + 长势历史曲线：按选定地块回看，独立于全局指标筛选 */
const growthPlotCode = ref('')
const growthLoading = ref(false)
const growthStages = ref<GrowthStage[]>([])
const growthDialogVisible = ref(false)
const growthEditing = ref(false)
const growthSaving = ref(false)
const growthForm = reactive<{ id: string; plotCode: string; stage: string; plannedStart: string; plannedEnd: string; actualStart: string; actualEnd: string; note: string }>({ id: '', plotCode: '', stage: 'seedling', plannedStart: '', plannedEnd: '', actualStart: '', actualEnd: '', note: '' })
const seedlingMetric = ref('canopyCoverage')
const seedlingRange = ref<[string, string] | null>(null)
const seedlingHistoryLoaded = ref(false)
const seedlingTimes = ref<string[]>([])
const seedlingValues = ref<number[]>([])

/** 农场东八区日历日 ↔ ISO：节点按农场日零点存储，回显不受浏览器时区影响 */
function farmDateToIso(date: string): string {
  return new Date(`${date}T00:00:00+08:00`).toISOString()
}
function isoToFarmDate(iso?: string): string {
  if (!iso) return ''
  const time = new Date(iso).getTime()
  return Number.isNaN(time) ? '' : new Date(time + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 时间轴：按生育期顺序排列，标注计划/实际节点与提前滞后天数 */
const growthTimeline = computed(() => growthStages.value
  .slice()
  .sort((a, b) => growthStageOrder(a.stage) - growthStageOrder(b.stage))
  .map((stage) => {
    const status = stage.actualEndAt ? 'done' : stage.actualStartAt ? 'active' : 'pending'
    let deviation = ''
    if (stage.actualStartAt && stage.plannedStartAt) {
      const days = Math.round((new Date(stage.actualStartAt).getTime() - new Date(stage.plannedStartAt).getTime()) / 86400000)
      deviation = days > 0 ? `滞后 ${days} 天` : days < 0 ? `提前 ${-days} 天` : '按期'
    }
    return { ...stage, label: growthStageLabel(stage.stage), status, deviation }
  }))

const seedlingChartOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  legend: { data: [metricLabel(seedlingMetric.value)], bottom: 0 },
  grid: { left: '3%', right: '4%', bottom: '15%', containLabel: true },
  xAxis: { type: 'category', boundaryGap: false, data: seedlingTimes.value },
  yAxis: { type: 'value' },
  series: [{ name: metricLabel(seedlingMetric.value), type: 'line', smooth: true, data: seedlingValues.value }],
}))

/** 虫情统计/趋势与治理派单（开发方案 6.3） */
const pestStats = ref<PestStats | null>(null)
const pestTrend = ref<PestTrendPoint[]>([])
const pestTrendDays = ref(14)
const pestGovernVisible = ref(false)
const pestGovernSaving = ref(false)
const pestGovernForm = reactive<{ id: string; pestType: string; plotCode: string; status: Exclude<GovernanceStatus, 'pending'>; measure: string; pesticide: string; dosage: string; dispatchNote: string; governedBy: string; dispatch: boolean }>({ id: '', pestType: '', plotCode: '', status: 'planned', measure: '', pesticide: '', dosage: '', dispatchNote: '', governedBy: '', dispatch: false })

const pestTrendChartOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  legend: { data: ['识别数'], bottom: 0 },
  grid: { left: '3%', right: '4%', bottom: '15%', containLabel: true },
  xAxis: { type: 'category', data: pestTrend.value.map((point) => point.date.slice(5)) },
  yAxis: { type: 'value', minInterval: 1 },
  series: [{ name: '识别数', type: 'line', smooth: true, data: pestTrend.value.map((point) => point.count) }],
}))
const pestStatsEmpty = computed(() => !!pestStats.value && pestStats.value.total === 0)

function governanceText(status: GovernanceStatus): string {
  return status === 'dispatched' ? '已派单' : status === 'archived' ? '已归档' : status === 'planned' ? '已定方案' : '待处置'
}
function governanceTag(status: GovernanceStatus): 'success' | 'warning' | 'primary' | 'info' {
  return status === 'archived' ? 'success' : status === 'dispatched' ? 'warning' : status === 'planned' ? 'primary' : 'info'
}

/** 灾情档案（开发方案 6.4）：灾种/分级/状态目录与上报、处置弹窗 */
const disasterTypeOptions: Array<{ value: DisasterType; label: string }> = [
  { value: 'drought', label: '干旱' },
  { value: 'flood', label: '洪涝' },
  { value: 'frost', label: '低温冻害' },
  { value: 'wind', label: '大风倒伏' },
  { value: 'hail', label: '冰雹' },
  { value: 'pest', label: '病虫害' },
]
const disasterSeverityOptions: Array<{ value: DisasterSeverity; label: string }> = [
  { value: 1, label: '轻度' },
  { value: 2, label: '中度' },
  { value: 3, label: '重度' },
  { value: 4, label: '特别重大' },
]
const disasterStatusCatalog: Array<{ value: DisasterStatus; label: string }> = [
  { value: 'REPORTED', label: '已上报' },
  { value: 'ASSESSED', label: '已核查' },
  { value: 'HANDLED', label: '已处置' },
  { value: 'ARCHIVED', label: '已归档' },
]
const disasters = ref<DisasterRecord[]>([])
const disasterStats = ref<DisasterStats | null>(null)
const disasterLoading = ref(false)
const disasterStatusFilter = ref('')
const disasterReportVisible = ref(false)
const disasterSupplementVisible = ref(false)
const disasterSaving = ref(false)
const disasterReportForm = reactive<{ disasterType: DisasterType; severity: DisasterSeverity; occurredDate: string; plotCode: string; affectedAreaMu: number; suggestion: string; reportedBy: string; imageFileIds: string }>({ disasterType: 'drought', severity: 2, occurredDate: '', plotCode: '', affectedAreaMu: 0, suggestion: '', reportedBy: '', imageFileIds: '' })
const disasterSupplementForm = reactive<{ id: string; disasterType: DisasterType; plotCode: string; currentStatus: DisasterStatus; status: DisasterStatus; handledBy: string; suggestion: string; lossAssessment: string; affectedAreaMu: number }>({ id: '', disasterType: 'drought', plotCode: '', currentStatus: 'REPORTED', status: 'ASSESSED', handledBy: '', suggestion: '', lossAssessment: '', affectedAreaMu: 0 })

const disasterStatsEmpty = computed(() => !!disasterStats.value && disasterStats.value.total === 0)

function disasterTypeLabel(type: DisasterType): string {
  return disasterTypeOptions.find((item) => item.value === type)?.label ?? type
}
function disasterSeverityLabel(severity: DisasterSeverity): string {
  return disasterSeverityOptions.find((item) => item.value === severity)?.label ?? String(severity)
}
function disasterSeverityTag(severity: DisasterSeverity): 'info' | 'warning' | 'danger' {
  return severity >= 3 ? 'danger' : severity === 2 ? 'warning' : 'info'
}
function disasterStatusText(status: DisasterStatus): string {
  return disasterStatusCatalog.find((item) => item.value === status)?.label ?? status
}
function disasterStatusTag(status: DisasterStatus): 'info' | 'primary' | 'warning' | 'success' {
  return status === 'ARCHIVED' ? 'success' : status === 'HANDLED' ? 'warning' : status === 'ASSESSED' ? 'primary' : 'info'
}
/** 处置状态下拉只允许当前状态及之后的单向推进，禁止回退 */
function disasterStatusOptions(current: DisasterStatus): Array<{ value: DisasterStatus; label: string }> {
  const index = disasterStatusCatalog.findIndex((item) => item.value === current)
  return disasterStatusCatalog.slice(Math.max(0, index))
}

async function loadDisasters() {
  disasterLoading.value = true
  try {
    const [rows, stats] = await Promise.all([
      telemetryApi.getDisasters({
        ...(query.plotCode ? { plotCode: query.plotCode } : {}),
        ...(disasterStatusFilter.value ? { status: disasterStatusFilter.value } : {}),
      }),
      telemetryApi.getDisasterStats(query.plotCode ? { plotCode: query.plotCode } : {}),
    ])
    disasters.value = rows
    disasterStats.value = stats
  } catch {
    ElMessage.error('灾情档案加载失败')
  } finally {
    disasterLoading.value = false
  }
}

function openDisasterReport() {
  disasterReportForm.disasterType = 'drought'
  disasterReportForm.severity = 2
  disasterReportForm.occurredDate = ''
  disasterReportForm.plotCode = query.plotCode
  disasterReportForm.affectedAreaMu = 0
  disasterReportForm.suggestion = ''
  disasterReportForm.reportedBy = ''
  disasterReportForm.imageFileIds = ''
  disasterReportVisible.value = true
}

async function submitDisasterReport() {
  if (!disasterReportForm.occurredDate) {
    ElMessage.warning('请选择灾情发生日期')
    return
  }
  const ids = disasterReportForm.imageFileIds.split(',').map((item) => item.trim()).filter((item) => item !== '')
  disasterSaving.value = true
  try {
    await telemetryApi.createDisaster({
      disasterType: disasterReportForm.disasterType,
      plotCode: disasterReportForm.plotCode,
      severity: disasterReportForm.severity,
      affectedAreaMu: disasterReportForm.affectedAreaMu,
      occurredAt: farmDateToIso(disasterReportForm.occurredDate),
      suggestion: disasterReportForm.suggestion,
      reportedBy: disasterReportForm.reportedBy,
      ...(ids.length ? { imageFileIds: ids } : {}),
    })
    ElMessage.success('灾情已上报')
    disasterReportVisible.value = false
    await loadDisasters()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '灾情上报失败')
  } finally {
    disasterSaving.value = false
  }
}

function openDisasterSupplement(row: DisasterRecord) {
  disasterSupplementForm.id = row.id
  disasterSupplementForm.disasterType = row.disasterType
  disasterSupplementForm.plotCode = row.plotCode
  disasterSupplementForm.currentStatus = row.status
  // 默认推进到下一档，已归档不进入本弹窗
  disasterSupplementForm.status = disasterStatusOptions(row.status)[1]?.value ?? row.status
  disasterSupplementForm.handledBy = row.handledBy
  disasterSupplementForm.suggestion = row.suggestion
  disasterSupplementForm.lossAssessment = row.lossAssessment
  disasterSupplementForm.affectedAreaMu = row.affectedAreaMu
  disasterSupplementVisible.value = true
}

async function submitDisasterSupplement() {
  disasterSaving.value = true
  try {
    await telemetryApi.supplementDisaster(disasterSupplementForm.id, {
      status: disasterSupplementForm.status,
      handledBy: disasterSupplementForm.handledBy,
      suggestion: disasterSupplementForm.suggestion,
      lossAssessment: disasterSupplementForm.lossAssessment,
      affectedAreaMu: disasterSupplementForm.affectedAreaMu,
    })
    ElMessage.success('处置信息已更新')
    disasterSupplementVisible.value = false
    await loadDisasters()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '灾情处置失败')
  } finally {
    disasterSaving.value = false
  }
}

/** 虫情统计与趋势随查询条件（地块/虫害类型）联动刷新 */
async function loadPestAnalytics() {
  try {
    const [stats, trend] = await Promise.all([
      telemetryApi.getPestStats({
        ...(query.plotCode ? { plotCode: query.plotCode } : {}),
        ...(query.pestType ? { pestType: query.pestType } : {}),
      }),
      telemetryApi.getPestTrend({
        days: pestTrendDays.value,
        ...(query.plotCode ? { plotCode: query.plotCode } : {}),
        ...(query.pestType ? { pestType: query.pestType } : {}),
      }),
    ])
    pestStats.value = stats
    pestTrend.value = trend
  } catch {
    ElMessage.error('虫情统计加载失败')
  }
}

/** 打开治理弹窗：带入记录现状，派单勾选默认关闭 */
function openPestGovern(row: PestEvent) {
  pestGovernForm.id = row.id
  pestGovernForm.pestType = row.pestType
  pestGovernForm.plotCode = row.plotCode
  pestGovernForm.status = row.governanceStatus === 'pending' ? 'planned' : (row.governanceStatus as Exclude<GovernanceStatus, 'pending'>)
  pestGovernForm.measure = row.measure
  pestGovernForm.pesticide = row.pesticide
  pestGovernForm.dosage = row.dosage
  pestGovernForm.dispatchNote = row.dispatchNote
  pestGovernForm.governedBy = row.governedBy
  pestGovernForm.dispatch = false
  pestGovernVisible.value = true
}

/**
 * 提交治理：勾选派单时，前端先建植保喷防农事任务拿到 id，再回写虫情治理状态；
 * 遥测服务与农事服务保持解耦，派单编排只发生在前端，无人机实际出勤仍是线下依赖。
 */
async function submitPestGovern() {
  if (!pestGovernForm.measure.trim()) {
    ElMessage.warning('请填写治理措施')
    return
  }
  pestGovernSaving.value = true
  try {
    const base = {
      measure: pestGovernForm.measure,
      pesticide: pestGovernForm.pesticide,
      dosage: pestGovernForm.dosage,
      dispatchNote: pestGovernForm.dispatchNote,
      ...(pestGovernForm.governedBy ? { governedBy: pestGovernForm.governedBy } : {}),
    }
    if (pestGovernForm.dispatch) {
      const task = await operationApi.createTask({
        type: 'SPRAYING',
        name: `${pestGovernForm.pestType || '病虫害'}喷防作业`,
        plotCode: pestGovernForm.plotCode,
        ...(pestGovernForm.governedBy ? { assigneeName: pestGovernForm.governedBy } : {}),
      })
      await telemetryApi.governPest(pestGovernForm.id, { status: 'dispatched', ...base, taskId: task.id })
      ElMessage.success(`已派单并生成植保喷防任务（${task.name}）`)
    } else {
      await telemetryApi.governPest(pestGovernForm.id, { status: pestGovernForm.status, ...base })
      ElMessage.success('治理方案已登记')
    }
    pestGovernVisible.value = false
    await Promise.all([loadPests(), loadPestAnalytics()])
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '治理登记失败')
  } finally {
    pestGovernSaving.value = false
  }
}

const ruleForm = reactive<TelemetryRuleInput>({ metric: 'soilMoisture', plotCode: '', direction: 'below', threshold: 30, level: 'WARNING', message: '', enabled: true })
const ruleDialogVisible = ref(false)
const ruleEditing = ref(false)
const ruleSaving = ref(false)
const canWrite = computed(() => userStore.hasPermission('telemetry:write'))
const ruleUnit = computed(() => metricOptions.find((item) => item.value === ruleForm.metric)?.unit ?? '')
/** 地块下拉数据：规则弹窗按地块配置专属阈值 */
const plotOptions = ref<Array<{ parcelCode: string; parcelName: string }>>([])
const pestForm = reactive({ plotCode: '', deviceId: 'camera-001', pestType: '', level: 2 as 1 | 2 | 3, confidence: 0.9, imageFileId: '' })

function ruleLevelText(level: string): string {
  return level === 'CRITICAL' ? '告警' : level === 'INFO' ? '提示' : '预警'
}

function formatTime(value?: string): string {
  return value ? value.replace('T', ' ').slice(0, 19) : '—'
}

function pestLevelText(level: 1 | 2 | 3): string {
  return level === 3 ? '严重' : level === 2 ? '中等' : '轻微'
}

function pestLevelTag(level: 1 | 2 | 3): 'danger' | 'warning' | 'info' {
  return level === 3 ? 'danger' : level === 2 ? 'warning' : 'info'
}

function alertLevelTag(level: string): 'danger' | 'warning' | 'info' {
  return level === 'CRITICAL' ? 'danger' : level === 'WARNING' ? 'warning' : 'info'
}

async function loadOverview() {
  loading.value = true
  try {
    const overview = await telemetryApi.getOverview({
      ...(query.plotCode ? { plotCode: query.plotCode } : {}),
      ...(query.metric ? { metric: query.metric } : {}),
      ...(query.level ? { level: query.level as any } : {}),
      ...(query.pestType ? { pestType: query.pestType } : {})
    })
    latest.value = overview.latest
    alerts.value = overview.alerts
    pests.value = overview.pests
    rules.value = overview.rules
  } catch {
    ElMessage.error('四情数据加载失败')
  } finally {
    loading.value = false
  }
}

function applyFilter() {
  void loadOverview()
  if (activeTab.value === 'soil') void reloadSoil()
  if (activeTab.value === 'seedling') { growthPlotCode.value = query.plotCode || plotOptions.value[0]?.parcelCode || ''; void reloadSeedling() }
  if (activeTab.value === 'pest') { void loadPests(); void loadPestAnalytics() }
  if (activeTab.value === 'disaster') void loadDisasters()
}
function resetFilter() {
  query.plotCode = ''; query.metric = ''; query.level = ''; query.pestType = ''
  void loadOverview()
  if (activeTab.value === 'soil') void reloadSoil()
  if (activeTab.value === 'seedling') { growthPlotCode.value = plotOptions.value[0]?.parcelCode || ''; void reloadSeedling() }
  if (activeTab.value === 'pest') { void loadPests(); void loadPestAnalytics() }
  if (activeTab.value === 'disaster') void loadDisasters()
}

/** 切到土壤墒情/苗情页才拉对应数据，避免无谓请求 */
function onTabChange(name: string | number) {
  if (name === 'soil') void reloadSoil()
  if (name === 'seedling') void reloadSeedling()
  if (name === 'pest') void loadPestAnalytics()
  if (name === 'disaster') void loadDisasters()
}

async function reloadSoil() {
  await loadSoil()
  await loadSoilHistory()
}

async function loadSoil() {
  soilLoading.value = true
  try {
    const rows = await telemetryApi.getLatest({ ...(query.plotCode ? { plotCode: query.plotCode } : {}) })
    soilLatest.value = (rows as SoilReading[]).filter((row) => soilMetricValues.has(row.metric))
    // 历史深度默认落到第一个分层，未分层(-1)不作为默认
    const firstLayer = soilDepthColumns.value.find((column) => column.value >= 0)
    if (soilHistoryDepth.value === '' && firstLayer) soilHistoryDepth.value = firstLayer.value
  } catch {
    ElMessage.error('分层土壤读数加载失败')
  } finally {
    soilLoading.value = false
  }
}

async function loadSoilHistory() {
  try {
    const depth = soilHistoryDepth.value
    // 纯日期按农场东八区日历日转成 UTC 时刻，与遥测历史的时间窗比较口径一致
    const from = soilRange.value?.[0] ? new Date(`${soilRange.value[0]}T00:00:00+08:00`).toISOString() : undefined
    const to = soilRange.value?.[1] ? new Date(`${soilRange.value[1]}T23:59:59.999+08:00`).toISOString() : undefined
    const points = await telemetryApi.getHistorySeries('', soilMetric.value, {
      ...(query.plotCode ? { plotCode: query.plotCode } : {}),
      ...(typeof depth === 'number' && depth >= 0 ? { depthCm: depth } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      size: 500,
    })
    const first = points[0]
    const last = points[points.length - 1]
    const crossDay = !!first && !!last && formatDateTime(first.recordedAt, 'YYYY-MM-DD') !== formatDateTime(last.recordedAt, 'YYYY-MM-DD')
    soilTimes.value = points.map((point: TelemetryHistoryPoint) => formatDateTime(point.recordedAt, crossDay ? 'MM-DD HH:mm' : 'HH:mm:ss'))
    soilValues.value = points.map((point: TelemetryHistoryPoint) => point.value)
    soilHistoryLoaded.value = points.length > 0
  } catch {
    soilTimes.value = []
    soilValues.value = []
    soilHistoryLoaded.value = false
  }
}

/** 切到苗情页拉取选定地块的生育期档案与长势历史曲线 */
async function reloadSeedling() {
  await loadGrowth()
  await loadSeedlingHistory()
}

async function loadGrowth() {
  if (!growthPlotCode.value) { growthStages.value = []; return }
  growthLoading.value = true
  try {
    growthStages.value = await telemetryApi.getGrowthStages(growthPlotCode.value)
  } catch {
    ElMessage.error('生育期档案加载失败')
  } finally {
    growthLoading.value = false
  }
}

async function loadSeedlingHistory() {
  try {
    const from = seedlingRange.value?.[0] ? farmDateToIso(seedlingRange.value[0]) : undefined
    const to = seedlingRange.value?.[1] ? new Date(`${seedlingRange.value[1]}T23:59:59.999+08:00`).toISOString() : undefined
    const points = await telemetryApi.getHistorySeries('', seedlingMetric.value, {
      ...(growthPlotCode.value ? { plotCode: growthPlotCode.value } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      size: 500,
    })
    const first = points[0]
    const last = points[points.length - 1]
    const crossDay = !!first && !!last && formatDateTime(first.recordedAt, 'YYYY-MM-DD') !== formatDateTime(last.recordedAt, 'YYYY-MM-DD')
    seedlingTimes.value = points.map((point: TelemetryHistoryPoint) => formatDateTime(point.recordedAt, crossDay ? 'MM-DD HH:mm' : 'HH:mm:ss'))
    seedlingValues.value = points.map((point: TelemetryHistoryPoint) => point.value)
    seedlingHistoryLoaded.value = points.length > 0
  } catch {
    seedlingTimes.value = []
    seedlingValues.value = []
    seedlingHistoryLoaded.value = false
  }
}

function openGrowthCreate() {
  growthEditing.value = false
  growthForm.id = ''
  growthForm.plotCode = growthPlotCode.value
  growthForm.stage = 'seedling'
  growthForm.plannedStart = ''
  growthForm.plannedEnd = ''
  growthForm.actualStart = ''
  growthForm.actualEnd = ''
  growthForm.note = ''
  growthDialogVisible.value = true
}

function openGrowthEdit(stage: GrowthStage) {
  growthEditing.value = true
  growthForm.id = stage.id
  growthForm.plotCode = stage.plotCode
  growthForm.stage = stage.stage
  growthForm.plannedStart = isoToFarmDate(stage.plannedStartAt)
  growthForm.plannedEnd = isoToFarmDate(stage.plannedEndAt)
  growthForm.actualStart = isoToFarmDate(stage.actualStartAt)
  growthForm.actualEnd = isoToFarmDate(stage.actualEndAt)
  growthForm.note = stage.note
  growthDialogVisible.value = true
}

async function saveGrowth() {
  if (!growthForm.plotCode) { ElMessage.warning('请选择地块'); return }
  const payload: GrowthStageInput = {
    plotCode: growthForm.plotCode,
    stage: growthForm.stage,
    note: growthForm.note.trim(),
    ...(growthForm.plannedStart ? { plannedStartAt: farmDateToIso(growthForm.plannedStart) } : {}),
    ...(growthForm.plannedEnd ? { plannedEndAt: farmDateToIso(growthForm.plannedEnd) } : {}),
    ...(growthForm.actualStart ? { actualStartAt: farmDateToIso(growthForm.actualStart) } : {}),
    ...(growthForm.actualEnd ? { actualEndAt: farmDateToIso(growthForm.actualEnd) } : {}),
  }
  growthSaving.value = true
  try {
    await telemetryApi.saveGrowthStage(payload)
    ElMessage.success('生育期档案已保存')
    growthDialogVisible.value = false
    growthPlotCode.value = growthForm.plotCode
    await loadGrowth()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '生育期档案保存失败')
  } finally {
    growthSaving.value = false
  }
}

async function removeGrowth(stage: GrowthStage) {
  try {
    await ElMessageBox.confirm(`确认删除「${growthStageLabel(stage.stage)}」的生育期档案？`, '删除档案', { type: 'warning' })
  } catch {
    return
  }
  await telemetryApi.deleteGrowthStage(stage.id)
  ElMessage.success('生育期档案已删除')
  await loadGrowth()
}

/** 苗情长势异常联动虫情治理：切到虫情页并带上当前地块 */
function goPestGovernance() {
  if (growthPlotCode.value) query.plotCode = growthPlotCode.value
  activeTab.value = 'pest'
  void loadPests()
}

async function loadPests() {
  try {
    pests.value = await telemetryApi.getPests({
      ...(pestPendingOnly.value ? { pendingOnly: true } : {}),
      ...(query.pestType ? { pestType: query.pestType } : {}),
      ...(query.plotCode ? { plotCode: query.plotCode } : {})
    })
  } catch {
    ElMessage.error('虫情记录加载失败')
  }
}

async function handlePest(row: PestEvent) {
  await telemetryApi.handlePest(row.id)
  ElMessage.success('已标记处置')
  await loadPests()
}

async function handleAlert(row: TelemetryAlert) {
  await telemetryApi.handleAlert(row.id)
  ElMessage.success('告警已处理')
  await loadOverview()
}

async function submitPest() {
  if (!pestForm.pestType) {
    ElMessage.warning('请填写虫害类型')
    return
  }
  try {
    await telemetryApi.reportPest({
      plotCode: pestForm.plotCode,
      deviceId: pestForm.deviceId,
      pestType: pestForm.pestType,
      level: pestForm.level,
      confidence: pestForm.confidence,
      ...(pestForm.imageFileId ? { imageFileId: pestForm.imageFileId } : {}),
    })
    ElMessage.success('识别结果已登记并生成告警')
    pestDialogVisible.value = false
    pestForm.pestType = ''
    pestForm.imageFileId = ''
    await loadOverview()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '识别结果登记失败')
  }
}

function openRuleCreate() {
  ruleEditing.value = false
  // 规则按 (指标, 地块, 级别) 唯一，新建默认落到土壤湿度全局提示级，避开已有的全局预警/告警默认
  ruleForm.metric = 'soilMoisture'
  ruleForm.plotCode = ''
  ruleForm.direction = 'below'
  ruleForm.threshold = 30
  ruleForm.level = 'INFO'
  ruleForm.message = ''
  ruleForm.enabled = true
  ruleDialogVisible.value = true
}

function openRuleEdit(row: TelemetryRule) {
  ruleEditing.value = true
  ruleForm.metric = row.metric
  ruleForm.plotCode = row.plotCode
  ruleForm.direction = row.direction
  ruleForm.threshold = row.threshold
  ruleForm.level = row.level
  ruleForm.message = row.message
  ruleForm.enabled = row.enabled
  ruleDialogVisible.value = true
}

async function saveRule() {
  const plotCode = ruleForm.plotCode ?? ''
  if (!ruleEditing.value && rules.value.some((item) => item.metric === ruleForm.metric && item.plotCode === plotCode && item.level === ruleForm.level)) {
    ElMessage.warning('该指标在此地块上已有此级别的规则，请在列表里点「编辑」')
    return
  }
  ruleSaving.value = true
  try {
    await telemetryApi.saveRule({ ...ruleForm, plotCode, message: ruleForm.message.trim() })
    ElMessage.success('阈值规则已保存')
    ruleDialogVisible.value = false
    await loadOverview()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '规则保存失败')
  } finally {
    ruleSaving.value = false
  }
}

async function toggleRule(row: TelemetryRule, enabled: boolean) {
  await telemetryApi.saveRule({ metric: row.metric, plotCode: row.plotCode, direction: row.direction, threshold: row.threshold, level: row.level, message: row.message, enabled })
  row.enabled = enabled
}

async function removeRule(row: TelemetryRule) {
  const scope = row.plotCode ? `地块 ${row.plotCode}` : '全局'
  try {
    await ElMessageBox.confirm(`确认删除「${metricLabel(row.metric)}」在${scope}的「${ruleLevelText(row.level)}」级规则？`, '删除规则', { type: 'warning' })
  } catch {
    return
  }
  await telemetryApi.deleteRule(row.metric, row.plotCode, row.level)
  ElMessage.success('规则已删除')
  await loadOverview()
}

onMounted(async () => {
  await loadOverview()
  // 地块服务不可用时不影响四情展示，仅用于规则/生育期弹窗的地块下拉与默认地块
  try {
    const plots = await plotApi.getList({ page: 1, pageSize: 200 })
    plotOptions.value = plots.items.map((plot) => ({ parcelCode: plot.parcelCode, parcelName: plot.name }))
    if (plots.items[0]) pestForm.plotCode = plots.items[0].parcelCode
  } catch {
    // 忽略：地块编码为选填
  }
  // 苗情为默认页：优先用筛选地块，否则取下拉首个地块回看生育期与长势曲线
  growthPlotCode.value = query.plotCode || plotOptions.value[0]?.parcelCode || ''
  await reloadSeedling()
})
</script>

<style scoped lang="scss">
.summary-row { margin-bottom: 4px; }
.summary-card { display: flex; flex-direction: column; gap: 6px; padding: 16px 18px; background: #fff; border: 1px solid #e4e7ed; border-radius: 6px; }
.summary-card span { color: #606266; font-size: 13px; }
.summary-card strong { color: #303133; font-size: 26px; font-variant-numeric: tabular-nums; }
.summary-card small { color: #909399; font-size: 12px; }
.summary-card--pest strong { color: #e6a23c; }
.summary-card--alert strong { color: #f56c6c; }
.toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.agro-filter { margin-bottom: 4px; }
.rule-hint { margin-left: 12px; font-size: 12px; color: var(--el-text-color-secondary); }
.history-controls { display: flex; align-items: center; gap: 12px; }
.soil-history { margin-top: 20px; }
.growth-block { margin-top: 20px; }
.pest-stat-cards { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
.pest-stat { display: flex; flex-direction: column; gap: 4px; min-width: 96px; padding: 12px 16px; background: #fff; border: 1px solid #e4e7ed; border-radius: 6px; }
.pest-stat span { color: #606266; font-size: 13px; }
.pest-stat strong { color: #303133; font-size: 22px; font-variant-numeric: tabular-nums; }
.pest-stat-tables { display: flex; flex-wrap: wrap; gap: 16px; }
.pest-stat-tables .el-table { flex: 1; min-width: 240px; }
.growth-item { display: flex; flex-direction: column; gap: 4px; }
.growth-item__head { display: flex; align-items: center; gap: 8px; }
.growth-item__head strong { color: #303133; font-size: 15px; }
.growth-item__actions { margin-left: auto; }
.growth-item__meta { display: flex; gap: 20px; color: #606266; font-size: 13px; }
.growth-item__note { color: #909399; font-size: 12px; }
/* vue-echarts 根节点没有 intrinsic 高度，不给高度图表会塌成 0 像素 */
.chart { height: 320px; }
:deep(.el-tabs__header) { margin-bottom: 16px; }
</style>
