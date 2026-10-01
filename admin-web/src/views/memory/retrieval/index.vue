<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  searchMemory,
  listMemoryStores,
  type RetrievalResultRow
} from "@/api/memory";
import { message } from "@/utils/message";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "MemoryRetrieval" });

const query = ref("");
const store = ref("");
const entity = ref("");
const topK = ref(5);
const storeOptions = ref<string[]>([]);
const results = ref<RetrievalResultRow[]>([]);
const took = ref(0);
const searched = ref(false);
const { loading, error, run } = useAsyncData();

async function loadStores() {
  const res = await run(() => listMemoryStores());
  if (res) storeOptions.value = (res.stores ?? []).map(s => s.name);
}

async function search() {
  if (!query.value.trim()) {
    message("请输入检索 Query", { type: "warning" });
    return;
  }
  const res = await run(() =>
    searchMemory({
      query: query.value.trim(),
      store: store.value || undefined,
      entity: entity.value || undefined,
      topK: topK.value
    })
  );
  searched.value = true;
  if (res) {
    results.value = res.results;
    took.value = res.took;
  }
}

onMounted(loadStores);
</script>

<template>
  <div class="p-4">
    <el-card shadow="never" class="mb-3">
      <el-form inline @submit.prevent="search">
        <el-form-item label="查询 Query">
          <el-input
            v-model="query"
            placeholder="如：铁匠对玩家的态度"
            class="!w-96"
            @keyup.enter="search"
          />
        </el-form-item>
        <el-form-item label="Store">
          <el-select
            v-model="store"
            placeholder="全部"
            clearable
            class="!w-40"
          >
            <el-option
              v-for="s in storeOptions"
              :key="s"
              :label="s"
              :value="s"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="实体 Entity">
          <el-input
            v-model="entity"
            placeholder="可选，缺省聚合全部 owner"
            class="!w-52"
            clearable
          />
        </el-form-item>
        <el-form-item label="Top K">
          <el-input-number v-model="topK" :min="1" :max="20" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="loading" @click="search">
            <IconifyIconOffline icon="ep/search" class="mr-1" />Search
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="flex items-center justify-between">
          <span>检索结果</span>
          <span
            v-if="searched && !error"
            class="text-xs text-[--el-text-color-secondary]"
          >
            {{ results.length }} 条 · {{ took }}ms
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
          检索失败：{{ error }}
          <el-button text type="primary" size="small" @click="search"
            >重试</el-button
          >
        </template>
      </el-alert>

      <el-table v-if="results.length" :data="results" stripe>
        <el-table-column min-width="260"
          ><template #header><BiText zh="记忆内容" en="Memory" /></template>
          <template #default="{ row }">
            <div class="text-sm">{{ row.content }}</div>
            <div
              class="text-xs text-[--el-text-color-secondary] mt-1 font-mono"
            >
              {{ row.id }} · D{{ row.day }} · {{ row.via }}
            </div>
          </template>
        </el-table-column>
        <el-table-column width="150"
          ><template #header><BiText zh="相关度" en="Score" /></template>
          <template #default="{ row }">
            <el-progress
              :percentage="Number(Math.min(100, row.score * 50).toFixed(1))"
              :stroke-width="8"
              :color="
                row.score > 1.2
                  ? '#67c23a'
                  : row.score > 0.7
                    ? '#e6a23c'
                    : '#909399'
              "
              class="flex-1"
            />
            <span class="text-xs tabular-nums">{{
              row.score.toFixed(3)
            }}</span>
          </template>
        </el-table-column>
        <el-table-column width="130"
          ><template #header><BiText zh="主人 / 类别" en="Owner·Kind" /></template>
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.metadata.owner }}</span>
            <div class="text-xs text-[--el-text-color-secondary]">
              {{ row.metadata.kind }}
            </div>
          </template>
        </el-table-column>
        <el-table-column width="100" align="center"
          ><template #header><BiText zh="置信度" en="Conf." /></template>
          <template #default="{ row }">{{
            Number(row.confidence).toFixed(2)
          }}</template>
        </el-table-column>
        <el-table-column width="90" align="center"
          ><template #header><BiText zh="召回" en="Recall" /></template>
          <template #default="{ row }">{{
            row.metadata.recallCount
          }}</template>
        </el-table-column>
      </el-table>
      <el-empty
        v-else
        :description="
          searched ? '无匹配结果' : '输入 Query 并点击 Search 验证记忆检索'
        "
        :image-size="72"
      />
    </el-card>
  </div>
</template>
