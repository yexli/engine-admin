<script setup lang="ts">
import { onMounted, ref } from "vue";
import { listMemoryStores, type MemoryStoreRow } from "@/api/memory";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "MemoryStores" });

const list = ref<MemoryStoreRow[]>([]);
const { loading, error, run } = useAsyncData();

async function load() {
  const res = await run(() => listMemoryStores());
  if (res?.data) list.value = res.data.list;
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <el-alert
      type="info"
      :closable="false"
      show-icon
      class="mb-3"
      title="Memory Store 清单为 Mock（memory/ 为纯库，HTTP API 待建，见 ADMIN-API-GAP.md）"
    />
    <el-row :gutter="12">
      <el-col v-for="s in list" :key="s.id" :md="8" :xs="24" class="mb-3">
        <el-card shadow="never">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="font-mono font-medium">{{ s.name }}</span>
              <el-tag
                :type="
                  s.status === 'healthy'
                    ? 'success'
                    : s.status === 'degraded'
                      ? 'warning'
                      : 'danger'
                "
                size="small"
              >
                {{ s.status }}
              </el-tag>
            </div>
          </template>
          <el-descriptions :column="1" size="small">
            <el-descriptions-item label="Provider">{{
              s.provider
            }}</el-descriptions-item>
            <el-descriptions-item label="Dimension">{{
              s.dimension
            }}</el-descriptions-item>
            <el-descriptions-item label="Document Count">
              {{ s.documentCount.toLocaleString() }}
            </el-descriptions-item>
            <el-descriptions-item label="说明">{{
              s.description
            }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
      </el-col>
    </el-row>

    <el-card v-if="!list.length" shadow="never">
      <el-empty v-if="!error && !loading" description="暂无 Memory Store" />
      <el-alert v-else-if="error" type="error" :closable="false" show-icon>
        <template #title>
          加载失败：{{ error }}
          <el-button text type="primary" size="small" @click="load"
            >重试</el-button
          >
        </template>
      </el-alert>
    </el-card>
  </div>
</template>
