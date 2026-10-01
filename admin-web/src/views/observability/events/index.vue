<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  listPlatformEvents,
  type EventStreamRow
} from "@/api/event";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePolling } from "@/composables/usePolling";
import { message } from "@/utils/message";

defineOptions({ name: "ObsEvents" });

const list = ref<EventStreamRow[]>([]);
const total = ref(0);
const filters = ref({ worldId: "", type: "" });
const n = ref(20);
const { loading, error, run } = useAsyncData();

async function load() {
  const res = await run(() =>
    listPlatformEvents({
      world: filters.value.worldId || undefined,
      n: n.value
    })
  );
  const events = res?.events ?? [];
  const type = filters.value.type.trim();
  list.value = type ? events.filter(e => e.type.includes(type)) : events;
  total.value = res?.total ?? 0;
}

const { polling, toggle, start, stop } = usePolling(load, 10_000);

/* ---------- G3 实时模式：WebSocket 直连引擎 /v1/stream（替代轮询） ---------- */
const LIVE_CAP = 200;
const live = ref(false);
const liveCount = ref(0);
let ws: WebSocket | null = null;

function toggleLive() {
  if (live.value) {
    ws?.close();
    return;
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/world-api/v1/stream?replay=0`);
  ws.onopen = () => {
    live.value = true;
    liveCount.value = 0;
    if (polling.value) toggle(); /* 实时开着就别轮询了 */
  };
  ws.onmessage = ev => {
    try {
      const msg = JSON.parse(String(ev.data)) as {
        type: string;
        worldId?: string;
        event?: Omit<EventStreamRow, "worldId">;
      };
      if (msg.type !== "event" || !msg.event || !msg.worldId) return;
      if (msg.event.id && list.value.some(r => r.id === msg.event!.id)) return; /* 幂等去重 */
      const typeFilter = filters.value.type.trim();
      if (typeFilter && !msg.event.type.includes(typeFilter)) return;
      total.value++;
      liveCount.value++;
      list.value = [
        { ...msg.event, worldId: msg.worldId } as EventStreamRow,
        ...list.value
      ].slice(0, LIVE_CAP);
    } catch {
      /* 非 JSON 帧忽略 */
    }
  };
  ws.onclose = () => {
    const wasLive = live.value;
    live.value = false;
    ws = null;
    if (wasLive && !polling.value) start(); /* 断线回落轮询 */
  };
  ws.onerror = () => {
    /* onclose 会跟着来；这里只提示 */
    message("实时连接不可用（引擎未启动？），已回落 10s 轮询", { type: "warning" });
  };
}

onBeforeUnmount(() => ws?.close());

onMounted(start);

function levelTag(level: number) {
  return (["info", "primary", "warning", "danger"] as const)[level] ?? "info";
}

watch(
  () => filters.value.worldId,
  () => load()
);

function reset() {
  filters.value = { worldId: "", type: "" };
  n.value = 20;
  load();
}

function worldDay(row: EventStreamRow): string {
  return `第${row.day}天 · ${String(row.tick).padStart(2, "0")}刻`;
}
</script>

<template>
  <div class="p-4">
    <el-alert
      type="info"
      :closable="false"
      show-icon
      class="mb-3"
      title="平台事件流（M4.1 起真实）：跨世界事实聚合（引擎只读，各世界最近 n 条按世界历降序混排）。世界事件只有世界历时间（day/tick），没有墙钟时刻；因果链事实（parentId）带链接标记，向上追溯请到 Runtime → Events 详情。"
    />
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-input
          v-model="filters.worldId"
          placeholder="World ID（留空 = 全部世界）"
          clearable
          class="!w-52"
        />
        <el-input
          v-model="filters.type"
          placeholder="事件类型过滤（如 talk_started）"
          clearable
          class="!w-56"
          @change="load"
        />
        <el-input-number v-model="n" :min="5" :max="100" :step="5" size="small" />
        <span class="text-xs text-[--el-text-color-secondary]">每世界取最近 n 条</span>
        <el-button :loading="loading" @click="load">
          <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
        </el-button>
        <el-button
          :type="polling ? 'primary' : 'default'"
          :disabled="live"
          @click="toggle"
        >
          {{ polling ? "10s 轮询中" : "已暂停" }}
        </el-button>
        <el-button :type="live ? 'success' : 'default'" @click="toggleLive">
          <IconifyIconOffline
            :icon="live ? 'ep/connection' : 'ep/video-play'"
            class="mr-1"
          />
          {{ live ? `实时推送中 · +${liveCount}` : "实时" }}
        </el-button>
        <el-button @click="reset">重置</el-button>
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
          <el-button text type="primary" size="small" @click="load"
            >重试</el-button
          >
        </template>
      </el-alert>

      <el-table v-loading="loading" :data="list" stripe size="small">
        <el-table-column min-width="130"
          ><template #header><BiText zh="世界历" en="World Time" /></template>
          <template #default="{ row }">{{ worldDay(row as EventStreamRow) }}</template>
        </el-table-column>
        <el-table-column prop="worldId" width="100"
          ><template #header><BiText zh="世界" en="World" /></template
        ></el-table-column>
        <el-table-column min-width="180"
          ><template #header><BiText zh="类型" en="Type" /></template>
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.type }}</span>
            <el-tag
              v-if="row.parentId"
              size="small"
              type="warning"
              effect="plain"
              class="ml-1"
              >因果</el-tag
            >
          </template>
        </el-table-column>
        <el-table-column min-width="110"
          ><template #header><BiText zh="行为者" en="Actor" /></template>
          <template #default="{ row }">{{ row.actor ?? "—" }}</template>
        </el-table-column>
        <el-table-column min-width="110"
          ><template #header><BiText zh="对象" en="Target" /></template>
          <template #default="{ row }">{{ row.target ?? "—" }}</template>
        </el-table-column>
        <el-table-column label="分级" width="70" align="center">
          <template #default="{ row }">
            <el-tag :type="levelTag(row.level)" size="small"
              >L{{ row.level }}</el-tag
            >
          </template>
        </el-table-column>
        <el-table-column min-width="120"
          ><template #header><BiText zh="事件 ID" en="Event ID" /></template>
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.id }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty
            description="暂无事件（引擎不可达或世界尚无事实）"
            :image-size="64"
          />
        </template>
      </el-table>
    </el-card>
  </div>
</template>
