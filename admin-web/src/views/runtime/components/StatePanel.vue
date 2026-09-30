<!-- State 面板：概览 + Raw JSON（真实引擎数据） -->
<template>
  <div v-loading="loading">
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

    <template v-if="state">
      <el-row :gutter="12" class="mb-3">
        <el-col
          v-for="item in overview"
          :key="item.zh"
          :xs="12"
          :sm="8"
          :md="4"
        >
          <el-card shadow="never" class="mb-2">
            <BiText
              :zh="item.zh"
              :en="item.en"
              class="text-[--el-text-color-secondary]! text-xs!"
            />
            <div
              class="text-lg font-semibold mt-1 truncate"
              :title="String(item.value)"
            >
              {{ item.value }}
            </div>
          </el-card>
        </el-col>
      </el-row>

      <el-row :gutter="12">
        <el-col :md="12" class="mb-3">
          <el-card shadow="never">
            <template #header><BiText zh="世界变量" en="Variables" /></template>
            <el-empty
              v-if="!Object.keys(state.variables ?? {}).length"
              description="无变量"
              :image-size="48"
            />
            <el-descriptions v-else :column="1" border size="small">
              <el-descriptions-item
                v-for="(v, k) in state.variables"
                :key="k"
                :label="String(k)"
              >
                {{ typeof v === "object" ? JSON.stringify(v) : v }}
              </el-descriptions-item>
            </el-descriptions>
          </el-card>
        </el-col>
        <el-col :md="12" class="mb-3">
          <el-card shadow="never">
            <template #header>
              <BiText zh="元数据 / 声望 / 章节摘要" en="Metadata" />
            </template>
            <el-descriptions :column="1" border size="small">
              <el-descriptions-item label="种子 Seed">{{
                state.seed ?? "—"
              }}</el-descriptions-item>
              <el-descriptions-item label="版本 Ver">{{
                state.ver
              }}</el-descriptions-item>
              <el-descriptions-item label="摘要 Recap">
                {{ state.recap?.length ? state.recap.join(" / ") : "—" }}
              </el-descriptions-item>
            </el-descriptions>
            <div class="mt-2 text-xs text-[--el-text-color-secondary]">
              声望：{{
                Object.keys(state.rep ?? {}).length
                  ? JSON.stringify(state.rep)
                  : "无"
              }}
            </div>
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never">
        <template #header>
          <BiText zh="原始 JSON（只读，修改必须走命令）" en="Raw JSON" />
        </template>
        <JsonView :data="state" height="420px" />
      </el-card>
    </template>
    <el-empty v-else-if="!loading && !error" description="暂无状态数据" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { EngineWorldState } from "@/api/types";
import { getWorldState } from "@/api/world";
import JsonView from "@/components/JsonView/index.vue";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "StatePanel" });

const props = defineProps<{ worldId: string }>();

const state = ref<EngineWorldState | null>(null);
const { loading, error, run } = useAsyncData();

async function load() {
  if (!props.worldId) return;
  const res = await run(() => getWorldState(props.worldId));
  if (res) state.value = res;
}

watch(() => props.worldId, load, { immediate: true });

defineExpose({ reload: load });

const overview = computed(() => {
  const s = state.value;
  if (!s) return [];
  return [
    { zh: "总刻数", en: "Tick", value: s.t },
    { zh: "天气", en: "Weather", value: s.weather || "—" },
    {
      zh: "实体数",
      en: "Entities",
      value: Object.keys(s.npcs ?? {}).length + 1
    },
    {
      zh: "地点数",
      en: "Locations",
      value: Object.keys(s.locations ?? {}).length
    },
    {
      zh: "关系数",
      en: "Relations",
      value:
        (s.relations?.length ?? 0) +
        Object.values(s.npcs ?? {}).reduce(
          (acc, n) => acc + Object.keys(n.rels ?? {}).length,
          0
        )
    },
    { zh: "事件数", en: "Events", value: s.events?.length ?? 0 }
  ];
});
</script>
