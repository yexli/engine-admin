<!-- Scheduler 面板：M1.2 起接真实调度观测（GET /v1/worlds/{id}/scheduler，bus 只读面） -->
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
    </div>

    <el-alert
      v-if="error"
      type="error"
      :closable="false"
      class="mb-3"
      show-icon
    >
      <template #title>
        加载失败：{{ error }}
        <el-button text type="primary" size="small" @click="load">重试</el-button>
      </template>
    </el-alert>

    <template v-if="view">
      <el-row :gutter="12" class="mb-3">
        <el-col :xs="12" :md="4" v-for="item in statCards" :key="item.label">
          <el-card shadow="never">
            <div class="text-xs text-[--el-text-color-secondary]">
              {{ item.label }}
            </div>
            <div class="text-xl font-semibold">{{ item.value }}</div>
          </el-card>
        </el-col>
      </el-row>

      <el-tabs v-model="tab">
        <el-tab-pane
          :label="`定时事件 Scheduled（${view.stats.scheduled}）`"
          name="scheduled"
        >
          <el-table :data="view.scheduled" size="default" stripe>
            <el-table-column prop="event.id" min-width="110">
              <template #header><BiText zh="事件 ID" en="Event ID" /></template>
            </el-table-column>
            <el-table-column prop="event.type" min-width="150">
              <template #header><BiText zh="类型" en="Type" /></template>
              <template #default="{ row }">
                <span class="font-mono text-xs">{{ row.event.type }}</span>
              </template>
            </el-table-column>
            <el-table-column width="170" align="center">
              <template #header>
                <BiText
                  :zh="`到期日（世界当前 D${currentDay ?? '—'}）`"
                  en="Due Day"
                />
              </template>
              <template #default="{ row }">
                <el-tooltip
                  :content="
                    currentDay !== null && row.dueDay <= currentDay
                      ? '已到期（等待调度分发）'
                      : '未到期'
                  "
                  placement="top"
                >
                  <el-tag
                    :type="
                      currentDay !== null && row.dueDay <= currentDay
                        ? 'warning'
                        : 'info'
                    "
                    size="small"
                  >
                    D{{ row.dueDay
                    }}{{
                      currentDay !== null && row.dueDay <= currentDay
                        ? " · 已到期"
                        : ""
                    }}
                  </el-tag>
                </el-tooltip>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="无定时事件" :image-size="60" />
            </template>
          </el-table>
        </el-tab-pane>

        <el-tab-pane
          :label="`延后重投 Deferred（${view.stats.deferred}）`"
          name="deferred"
        >
          <el-table :data="view.deferred" size="default" stripe>
            <el-table-column prop="id" min-width="110">
              <template #header><BiText zh="事件 ID" en="Event ID" /></template>
            </el-table-column>
            <el-table-column prop="type" min-width="150">
              <template #header><BiText zh="类型" en="Type" /></template>
              <template #default="{ row }">
                <span class="font-mono text-xs">{{ row.type }}</span>
              </template>
            </el-table-column>
            <el-table-column width="100" align="center">
              <template #header><BiText zh="天 / 刻" en="D·T" /></template>
              <template #default="{ row }">D{{ row.day }}·{{ row.tick }}</template>
            </el-table-column>
            <template #empty>
              <el-empty
                description="无延后事件（语义事件单 tick 超限时延后到下个 tick 重投）"
                :image-size="60"
              />
            </template>
          </el-table>
        </el-tab-pane>

        <el-tab-pane
          :label="`死信 Dead Letters（${view.stats.deadLetters}）`"
          name="dead"
        >
          <el-table :data="view.deadLetters" size="default" stripe>
            <el-table-column prop="id" min-width="110">
              <template #header><BiText zh="事件 ID" en="Event ID" /></template>
            </el-table-column>
            <el-table-column prop="type" min-width="150">
              <template #header><BiText zh="类型" en="Type" /></template>
              <template #default="{ row }">
                <span class="font-mono text-xs">{{ row.type }}</span>
              </template>
            </el-table-column>
            <el-table-column width="100" align="center">
              <template #header><BiText zh="天 / 刻" en="D·T" /></template>
              <template #default="{ row }">D{{ row.day }}·{{ row.tick }}</template>
            </el-table-column>
            <template #empty>
              <el-empty
                description="无死信（超限 / 链过深 / 队列满的事件进入死信队列）"
                :image-size="60"
              />
            </template>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </template>

    <el-empty
      v-else-if="!loading && !error"
      description="请先选择世界"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { getSchedulerView, type SchedulerView } from "@/api/runtime";
import { getWorld } from "@/api/world";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePolling } from "@/composables/usePolling";

defineOptions({ name: "SchedulerPanel" });

const props = defineProps<{ worldId: string }>();

const interval = 5000;
const view = ref<SchedulerView | null>(null);
const currentDay = ref<number | null>(null);
const { loading, error, run } = useAsyncData();

const tab = ref("scheduled");

const statCards = computed(() => [
  { label: "订阅者 Subscribers", value: view.value?.stats.subscribers ?? 0 },
  { label: "定时 Scheduled", value: view.value?.stats.scheduled ?? 0 },
  { label: "延后 Deferred", value: view.value?.stats.deferred ?? 0 },
  { label: "死信 Dead Letters", value: view.value?.stats.deadLetters ?? 0 },
  { label: "本 Tick 派发", value: view.value?.stats.tickEmitted ?? 0 }
]);

async function load() {
  if (!props.worldId) return;
  const res = await run(() => getSchedulerView(props.worldId));
  if (res) view.value = res;
  const info = await run(() => getWorld(props.worldId));
  if (info) currentDay.value = info.time?.day ?? null;
}

const { polling, toggle, start } = usePolling(load, interval);

watch(
  () => props.worldId,
  () => {
    view.value = null;
    load();
    if (!polling.value) start();
  },
  { immediate: true }
);

defineExpose({ reload: load });
</script>
