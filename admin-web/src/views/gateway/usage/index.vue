<script setup lang="ts">
import { onMounted, ref } from "vue";
import { listUsage, type UsageData, type UsageRow } from "@/api/usage";
import { useAsyncData, fmtTime } from "@/composables/useAsyncData";

defineOptions({ name: "GatewayUsage" });

const data = ref<UsageData | null>(null);
const page = ref(1);
const pageSize = ref(20);
/* 本页定位 = AI 用量：固定 kind=chat（worlds 透传记录经 group_by 也可查） */
const filters = ref({ model: "", worldId: "", capability: "", status: "" });
const { loading, error, run } = useAsyncData();

async function load() {
  const res = await run(
    () =>
      listUsage({
        kind: "chat",
        page: page.value,
        page_size: pageSize.value,
        model: filters.value.model || undefined,
        world_id: filters.value.worldId || undefined,
        capability: filters.value.capability || undefined,
        status: filters.value.status || undefined
      }),
    { silent: true }
  );
  if (res) data.value = res;
}

function reset() {
  filters.value = { model: "", worldId: "", capability: "", status: "" };
  page.value = 1;
  load();
}

onMounted(load);
</script>

<template>
  <div class="p-4">
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
          <div class="text-xs text-[--el-text-color-secondary]">Total Tokens</div>
          <div class="text-xl font-semibold">
            {{ data.summary.totalTokens.toLocaleString() }}
          </div>
        </el-card>
      </el-col>
      <el-col :xs="12" :md="6">
        <el-card shadow="never">
          <div class="text-xs text-[--el-text-color-secondary]">
            Tokens（输入 / 输出）
          </div>
          <div class="text-xl font-semibold">
            {{ data.summary.promptTokens.toLocaleString() }} /
            {{ data.summary.completionTokens.toLocaleString() }}
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
          placeholder="Model（world-agent 或模型 ID）"
          clearable
          class="!w-52"
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
        <el-input
          v-model="filters.capability"
          placeholder="Capability"
          clearable
          class="!w-36"
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
        <el-table-column min-width="180"
          ><template #header><BiText zh="模型" en="Model" /></template>
          <template #default="{ row }">
            <div class="font-mono text-xs">
              {{ (row as UsageRow).model }}
              <template v-if="(row as UsageRow).modelUsed && (row as UsageRow).model !== (row as UsageRow).modelUsed">
                <div class="text-[--el-text-color-secondary]">
                  → {{ (row as UsageRow).modelUsed }}
                </div>
              </template>
            </div>
          </template>
        </el-table-column>
        <el-table-column min-width="100"
          ><template #header><BiText zh="提供方" en="Provider" /></template>
          <template #default="{ row }">
            {{ (row as UsageRow).provider ?? "—" }}
          </template>
        </el-table-column>
        <el-table-column min-width="90"
          ><template #header><BiText zh="世界" en="World" /></template>
          <template #default="{ row }">
            {{ (row as UsageRow).worldId ?? "—" }}
          </template>
        </el-table-column>
        <el-table-column min-width="100"
          ><template #header><BiText zh="能力" en="Capability" /></template>
          <template #default="{ row }">
            <el-tag
              v-if="(row as UsageRow).capability"
              size="small"
              type="info"
              effect="plain"
              >{{ (row as UsageRow).capability }}</el-tag
            >
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column width="90" align="right"
          ><template #header><BiText zh="输入" en="Prompt" /></template>
          <template #default="{ row }">{{
            (row as UsageRow).promptTokens ?? "—"
          }}</template>
        </el-table-column>
        <el-table-column width="90" align="right"
          ><template #header><BiText zh="输出" en="Completion" /></template>
          <template #default="{ row }">{{
            (row as UsageRow).completionTokens ?? "—"
          }}</template>
        </el-table-column>
        <el-table-column width="90" align="right"
          ><template #header><BiText zh="合计" en="Total" /></template>
          <template #default="{ row }">{{
            (row as UsageRow).totalTokens ?? "—"
          }}</template>
        </el-table-column>
        <el-table-column width="90" align="right"
          ><template #header><BiText zh="延迟" en="Latency" /></template>
          <template #default="{ row }"
            >{{ (row as UsageRow).latencyMs }}ms</template
          >
        </el-table-column>
        <el-table-column width="90" align="center"
          ><template #header><BiText zh="状态" en="Status" /></template>
          <template #default="{ row }">
            <el-tooltip
              :content="(row as UsageRow).error ?? ''"
              :disabled="!(row as UsageRow).error"
              placement="top"
            >
              <el-tag
                :type="
                  (row as UsageRow).status === 'success' ? 'success' : 'danger'
                "
                size="small"
              >
                {{ (row as UsageRow).status }}
              </el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty
            description="暂无用量记录（平台收到首个 AI 调用后开始累积）"
            :image-size="64"
          />
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
