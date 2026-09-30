<script setup lang="ts">
import { onMounted, ref } from "vue";
import { listLogs, type LogRow } from "@/api/logs";
import { useAsyncData, fmtTime } from "@/composables/useAsyncData";

defineOptions({ name: "ObsLogs" });

const list = ref<LogRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const filters = ref({ level: "", service: "", worldId: "", keyword: "" });
const { loading, error, run } = useAsyncData();

const LEVELS = ["debug", "info", "warn", "error"];
const SERVICES = ["world-engine", "ai-gateway", "memory", "admin-api"];

async function load() {
  const res = await run(() =>
    listLogs({
      page: page.value,
      pageSize: pageSize.value,
      level: filters.value.level || undefined,
      service: filters.value.service || undefined,
      worldId: filters.value.worldId || undefined,
      keyword: filters.value.keyword || undefined
    })
  );
  if (res?.data) {
    list.value = res.data.list;
    total.value = res.data.total;
  }
}

function levelTag(level: string) {
  return ({ debug: "info", info: "primary", warn: "warning", error: "danger" }[
    level
  ] ?? "info") as "info" | "primary" | "warning" | "danger";
}

function reset() {
  filters.value = { level: "", service: "", worldId: "", keyword: "" };
  page.value = 1;
  load();
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <div class="flex justify-end mb-1">
      <MockTag
        detail="平台日志为 Mock（聚合日志查询 API 待建，见 ADMIN-API-GAP.md）"
      />
    </div>
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-select
          v-model="filters.level"
          placeholder="Level"
          clearable
          class="!w-32"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        >
          <el-option v-for="l in LEVELS" :key="l" :label="l" :value="l" />
        </el-select>
        <el-select
          v-model="filters.service"
          placeholder="Service"
          clearable
          class="!w-44"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        >
          <el-option v-for="s in SERVICES" :key="s" :label="s" :value="s" />
        </el-select>
        <el-input
          v-model="filters.worldId"
          placeholder="World ID"
          clearable
          class="!w-40"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        />
        <el-input
          v-model="filters.keyword"
          placeholder="消息关键词"
          clearable
          class="!w-48"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        />
        <el-button :loading="loading" @click="load">
          <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
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
        <el-table-column width="160"
          ><template #header><BiText zh="时间" en="Time" /></template>
          <template #default="{ row }">{{ fmtTime(row.time) }}</template>
        </el-table-column>
        <el-table-column width="80" align="center"
          ><template #header><BiText zh="级别" en="Level" /></template>
          <template #default="{ row }">
            <el-tag :type="levelTag(row.level)" size="small">{{
              row.level
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="service" width="130"
          ><template #header><BiText zh="服务" en="Service" /></template
        ></el-table-column>
        <el-table-column width="100"
          ><template #header><BiText zh="世界" en="World" /></template>
          <template #default="{ row }">{{ row.worldId ?? "—" }}</template>
        </el-table-column>
        <el-table-column prop="requestId" min-width="130"
          ><template #header><BiText zh="请求" en="ID Request ID" /></template>
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.requestId }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="message" min-width="240" show-overflow-tooltip
          ><template #header><BiText zh="消息" en="Message" /></template
        ></el-table-column>
        <template #empty>
          <el-empty description="暂无日志" :image-size="64" />
        </template>
      </el-table>

      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        layout="total, sizes, prev, pager, next"
        :page-sizes="[20, 50, 100]"
        class="mt-3 justify-end"
        @current-change="load"
        @size-change="load"
      />
    </el-card>
  </div>
</template>
