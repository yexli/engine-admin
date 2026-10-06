<script setup lang="ts">
import { onMounted, ref } from "vue";
import { probeServices, type ServiceRow } from "@/api/system";
import { getWorlds } from "@/api/world";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePolling } from "@/composables/usePolling";

defineOptions({ name: "SystemStatus" });

const services = ref<ServiceRow[]>([]);
const engine = ref<{ online: boolean; worlds: number; detail: string }>({
  online: false,
  worlds: 0,
  detail: ""
});
const { loading, run } = useAsyncData();

async function load() {
  await run(
    async () => {
      const [rows, worlds] = await Promise.all([
        probeServices(),
        getWorlds()
          .then(r => ({ ok: true, list: r.worlds ?? [] }))
          .catch(e => ({
            ok: false,
            list: [],
            msg: e instanceof Error ? e.message : String(e)
          }))
      ]);
      services.value = rows;
      engine.value = {
        online: worlds.ok,
        worlds: worlds.list.length,
        detail: worlds.ok
          ? "引擎世界清单可读（/world-api 代理）"
          : `不可达：${(worlds as { msg?: string }).msg ?? ""}`
      };
    },
    { silent: true }
  );
}

const { polling, toggle, start } = usePolling(load, 15_000);

onMounted(async () => {
  await load();
  start();
});

function serviceTag(s: string) {
  return (s === "up" ? "success" : "danger") as "success" | "danger";
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

    <!-- 服务连通性（真实探测：同源代理） -->
    <el-card shadow="never" class="mb-3">
      <template #header>
        <div class="flex items-center justify-between">
          <span>服务连通性（真实探测，15s 轮询）</span>
          <span class="text-xs text-[--el-text-color-secondary]">
            状态 = 探测端点是否应答（不编造版本/运行时长）
          </span>
        </div>
      </template>
      <el-table :data="services" stripe>
        <el-table-column prop="name" label="服务" min-width="150">
          <template #default="{ row }">
            <span class="font-mono">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="serviceTag(row.status)" size="small">{{
              row.status
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="探测端点" min-width="220">
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.probe }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="detail" label="详情" min-width="220" />
        <template #empty>
          <el-empty description="暂无探测数据" :image-size="60" />
        </template>
      </el-table>
    </el-card>

    <!-- World Engine 直探（真实） -->
    <el-card shadow="never">
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
  </div>
</template>
