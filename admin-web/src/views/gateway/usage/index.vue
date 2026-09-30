<script setup lang="ts">
import { onMounted, ref } from "vue";
import { listUsage, type UsageData, type UsageRow } from "@/api/usage";
import { useAsyncData, fmtTime } from "@/composables/useAsyncData";

defineOptions({ name: "GatewayUsage" });

const data = ref<UsageData | null>(null);
const page = ref(1);
const pageSize = ref(20);
const filters = ref({ model: "", provider: "", worldId: "", status: "" });
const { loading, error, run } = useAsyncData();

async function load() {
  const res = await run(() =>
    listUsage({
      page: page.value,
      pageSize: pageSize.value,
      model: filters.value.model || undefined,
      provider: filters.value.provider || undefined,
      worldId: filters.value.worldId || undefined,
      status: filters.value.status || undefined
    })
  );
  if (res?.data) data.value = res.data;
}

function reset() {
  filters.value = { model: "", provider: "", worldId: "", status: "" };
  page.value = 1;
  load();
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <div class="flex justify-end mb-1">
      <MockTag
        detail="Usage 数据为 Mock（管理面聚合 API 待建，见 ADMIN-API-GAP.md）；支持时间 / World / Model / Provider 筛选"
      />
    </div>

    <!-- 汇总卡 -->
    <el-row v-if="data?.summary" :gutter="12" class="mb-3">
      <el-col :xs="12" :md="6">
        <el-card shadow="never">
          <div class="text-xs text-[--el-text-color-secondary]">
            Requests（当前筛选）
          </div>
          <div class="text-xl font-semibold">{{ data.summary.requests }}</div>
        </el-card>
      </el-col>
      <el-col :xs="12" :md="6">
        <el-card shadow="never">
          <div class="text-xs text-[--el-text-color-secondary]">Tokens</div>
          <div class="text-xl font-semibold">
            {{ data.summary.totalTokens.toLocaleString() }}
          </div>
        </el-card>
      </el-col>
      <el-col :xs="12" :md="6">
        <el-card shadow="never">
          <div class="text-xs text-[--el-text-color-secondary]">Cost</div>
          <div class="text-xl font-semibold">
            ${{ data.summary.totalCost.toFixed(4) }}
          </div>
        </el-card>
      </el-col>
      <el-col :xs="12" :md="6">
        <el-card shadow="never">
          <div class="text-xs text-[--el-text-color-secondary]">
            Success Rate
          </div>
          <div class="text-xl font-semibold">
            {{ data.summary.successRate }}%
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-input
          v-model="filters.model"
          placeholder="Model（如 gpt-4o）"
          clearable
          class="!w-44"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        />
        <el-input
          v-model="filters.provider"
          placeholder="Provider"
          clearable
          class="!w-40"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        />
        <el-input
          v-model="filters.worldId"
          placeholder="World ID"
          clearable
          class="!w-40"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        />
        <el-select
          v-model="filters.status"
          placeholder="状态"
          clearable
          class="!w-32"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        >
          <el-option label="success" value="success" />
          <el-option label="error" value="error" />
        </el-select>
        <el-button :loading="loading" @click="load">
          <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
        </el-button>
        <el-button @click="reset">重置</el-button>
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
        :data="data?.list ?? []"
        stripe
        size="small"
      >
        <el-table-column min-width="150"
          ><template #header><BiText zh="时间" en="Time" /></template>
          <template #default="{ row }">{{
            fmtTime((row as UsageRow).time)
          }}</template>
        </el-table-column>
        <el-table-column prop="model" min-width="150"
          ><template #header><BiText zh="模型" en="Model" /></template>
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ (row as UsageRow).model }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="provider" min-width="100"
          ><template #header><BiText zh="提供方" en="Provider" /></template
        ></el-table-column>
        <el-table-column prop="worldId" min-width="90"
          ><template #header><BiText zh="世界" en="World" /></template
        ></el-table-column>
        <el-table-column prop="capability" min-width="100"
          ><template #header><BiText zh="能力" en="Capability" /></template>
          <template #default="{ row }">
            <el-tag size="small" type="info" effect="plain">{{
              (row as UsageRow).capability
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="promptTokens" width="100" align="right"
          ><template #header><BiText zh="输入" en="Tokens Prompt" /></template
        ></el-table-column>
        <el-table-column prop="completionTokens" width="130" align="right"
          ><template #header
            ><BiText zh="输出" en="Tokens Completion" /></template
        ></el-table-column>
        <el-table-column width="90" align="right"
          ><template #header><BiText zh="成本" en="Cost" /></template>
          <template #default="{ row }"
            >${{ (row as UsageRow).cost.toFixed(4) }}</template
          >
        </el-table-column>
        <el-table-column prop="latencyMs" width="90" align="right"
          ><template #header><BiText zh="延迟" en="Latency" /></template>
          <template #default="{ row }"
            >{{ (row as UsageRow).latencyMs }}ms</template
          >
        </el-table-column>
        <el-table-column width="90" align="center"
          ><template #header><BiText zh="状态" en="Status" /></template>
          <template #default="{ row }">
            <el-tag
              :type="
                (row as UsageRow).status === 'success' ? 'success' : 'danger'
              "
              size="small"
            >
              {{ (row as UsageRow).status }}
            </el-tag>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无用量记录" :image-size="64" />
        </template>
      </el-table>

      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="data?.total ?? 0"
        layout="total, sizes, prev, pager, next"
        :page-sizes="[10, 20, 50]"
        class="mt-3 justify-end"
        @current-change="load"
        @size-change="load"
      />
    </el-card>
  </div>
</template>
