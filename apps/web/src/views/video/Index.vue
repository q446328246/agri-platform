<template>
  <div class="page-container">
    <div class="video-toolbar">
      <span class="video-title">视频监控</span>
      <el-tag v-if="total" type="info" size="small">{{ cameras.length }} / {{ total }} 台</el-tag>
      <span v-if="playableCount === 0 && cameras.length && activeTab === 'live'" class="video-hint">当前无在线摄像机</span>
      <div class="flex-spacer" />
      <el-tooltip content="刷新"><el-button circle size="small" @click="refreshActive"><el-icon><Refresh /></el-icon></el-button></el-tooltip>
    </div>

    <el-tabs v-model="activeTab" @tab-change="onTabChange">
      <el-tab-pane label="实时监看" name="live">
        <div class="search-bar">
          <el-form :inline="true" :model="query" @submit.prevent="search">
            <el-form-item label="关键词"><el-input v-model="query.keyword" placeholder="摄像机名称/编号" clearable style="width: 180px" /></el-form-item>
            <el-form-item label="地块编码"><el-input v-model="query.plotCode" placeholder="可选" clearable style="width: 170px" /></el-form-item>
            <el-form-item label="状态">
              <el-select v-model="query.status" placeholder="全部" clearable style="width: 110px">
                <el-option label="在线" value="ONLINE" />
                <el-option label="离线" value="OFFLINE" />
              </el-select>
            </el-form-item>
            <el-form-item><el-button type="primary" @click="search">查询</el-button><el-button @click="resetQuery">重置</el-button></el-form-item>
          </el-form>
        </div>

        <div class="split-toolbar">
          <span class="split-label">分屏</span>
          <el-radio-group v-model="splitCount" size="small">
            <el-radio-button :value="1">单画面</el-radio-button>
            <el-radio-button :value="2">2 分屏</el-radio-button>
            <el-radio-button :value="4">4 分屏</el-radio-button>
            <el-radio-button :value="9">9 分屏</el-radio-button>
          </el-radio-group>
          <span class="split-hint">切换分屏会重建播放器；每屏可独立换台、截图、云台与全屏</span>
        </div>

        <el-skeleton v-if="loading && !cameras.length" :rows="4" animated />
        <el-empty v-else-if="!cameras.length" description="暂无摄像机" />
        <div v-else class="split-grid" :class="`split-${splitCount}`">
          <div v-for="(cameraId, index) in slots" :key="index" class="split-cell">
            <div class="split-head">
              <el-select :model-value="cameraId" placeholder="分配摄像机" clearable size="small" class="split-select" @update:model-value="(value: any) => assignCamera(index, value)">
                <el-option v-for="camera in cameras" :key="camera.id" :label="camera.name" :value="camera.id" />
              </el-select>
              <el-tag v-if="slotCamera(index)" :type="slotCamera(index)!.status === 'ONLINE' ? 'success' : 'info'" size="small">
                {{ slotCamera(index)!.status === 'ONLINE' ? '在线' : '离线' }}
              </el-tag>
            </div>
            <div class="camera-screen split-screen" :ref="(el) => setScreenRef(`slot-${index}`, el)">
              <template v-if="slotCamera(index) && playable(slotCamera(index)!)">
                <video
                  :ref="(el) => setVideoRef(`slot-${index}`, el)"
                  class="camera-video"
                  :class="{ visible: playState[`slot-${index}`] === 'playing' }"
                  controls
                  muted
                  playsinline
                  preload="auto"
                  @playing="playState[`slot-${index}`] = 'playing'"
                  @error="onVideoError(`slot-${index}`, $event)"
                />
                <div v-if="playState[`slot-${index}`] === 'loading'" class="camera-placeholder">
                  <el-icon :size="32" class="is-loading"><Loading /></el-icon>
                  <span>视频加载中…</span>
                </div>
                <div v-else-if="playState[`slot-${index}`] === 'error'" class="camera-placeholder">
                  <el-icon :size="40"><CircleCloseFilled /></el-icon>
                  <span>视频加载失败，流不可用</span>
                  <el-button size="small" @click="retrySlot(index)"><el-icon><RefreshRight /></el-icon>重试</el-button>
                </div>
              </template>
              <div v-else class="camera-placeholder">
                <el-icon :size="32"><VideoCameraFilled /></el-icon>
                <span>{{ slotCamera(index) ? (slotCamera(index)!.streamUrl ? '设备离线' : '无流地址') : '未分配摄像机' }}</span>
              </div>
            </div>
            <div class="camera-actions split-actions">
              <el-button size="small" :disabled="!slotCamera(index)" @click="openPtz(slotCamera(index)!)">云台</el-button>
              <el-button size="small" :disabled="playState[`slot-${index}`] !== 'playing'" @click="screenshot(`slot-${index}`, slotCamera(index)?.name ?? `画面${index + 1}`)">截图</el-button>
              <el-button size="small" :disabled="!slotCamera(index) || !playable(slotCamera(index)!)" @click="fullscreen(`slot-${index}`)">全屏</el-button>
              <el-button size="small" :disabled="!slotCamera(index) || !playable(slotCamera(index)!)" @click="retrySlot(index)">刷新</el-button>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane label="录像回放" name="recordings">
        <div class="search-bar">
          <el-form :inline="true" @submit.prevent="loadRecordings">
            <el-form-item label="摄像机">
              <el-select v-model="recQuery.cameraId" placeholder="全部" clearable style="width: 200px">
                <el-option v-for="camera in cameras" :key="camera.id" :label="camera.name" :value="camera.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="开始日期">
              <el-date-picker v-model="recQuery.range" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="起" end-placeholder="止" style="width: 260px" />
            </el-form-item>
            <el-form-item><el-button type="primary" @click="recPage = 1; loadRecordings()">查询</el-button><el-button @click="resetRecQuery">重置</el-button></el-form-item>
          </el-form>
        </div>
        <el-table v-loading="recLoading" :data="recordings" stripe>
          <el-table-column label="摄像机" min-width="160"><template #default="{ row }">{{ cameraName(row.cameraId) }}</template></el-table-column>
          <el-table-column label="开始时间" min-width="160"><template #default="{ row }">{{ formatDateTime(row.startedAt) }}</template></el-table-column>
          <el-table-column label="结束时间" min-width="160"><template #default="{ row }">{{ formatDateTime(row.endedAt) }}</template></el-table-column>
          <el-table-column label="时长" width="90"><template #default="{ row }">{{ durationText(row) }}</template></el-table-column>
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="{ row }"><el-button size="small" type="primary" link @click="playRecording(row)">回放</el-button></template>
          </el-table-column>
          <template #empty><el-empty description="暂无录像" /></template>
        </el-table>
        <el-pagination class="pager" background layout="total, prev, pager, next" :total="recTotal" :page-size="recSize" v-model:current-page="recPage" @current-change="loadRecordings" />
      </el-tab-pane>

      <el-tab-pane label="录像留档" name="archives">
        <div class="search-bar">
          <el-form :inline="true" @submit.prevent="loadArchives">
            <el-form-item label="摄像机">
              <el-select v-model="arcQuery.cameraId" placeholder="全部" clearable style="width: 180px">
                <el-option v-for="camera in cameras" :key="camera.id" :label="camera.name" :value="camera.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="来源">
              <el-select v-model="arcQuery.source" placeholder="全部" clearable style="width: 120px">
                <el-option label="AI 识别" value="AI_EVENT" />
                <el-option label="告警联动" value="ALERT" />
                <el-option label="人工补登" value="MANUAL" />
              </el-select>
            </el-form-item>
            <el-form-item label="状态">
              <el-select v-model="arcQuery.status" placeholder="全部" clearable style="width: 120px">
                <el-option label="待切片" value="PENDING" />
                <el-option label="已留档" value="ARCHIVED" />
                <el-option label="切片失败" value="FAILED" />
              </el-select>
            </el-form-item>
            <el-form-item label="事件日期">
              <el-date-picker v-model="arcQuery.range" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="起" end-placeholder="止" style="width: 240px" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="arcPage = 1; loadArchives()">查询</el-button>
              <el-button @click="resetArcQuery">重置</el-button>
              <el-button type="success" plain @click="openArcDialog">人工补登留档</el-button>
            </el-form-item>
          </el-form>
        </div>
        <el-alert title="识别事件落库时自动登记告警时刻前后窗口的留档；片段本体由流媒体服务切片后回填，未接入时保持「待切片」，不伪造回放地址" type="info" :closable="false" show-icon class="mb-20" />
        <el-table v-loading="arcLoading" :data="archives" stripe>
          <el-table-column label="摄像机" min-width="150"><template #default="{ row }">{{ cameraName(row.cameraId) }}</template></el-table-column>
          <el-table-column label="来源" width="100">
            <template #default="{ row }">
              <el-tag :type="row.source === 'AI_EVENT' ? 'danger' : row.source === 'ALERT' ? 'warning' : 'info'" size="small">{{ ARCHIVE_SOURCE_LABELS[row.source] ?? row.source }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="事件时刻" min-width="160"><template #default="{ row }">{{ formatDateTime(row.eventAt) }}</template></el-table-column>
          <el-table-column label="片段窗口" min-width="250">
            <template #default="{ row }">{{ formatDateTime(row.startedAt) }} ~ {{ formatDateTime(row.endedAt) }}（前 {{ row.preSeconds }}s / 后 {{ row.postSeconds }}s）</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tooltip :content="row.message || row.note || '—'" placement="top">
                <el-tag :type="row.status === 'ARCHIVED' ? 'success' : row.status === 'FAILED' ? 'danger' : 'warning'" size="small">{{ ARCHIVE_STATUS_LABELS[row.status] ?? row.status }}</el-tag>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column prop="note" label="备注" min-width="140" show-overflow-tooltip />
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }">
              <el-button size="small" type="primary" link :disabled="!row.playbackUrl" @click="playArchive(row)">回放</el-button>
            </template>
          </el-table-column>
          <template #empty><el-empty description="暂无留档记录" /></template>
        </el-table>
        <el-pagination class="pager" background layout="total, prev, pager, next" :total="arcTotal" :page-size="arcSize" v-model:current-page="arcPage" @current-change="loadArchives" />
      </el-tab-pane>

      <el-tab-pane label="AI 识别事件" name="ai">
        <div class="search-bar">
          <el-form :inline="true" @submit.prevent="loadAiEvents">
            <el-form-item label="地块编码"><el-input v-model="aiQuery.plotCode" placeholder="可选" clearable style="width: 180px" /></el-form-item>
            <el-form-item label="事件类型">
              <el-select v-model="aiQuery.eventType" placeholder="全部" clearable style="width: 140px">
                <el-option v-for="opt in aiTypeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
              </el-select>
            </el-form-item>
            <el-form-item label="转发状态">
              <el-select v-model="aiQuery.forwarded" placeholder="全部" clearable style="width: 130px">
                <el-option label="已转发" value="true" />
                <el-option label="待补投" value="false" />
              </el-select>
            </el-form-item>
            <el-form-item><el-button type="primary" @click="aiPage = 1; loadAiEvents()">查询</el-button><el-button @click="resetAiQuery">重置</el-button></el-form-item>
          </el-form>
        </div>
        <el-table v-loading="aiLoading" :data="aiEvents" stripe>
          <el-table-column label="摄像机" min-width="150"><template #default="{ row }">{{ cameraName(row.cameraId) }}</template></el-table-column>
          <el-table-column prop="plotCode" label="地块" min-width="180" show-overflow-tooltip />
          <el-table-column label="事件类型" width="110">
            <template #default="{ row }">{{ aiTypeLabel(row.eventType) }}</template>
          </el-table-column>
          <el-table-column label="虫害类型" width="110">
            <template #default="{ row }">{{ (row.eventType ?? 'PEST') === 'PEST' ? row.pestType : '—' }}</template>
          </el-table-column>
          <el-table-column label="等级" width="80">
            <template #default="{ row }">
              <el-tag :type="row.level === 3 ? 'danger' : row.level === 2 ? 'warning' : 'info'" size="small">{{ ['', '轻微', '中等', '严重'][row.level] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="置信度" width="80"><template #default="{ row }">{{ Math.round(row.confidence * 100) }}%</template></el-table-column>
          <el-table-column label="识别时间" min-width="160"><template #default="{ row }">{{ formatDateTime(row.detectedAt) }}</template></el-table-column>
          <el-table-column label="转发状态" min-width="150">
            <template #default="{ row }">
              <el-tag v-if="row.forwarded" type="success" size="small">已转发</el-tag>
              <el-tooltip v-else :content="row.lastError || row.forwardMessage || '等待自动补投'" placement="top">
                <el-tag type="warning" size="small">待补投（已试 {{ row.retryCount }} 次）</el-tag>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }">
              <el-button v-if="!row.forwarded" size="small" type="primary" link :loading="retryingId === row.id" @click="retryAiEvent(row)">重试</el-button>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <template #empty><el-empty description="暂无识别事件" /></template>
        </el-table>
        <el-pagination class="pager" background layout="total, prev, pager, next" :total="aiTotal" :page-size="aiSize" v-model:current-page="aiPage" @current-change="loadAiEvents" />
      </el-tab-pane>

      <el-tab-pane label="云台指令历史" name="ptz">
        <div class="search-bar">
          <el-form :inline="true" @submit.prevent="loadPtzCommands">
            <el-form-item label="摄像机">
              <el-select v-model="ptzFilterCameraId" placeholder="全部" clearable style="width: 200px">
                <el-option v-for="camera in cameras" :key="camera.id" :label="camera.name" :value="camera.id" />
              </el-select>
            </el-form-item>
            <el-form-item><el-button type="primary" @click="ptzPage = 1; loadPtzCommands()">查询</el-button><el-button @click="ptzFilterCameraId = ''; ptzPage = 1; loadPtzCommands()">重置</el-button></el-form-item>
          </el-form>
        </div>
        <el-table v-loading="ptzLoading" :data="ptzCommands" stripe>
          <el-table-column label="摄像机" min-width="150"><template #default="{ row }">{{ cameraName(row.cameraId) }}</template></el-table-column>
          <el-table-column label="动作" width="90"><template #default="{ row }">{{ PTZ_LABELS[row.action] ?? row.action }}</template></el-table-column>
          <el-table-column label="速度" width="70"><template #default="{ row }">{{ row.speed ?? '—' }}</template></el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.status === 'SENT' ? 'success' : row.status === 'FAILED' ? 'danger' : 'warning'" size="small">{{ PTZ_STATUS_LABELS[row.status] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="message" label="回执说明" min-width="220" show-overflow-tooltip />
          <el-table-column label="下发时间" min-width="160"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }">
              <el-button v-if="row.status !== 'SENT'" size="small" type="primary" link :loading="retryingId === row.id" @click="retryPtzCommand(row)">重试</el-button>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <template #empty><el-empty description="暂无云台指令" /></template>
        </el-table>
        <el-pagination class="pager" background layout="total, prev, pager, next" :total="ptzTotal" :page-size="ptzSize" v-model:current-page="ptzPage" @current-change="loadPtzCommands" />
      </el-tab-pane>

      <el-tab-pane label="摄像头管理" name="cameras">
        <div class="search-bar">
          <el-form :inline="true" @submit.prevent="cameraPage = 1; loadCameras()">
            <el-form-item label="关键词"><el-input v-model="cameraQuery.keyword" placeholder="摄像机名称" clearable style="width: 180px" /></el-form-item>
            <el-form-item label="地块编码"><el-input v-model="cameraQuery.plotCode" placeholder="可选" clearable style="width: 170px" /></el-form-item>
            <el-form-item label="状态">
              <el-select v-model="cameraQuery.status" placeholder="全部" clearable style="width: 110px">
                <el-option label="在线" value="ONLINE" />
                <el-option label="离线" value="OFFLINE" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="cameraPage = 1; loadCameras()">查询</el-button>
              <el-button @click="resetCameraQuery">重置</el-button>
              <el-button type="success" plain @click="openCameraDialog()">添加摄像头</el-button>
            </el-form-item>
          </el-form>
        </div>
        <el-table v-loading="cameraLoading" :data="cameraList" stripe>
          <el-table-column prop="name" label="名称" min-width="180" />
          <el-table-column label="地块" min-width="180">
            <template #default="{ row }">{{ row.plotCode || '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.status === 'ONLINE' ? 'success' : 'info'" size="small">{{ row.status === 'ONLINE' ? '在线' : '离线' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="streamUrl" label="流地址" min-width="260" show-overflow-tooltip />
          <el-table-column label="操作" width="140" fixed="right">
            <template #default="{ row }">
              <el-button size="small" type="primary" link @click="openCameraDialog(row)">编辑</el-button>
              <el-button size="small" type="danger" link @click="removeCamera(row)">删除</el-button>
            </template>
          </el-table-column>
          <template #empty><el-empty description="暂无摄像机" /></template>
        </el-table>
        <el-pagination class="pager" background layout="total, prev, pager, next" :total="cameraTotal" :page-size="cameraSize" v-model:current-page="cameraPage" @current-change="loadCameras" />
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="ptzDialogVisible" :title="`云台控制 · ${ptzCamera?.name ?? ''}`" width="600px">
      <div class="ptz-panel">
        <div class="ptz-pad">
          <span /><el-button :disabled="!ptzCameraOnline" @click="ptzAction('UP')"><el-icon><Top /></el-icon>上仰</el-button><span />
          <el-button :disabled="!ptzCameraOnline" @click="ptzAction('LEFT')"><el-icon><Back /></el-icon>左转</el-button>
          <el-button :disabled="!ptzCameraOnline" type="danger" plain @click="ptzAction('STOP')"><el-icon><VideoPause /></el-icon>停止</el-button>
          <el-button :disabled="!ptzCameraOnline" @click="ptzAction('RIGHT')">右转<el-icon><Right /></el-icon></el-button>
          <span /><el-button :disabled="!ptzCameraOnline" @click="ptzAction('DOWN')"><el-icon><Bottom /></el-icon>下俯</el-button><span />
        </div>
        <div class="ptz-side">
          <div class="ptz-zoom">
            <el-button :disabled="!ptzCameraOnline" @click="ptzAction('ZOOM_IN')"><el-icon><ZoomIn /></el-icon>放大</el-button>
            <el-button :disabled="!ptzCameraOnline" @click="ptzAction('ZOOM_OUT')"><el-icon><ZoomOut /></el-icon>缩小</el-button>
          </div>
          <div class="ptz-speed">
            <span>速度</span>
            <el-input-number v-model="ptzSpeed" :min="1" :max="10" size="small" />
          </div>
          <p class="ptz-note">指令先留存台账，再经摄像机网关下发；未接入网关时保持「已排队」，接入后可重试。</p>
        </div>
      </div>
      <el-divider content-position="left">最近指令</el-divider>
      <el-table v-loading="ptzDialogLoading" :data="ptzDialogCommands" size="small" max-height="220">
        <el-table-column label="动作" width="80"><template #default="{ row }">{{ PTZ_LABELS[row.action] ?? row.action }}</template></el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.status === 'SENT' ? 'success' : row.status === 'FAILED' ? 'danger' : 'warning'" size="small">{{ PTZ_STATUS_LABELS[row.status] }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="message" label="回执" min-width="180" show-overflow-tooltip />
        <el-table-column label="时间" width="150"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
        <el-table-column label="操作" width="70">
          <template #default="{ row }">
            <el-button v-if="row.status !== 'SENT'" size="small" type="primary" link :loading="retryingId === row.id" @click="retryPtzCommand(row, true)">重试</el-button>
          </template>
        </el-table-column>
        <template #empty><el-empty description="暂无指令" :image-size="60" /></template>
      </el-table>
    </el-dialog>

    <el-dialog v-model="cameraDialogVisible" :title="cameraForm.id ? '编辑摄像头' : '添加摄像头'" width="560px">
      <el-form label-width="90px">
        <el-form-item label="名称" required>
          <el-input v-model="cameraForm.name" placeholder="如 东区一号田摄像头" maxlength="40" />
        </el-form-item>
        <el-form-item label="所属地块">
          <el-select v-model="cameraForm.plotCode" placeholder="未绑定地块" clearable filterable style="width: 100%">
            <el-option v-for="plot in plotOptions" :key="plot.parcelCode" :label="`${plot.parcelName}（${plot.parcelCode}）`" :value="plot.parcelCode" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态" required>
          <el-radio-group v-model="cameraForm.status">
            <el-radio value="ONLINE">在线</el-radio>
            <el-radio value="OFFLINE">离线</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="流地址">
          <el-input v-model="cameraForm.streamUrl" placeholder="HLS m3u8 或 mp4 地址" />
          <span class="nav-unit">平台只存地址、不保证能拉到流；不可用时监看页如实提示，不伪造画面</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cameraDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="cameraSaving" @click="submitCamera">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="arcDialogVisible" title="人工补登录像留档" width="520px">
      <el-form label-width="110px">
        <el-form-item label="摄像机" required>
          <el-select v-model="arcForm.cameraId" placeholder="选择摄像机" style="width: 100%">
            <el-option v-for="camera in cameras" :key="camera.id" :label="camera.name" :value="camera.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="事件时刻" required>
          <el-date-picker v-model="arcForm.eventAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" placeholder="告警/异常发生时刻" style="width: 100%" />
        </el-form-item>
        <el-form-item label="前置窗口">
          <el-input-number v-model="arcForm.preSeconds" :min="0" :max="600" :step="10" />
          <span class="nav-unit">秒（事件时刻之前）</span>
        </el-form-item>
        <el-form-item label="后置窗口">
          <el-input-number v-model="arcForm.postSeconds" :min="0" :max="600" :step="10" />
          <span class="nav-unit">秒（事件时刻之后）</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="arcForm.note" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="可选：补登原因与现场情况" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="arcDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="arcSaving" @click="submitArchive">登记留档</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="recordingDialogVisible" :title="`录像回放 · ${recordingPlaying ? cameraName(recordingPlaying.cameraId) : ''}`" width="820px" destroy-on-close @closed="stopRecordingPlayback">
      <div v-if="recordingPlaying" class="recording-meta">
        {{ formatDateTime(recordingPlaying.startedAt) }} 至 {{ formatDateTime(recordingPlaying.endedAt) }}（{{ durationText(recordingPlaying) }}）
      </div>
      <div class="camera-screen recording-screen">
        <video
          :ref="(el) => setVideoRef('recording', el)"
          class="camera-video"
          :class="{ visible: playState['recording'] === 'playing' }"
          controls
          muted
          playsinline
          preload="auto"
          @playing="playState['recording'] = 'playing'"
          @error="onVideoError('recording', $event)"
        />
        <div v-if="playState['recording'] === 'loading'" class="camera-placeholder">
          <el-icon :size="32" class="is-loading"><Loading /></el-icon>
          <span>录像加载中…</span>
        </div>
        <div v-else-if="playState['recording'] === 'error'" class="camera-placeholder">
          <el-icon :size="40"><CircleCloseFilled /></el-icon>
          <span>录像加载失败，回放地址不可用</span>
          <el-button size="small" @click="retryRecording"><el-icon><RefreshRight /></el-icon>重试</el-button>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { plotApi, videoApi } from '@/api'
import { formatDateTime } from '@/utils'
import type { AiEventType, ArchiveSource, ArchiveStatus, Camera, PtzAction, PtzCommand, Recording, RecordingArchive, VideoAiEvent } from '@/types'

/** 播放状态：加载中、播放中、加载失败、未开始 */
type PlayState = 'loading' | 'playing' | 'error' | 'idle'
type TabName = 'live' | 'recordings' | 'archives' | 'ai' | 'ptz'

const PTZ_LABELS: Record<string, string> = { LEFT: '左转', RIGHT: '右转', UP: '上仰', DOWN: '下俯', ZOOM_IN: '放大', ZOOM_OUT: '缩小', STOP: '停止' }
const PTZ_STATUS_LABELS: Record<string, string> = { QUEUED: '已排队', SENT: '已下发', FAILED: '失败' }

const activeTab = ref<TabName>('live')
const loading = ref(false)
const cameras = ref<Camera[]>([])
const total = ref(0)
const query = reactive<{ keyword: string; plotCode: string; status: string }>({ keyword: '', plotCode: '', status: '' })
const playableCount = computed(() => cameras.value.filter((camera) => playable(camera)).length)
const playState = reactive<Record<string, PlayState>>({})
const videoEls = new Map<string, HTMLVideoElement>()
const screenEls = new Map<string, HTMLElement>()
const engines = new Map<string, () => void>()
const retryingId = ref('')

function setVideoRef(key: string, el: unknown) {
  if (el instanceof HTMLVideoElement) videoEls.set(key, el)
  else videoEls.delete(key)
}

function setScreenRef(cameraId: string, el: unknown) {
  if (el instanceof HTMLElement) screenEls.set(cameraId, el)
  else screenEls.delete(cameraId)
}

/** 摄像机是否应展示播放器：必须有流地址且在线 */
const playable = (camera: Camera) => Boolean(camera.streamUrl) && camera.status === 'ONLINE'
const cameraName = (cameraId: string) => cameras.value.find((camera) => camera.id === cameraId)?.name ?? cameraId

// —— 分屏监看（A13）：1/2/4/9 画面，每屏独立换台/截图/云台/全屏 ——
const splitCount = ref<1 | 2 | 4 | 9>(4)
const slots = ref<Array<string | null>>([])
const slotKey = (index: number) => `slot-${index}`
const slotCamera = (index: number): Camera | null => cameras.value.find((camera) => camera.id === slots.value[index]) ?? null

/** 销毁现有分屏播放器：切换分屏先释放引擎与引用，不泄漏播放器实例 */
function teardownSlots() {
  for (let index = 0; index < slots.value.length; index += 1) {
    destroyEngine(slotKey(index))
    videoEls.delete(slotKey(index))
    screenEls.delete(slotKey(index))
    delete playState[slotKey(index)]
  }
}

/** 按分屏数重建：在线摄像机优先自动分配到各屏，再逐屏拉流 */
async function applyLayout() {
  teardownSlots()
  const ordered = [...cameras.value].sort((a, b) => Number(playable(b)) - Number(playable(a)))
  slots.value = Array.from({ length: splitCount.value }, (_, index) => ordered[index]?.id ?? null)
  await nextTick()
  for (let index = 0; index < slots.value.length; index += 1) {
    const camera = slotCamera(index)
    if (camera && playable(camera)) {
      playState[slotKey(index)] = 'loading'
      void playStream(slotKey(index), camera.streamUrl)
    }
  }
}

watch(splitCount, () => void applyLayout())

/** 单屏换台：先销毁旧引擎再挂新源，空选即回收该屏 */
async function assignCamera(index: number, cameraId: string | null) {
  destroyEngine(slotKey(index))
  videoEls.delete(slotKey(index))
  delete playState[slotKey(index)]
  slots.value[index] = cameraId || null
  await nextTick()
  const camera = slotCamera(index)
  if (camera && playable(camera)) {
    playState[slotKey(index)] = 'loading'
    void playStream(slotKey(index), camera.streamUrl)
  }
}

function retrySlot(index: number) {
  const camera = slotCamera(index)
  if (camera) void playStream(slotKey(index), camera.streamUrl)
}

/** 原生视频源兜底：HLS 用 canPlayType 探测，FLV/未知协议直接判为不支持。 */
function useNativeSource(video: HTMLVideoElement, url: string): boolean {
  const protocol = url.split('?')[0]?.split('.').pop()?.toLowerCase()
  const canPlay = (type: string) => video.canPlayType(type) !== ''
  if (protocol === 'mp4' && canPlay('video/mp4')) video.src = url
  else if (protocol === 'webm' && canPlay('video/webm')) video.src = url
  else if (protocol === 'm3u8' && canPlay('application/vnd.apple.mpegurl')) video.src = url
  else return false
  return true
}

/** 按需加载 hls.js（可选依赖），失败时返回 null，由原生播放或错误占位兜底。 */
async function loadHls(): Promise<any | null> {
  try {
    const module = await import('hls.js')
    return module.default
  } catch {
    return null
  }
}

/** 挂载播放：优先 HLS.js 拉流，不支持时回退到原生 video，都不可用则提示失败。 */
async function playStream(key: string, url: string) {
  const video = videoEls.get(key)
  if (!video || !url) return
  destroyEngine(key)
  playState[key] = 'loading'
  if (useNativeSource(video, url)) {
    void video.play().catch(() => undefined)
    return
  }
  const Hls = await loadHls()
  if (!Hls || !Hls.isSupported?.()) {
    playState[key] = 'error'
    return
  }
  const hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 30 })
  const release = () => {
    hls.destroy()
    engines.delete(key)
  }
  engines.set(key, release)
  hls.on(Hls.Events.MANIFEST_PARSED, () => void video.play().catch(() => undefined))
  hls.on(Hls.Events.ERROR, (_event: unknown, data: { fatal?: boolean }) => {
    if (!data?.fatal) return
    release()
    playState[key] = 'error'
  })
  hls.loadSource(url)
  hls.attachMedia(video)
}

function destroyEngine(key: string) {
  engines.get(key)?.()
  engines.delete(key)
}

/** 切换/销毁播放器会清空 src 并触发一次空错误，只有真的带错误码的媒体故障才算拉流失败 */
function onVideoError(key: string, event: Event) {
  const video = event.target as HTMLVideoElement
  if (!video.error || !video.currentSrc) return
  playState[key] = 'error'
}

async function load() {
  loading.value = true
  try {
    const res = await videoApi.getCameras({
      page: 1,
      size: 100,
      ...(query.keyword ? { keyword: query.keyword } : {}),
      ...(query.plotCode ? { plotCode: query.plotCode } : {}),
      ...(query.status ? { status: query.status } : {})
    })
    cameras.value = res.items ?? []
    total.value = res.total
    await applyLayout()
  } catch {
    cameras.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function search() { void load() }
function resetQuery() { query.keyword = ''; query.plotCode = ''; query.status = ''; void load() }

/** 全屏：直接放大画面容器，退出由浏览器 Esc 处理 */
function fullscreen(key: string) {
  const el = screenEls.get(key)
  if (!el?.requestFullscreen) { ElMessage.warning('当前浏览器不支持全屏'); return }
  el.requestFullscreen().catch(() => ElMessage.warning('全屏被浏览器拒绝'))
}

/** 截图：抓取当前视频帧导出 PNG；跨域流未开 CORS 时画布被污染，如实报错而不是导出黑图 */
function screenshot(key: string, name: string) {
  const video = videoEls.get(key)
  if (!video || playState[key] !== 'playing' || !video.videoWidth) { ElMessage.warning('请等待视频播放后再截图'); return }
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) { ElMessage.error('当前浏览器不支持截图'); return }
  ctx.drawImage(video, 0, 0)
  try {
    canvas.toBlob((blob) => {
      if (!blob) { ElMessage.error('截图失败'); return }
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
      link.click()
      URL.revokeObjectURL(link.href)
      ElMessage.success('截图已保存')
    }, 'image/png')
  } catch {
    ElMessage.error('视频流存在跨域限制，无法截图（需流媒体侧开启 CORS）')
  }
}

// —— 云台控制 ——
const ptzDialogVisible = ref(false)
const ptzCamera = ref<Camera | null>(null)
const ptzSpeed = ref(5)
const ptzDialogCommands = ref<PtzCommand[]>([])
const ptzDialogLoading = ref(false)
const ptzCameraOnline = computed(() => Boolean(ptzCamera.value && playable(ptzCamera.value)))

function openPtz(camera: Camera) {
  ptzCamera.value = camera
  ptzDialogVisible.value = true
  void loadPtzDialogCommands()
}

async function loadPtzDialogCommands() {
  if (!ptzCamera.value) return
  ptzDialogLoading.value = true
  try {
    const res = await videoApi.getPtzCommands({ page: 1, size: 5, cameraId: ptzCamera.value.id })
    ptzDialogCommands.value = res.items ?? []
  } catch {
    ptzDialogCommands.value = []
  } finally {
    ptzDialogLoading.value = false
  }
}

/** 按后端真实回执提示：已下发/失败/通道未接入排队，不假装成功 */
function reportPtzResult(command: PtzCommand) {
  const text = command.message || PTZ_STATUS_LABELS[command.status]
  if (command.status === 'SENT') ElMessage.success(text)
  else if (command.status === 'FAILED') ElMessage.error(text)
  else ElMessage.warning(text)
}

async function ptzAction(action: PtzAction) {
  if (!ptzCamera.value) return
  try {
    const command = await videoApi.sendPtz(ptzCamera.value.id, { action, speed: ptzSpeed.value })
    reportPtzResult(command)
    void loadPtzDialogCommands()
  } catch {
    ElMessage.error('云台指令下发失败')
  }
}

async function retryPtzCommand(command: PtzCommand, inDialog = false) {
  retryingId.value = command.id
  try {
    const updated = await videoApi.retryPtz(command.id)
    reportPtzResult(updated)
    if (inDialog) void loadPtzDialogCommands()
    else void loadPtzCommands()
  } catch {
    ElMessage.error('云台指令重试失败')
  } finally {
    retryingId.value = ''
  }
}

// —— 录像回放 ——
const recQuery = reactive<{ cameraId: string; range: string[] }>({ cameraId: '', range: [] })
const recordings = ref<Recording[]>([])
const recLoading = ref(false)
const recPage = ref(1)
const recSize = 10
const recTotal = ref(0)
const recordingDialogVisible = ref(false)
const recordingPlaying = ref<Recording | null>(null)

async function loadRecordings() {
  recLoading.value = true
  try {
    const res = await videoApi.getRecordings({
      page: recPage.value,
      size: recSize,
      ...(recQuery.cameraId ? { cameraId: recQuery.cameraId } : {}),
      ...(recQuery.range?.[0] ? { from: recQuery.range[0] } : {}),
      ...(recQuery.range?.[1] ? { to: recQuery.range[1] } : {})
    })
    recordings.value = res.items ?? []
    recTotal.value = res.total
  } catch {
    recordings.value = []
    recTotal.value = 0
  } finally {
    recLoading.value = false
  }
}

function resetRecQuery() { recQuery.cameraId = ''; recQuery.range = []; recPage.value = 1; void loadRecordings() }

function durationText(recording: Recording): string {
  const minutes = Math.max(0, Math.round((Date.parse(recording.endedAt) - Date.parse(recording.startedAt)) / 60000))
  return `${minutes} 分钟`
}

async function playRecording(recording: Recording) {
  recordingPlaying.value = recording
  recordingDialogVisible.value = true
  playState['recording'] = 'loading'
  await nextTick()
  void playStream('recording', recording.playbackUrl)
}

function retryRecording() {
  if (recordingPlaying.value) void playStream('recording', recordingPlaying.value.playbackUrl)
}

function stopRecordingPlayback() {
  destroyEngine('recording')
  videoEls.delete('recording')
  playState['recording'] = 'idle'
  recordingPlaying.value = null
}

// —— 录像留档（A13）：告警时刻前后窗口的片段档案，切片本体依赖流媒体服务 ——
const ARCHIVE_SOURCE_LABELS: Record<string, string> = { AI_EVENT: 'AI 识别', ALERT: '告警联动', MANUAL: '人工补登' }
const ARCHIVE_STATUS_LABELS: Record<string, string> = { PENDING: '待切片', ARCHIVED: '已留档', FAILED: '切片失败' }
const arcQuery = reactive<{ cameraId: string; source: string; status: string; range: string[] }>({ cameraId: '', source: '', status: '', range: [] })
const archives = ref<RecordingArchive[]>([])
const arcLoading = ref(false)
const arcPage = ref(1)
const arcSize = 10
const arcTotal = ref(0)
const arcDialogVisible = ref(false)
const arcSaving = ref(false)
const arcForm = reactive<{ cameraId: string; eventAt: string; preSeconds: number; postSeconds: number; note: string }>({ cameraId: '', eventAt: '', preSeconds: 30, postSeconds: 60, note: '' })

async function loadArchives() {
  arcLoading.value = true
  try {
    const res = await videoApi.getRecordingArchives({
      page: arcPage.value,
      size: arcSize,
      ...(arcQuery.cameraId ? { cameraId: arcQuery.cameraId } : {}),
      ...(arcQuery.source ? { source: arcQuery.source as ArchiveSource } : {}),
      ...(arcQuery.status ? { status: arcQuery.status as ArchiveStatus } : {}),
      ...(arcQuery.range?.[0] ? { from: arcQuery.range[0] } : {}),
      ...(arcQuery.range?.[1] ? { to: arcQuery.range[1] } : {})
    })
    archives.value = res.items ?? []
    arcTotal.value = res.total
  } catch {
    archives.value = []
    arcTotal.value = 0
  } finally {
    arcLoading.value = false
  }
}

function resetArcQuery() { arcQuery.cameraId = ''; arcQuery.source = ''; arcQuery.status = ''; arcQuery.range = []; arcPage.value = 1; void loadArchives() }

function openArcDialog() {
  arcForm.cameraId = cameras.value[0]?.id ?? ''
  arcForm.eventAt = formatDateTime(new Date().toISOString())
  arcForm.preSeconds = 30
  arcForm.postSeconds = 60
  arcForm.note = ''
  arcDialogVisible.value = true
}

async function submitArchive() {
  if (!arcForm.cameraId) { ElMessage.warning('请选择摄像机'); return }
  if (!arcForm.eventAt) { ElMessage.warning('请选择事件时刻'); return }
  arcSaving.value = true
  try {
    await videoApi.createRecordingArchive({
      cameraId: arcForm.cameraId,
      eventAt: new Date(arcForm.eventAt).toISOString(),
      preSeconds: arcForm.preSeconds,
      postSeconds: arcForm.postSeconds,
      ...(arcForm.note.trim() ? { note: arcForm.note.trim() } : {})
    })
    ElMessage.success('留档已登记，片段待流媒体服务切片后回填')
    arcDialogVisible.value = false
    void loadArchives()
  } catch {
    // 错误提示由请求层统一弹出
  } finally {
    arcSaving.value = false
  }
}

/** 留档回放复用录像回放对话框：窗口起止与片段地址同构 */
function playArchive(row: RecordingArchive) {
  if (!row.playbackUrl) { ElMessage.warning('片段尚未回填回放地址'); return }
  void playRecording({ id: row.id, cameraId: row.cameraId, startedAt: row.startedAt, endedAt: row.endedAt, playbackUrl: row.playbackUrl })
}

// —— AI 识别事件 ——
/** 事件类型白名单（迁移 048），与 contracts AiEventType 七码同步；存量记录无 eventType 视为虫情 */
const aiTypeOptions: Array<{ value: AiEventType; label: string }> = [
  { value: 'PEST', label: '虫情' },
  { value: 'PERSON_INTRUSION', label: '人员闯入' },
  { value: 'MACHINE_STATUS', label: '农机状态' },
  { value: 'FLOOD', label: '涝情' },
  { value: 'LODGING', label: '倒伏' },
  { value: 'FIRE', label: '火情' },
  { value: 'SMOKE', label: '烟雾' },
]
function aiTypeLabel(type?: AiEventType): string {
  return aiTypeOptions.find((opt) => opt.value === (type ?? 'PEST'))?.label ?? (type ?? 'PEST')
}
const aiQuery = reactive<{ plotCode: string; eventType: string; forwarded: string }>({ plotCode: '', eventType: '', forwarded: '' })
const aiEvents = ref<VideoAiEvent[]>([])
const aiLoading = ref(false)
const aiPage = ref(1)
const aiSize = 10
const aiTotal = ref(0)

async function loadAiEvents() {
  aiLoading.value = true
  try {
    const res = await videoApi.getAiEvents({
      page: aiPage.value,
      size: aiSize,
      ...(aiQuery.plotCode ? { plotCode: aiQuery.plotCode } : {}),
      ...(aiQuery.eventType ? { eventType: aiQuery.eventType as AiEventType } : {}),
      ...(aiQuery.forwarded ? { forwarded: aiQuery.forwarded === 'true' } : {})
    })
    aiEvents.value = res.items ?? []
    aiTotal.value = res.total
  } catch {
    aiEvents.value = []
    aiTotal.value = 0
  } finally {
    aiLoading.value = false
  }
}

function resetAiQuery() { aiQuery.plotCode = ''; aiQuery.eventType = ''; aiQuery.forwarded = ''; aiPage.value = 1; void loadAiEvents() }

async function retryAiEvent(event: VideoAiEvent) {
  retryingId.value = event.id
  try {
    const updated = await videoApi.retryAiEvent(event.id)
    if (updated.forwarded) ElMessage.success(updated.forwardMessage || '转发成功，已生成告警')
    else ElMessage.warning(updated.forwardMessage || '遥测服务仍不可达，稍后再试')
    void loadAiEvents()
  } catch {
    ElMessage.error('识别事件重试失败')
  } finally {
    retryingId.value = ''
  }
}

// —— 云台指令历史 ——
const ptzFilterCameraId = ref('')
const ptzCommands = ref<PtzCommand[]>([])
const ptzLoading = ref(false)
const ptzPage = ref(1)
const ptzSize = 10
const ptzTotal = ref(0)

async function loadPtzCommands() {
  ptzLoading.value = true
  try {
    const res = await videoApi.getPtzCommands({
      page: ptzPage.value,
      size: ptzSize,
      ...(ptzFilterCameraId.value ? { cameraId: ptzFilterCameraId.value } : {})
    })
    ptzCommands.value = res.items ?? []
    ptzTotal.value = res.total
  } catch {
    ptzCommands.value = []
    ptzTotal.value = 0
  } finally {
    ptzLoading.value = false
  }
}

// —— 摄像机台账管理 ——
const cameraQuery = reactive<{ keyword: string; plotCode: string; status: string }>({ keyword: '', plotCode: '', status: '' })
const cameraList = ref<Camera[]>([])
const cameraTotal = ref(0)
const cameraLoading = ref(false)
const cameraPage = ref(1)
const cameraSize = 10

async function loadCameras() {
  cameraLoading.value = true
  try {
    const res = await videoApi.getCameras({
      page: cameraPage.value,
      size: cameraSize,
      ...(cameraQuery.keyword ? { keyword: cameraQuery.keyword } : {}),
      ...(cameraQuery.plotCode ? { plotCode: cameraQuery.plotCode } : {}),
      ...(cameraQuery.status ? { status: cameraQuery.status } : {}),
    })
    cameraList.value = res.items ?? []
    cameraTotal.value = res.total
  } catch {
    cameraList.value = []
    cameraTotal.value = 0
  } finally {
    cameraLoading.value = false
  }
}

function resetCameraQuery() {
  cameraQuery.keyword = ''
  cameraQuery.plotCode = ''
  cameraQuery.status = ''
  cameraPage.value = 1
  void loadCameras()
}

const cameraDialogVisible = ref(false)
const cameraSaving = ref(false)
const cameraForm = reactive<{ id: string; name: string; plotCode: string; status: 'ONLINE' | 'OFFLINE'; streamUrl: string }>({
  id: '', name: '', plotCode: '', status: 'ONLINE', streamUrl: '',
})

/** 地块下拉与设备页同源：第一次打开时按全量边界取一次 */
const plotOptions = ref<Array<{ parcelCode: string; parcelName: string }>>([])
async function ensurePlotOptions() {
  if (plotOptions.value.length) return
  try {
    plotOptions.value = await plotApi.getBounds()
  } catch {
    plotOptions.value = []
  }
}

function openCameraDialog(camera?: Camera) {
  cameraForm.id = camera?.id ?? ''
  cameraForm.name = camera?.name ?? ''
  cameraForm.plotCode = camera?.plotCode ?? ''
  cameraForm.status = camera?.status ?? 'ONLINE'
  cameraForm.streamUrl = camera?.streamUrl ?? ''
  cameraDialogVisible.value = true
  void ensurePlotOptions()
}

async function submitCamera() {
  if (!cameraForm.name.trim()) {
    ElMessage.warning('请填写摄像头名称')
    return
  }
  cameraSaving.value = true
  try {
    const payload = {
      name: cameraForm.name.trim(),
      plotCode: cameraForm.plotCode,
      status: cameraForm.status,
      streamUrl: cameraForm.streamUrl.trim(),
    }
    if (cameraForm.id) await videoApi.updateCamera(cameraForm.id, payload)
    else await videoApi.createCamera(payload)
    ElMessage.success(cameraForm.id ? '摄像头配置已更新' : '摄像头已登记')
    cameraDialogVisible.value = false
    await loadCameras()
    // 台账变了，监看页的可用摄像机也要跟着刷新
    void load()
  } catch {
    // 错误提示由请求层统一弹出
  } finally {
    cameraSaving.value = false
  }
}

async function removeCamera(camera: Camera) {
  try {
    await ElMessageBox.confirm(
      `确认删除摄像机「${camera.name}」？其云台指令、识别事件与留档记录按摄像机标识关联保留，不随删除清除。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await videoApi.deleteCamera(camera.id)
    ElMessage.success('摄像机已删除')
    await loadCameras()
    void load()
  } catch {
    // 错误提示由请求层统一弹出
  }
}

function onTabChange(name: string | number) {
  if (name === 'recordings') void loadRecordings()
  else if (name === 'archives') void loadArchives()
  else if (name === 'ai') void loadAiEvents()
  else if (name === 'ptz') void loadPtzCommands()
  else if (name === 'cameras') void loadCameras()
}

function refreshActive() {
  if (activeTab.value === 'live') void load()
  else if (activeTab.value === 'recordings') void loadRecordings()
  else if (activeTab.value === 'archives') void loadArchives()
  else if (activeTab.value === 'ai') void loadAiEvents()
  else if (activeTab.value === 'cameras') void loadCameras()
  else void loadPtzCommands()
}

onMounted(() => void load())
onUnmounted(() => {
  for (const key of [...engines.keys()]) destroyEngine(key)
  videoEls.clear()
  screenEls.clear()
  engines.clear()
})
</script>

<style scoped>
.video-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.video-title { font-size: 18px; font-weight: 600; }

.camera-card {
  background: #fff;
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 1px 4px rgba(0,0,0,.08);
}

.camera-screen {
  height: 200px;
  background: #0f172a;
  border-radius: 6px;
  overflow: hidden;
  position: relative;
}

.camera-screen:fullscreen { height: 100%; border-radius: 0; }
.recording-screen { height: 420px; }

.camera-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: #64748b;
  font-size: 13px;
}

.camera-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.camera-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0 8px;
}

.camera-url {
  font-size: 11px;
  color: #94a3b8;
  margin-bottom: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.camera-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.ptz-panel { display: flex; gap: 24px; align-items: flex-start; }
.ptz-pad { display: grid; grid-template-columns: repeat(3, 86px); gap: 8px; }
.ptz-pad .el-button { margin: 0; width: 86px; }
.ptz-side { flex: 1; display: flex; flex-direction: column; gap: 12px; }
.ptz-zoom { display: flex; gap: 8px; }
.ptz-speed { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #475569; }
.ptz-note { font-size: 12px; color: #94a3b8; line-height: 1.6; margin: 0; }
.recording-meta { font-size: 13px; color: #475569; margin-bottom: 10px; }
.pager { margin-top: 16px; justify-content: flex-end; }
.muted { color: #94a3b8; }
.camera-video { opacity: 0; }.camera-video.visible { opacity: 1; }.video-hint { color: #94a3b8; font-size: 12px; }.flex-spacer { flex: 1; }

/* 分屏监看（A13）：1/2/4/9 布局，屏内播放器随分屏切换重建 */
.split-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.split-label { font-size: 13px; color: #475569; }
.split-hint { font-size: 12px; color: #94a3b8; }
.split-grid { display: grid; gap: 12px; }
.split-1 { grid-template-columns: 1fr; }
.split-2 { grid-template-columns: repeat(2, 1fr); }
.split-4 { grid-template-columns: repeat(2, 1fr); }
.split-9 { grid-template-columns: repeat(3, 1fr); }
.split-cell { background: #fff; border-radius: 8px; padding: 10px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
.split-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.split-select { flex: 1; }
.split-screen { height: 180px; }
.split-1 .split-screen { height: 420px; }
.split-9 .split-screen { height: 140px; }
.split-actions { margin-top: 8px; }
.nav-unit { font-size: 12px; color: #94a3b8; margin-left: 8px; }
.mb-20 { margin-bottom: 16px; }
</style>