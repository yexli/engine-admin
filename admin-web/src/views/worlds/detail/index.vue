<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getWorld } from "@/api/world";
import type { WorldInfo } from "@/api/types";
import { useAsyncData } from "@/composables/useAsyncData";
import StatePanel from "@/views/runtime/components/StatePanel.vue";
import EntitiesPanel from "@/views/runtime/components/EntitiesPanel.vue";
import LocationsPanel from "@/views/runtime/components/LocationsPanel.vue";
import RelationsPanel from "@/views/runtime/components/RelationsPanel.vue";
import EventsPanel from "@/views/runtime/components/EventsPanel.vue";
import CommandConsole from "@/views/runtime/components/CommandConsole.vue";
import SchedulerPanel from "@/views/runtime/components/SchedulerPanel.vue";
import MonitorPanel from "@/views/runtime/components/MonitorPanel.vue";

defineOptions({ name: "WorldDetail" });

const route = useRoute();
const router = useRouter();
const worldId = computed(() => String(route.params.id ?? ""));

const info = ref<WorldInfo | null>(null);
const { loading, error, run } = useAsyncData();

const activeTab = ref("state");
const stateRef = ref<InstanceType<typeof StatePanel> | null>(null);

async function loadInfo() {
  if (!worldId.value) return;
  const res = await run(() => getWorld(worldId.value));
  if (res) info.value = res;
  else info.value = null;
}

function onTabChange() {
  // 切换到状态页时刷新一次
  if (activeTab.value === "state") stateRef.value?.reload?.();
}

function onCommandExecuted() {
  loadInfo();
}

onMounted(loadInfo);
watch(worldId, loadInfo);

function goBack() {
  router.push("/worlds/list");
}
</script>

<template>
  <div class="p-4">
    <!-- 头部 -->
    <el-card v-loading="loading" shadow="never" class="mb-3">
      <div class="flex flex-wrap items-center gap-3">
        <el-button circle @click="goBack">
          <IconifyIconOffline icon="ep/back" />
        </el-button>
        <div class="min-w-0">
          <div class="text-lg font-semibold font-mono truncate">
            {{ worldId }}
          </div>
          <div
            v-if="info"
            class="text-xs text-[--el-text-color-secondary] mt-0.5"
          >
            玩家位置：{{ info.location ?? "—" }} · 实体：{{ info.entities }} ·
            时间：{{
              info.time
                ? `第${info.time.day}天 ${String(info.time.hour).padStart(2, "0")}:00（${info.time.year}/${info.time.month}/${info.time.date} ${info.time.period}）`
                : "—"
            }}
          </div>
          <div
            v-else-if="error"
            class="text-xs text-[--el-color-danger] mt-0.5"
          >
            引擎不可达：{{ error }}
            <el-button text type="primary" size="small" @click="loadInfo"
              >重试</el-button
            >
          </div>
        </div>
        <div class="flex-1" />
        <el-tag
          v-if="info"
          :type="info.status === 'paused' ? 'warning' : 'success'"
          effect="plain"
        >
          {{ info.status === "paused" ? "已暂停" : "运行中" }}
        </el-tag>
      </div>
    </el-card>

    <!-- Tabs -->
    <el-card :key="worldId" shadow="never">
      <el-tabs v-model="activeTab" @tab-change="onTabChange">
        <el-tab-pane name="state">
          <template #label><BiText zh="状态" en="State" /></template>
          <StatePanel ref="stateRef" :world-id="worldId" />
        </el-tab-pane>
        <el-tab-pane name="entities" lazy>
          <template #label><BiText zh="实体" en="Entities" /></template>
          <EntitiesPanel :world-id="worldId" />
        </el-tab-pane>
        <el-tab-pane name="locations" lazy>
          <template #label><BiText zh="地点" en="Locations" /></template>
          <LocationsPanel :world-id="worldId" />
        </el-tab-pane>
        <el-tab-pane name="relations" lazy>
          <template #label><BiText zh="关系" en="Relations" /></template>
          <RelationsPanel :world-id="worldId" />
        </el-tab-pane>
        <el-tab-pane name="events" lazy>
          <template #label><BiText zh="事件" en="Events" /></template>
          <EventsPanel :world-id="worldId" />
        </el-tab-pane>
        <el-tab-pane name="commands" lazy>
          <template #label><BiText zh="命令调试台" en="Commands" /></template>
          <CommandConsole :world-id="worldId" @executed="onCommandExecuted" />
        </el-tab-pane>
        <el-tab-pane name="scheduler" lazy>
          <template #label><BiText zh="调度器" en="Scheduler" /></template>
          <SchedulerPanel :world-id="worldId" />
        </el-tab-pane>
        <el-tab-pane name="runtime" lazy>
          <template #label><BiText zh="运行监视" en="Runtime" /></template>
          <MonitorPanel :world-id="worldId" />
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>
