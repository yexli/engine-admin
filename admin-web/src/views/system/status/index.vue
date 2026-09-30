<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getSystemStatus, type SystemStatus } from "@/api/system";
import { getWorlds } from "@/api/world";
import { useAsyncData, fmtTime, timeAgo } from "@/composables/useAsyncData";
import { usePolling } from "@/composables/usePolling";

defineOptions({ name: "SystemStatus" });

const status = ref<SystemStatus | null>(null);
const engine = ref<{ online: boolean; worlds: number; detail: string }>({
  online: false,
  worlds: 0,
  detail: ""
});
const { loading, error, run } = useAsyncData();

async function load() {
  const res = await run(
    async () => {
      const [s, worlds] = await Promise.all([
        getSystemStatus(),
        getWorlds()
          .then(r => ({ ok: true, list: r.worlds ?? [] }))
          .catch(e => ({
            ok: false,
            list: [],
            msg: e instanceof Error ? e.message : String(e)
          }))
      ]);
      status.value = s.data;
      engine.value = {
        online: worlds.ok,
        worlds: worlds.list.length,
        detail: worlds.ok
          ? "127.0.0.1:8787 可达"
          : `不可达：${(worlds as { msg?: string }).msg ?? ""}`
      };
      return s.data;
    },
    { silent: true }
  );
  void res;
}

const { polling, toggle, start } = usePolling(load, 15_000);

onMounted(async () => {
  await load();
  start();
});

function serviceTag(s: string) {
  return ({ up: "success", degraded: "warning", down: "danger" }[s] ??
    "info") as "success" | "warning" | "danger" | "info";
}
</script>

<template>
  <div class="p-4">
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
        {{ polling ? "轮询中(15s)" : "已暂停" }}
      </el-button>
      <el-button size="small" :loading="loading" @click="load">
        <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
      </el-button>
    </div>

    <!-- 引擎直探（真实） -->
    <el-card shadow="never" class="mb-3">
      <template #header>
        <div class="flex items-center justify-between">
          <span>World Engine 直探（真实探测）</span>
          <el-tag :type="engine.online ? 'success' : 'danger'" size="small">
            {{ engine.online ? "在线" : "离线" }}
          </el-tag>
        </div>
      </template>
      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="地址"
          >127.0.0.1:8787（/world-api 代理）</el-descriptions-item
        >
        <el-descriptions-item label="世界数">{{
          engine.online ? engine.worlds : "—"
        }}</el-descriptions-item>
        <el-descriptions-item label="探测结果">{{
          engine.detail
        }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <!-- 平台服务（Mock） -->
    <el-card shadow="never" class="mb-3">
      <template #header>
        <div class="flex items-center justify-between">
          <span>平台服务状态（Mock）</span>
          <span
            v-if="status?.engine?.lastErrorAt"
            class="text-xs text-[--el-text-color-secondary]"
          >
            最近错误：{{ timeAgo(status.engine.lastErrorAt) }}
          </span>
        </div>
      </template>
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
      <el-table v-if="status" :data="status.services" stripe>
        <el-table-column prop="name" label="服务" min-width="140">
          <template #default="{ row }">
            <span class="font-mono">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="serviceTag(row.status)" size="small">{{
              row.status
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="version" label="版本" width="100" />
        <el-table-column prop="uptime" label="运行时长 Uptime" width="110" />
        <el-table-column prop="detail" label="详情" min-width="240" />
        <template #empty>
          <el-empty description="暂无服务数据" :image-size="60" />
        </template>
      </el-table>
    </el-card>

    <!-- 引擎概览（Mock 聚合） -->
    <el-card v-if="status" shadow="never" header="引擎概览（Mock 聚合）">
      <el-descriptions :column="4" border size="small">
        <el-descriptions-item label="世界数 Worlds">{{
          status.engine.worlds
        }}</el-descriptions-item>
        <el-descriptions-item label="运行中 Running">{{
          status.engine.running
        }}</el-descriptions-item>
        <el-descriptions-item label="Tick 速率 Tick Rate">{{
          status.engine.tickRate
        }}</el-descriptions-item>
        <el-descriptions-item label="最近错误 Last Error">
          {{
            status.engine.lastErrorAt ? fmtTime(status.engine.lastErrorAt) : "—"
          }}
        </el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>
