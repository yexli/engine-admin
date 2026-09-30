<!-- Entities 面板：实体列表 + 详情抽屉（真实引擎数据，从 state 派生） -->
<template>
  <div>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <el-input
        v-model="keyword"
        placeholder="搜索实体 ID"
        clearable
        class="!w-56"
      />
      <el-select
        v-model="typeFilter"
        placeholder="类型筛选"
        clearable
        class="!w-36"
      >
        <el-option label="npc" value="npc" />
        <el-option label="character" value="character" />
        <el-option label="building" value="building" />
        <el-option label="vehicle" value="vehicle" />
      </el-select>
      <el-button :loading="loading" @click="load">
        <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
      </el-button>
      <span class="text-xs text-[--el-text-color-secondary]">
        实体视图由 World State 派生；修改请走命令调试台
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

    <el-table
      v-loading="loading"
      :data="filtered"
      size="default"
      stripe
      @row-click="row => openDetail(row.id)"
    >
      <el-table-column prop="id" min-width="140" show-overflow-tooltip>
        <template #header><BiText zh="实体 ID" en="Entity ID" /></template>
      </el-table-column>
      <el-table-column prop="type" width="110">
        <template #header><BiText zh="类型" en="Type" /></template>
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ row.type }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column width="150">
        <template #header><BiText zh="态度" en="Attitude" /></template>
        <template #default="{ row }">
          <div class="flex items-center gap-2">
            <el-progress
              :percentage="(row.att + 100) / 2"
              :stroke-width="8"
              :show-text="false"
              :color="attColor(row.att)"
              class="flex-1"
            />
            <span class="text-xs tabular-nums w-8 text-right">{{
              row.att
            }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="location" min-width="110" show-overflow-tooltip>
        <template #header><BiText zh="位置" en="Location" /></template>
      </el-table-column>
      <el-table-column width="70">
        <template #header><BiText zh="相识" en="Met" /></template>
        <template #default="{ row }">
          <el-tag :type="row.met ? 'success' : 'info'" size="small">
            {{ row.met ? "是" : "否" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="bagCount" width="70" align="center">
        <template #header><BiText zh="背包" en="Bag" /></template>
      </el-table-column>
      <el-table-column prop="relCount" width="70" align="center">
        <template #header><BiText zh="关系" en="Rels" /></template>
      </el-table-column>
      <el-table-column label="操作" width="80" fixed="right">
        <template #default="{ row }">
          <el-button
            text
            type="primary"
            size="small"
            @click.stop="openDetail(row.id)"
          >
            详情
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="暂无实体（或引擎不可达）" :image-size="60" />
      </template>
    </el-table>

    <!-- 实体详情抽屉 -->
    <el-drawer v-model="drawer" :title="`实体详情 · ${detailId}`" size="560px">
      <div v-loading="detailLoading">
        <template v-if="detail">
          <el-descriptions :column="2" border size="small" class="mb-3">
            <el-descriptions-item label="ID">{{
              detail.id
            }}</el-descriptions-item>
            <el-descriptions-item label="类型 Type">{{
              detail.type
            }}</el-descriptions-item>
            <el-descriptions-item label="态度 Attitude">{{
              detail.att
            }}</el-descriptions-item>
            <el-descriptions-item label="相识 Met">{{
              detail.met ? "是" : "否"
            }}</el-descriptions-item>
            <el-descriptions-item label="位置 Location" :span="2">{{
              detail.location
            }}</el-descriptions-item>
            <el-descriptions-item label="金币 Gold">{{
              detail.gold ?? "—"
            }}</el-descriptions-item>
            <el-descriptions-item label="记忆条目 Mem">{{
              detail.memCount
            }}</el-descriptions-item>
          </el-descriptions>

          <el-collapse>
            <el-collapse-item title="属性袋 Attributes">
              <JsonView :data="detail.raw.attributes ?? {}" height="220px" />
            </el-collapse-item>
            <el-collapse-item title="背包 / 效果 Bag & Effects">
              <JsonView
                :data="{
                  bag: detail.raw.bag ?? [],
                  effects: detail.raw.effects ?? []
                }"
                height="220px"
              />
            </el-collapse-item>
            <el-collapse-item
              :title="`关系 Relations（${detailRelations.length}）`"
            >
              <el-table :data="detailRelations" size="small">
                <el-table-column
                  prop="target"
                  label="对象 Target"
                  min-width="100"
                />
                <el-table-column prop="type" label="类型" min-width="90" />
                <el-table-column prop="value" label="数值" width="80" />
              </el-table>
            </el-collapse-item>
            <el-collapse-item title="原始数据 Raw Data">
              <JsonView :data="detail.raw" height="260px" />
            </el-collapse-item>
          </el-collapse>
        </template>
        <el-empty v-else-if="!detailLoading" description="实体不存在" />
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  listEntities,
  getEntity,
  type EntityView,
  type RelationView
} from "@/api/entity";
import { useAsyncData } from "@/composables/useAsyncData";
import JsonView from "@/components/JsonView/index.vue";

defineOptions({ name: "EntitiesPanel" });

const props = defineProps<{ worldId: string }>();

const keyword = ref("");
const typeFilter = ref("");
const entities = ref<EntityView[]>([]);
const player = ref<{ name: string; loc: string } | null>(null);
const { loading, error, run } = useAsyncData();

const drawer = ref(false);
const detailId = ref("");
const detail = ref<EntityView | null>(null);
const detailRelations = ref<RelationView[]>([]);
const { loading: detailLoading, run: runDetail } = useAsyncData();

const filtered = computed(() =>
  entities.value.filter(
    e =>
      (!keyword.value || e.id.includes(keyword.value)) &&
      (!typeFilter.value || e.type === typeFilter.value)
  )
);

async function load() {
  if (!props.worldId) return;
  const res = await run(() => listEntities(props.worldId));
  if (res) {
    entities.value = res.entities;
    player.value = res.player;
  }
}

async function openDetail(id: string) {
  detailId.value = id;
  drawer.value = true;
  const res = await runDetail(() => getEntity(props.worldId, id));
  if (res) {
    detail.value = res.entity;
    detailRelations.value = res.relations;
  } else {
    detail.value = null;
    detailRelations.value = [];
  }
}

function attColor(att: number): string {
  if (att >= 30) return "#67c23a";
  if (att <= -30) return "#f56c6c";
  return "#e6a23c";
}

watch(() => props.worldId, load, { immediate: true });
defineExpose({ reload: load });
</script>
