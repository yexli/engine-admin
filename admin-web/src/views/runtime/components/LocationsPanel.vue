<!-- Locations 面板：地点表 + 实体驻留（真实引擎数据，从 state 派生） -->
<template>
  <div>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <el-input
        v-model="keyword"
        placeholder="搜索地点 ID"
        clearable
        class="!w-56"
      />
      <el-button :loading="loading" @click="load">
        <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
      </el-button>
      <span class="text-xs text-[--el-text-color-secondary]">
        地点表（id/type/attributes）由 World State 派生
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

    <el-table v-loading="loading" :data="filtered" stripe>
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
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { listLocations, type LocationView } from "@/api/location";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "LocationsPanel" });

const props = defineProps<{ worldId: string }>();

const keyword = ref("");
const locations = ref<LocationView[]>([]);
const unknown = ref<string[]>([]);
const { loading, error, run } = useAsyncData();

const filtered = computed(() =>
  locations.value.filter(l => !keyword.value || l.id.includes(keyword.value))
);

async function load() {
  if (!props.worldId) return;
  const res = await run(() => listLocations(props.worldId));
  if (res) {
    locations.value = res.locations;
    unknown.value = res.unknown;
  }
}

watch(() => props.worldId, load, { immediate: true });
defineExpose({ reload: load });
</script>
