<!-- Events 面板：世界事实列表 + 详情（含因果链）（真实引擎数据） -->
<template>
  <div>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <el-input
        v-model="typeFilter"
        placeholder="按类型过滤（如 npc_attitude_shift）"
        clearable
        class="!w-64"
      />
      <el-select
        v-model="actorFilter"
        placeholder="Actor"
        clearable
        class="!w-40"
      >
        <el-option v-for="a in actors" :key="a" :label="a" :value="a" />
      </el-select>
      <el-select
        v-model="levelFilter"
        placeholder="分级"
        clearable
        class="!w-32"
      >
        <el-option label="0 内部" :value="0" />
        <el-option label="1 局部" :value="1" />
        <el-option label="2 跨系统" :value="2" />
        <el-option label="3 复杂世界" :value="3" />
      </el-select>
      <el-button :loading="loading" @click="load">
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
        <el-button text type="primary" size="small" @click="load"
          >重试</el-button
        >
      </template>
    </el-alert>

    <el-table
      v-loading="loading"
      :data="filtered"
      stripe
      size="default"
      @row-click="row => openDetail(row)"
    >
      <el-table-column prop="id" min-width="90" show-overflow-tooltip>
        <template #header><BiText zh="事件 ID" en="Event ID" /></template>
      </el-table-column>
      <el-table-column
        prop="type"
        label="类型"
        min-width="160"
        show-overflow-tooltip
      >
        <template #default="{ row }">
          <span class="font-mono text-xs">{{ row.type }}</span>
        </template>
      </el-table-column>
      <el-table-column label="分级" width="90" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="levelTag(row.level)"
            >L{{ row.level }}</el-tag
          >
        </template>
      </el-table-column>
      <el-table-column prop="actor" min-width="110" show-overflow-tooltip>
        <template #header><BiText zh="行为者" en="Actor" /></template>
        <template #default="{ row }">{{ row.actor ?? "—" }}</template>
      </el-table-column>
      <el-table-column prop="target" min-width="110" show-overflow-tooltip>
        <template #header><BiText zh="对象" en="Target" /></template>
        <template #default="{ row }">{{ row.target ?? "—" }}</template>
      </el-table-column>
      <el-table-column width="100" align="center">
        <template #header><BiText zh="天 / 刻" en="Day·Tick" /></template>
        <template #default="{ row }">D{{ row.day }} · {{ row.tick }}</template>
      </el-table-column>
      <el-table-column prop="cause" min-width="90" show-overflow-tooltip>
        <template #header><BiText zh="因果" en="Causal" /></template>
        <template #default="{ row }">{{
          row.cause ?? row.parent ?? "—"
        }}</template>
      </el-table-column>
      <template #empty>
        <el-empty description="暂无事件" :image-size="60" />
      </template>
    </el-table>

    <!-- 事件详情 -->
    <el-drawer
      v-model="drawer"
      :title="`事件详情 · ${detail?.id ?? ''}`"
      size="520px"
    >
      <template v-if="detail">
        <el-descriptions :column="2" border size="small" class="mb-3">
          <el-descriptions-item label="类型" :span="2">
            <span class="font-mono text-xs">{{ detail.type }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="天 Day">{{
            detail.day
          }}</el-descriptions-item>
          <el-descriptions-item label="刻 Tick">{{
            detail.tick
          }}</el-descriptions-item>
          <el-descriptions-item label="行为者 Actor">{{
            detail.actor ?? "—"
          }}</el-descriptions-item>
          <el-descriptions-item label="对象 Target">{{
            detail.target ?? "—"
          }}</el-descriptions-item>
          <el-descriptions-item label="位置 Location">{{
            detail.location ?? "—"
          }}</el-descriptions-item>
          <el-descriptions-item label="分级"
            >L{{ detail.level }}</el-descriptions-item
          >
          <el-descriptions-item label="目击者 Witnesses" :span="2">
            {{ detail.witnesses?.join("、") ?? "—" }}
          </el-descriptions-item>
        </el-descriptions>

        <el-collapse>
          <el-collapse-item title="载荷 Payload">
            <JsonView :data="detail.data ?? {}" height="200px" />
          </el-collapse-item>
          <el-collapse-item title="因果链（向上追溯）Causal Chain">
            <el-empty
              v-if="causalChain.length <= 1"
              description="无更上游因果（根事件）"
              :image-size="40"
            />
            <el-steps v-else direction="vertical" :active="causalChain.length">
              <el-step
                v-for="e in causalChain"
                :key="e.id"
                :title="`${e.type}（${e.id}）`"
                :description="`D${e.day} · ${e.tick}`"
              />
            </el-steps>
          </el-collapse-item>
          <el-collapse-item title="原始 JSON Raw JSON">
            <JsonView :data="detail" height="240px" />
          </el-collapse-item>
        </el-collapse>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  listWorldEvents,
  buildCausalChain,
  type WorldEvent
} from "@/api/event";
import { useAsyncData } from "@/composables/useAsyncData";
import JsonView from "@/components/JsonView/index.vue";

defineOptions({ name: "EventsPanel" });

const props = defineProps<{ worldId: string }>();

const events = ref<WorldEvent[]>([]);
const typeFilter = ref("");
const actorFilter = ref("");
const levelFilter = ref<number | null>(null);
const { loading, error, run } = useAsyncData();

const drawer = ref(false);
const detail = ref<WorldEvent | null>(null);

const actors = computed(() => [
  ...new Set(events.value.map(e => e.actor).filter(Boolean) as string[])
]);

const filtered = computed(() =>
  events.value.filter(
    e =>
      (!typeFilter.value || e.type.includes(typeFilter.value)) &&
      (!actorFilter.value || e.actor === actorFilter.value) &&
      (levelFilter.value === null ||
        levelFilter.value === undefined ||
        e.level === levelFilter.value)
  )
);

const causalChain = computed(() =>
  detail.value ? buildCausalChain(events.value, detail.value.id) : []
);

async function load() {
  if (!props.worldId) return;
  const res = await run(() => listWorldEvents(props.worldId, 100));
  if (res) events.value = res.events ?? [];
}

function openDetail(row: WorldEvent) {
  detail.value = row;
  drawer.value = true;
}

function levelTag(level: number) {
  return (["info", "primary", "warning", "danger"] as const)[level] ?? "info";
}

watch(() => props.worldId, load, { immediate: true });
defineExpose({ reload: load });
</script>
