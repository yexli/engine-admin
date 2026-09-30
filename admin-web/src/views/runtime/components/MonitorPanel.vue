<!-- Runtime Monitor 面板：轮询观察世界运行时 + 快捷推进时间 -->
<template>
  <div>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <el-button
        :type="polling ? 'primary' : 'default'"
        size="small"
        @click="toggle"
      >
        <IconifyIconOffline
          :icon="polling ? 'ep/video-pause' : 'ep/video-play'"
          class="mr-1"
        />
        {{ polling ? `轮询中（${interval / 1000}s）` : "开始轮询" }}
      </el-button>
      <el-button size="small" :loading="loading" @click="load">
        <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
      </el-button>
      <Perms value="world:write">
        <el-button size="small" type="warning" @click="timeDialog = true">
          <IconifyIconOffline icon="ep/timer" class="mr-1" />推进时间
        </el-button>
      </Perms>
      <el-tooltip
        content="引擎 V1.0 暂无暂停/恢复/关闭 API（见 ADMIN-API-GAP.md）"
        placement="top"
      >
        <span>
          <el-button size="small" disabled>
            <IconifyIconOffline icon="ep/video-pause" class="mr-1" />暂停
          </el-button>
        </span>
      </el-tooltip>
    </div>

    <el-alert
      v-if="error"
      type="error"
      :closable="false"
      class="mb-3"
      show-icon
    >
      <template #title>
        引擎不可达：{{ error }}
        <el-button text type="primary" size="small" @click="load"
          >重试</el-button
        >
      </template>
    </el-alert>

    <el-row v-if="summary" :gutter="12">
      <el-col :md="10" class="mb-3">
        <el-card shadow="never">
          <template #header><BiText zh="运行时状态" en="Runtime" /></template>
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="世界 World">{{
              summary.worldId
            }}</el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag type="success" size="small">assumed-running</el-tag>
              <span class="text-xs text-[--el-text-color-secondary] ml-1"
                >（引擎无暂停 API）</span
              >
            </el-descriptions-item>
            <el-descriptions-item label="刻 Tick">{{
              summary.tick
            }}</el-descriptions-item>
            <el-descriptions-item label="天气 Weather">{{
              summary.weather || "—"
            }}</el-descriptions-item>
            <el-descriptions-item label="实体 Entities">{{
              summary.entityCount
            }}</el-descriptions-item>
            <el-descriptions-item label="地点 Locations">{{
              summary.locationCount
            }}</el-descriptions-item>
            <el-descriptions-item label="关系 Relations">{{
              summary.relationCount
            }}</el-descriptions-item>
            <el-descriptions-item label="版本 Ver">{{
              summary.ver
            }}</el-descriptions-item>
            <el-descriptions-item label="种子 Seed" :span="2">{{
              summary.seed ?? "—"
            }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
      </el-col>

      <el-col :md="14" class="mb-3">
        <el-card shadow="never">
          <template #header>
            <div class="flex items-center justify-between">
              <BiText zh="最近事件（队列尾部）" en="Recent Events" />
              <router-link to="/runtime/events">
                <el-button size="small" text type="primary">全部事件</el-button>
              </router-link>
            </div>
          </template>
          <el-table
            :data="summary.lastEvents.slice(0, 8)"
            size="small"
            height="260"
          >
            <el-table-column
              prop="id"
              label="ID"
              width="90"
              show-overflow-tooltip
            />
            <el-table-column
              prop="type"
              label="类型"
              min-width="150"
              show-overflow-tooltip
            >
              <template #default="{ row }">
                <span class="font-mono text-xs">{{ row.type }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="actor" min-width="90">
              <template #header><BiText zh="行为者" en="Actor" /></template>
              <template #default="{ row }">{{ row.actor ?? "—" }}</template>
            </el-table-column>
            <el-table-column width="90">
              <template #header><BiText zh="天 / 刻" en="D·T" /></template>
              <template #default="{ row }"
                >D{{ row.day }}·{{ row.tick }}</template
              >
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-empty v-else-if="!loading && !error" description="请先选择世界" />

    <!-- 推进时间 -->
    <el-dialog v-model="timeDialog" title="推进世界时间" width="420px">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        class="mb-3"
        title="推进时间会触发规则与调度事件，直接改变世界状态。"
      />
      <el-form label-width="80px">
        <el-form-item label="刻数">
          <el-input-number v-model="ticks" :min="1" :max="100000" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="timeDialog = false">取消</el-button>
        <el-button type="primary" :loading="advancing" @click="doAdvance"
          >确认推进</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import {
  getRuntimeSummary,
  advanceTime,
  type RuntimeSummary
} from "@/api/runtime";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePolling } from "@/composables/usePolling";
import { message } from "@/utils/message";

defineOptions({ name: "MonitorPanel" });

const props = defineProps<{ worldId: string }>();

const interval = 5000;
const summary = ref<RuntimeSummary | null>(null);
const { loading, error, run } = useAsyncData();

const timeDialog = ref(false);
const ticks = ref(12);
const { loading: advancing, run: runAdvance } = useAsyncData();

async function load() {
  if (!props.worldId) return;
  const res = await run(() => getRuntimeSummary(props.worldId));
  if (res) summary.value = res;
}

async function doAdvance() {
  const res = await runAdvance(() => advanceTime(props.worldId, ticks.value));
  if (res) {
    message(res.ok ? `已推进 ${ticks.value} 刻` : `拒绝：${res.reason ?? ""}`, {
      type: res.ok ? "success" : "error"
    });
    timeDialog.value = false;
    await load();
  }
}

const { polling, toggle, start } = usePolling(load, interval);

watch(
  () => props.worldId,
  () => {
    summary.value = null;
    load();
    if (!polling.value) start();
  },
  { immediate: true }
);

defineExpose({ reload: load });
</script>
