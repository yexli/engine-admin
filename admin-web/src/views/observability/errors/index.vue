<script setup lang="ts">
import { onMounted, ref } from "vue";
import { listErrors, type ErrorRow } from "@/api/logs";
import { useAsyncData, fmtTime } from "@/composables/useAsyncData";

defineOptions({ name: "ObsErrors" });

const list = ref<ErrorRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const filters = ref({ worldId: "", kind: "" });
const { loading, error, run } = useAsyncData();

const drawer = ref(false);
const current = ref<ErrorRow | null>(null);

async function load() {
  const res = await run(() =>
    listErrors({
      page: page.value,
      page_size: pageSize.value,
      world: filters.value.worldId || undefined,
      kind: filters.value.kind || undefined
    })
  );
  list.value = res?.list ?? [];
  total.value = res?.total ?? 0;
}

function reset() {
  filters.value = { worldId: "", kind: "" };
  page.value = 1;
  load();
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
      title="失败请求登记（M4.1 起真实）：公共 API 面的状态 ≥400 请求，源于 M2.2 用量数据面；只读投影——原 Mock 的确认/解决工作流无真实支撑，已移除。"
    />
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
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
          v-model="filters.kind"
          placeholder="类型"
          clearable
          class="!w-32"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        >
          <el-option label="chat" value="chat" />
          <el-option label="worlds" value="worlds" />
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
        @row-click="
          row => {
            current = row;
            drawer = true;
          }
        "
      >
        <el-table-column width="160"
          ><template #header><BiText zh="时间" en="Time" /></template>
          <template #default="{ row }">{{ fmtTime(row.time) }}</template>
        </el-table-column>
        <el-table-column width="80" align="center"
          ><template #header><BiText zh="类型" en="Kind" /></template>
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.kind }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column width="100"
          ><template #header><BiText zh="世界" en="World" /></template>
          <template #default="{ row }">{{ row.worldId ?? "—" }}</template>
        </el-table-column>
        <el-table-column min-width="140"
          ><template #header><BiText zh="错误码" en="Type" /></template>
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.type }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="message" min-width="260" show-overflow-tooltip
          ><template #header><BiText zh="消息" en="Message" /></template
        ></el-table-column>
        <el-table-column min-width="120"
          ><template #header><BiText zh="请求" en="Request ID" /></template>
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.id }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无错误（无失败请求）" :image-size="64" />
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

    <!-- 错误详情 -->
    <el-drawer
      v-model="drawer"
      :title="`错误详情 · ${current?.id ?? ''}`"
      size="480px"
    >
      <el-descriptions v-if="current" :column="1" border size="small">
        <el-descriptions-item label="时间 Time">{{
          fmtTime(current.time)
        }}</el-descriptions-item>
        <el-descriptions-item label="错误码 Type">
          <span class="font-mono text-xs">{{ current.type }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="消息 Message">{{
          current.message
        }}</el-descriptions-item>
        <el-descriptions-item label="请求 Request">{{
          `${current.method} ${current.path}`
        }}</el-descriptions-item>
        <el-descriptions-item label="世界 World">{{
          current.worldId ?? "—"
        }}</el-descriptions-item>
        <el-descriptions-item label="调用 Key">{{
          current.keyId
        }}</el-descriptions-item>
      </el-descriptions>
    </el-drawer>
  </div>
</template>
