<script setup lang="ts">
import { ref } from "vue";
import { searchMemory, type RetrievalResultRow } from "@/api/memory";
import { message } from "@/utils/message";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "MemoryRetrieval" });

const query = ref("");
const entity = ref("");
const topK = ref(5);
const results = ref<RetrievalResultRow[]>([]);
const took = ref(0);
const searched = ref(false);
const { loading, error, run } = useAsyncData();

async function search() {
  if (!query.value.trim()) {
    message("请输入检索 Query", { type: "warning" });
    return;
  }
  const res = await run(() =>
    searchMemory({
      query: query.value.trim(),
      entity: entity.value || undefined,
      topK: topK.value
    })
  );
  searched.value = true;
  if (res?.data) {
    results.value = res.data.results;
    took.value = res.data.took;
  }
}
</script>

<template>
  <div class="p-4">
    <div class="flex justify-end mb-1">
      <MockTag
        detail="检索调试台（Mock 后端，形状与真实向量检索一致）：验证 Memory 是否正常工作"
      />
    </div>
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
        <el-form-item label="实体 Entity">
          <el-input
            v-model="entity"
            placeholder="可选，如 npc-blacksmith"
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
        <el-table-column min-width="280"
          ><template #header><BiText zh="记忆内容" en="Memory" /></template>
          <template #default="{ row }">
            <div class="text-sm">{{ row.content }}</div>
            <div
              class="text-xs text-[--el-text-color-secondary] mt-1 font-mono"
            >
              {{ row.id }}
            </div>
          </template>
        </el-table-column>
        <el-table-column width="150"
          ><template #header><BiText zh="相关度" en="Score" /></template>
          <template #default="{ row }">
            <div class="flex items-center gap-2">
              <el-progress
                :percentage="Number((row.score * 100).toFixed(1))"
                :stroke-width="8"
                :color="
                  row.score > 0.8
                    ? '#67c23a'
                    : row.score > 0.5
                      ? '#e6a23c'
                      : '#909399'
                "
                class="flex-1"
              />
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="source" width="120"
          ><template #header><BiText zh="来源" en="Source" /></template
        ></el-table-column>
        <el-table-column min-width="180"
          ><template #header><BiText zh="元数据" en="Metadata" /></template>
          <template #default="{ row }">
            <span class="text-xs" :title="JSON.stringify(row.metadata)">
              {{ JSON.stringify(row.metadata) }}
            </span>
          </template>
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
