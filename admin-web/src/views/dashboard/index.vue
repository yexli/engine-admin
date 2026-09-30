<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import * as echarts from "echarts";
import { getDashboardOverview, type DashboardOverview } from "@/api/dashboard";
import { useWorldStore } from "@/store/modules/world";
import { useAsyncData, fmtTime } from "@/composables/useAsyncData";
import { usePolling } from "@/composables/usePolling";

defineOptions({ name: "Dashboard" });

const worldStore = useWorldStore();
const { loading, error, run } = useAsyncData();
const overview = ref<DashboardOverview | null>(null);
const chartRef = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;

/** 引擎直读数据（真实）与平台聚合（Mock）分开展示，界面标注口径 */
const engineWorlds = ref<{ id: string; entities: number; time: string }[]>([]);

async function loadAll(silent = false) {
  await run(
    async () => {
      const [res] = await Promise.all([
        getDashboardOverview(),
        worldStore.fetchWorlds(true).then(() => {
          engineWorlds.value = worldStore.worlds.map(w => ({
            id: w.worldId,
            entities: w.entities,
            time: w.time
              ? `第${w.time.day}天 ${String(w.time.hour).padStart(2, "0")}:00`
              : "—"
          }));
        })
      ]);
      overview.value = res.data;
      renderChart();
    },
    { silent }
  );
}

function renderChart() {
  if (!chartRef.value || !overview.value) return;
  if (!chart) {
    chart = echarts.init(chartRef.value);
  }
  const { hours, events, aiCalls } = overview.value.activity;
  chart.setOption({
    tooltip: { trigger: "axis" },
    legend: {
      data: ["世界事件", "AI 调用"],
      top: 0,
      right: 0,
      itemWidth: 16,
      itemHeight: 8,
      icon: "roundRect"
    },
    grid: { left: 40, right: 16, top: 36, bottom: 28 },
    xAxis: { type: "category", data: hours, boundaryGap: false },
    yAxis: { type: "value", minInterval: 1 },
    series: [
      {
        name: "世界事件",
        type: "line",
        smooth: true,
        showSymbol: false,
        data: events,
        areaStyle: { opacity: 0.08 },
        itemStyle: { color: "#409eff" }
      },
      {
        name: "AI 调用",
        type: "line",
        smooth: true,
        showSymbol: false,
        data: aiCalls,
        areaStyle: { opacity: 0.08 },
        itemStyle: { color: "#67c23a" }
      }
    ]
  });
}

function onResize() {
  chart?.resize();
}

const { polling, toggle, start } = usePolling(() => loadAll(true), 30_000);

onMounted(async () => {
  await loadAll();
  window.addEventListener("resize", onResize);
  start();
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
  chart?.dispose();
  chart = null;
});

const statCards = () => [
  {
    zh: "世界数",
    en: "Worlds",
    /** 引擎直读标注（tooltip） */
    tip: "来自 World Engine 直读",
    value: String(engineWorlds.value.length),
    icon: "ep/compass",
    color: "#409eff"
  },
  {
    zh: "活跃世界",
    en: "Active Worlds",
    tip: "运行中的世界数（Mock 聚合）",
    value: String(overview.value?.stats.activeWorlds ?? "—"),
    icon: "ep/video-play",
    color: "#67c23a"
  },
  {
    zh: "实体数",
    en: "Entities",
    tip: "来自 World Engine 直读",
    value: String(engineWorlds.value.reduce((s, w) => s + w.entities, 0)),
    icon: "ep/user",
    color: "#e6a23c"
  },
  {
    zh: "每分钟事件",
    en: "Events / min",
    tip: "平台事件速率（Mock 聚合）",
    value: String(overview.value?.stats.eventsPerMin ?? "—"),
    icon: "ep/bell",
    color: "#f56c6c"
  },
  {
    zh: "AI 请求",
    en: "Requests · 24h",
    tip: "近 24 小时模型调用次数（Mock 聚合）",
    value: String(overview.value?.stats.aiRequests24h ?? "—"),
    icon: "ep/coin",
    color: "#9a66e4"
  },
  {
    zh: "记忆条目",
    en: "Memory Records",
    tip: "全部记忆库文档数（Mock 聚合）",
    value: String(overview.value?.stats.memoryRecords ?? "—"),
    icon: "ep/collection",
    color: "#00b2a9"
  }
];
</script>

<template>
  <div class="p-4">
    <!-- 引擎不可达提示（真实 API 健康可见） -->
    <el-alert
      v-if="worldStore.error"
      type="warning"
      :closable="false"
      class="mb-3"
      show-icon
    >
      <template #title>
        World Engine 不可达（{{ worldStore.error }}）——
        世界/实体指标暂缺；启动引擎 (port 8787) 后自动恢复。
      </template>
    </el-alert>

    <!-- 指标卡 -->
    <el-row :gutter="12">
      <el-col
        v-for="card in statCards()"
        :key="card.zh"
        :xs="12"
        :sm="8"
        :md="4"
        class="mb-3"
      >
        <el-card shadow="never" class="h-full">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div
                class="text-sm font-medium text-[--el-text-color-primary] truncate"
                :title="card.tip"
              >
                {{ card.zh }}
              </div>
              <div
                class="text-[11px] font-mono text-[--el-text-color-secondary] truncate mb-1"
              >
                {{ card.en }}
              </div>
              <div
                v-loading="loading"
                class="text-[26px] leading-8 font-semibold tabular-nums"
              >
                {{ card.value }}
              </div>
            </div>
            <el-tooltip :content="card.tip" placement="top">
              <div
                class="w-9 h-9 shrink-0 rounded-lg flex items-center justify-center cursor-default"
                :style="{ background: `${card.color}14`, color: card.color }"
              >
                <IconifyIconOffline :icon="card.icon" class="text-lg" />
              </div>
            </el-tooltip>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="12">
      <!-- 事件活动 -->
      <el-col :md="16" class="mb-3">
        <el-card shadow="never">
          <template #header>
            <div class="flex items-center justify-between">
              <BiText
                zh="事件活动 / AI 调用（近 12 小时）"
                en="Activity / AI Calls"
              />
              <el-button
                size="small"
                :type="polling ? 'primary' : 'default'"
                @click="toggle"
              >
                <IconifyIconOffline
                  :icon="polling ? 'ep/video-pause' : 'ep/video-play'"
                  class="mr-1"
                />
                {{ polling ? "轮询中(30s)" : "已暂停" }}
              </el-button>
            </div>
          </template>
          <div ref="chartRef" class="h-[320px] w-full" />
        </el-card>
      </el-col>

      <!-- AI 用量 + 系统 -->
      <el-col :md="8" class="mb-3">
        <el-card shadow="never" class="mb-3">
          <template #header>
            <BiText zh="AI 用量（24h · Mock）" en="AI Usage" />
          </template>
          <template v-if="overview">
            <div class="flex justify-between mb-2 text-sm">
              <span class="text-[--el-text-color-secondary]">成本</span>
              <span>${{ overview.aiUsage24h.costUsd.toFixed(2) }}</span>
            </div>
            <div class="flex justify-between mb-2 text-sm">
              <span class="text-[--el-text-color-secondary]">Tokens</span>
              <span>{{ overview.aiUsage24h.tokens.toLocaleString() }}</span>
            </div>
            <div class="flex justify-between mb-3 text-sm">
              <span class="text-[--el-text-color-secondary]">成功率</span>
              <span>{{ overview.aiUsage24h.successRate }}%</span>
            </div>
            <div
              v-for="p in overview.aiUsage24h.byProvider"
              :key="p.provider"
              class="mb-2"
            >
              <div class="flex justify-between text-xs mb-1">
                <span>{{ p.provider }}</span>
                <span class="text-[--el-text-color-secondary]">{{
                  p.requests
                }}</span>
              </div>
              <el-progress
                :percentage="
                  Math.round(
                    (p.requests /
                      Math.max(1, overview.aiUsage24h.byProvider[0].requests)) *
                      100
                  )
                "
                :show-text="false"
                :stroke-width="6"
              />
            </div>
          </template>
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div class="flex items-center justify-between">
              <BiText zh="最近错误" en="Recent Errors" />
              <router-link to="/observability/errors">
                <el-button size="small" text type="primary">查看全部</el-button>
              </router-link>
            </div>
          </template>
          <el-empty
            v-if="!overview?.recentErrors.length"
            description="暂无错误"
            :image-size="48"
          />
          <div v-else class="space-y-2">
            <div
              v-for="e in overview.recentErrors"
              :key="e.id"
              class="flex items-start gap-2 text-sm"
            >
              <IconifyIconOffline
                icon="ep/circle-close"
                class="text-[--el-color-danger] mt-0.5"
              />
              <div class="min-w-0">
                <div class="truncate">{{ e.message }}</div>
                <div class="text-xs text-[--el-text-color-secondary]">
                  {{ e.type }} · {{ fmtTime(e.time) }}
                </div>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 引擎世界直读表 -->
    <el-card shadow="never">
      <template #header>
        <div class="flex items-center justify-between">
          <BiText zh="世界运行时（引擎直读）" en="World Runtime" />
          <router-link to="/worlds/list">
            <el-button size="small" text type="primary">世界列表</el-button>
          </router-link>
        </div>
      </template>
      <el-table v-loading="loading" :data="engineWorlds" size="small">
        <el-table-column prop="id" min-width="160">
          <template #header><BiText zh="世界 ID" en="World ID" /></template>
        </el-table-column>
        <el-table-column prop="entities" label="实体数" width="100" />
        <el-table-column prop="time" label="世界时间" min-width="140" />
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <router-link :to="`/worlds/detail/${row.id}`">
              <el-button size="small" text type="primary">详情</el-button>
            </router-link>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="引擎不可达或暂无世界" :image-size="60" />
        </template>
      </el-table>
    </el-card>
  </div>
</template>
