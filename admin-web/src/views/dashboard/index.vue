<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { getDashboardOverview, type DashboardOverview } from "@/api/dashboard";
import { probeServices } from "@/api/system";
import { useWorldStore } from "@/store/modules/world";
import { useAsyncData, fmtTime } from "@/composables/useAsyncData";
import { usePolling } from "@/composables/usePolling";

defineOptions({ name: "Dashboard" });

const worldStore = useWorldStore();
const { loading, error, run } = useAsyncData();
const overview = ref<DashboardOverview | null>(null);

/** 引擎直读数据（真实）；status 来自引擎 1.0.3 G1 软暂停 */
const engineWorlds = ref<
  { id: string; entities: number; time: string; status: string }[]
>([]);
/** 服务连通性（真实探测：world-engine / platform-admin） */
const services = ref<{ name: string; status: "up" | "down" }[]>([]);

async function loadAll(silent = false) {
  await run(
    async () => {
      await Promise.all([
        getDashboardOverview().then(res => {
          overview.value = res;
        }),
        worldStore.fetchWorlds(true).then(() => {
          engineWorlds.value = worldStore.worlds.map(w => ({
            id: w.worldId,
            entities: w.entities,
            time: w.time
              ? `第${w.time.day}天 ${String(w.time.hour).padStart(2, "0")}:00`
              : "—",
            status: w.status ?? "running"
          }));
        }),
        probeServices()
          .then(rows => {
            services.value = rows.map(r => ({ name: r.name, status: r.status }));
          })
          .catch(() => {
            services.value = [];
          })
      ]);
    },
    { silent }
  );
}

const { polling, toggle, start } = usePolling(() => loadAll(true), 30_000);

onMounted(async () => {
  await loadAll();
  start();
});
onBeforeUnmount(() => {
  /* 轮询随组件卸载自动停止 */
});

const statCards = () => {
  const up = services.value.filter(s => s.status === "up").length;
  const total = services.value.length;
  const allUp = total > 0 && up === total;
  return [
    {
      zh: "世界数",
      en: "Worlds",
      tip: "来自 World Engine 直读",
      value: String(engineWorlds.value.length),
      icon: "ep/compass",
      color: "#409eff"
    },
    {
      zh: "运行中世界",
      en: "Running",
      tip: "running 状态世界数（软暂停语义起真实；暂停中的不计入）",
      value: String(overview.value?.worlds.running ?? "—"),
      icon: "ep/video-play",
      color: "#67c23a"
    },
    {
      zh: "实体数",
      en: "Entities",
      tip: "全部世界的实体总数（引擎直读）",
      value: String(engineWorlds.value.reduce((s, w) => s + w.entities, 0)),
      icon: "ep/user",
      color: "#e6a23c"
    },
    {
      zh: "服务在线",
      en: "Services",
      tip: total
        ? `控制面依赖服务连通性（真实探测）：${services.value
            .map(s => `${s.name} ${s.status}`)
            .join(" · ")}`
        : "服务连通性探测中（world-engine / platform-admin）",
      value: total ? `${up}/${total}` : "—",
      icon: allUp ? "ep/circle-check" : "ep/warning",
      color: allUp ? "#67c23a" : "#e6a23c"
    }
  ];
};
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
        :sm="12"
        :md="6"
        class="mb-3"
      >
        <el-card shadow="never" class="h-full">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div
                class="flex items-baseline gap-1.5 text-[13px] font-medium text-[--el-text-color-secondary]"
                :title="card.tip"
              >
                <span class="truncate">{{ card.zh }}</span>
                <span
                  class="bi-en truncate font-mono text-[11px] font-normal opacity-70"
                  >{{ card.en }}</span
                >
              </div>
              <div
                v-loading="loading"
                class="mt-1.5 text-[28px] leading-9 font-semibold tabular-nums"
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
      <!-- 世界运行时（引擎直读） -->
      <el-col :md="16" class="mb-3">
        <el-card shadow="never" class="h-full">
          <template #header>
            <div class="flex items-center justify-between">
              <BiText zh="世界运行时（引擎直读）" en="World Runtime" />
              <div class="flex items-center gap-2">
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
                <router-link to="/worlds/list">
                  <el-button size="small" text type="primary">世界列表</el-button>
                </router-link>
              </div>
            </div>
          </template>
          <el-table v-loading="loading" :data="engineWorlds" size="small">
            <el-table-column prop="id" min-width="160">
              <template #header><BiText zh="世界 ID" en="World ID" /></template>
            </el-table-column>
            <el-table-column label="状态" width="100" align="center">
              <template #default="{ row }">
                <el-tag
                  :type="row.status === 'paused' ? 'warning' : 'success'"
                  size="small"
                >
                  {{ row.status }}
                </el-tag>
              </template>
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
      </el-col>

      <!-- 最近错误 -->
      <el-col :md="8" class="mb-3">
        <el-card shadow="never" class="h-full">
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
  </div>
</template>
