<!-- Relations 面板：M1.3 起走真实独立端点（状态关系表 + 实体关系边双视图，服务端筛选） -->
<template>
  <div>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <el-input
        v-model="keyword"
        placeholder="搜索 Source / Target / 类型"
        clearable
        class="!w-64"
        @keyup.enter="load"
        @clear="load"
      />
      <el-button :loading="loading" @click="load">
        <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
      </el-button>
      <span class="text-xs text-[--el-text-color-secondary]">
        关系 = 有向、带类型的边；数值含义由世界定义，前端不做语义假设
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

    <el-tabs v-model="tab">
      <el-tab-pane
        :label="`状态关系表（${totals.state}）`"
        name="state"
      >
        <el-table v-loading="loading" :data="stateRelations" stripe>
          <el-table-column prop="source" min-width="130" show-overflow-tooltip>
            <template #header><BiText zh="发起方" en="Source" /></template>
          </el-table-column>
          <el-table-column prop="type" min-width="110">
            <template #header><BiText zh="关系类型" en="Type" /></template>
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ row.type }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="target" min-width="130" show-overflow-tooltip>
            <template #header><BiText zh="接收方" en="Target" /></template>
          </el-table-column>
          <el-table-column width="100">
            <template #header><BiText zh="数值" en="Value" /></template>
            <template #default="{ row }">{{ row.value ?? "—" }}</template>
          </el-table-column>
          <el-table-column min-width="180">
            <template #header><BiText zh="元数据" en="Metadata" /></template>
            <template #default="{ row }">
              <span class="text-xs" :title="JSON.stringify(row.metadata ?? {})">
                {{ row.metadata ? JSON.stringify(row.metadata) : "—" }}
              </span>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty
              description="世界状态无 relations 记录"
              :image-size="60"
            />
          </template>
        </el-table>
      </el-tab-pane>

      <el-tab-pane
        :label="`实体关系边（${totals.edges}）`"
        name="edges"
      >
        <el-table v-loading="loading" :data="edgeRelations" stripe>
          <el-table-column prop="source" min-width="130" show-overflow-tooltip>
            <template #header><BiText zh="发起方" en="Source" /></template>
          </el-table-column>
          <el-table-column prop="type" min-width="110">
            <template #header><BiText zh="边类型" en="Type" /></template>
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ row.type }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="target" min-width="130" show-overflow-tooltip>
            <template #header><BiText zh="接收方" en="Target" /></template>
          </el-table-column>
          <el-table-column width="100">
            <template #header><BiText zh="数值" en="Value" /></template>
            <template #default="{ row }">
              <span
                :class="
                  Number(row.value) < 0
                    ? 'text-[--el-color-danger]'
                    : 'text-[--el-color-success]'
                "
              >
                {{ row.value ?? "—" }}
              </span>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty
              description="实体暂无关系边（rels 邻接表为空）"
              :image-size="60"
            />
          </template>
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { listRelations, type RelationRecord } from "@/api/relation";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "RelationsPanel" });

const props = defineProps<{ worldId: string }>();

const keyword = ref("");
const tab = ref("state");
const stateRelations = ref<RelationRecord[]>([]);
const edgeRelations = ref<RelationRecord[]>([]);
const totals = ref({ state: 0, edges: 0 });
const { loading, error, run } = useAsyncData();

async function load() {
  if (!props.worldId) return;
  const res = await run(() =>
    listRelations(props.worldId, { q: keyword.value || undefined })
  );
  if (res) {
    stateRelations.value = res.stateRelations;
    edgeRelations.value = res.edgeRelations;
    totals.value = res.totals;
  }
}

watch(
  () => props.worldId,
  load,
  { immediate: true }
);
defineExpose({ reload: load });
</script>
