<script setup lang="ts">
import { onMounted, ref } from "vue";
import { listModels, type ModelRow } from "@/api/model";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "GatewayModels" });

const CAPABILITIES = [
  "fast",
  "cheap",
  "reasoning",
  "roleplay",
  "narrative",
  "memory",
  "embedding"
];

const list = ref<ModelRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const providerFilter = ref("");
const capFilter = ref("");
const statusFilter = ref("");
const { loading, error, run } = useAsyncData();

async function load() {
  const res = await run(() =>
    listModels({
      page: page.value,
      pageSize: pageSize.value,
      provider: providerFilter.value || undefined,
      capability: capFilter.value || undefined,
      status: statusFilter.value || undefined
    })
  );
  if (res?.data) {
    list.value = res.data.list;
    total.value = res.data.total;
  }
}

function capTag(c: string) {
  const map: Record<string, string> = {
    fast: "success",
    cheap: "info",
    reasoning: "warning",
    roleplay: "danger",
    narrative: "primary",
    memory: "success",
    embedding: "info"
  };
  return (map[c] ?? "info") as
    "success" | "info" | "warning" | "danger" | "primary";
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
      title="Model 清单为 Mock（数据驱动，不把厂商写死在页面结构中；管理面 API 待建，见 ADMIN-API-GAP.md）"
    />
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-input
          v-model="providerFilter"
          placeholder="Provider（如 openai）"
          clearable
          class="!w-48"
          @change="load"
        />
        <el-select
          v-model="capFilter"
          placeholder="能力筛选"
          clearable
          class="!w-40"
          @change="load"
        >
          <el-option v-for="c in CAPABILITIES" :key="c" :label="c" :value="c" />
        </el-select>
        <el-select
          v-model="statusFilter"
          placeholder="状态"
          clearable
          class="!w-32"
          @change="load"
        >
          <el-option label="启用" value="enabled" />
          <el-option label="停用" value="disabled" />
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

      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="name" label="模型 Model" min-width="180">
          <template #default="{ row }">
            <span class="font-mono font-medium">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column
          prop="provider"
          label="提供方 Provider"
          min-width="110"
        />
        <el-table-column label="能力 Capabilities" min-width="220">
          <template #default="{ row }">
            <el-tag
              v-for="c in row.capabilities"
              :key="c"
              size="small"
              :type="capTag(c)"
              class="mr-1"
            >
              {{ c }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="上下文 Context" width="110" align="right">
          <template #default="{ row }"
            >{{ (row.contextWindow / 1000).toFixed(0) }}K</template
          >
        </el-table-column>
        <el-table-column label="定价 Pricing（输入/输出）" min-width="170">
          <template #default="{ row }">
            ${{ row.pricing.input }} / ${{ row.pricing.output }}
            <span class="text-xs text-[--el-text-color-secondary]">{{
              row.pricing.currency
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态 Status" width="100" align="center">
          <template #default="{ row }">
            <el-tag
              :type="row.status === 'enabled' ? 'success' : 'danger'"
              size="small"
            >
              {{ row.status === "enabled" ? "启用" : "停用" }}
            </el-tag>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无模型" :image-size="64" />
        </template>
      </el-table>

      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        layout="total, sizes, prev, pager, next"
        :page-sizes="[10, 20, 50]"
        class="mt-3 justify-end"
        @current-change="load"
        @size-change="load"
      />
    </el-card>
  </div>
</template>
