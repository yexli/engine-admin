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
        <el-button
          size="small"
          :type="paused ? 'success' : 'warning'"
          @click="togglePause"
        >
          <IconifyIconOffline
            :icon="paused ? 'ep/video-play' : 'ep/video-pause'"
            class="mr-1"
          />
          {{ paused ? "恢复" : "暂停" }}
        </el-button>
      </Perms>
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
              <el-tooltip
                :content="
                  paused
                    ? '软暂停：命令与时间推进被拒绝（读操作照常）'
                    : '正常运行（服务面受理命令与推进）'
                "
                placement="top"
              >
                <el-tag
                  :type="paused ? 'warning' : 'success'"
                  size="small"
                  class="cursor-default"
                >
                  {{ paused ? "paused（软暂停）" : "running" }}
                </el-tag>
              </el-tooltip>
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

    <!-- M1.2/M1.4：事件队列（scheduler）与最近命令（commands 历史） -->
    <el-row v-if="summary" :gutter="12">
      <el-col :md="10" class="mb-3">
        <el-card shadow="never">
          <template #header>
            <div class="flex items-center justify-between">
              <BiText zh="事件队列（调度观测）" en="Event Queue" />
              <router-link to="/runtime/scheduler">
                <el-button size="small" text type="primary"
                  >调度详情</el-button
                >
              </router-link>
            </div>
          </template>
          <el-descriptions v-if="scheduler" :column="2" border size="small">
            <el-descriptions-item label="订阅者">{{
              scheduler.stats.subscribers
            }}</el-descriptions-item>
            <el-descriptions-item label="定时事件">{{
              scheduler.stats.scheduled
            }}</el-descriptions-item>
            <el-descriptions-item label="延后重投">{{
              scheduler.stats.deferred
            }}</el-descriptions-item>
            <el-descriptions-item label="死信">
              <el-tag
                :type="scheduler.stats.deadLetters ? 'danger' : 'success'"
                size="small"
                >{{ scheduler.stats.deadLetters }}</el-tag
              >
            </el-descriptions-item>
            <el-descriptions-item label="本 Tick 派发" :span="2">{{
              scheduler.stats.tickEmitted
            }}</el-descriptions-item>
          </el-descriptions>
          <el-empty v-else description="—" :image-size="40" />
        </el-card>
      </el-col>

      <el-col :md="14" class="mb-3">
        <el-card shadow="never">
          <template #header>
            <div class="flex items-center justify-between">
              <BiText zh="Last Command（最近命令）" en="Last Command" />
              <router-link to="/runtime/commands">
                <el-button size="small" text type="primary">命令调试台</el-button>
              </router-link>
            </div>
          </template>
          <template v-if="lastCommand">
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item label="命令">
                <span class="font-mono">{{ lastCommand.command.type }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="结果">
                <el-tag
                  :type="lastCommand.ok ? 'success' : 'danger'"
                  size="small"
                  >{{ lastCommand.ok ? "ok" : "rejected" }}</el-tag
                >
              </el-descriptions-item>
              <el-descriptions-item label="时间" :span="2">{{
                lastCommand.at
              }}</el-descriptions-item>
              <el-descriptions-item
                v-if="lastCommand.reason"
                label="拒绝原因"
                :span="2"
                >{{ lastCommand.reason }}</el-descriptions-item
              >
              <el-descriptions-item label="产生事件" :span="2">
                <el-tag
                  v-for="ev in lastCommand.events.slice(0, 6)"
                  :key="ev"
                  size="small"
                  type="warning"
                  class="mr-1"
                  >{{ ev }}</el-tag
                >
                <span v-if="!lastCommand.events.length">—</span>
              </el-descriptions-item>
            </el-descriptions>
          </template>
          <el-empty v-else description="本世界还没有命令留痕" :image-size="40" />
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
  getSchedulerView,
  advanceTime,
  type RuntimeSummary,
  type SchedulerView
} from "@/api/runtime";
import { getCommandHistory } from "@/api/command";
import { getWorld, pauseWorld, resumeWorld } from "@/api/world";
import type { CommandHistoryEntry } from "@/api/types";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePolling } from "@/composables/usePolling";
import { message } from "@/utils/message";

defineOptions({ name: "MonitorPanel" });

const props = defineProps<{ worldId: string }>();

const interval = 5000;
const summary = ref<RuntimeSummary | null>(null);
const scheduler = ref<SchedulerView | null>(null);
const lastCommand = ref<CommandHistoryEntry | null>(null);
const paused = ref(false);
const { loading, error, run } = useAsyncData();

const timeDialog = ref(false);
const ticks = ref(12);
const { loading: advancing, run: runAdvance } = useAsyncData();

/** G1 软暂停：面板顶部提供暂停/恢复（状态来自世界清单） */
async function loadPaused() {
  if (!props.worldId) return;
  const info = await getWorld(props.worldId).catch(() => null);
  paused.value = info?.status === "paused";
}

async function togglePause() {
  try {
    const res = paused.value
      ? await resumeWorld(props.worldId)
      : await pauseWorld(props.worldId);
    paused.value = res.status === "paused";
    message(paused.value ? "已暂停（命令与推进被拒绝，读操作照常）" : "已恢复", {
      type: "success"
    });
  } catch (e) {
    message(e instanceof Error ? e.message : "操作失败", { type: "error" });
  }
}

async function load() {
  if (!props.worldId) return;
  const res = await run(() => getRuntimeSummary(props.worldId));
  if (res) summary.value = res;
  /* 调度观测 + 最近命令（失败不阻塞主面板） */
  const sched = await run(() => getSchedulerView(props.worldId));
  if (sched) scheduler.value = sched;
  const hist = await run(() => getCommandHistory(props.worldId, 1));
  if (hist) lastCommand.value = hist.commands[0] ?? null;
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
    loadPaused();
    if (!polling.value) start();
  },
  { immediate: true }
);

defineExpose({ reload: load });
</script>
