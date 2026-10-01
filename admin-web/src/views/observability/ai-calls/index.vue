<script setup lang="ts">
import { onMounted, ref } from "vue";
import { listAiCalls, type AiCallRow } from "@/api/logs";
import { useAsyncData, fmtTime } from "@/composables/useAsyncData";

defineOptions({ name: "ObsAiCalls" });

const list = ref<AiCallRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const filters = ref({ model: "", worldId: "", status: "" });
const { loading, error, run } = useAsyncData();

const drawer = ref(false);
const current = ref<AiCallRow | null>(null);

async function load() {
  const res = await run(() =>
    listAiCalls({
      page: page.value,
      page_size: pageSize.value,
      model: filters.value.model || undefined,
      world_id: filters.value.worldId || undefined,
      status: filters.value.status || undefined
    })
  );
  list.value = res?.list ?? [];
  total.value = res?.total ?? 0;
}

function openDetail(row: AiCallRow) {
  current.value = row;
  drawer.value = true;
}

function reset() {
  filters.value = { model: "", worldId: "", status: "" };
  page.value = 1;
  load();
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-input
          v-model="filters.model"
          placeholder="Model"
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
        :data="list"
        stripe
        size="small"
        @row-click="openDetail"
      >
        <el-table-column width="160"
          ><template #header><BiText zh="时间" en="Time" /></template>
          <template #default="{ row }">{{ fmtTime(row.time) }}</template>
        </el-table-column>
        <el-table-column min-width="150"
          ><template #header><BiText zh="请求模型" en="Model" /></template>
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.model ?? "—" }}</span>
          </template>
        </el-table-column>
        <el-table-column min-width="120"
          ><template #header
            ><BiText zh="实际模型" en="Model Used" /></template>
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.modelUsed ?? "—" }}</span>
          </template>
        </el-table-column>
        <el-table-column min-width="100"
          ><template #header><BiText zh="提供方" en="Provider" /></template>
          <template #default="{ row }">{{ row.provider ?? "—" }}</template>
        </el-table-column>
        <el-table-column width="100"
          ><template #header><BiText zh="世界" en="World" /></template>
          <template #default="{ row }">{{ row.worldId ?? "—" }}</template>
        </el-table-column>
        <el-table-column width="100"
          ><template #header><BiText zh="能力" en="Capability" /></template>
          <template #default="{ row }">{{ row.capability ?? "—" }}</template>
        </el-table-column>
        <el-table-column width="90" align="right"
          ><template #header><BiText zh="延迟" en="Latency" /></template>
          <template #default="{ row }">
            <span
              :class="row.latencyMs > 5000 ? 'text-[--el-color-danger]' : ''"
            >
              {{ row.latencyMs }}ms
            </span>
          </template>
        </el-table-column>
        <el-table-column label="Tokens（P/C）" width="120" align="right">
          <template #default="{ row }"
            >{{ row.promptTokens ?? "—" }} / {{ row.completionTokens ?? "—" }}</template
          >
        </el-table-column>
        <el-table-column width="90" align="center"
          ><template #header><BiText zh="状态" en="Status" /></template>
          <template #default="{ row }">
            <el-tag
              :type="row.status === 'success' ? 'success' : 'danger'"
              size="small"
            >
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty
            description="暂无 AI 调用记录（平台收到首个调用后开始累积）"
            :image-size="64"
          />
        </template>
      </el-table>

      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        layout="total, sizes, prev, pager, next"
        :page-sizes="[20, 50, 100]"
        class="mt-3 justify-end"
        @current-change="load"
        @size-change="load"
      />
    </el-card>

    <!-- 调用详情（路由留痕；不落 Prompt/响应原文） -->
    <el-drawer
      v-model="drawer"
      :title="`AI Call · ${current?.id ?? ''}`"
      size="480px"
    >
      <template v-if="current">
        <el-descriptions :column="2" border size="small" class="mb-3">
          <el-descriptions-item label="请求模型">{{
            current.model ?? "—"
          }}</el-descriptions-item>
          <el-descriptions-item label="调用路径">{{
            current.route ?? "—"
          }}</el-descriptions-item>
          <el-descriptions-item label="实际模型">{{
            current.modelUsed ?? "—"
          }}</el-descriptions-item>
          <el-descriptions-item label="提供方 Provider">{{
            current.provider ?? "—"
          }}</el-descriptions-item>
          <el-descriptions-item label="世界 World">{{
            current.worldId ?? "—"
          }}</el-descriptions-item>
          <el-descriptions-item label="能力 Capability">{{
            current.capability ?? "—"
          }}</el-descriptions-item>
          <el-descriptions-item label="延迟 Latency"
            >{{ current.latencyMs }}ms</el-descriptions-item
          >
          <el-descriptions-item label="状态 Status">
            <el-tag
              :type="current.status === 'success' ? 'success' : 'danger'"
              size="small"
            >
              {{ current.status }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="输入 Tokens">{{
            current.promptTokens ?? "—"
          }}</el-descriptions-item>
          <el-descriptions-item label="输出 Tokens">{{
            current.completionTokens ?? "—"
          }}</el-descriptions-item>
          <el-descriptions-item label="调用 Key">{{
            current.keyId
          }}</el-descriptions-item>
          <el-descriptions-item label="Token 口径">{{
            current.tokensEstimated ? "平台粗估" : current.promptTokens === null ? "透传路径无 usage" : "上游口径"
          }}</el-descriptions-item>
        </el-descriptions>

        <el-alert
          v-if="current.error"
          type="error"
          :closable="false"
          show-icon
          class="mb-3"
          :title="current.error"
        />

        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="平台只留路由留痕（key / 模型 / 能力 / 时延 / 状态），不落 Prompt 与响应原文"
        />
      </template>
    </el-drawer>
  </div>
</template>
