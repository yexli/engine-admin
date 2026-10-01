<!-- Locations 面板：M1.3 起走真实独立端点（服务端派生驻留统计与完整性告警） -->
<template>
  <div>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <el-input
        v-model="keyword"
        placeholder="搜索地点 ID"
        clearable
        class="!w-56"
        @keyup.enter="load"
        @clear="load"
      />
      <el-button :loading="loading" @click="load">
        <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
      </el-button>
      <span class="text-xs text-[--el-text-color-secondary]">
        服务端端点（GET /locations）；驻留统计与完整性告警由引擎侧派生
      </span>
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

    <el-alert
      v-if="unknown.length"
      type="warning"
      :closable="false"
      class="mb-3"
      show-icon
    >
      <template #title>
        有实体位于地点表之外的位置：{{ unknown.join("、") }}
      </template>
    </el-alert>

    <el-table v-loading="loading" :data="locations" stripe>
      <el-table-column prop="id" min-width="140" show-overflow-tooltip>
        <template #header><BiText zh="地点 ID" en="Location ID" /></template>
      </el-table-column>
      <el-table-column width="120">
        <template #header><BiText zh="类型" en="Type" /></template>
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ row.type ?? "—" }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="entityCount" width="90" align="center">
        <template #header><BiText zh="实体数" en="Entities" /></template>
      </el-table-column>
      <el-table-column min-width="180">
        <template #header><BiText zh="驻留实体" en="Occupants" /></template>
        <template #default="{ row }">
          <el-tag
            v-for="o in row.occupants.slice(0, 4)"
            :key="o"
            size="small"
            class="mr-1"
            type="info"
          >
            {{ o }}
          </el-tag>
          <span
            v-if="row.occupants.length > 4"
            class="text-xs text-[--el-text-color-secondary]"
          >
            +{{ row.occupants.length - 4 }}
          </span>
        </template>
      </el-table-column>
      <el-table-column min-width="200">
        <template #header><BiText zh="属性" en="Attributes" /></template>
        <template #default="{ row }">
          <span
            class="text-xs truncate block"
            :title="JSON.stringify(row.attributes ?? {})"
          >
            {{
              Object.keys(row.attributes ?? {}).length
                ? JSON.stringify(row.attributes)
                : "—"
            }}
          </span>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty
          description="暂无地点（世界未定义 locations 表）"
          :image-size="60"
        />
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
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { listLocations, type LocationView } from "@/api/location";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "LocationsPanel" });

const props = defineProps<{ worldId: string }>();

const keyword = ref("");
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const locations = ref<LocationView[]>([]);
const unknown = ref<string[]>([]);
const { loading, error, run } = useAsyncData();

async function load() {
  if (!props.worldId) return;
  const res = await run(() =>
    listLocations(props.worldId, {
      q: keyword.value || undefined,
      page: page.value,
      pageSize: pageSize.value
    })
  );
  if (res) {
    locations.value = res.locations;
    total.value = res.total;
    unknown.value = res.unknown;
  }
}

watch(
  () => props.worldId,
  () => {
    page.value = 1;
    load();
  },
  { immediate: true }
);
defineExpose({ reload: load });
</script>
