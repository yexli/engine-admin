<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getEmbeddingInfo, type EmbeddingInfo } from "@/api/memory";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "MemoryEmbedding" });

const info = ref<EmbeddingInfo | null>(null);
const { loading, error, run } = useAsyncData();

async function load() {
  const res = await run(() => getEmbeddingInfo());
  if (res?.data) info.value = res.data;
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <div class="flex justify-end mb-1">
      <MockTag
        detail="Embedding 模型与统计为 Mock（Embedding 调用统计 API 待建，见 ADMIN-API-GAP.md）"
      />
    </div>
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

      <el-row v-if="info" :gutter="12" class="mb-3">
        <el-col :xs="12" :md="6">
          <el-card shadow="never">
            <div class="text-xs text-[--el-text-color-secondary]">
              总向量化条数
            </div>
            <div class="text-xl font-semibold">
              {{ info.stats.totalEmbeddings.toLocaleString() }}
            </div>
          </el-card>
        </el-col>
        <el-col :xs="12" :md="6">
          <el-card shadow="never">
            <div class="text-xs text-[--el-text-color-secondary]">近 24h</div>
            <div class="text-xl font-semibold">{{ info.stats.last24h }}</div>
          </el-card>
        </el-col>
        <el-col :xs="12" :md="6">
          <el-card shadow="never">
            <div class="text-xs text-[--el-text-color-secondary]">平均延迟</div>
            <div class="text-xl font-semibold">
              {{ info.stats.avgLatencyMs }}ms
            </div>
          </el-card>
        </el-col>
        <el-col :xs="12" :md="6">
          <el-card shadow="never">
            <div class="text-xs text-[--el-text-color-secondary]">失败率</div>
            <div class="text-xl font-semibold">
              {{ info.stats.failureRate }}%
            </div>
          </el-card>
        </el-col>
      </el-row>

      <el-card v-if="info" shadow="never" header="Embedding Models">
        <el-table :data="info.models" stripe>
          <el-table-column prop="name" min-width="200"
            ><template #header><BiText zh="模型" en="Model" /></template>
            <template #default="{ row }">
              <span class="font-mono">{{ row.name }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="provider" min-width="120"
            ><template #header><BiText zh="提供方" en="Provider" /></template
          ></el-table-column>
          <el-table-column prop="dimension" width="110" align="center"
            ><template #header><BiText zh="维度" en="Dimension" /></template
          ></el-table-column>
          <el-table-column width="100" align="center"
            ><template #header><BiText zh="状态" en="Status" /></template>
            <template #default="{ row }">
              <el-tag
                :type="row.status === 'enabled' ? 'success' : 'info'"
                size="small"
              >
                {{ row.status }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>
  </div>
</template>
