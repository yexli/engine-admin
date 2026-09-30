<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { listPlatformEvents, type EventStreamRow } from "@/api/event";
import { useAsyncData, fmtTime } from "@/composables/useAsyncData";
import { usePolling } from "@/composables/usePolling";

defineOptions({ name: "ObsEvents" });

const list = ref<EventStreamRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const filters = ref({ type: "", worldId: "", status: "" });
const { loading, error, run } = useAsyncData();

async function load() {
  const res = await run(() =>
    listPlatformEvents({
      page: page.value,
      pageSize: pageSize.value,
      type: filters.value.type || undefined,
      worldId: filters.value.worldId || undefined,
      status: filters.value.status || undefined
    })
  );
  if (res?.data) {
    list.value = res.data.list;
    total.value = res.data.total;
  }
}

const { polling, toggle, start } = usePolling(load, 10_000);

onMounted(start);

function levelTag(level: number) {
  return (["info", "primary", "warning", "danger"] as const)[level] ?? "info";
}

watch(
  () => filters.value.worldId,
  () => {
    page.value = 1;
    load();
  }
);

function reset() {
  filters.value = { type: "", worldId: "", status: "" };
  page.value = 1;
  load();
}
</script>

<template>
  <div class="p-4">
    <div class="flex justify-end mb-1">
      <MockTag
        detail="平台事件流为 Mock（跨世界聚合事件流 API 待建）；查看单个世界的事实请到 Runtime → Events（真实引擎数据）"
      />
    </div>
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-input
          v-model="filters.type"
          placeholder="事件类型（如 npc_attitude_shift）"
          clearable
          class="!w-64"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        />
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
        <el-select
          v-model="filters.status"
          placeholder="状态"
          clearable
          class="!w-36"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        >
          <el-option label="delivered" value="delivered" />
          <el-option label="dead-letter" value="dead-letter" />
        </el-select>
        <el-button :loading="loading" @click="load">
          <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
        </el-button>
        <el-button
          :type="polling ? 'primary' : 'default'"
          @click="polling = !polling"
        >
          {{ polling ? "10s 轮询中" : "已暂停" }}
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
        <el-table-column prop="id" width="100"
          ><template #header><BiText zh="事件" en="ID Event ID" /></template>
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.id }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="type" label="类型" min-width="170">
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.type }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="worldId" width="100"
          ><template #header><BiText zh="世界" en="World" /></template
        ></el-table-column>
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
        <el-table-column width="110" align="center"
          ><template #header><BiText zh="状态" en="Status" /></template>
          <template #default="{ row }">
            <el-tag
              :type="row.status === 'delivered' ? 'success' : 'danger'"
              size="small"
            >
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无事件" :image-size="64" />
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
