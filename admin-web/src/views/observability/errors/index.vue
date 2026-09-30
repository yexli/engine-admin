<script setup lang="ts">
import { onMounted, ref } from "vue";
import { listErrors, setErrorStatus, type ErrorRow } from "@/api/logs";
import { message } from "@/utils/message";
import { useAsyncData, fmtTime } from "@/composables/useAsyncData";

defineOptions({ name: "ObsErrors" });

const list = ref<ErrorRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const filters = ref({ status: "", service: "", type: "" });
const { loading, error, run } = useAsyncData();

const drawer = ref(false);
const current = ref<ErrorRow | null>(null);

async function load() {
  const res = await run(() =>
    listErrors({
      page: page.value,
      pageSize: pageSize.value,
      status: filters.value.status || undefined,
      service: filters.value.service || undefined,
      type: filters.value.type || undefined
    })
  );
  if (res?.data) {
    list.value = res.data.list;
    total.value = res.data.total;
  }
}

async function ack(row: ErrorRow) {
  const res = await run(() => setErrorStatus(row.id, "acknowledged"));
  if (res) {
    row.status = "acknowledged";
    message("已确认", { type: "success" });
  }
}

async function resolve(row: ErrorRow) {
  const res = await run(() => setErrorStatus(row.id, "resolved"));
  if (res) {
    row.status = "resolved";
    message("已解决", { type: "success" });
  }
}

function statusTag(status: string) {
  return ({ open: "danger", acknowledged: "warning", resolved: "success" }[
    status
  ] ?? "info") as "danger" | "warning" | "success" | "info";
}

function reset() {
  filters.value = { status: "", service: "", type: "" };
  page.value = 1;
  load();
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <div class="flex justify-end mb-1">
      <MockTag
        detail="错误记录为 Mock（错误聚合 API 待建，见 ADMIN-API-GAP.md）；支持确认/解决工作流"
      />
    </div>
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-select
          v-model="filters.status"
          placeholder="状态"
          clearable
          class="!w-36"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        >
          <el-option label="open" value="open" />
          <el-option label="acknowledged" value="acknowledged" />
          <el-option label="resolved" value="resolved" />
        </el-select>
        <el-select
          v-model="filters.service"
          placeholder="Service"
          clearable
          class="!w-44"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        >
          <el-option
            v-for="s in ['world-engine', 'ai-gateway', 'memory', 'admin-api']"
            :key="s"
            :label="s"
            :value="s"
          />
        </el-select>
        <el-input
          v-model="filters.type"
          placeholder="错误类型"
          clearable
          class="!w-44"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        />
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
        <el-table-column width="100"
          ><template #header><BiText zh="错误" en="ID Error ID" /></template>
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.id }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="service" width="120"
          ><template #header><BiText zh="服务" en="Service" /></template
        ></el-table-column>
        <el-table-column width="100"
          ><template #header><BiText zh="世界" en="World" /></template>
          <template #default="{ row }">{{ row.worldId ?? "—" }}</template>
        </el-table-column>
        <el-table-column prop="type" label="类型" min-width="150">
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.type }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="message" min-width="240" show-overflow-tooltip
          ><template #header><BiText zh="消息" en="Message" /></template
        ></el-table-column>
        <el-table-column width="160"
          ><template #header><BiText zh="时间" en="Time" /></template>
          <template #default="{ row }">{{ fmtTime(row.time) }}</template>
        </el-table-column>
        <el-table-column width="120" align="center"
          ><template #header><BiText zh="状态" en="Status" /></template>
          <template #default="{ row }">
            <el-tag :type="statusTag(row.status)" size="small">{{
              row.status
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'open'"
              text
              size="small"
              type="warning"
              @click.stop="ack(row as ErrorRow)"
            >
              确认
            </el-button>
            <el-button
              v-if="row.status !== 'resolved'"
              text
              size="small"
              type="success"
              @click.stop="resolve(row as ErrorRow)"
            >
              解决
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无错误" :image-size="64" />
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
      size="520px"
    >
      <el-descriptions v-if="current" :column="1" border size="small">
        <el-descriptions-item label="服务 Service">{{
          current.service
        }}</el-descriptions-item>
        <el-descriptions-item label="世界 World">{{
          current.worldId ?? "—"
        }}</el-descriptions-item>
        <el-descriptions-item label="类型">
          <span class="font-mono text-xs">{{ current.type }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="消息 Message">{{
          current.message
        }}</el-descriptions-item>
        <el-descriptions-item label="时间 Time">{{
          fmtTime(current.time)
        }}</el-descriptions-item>
        <el-descriptions-item label="状态 Status">
          <el-tag :type="statusTag(current.status)" size="small">{{
            current.status
          }}</el-tag>
        </el-descriptions-item>
      </el-descriptions>
      <template v-if="current?.stack">
        <div class="mt-3 mb-1 text-sm font-medium">Stack</div>
        <pre
          class="whitespace-pre-wrap rounded bg-[--el-fill-color-lighter] p-3 text-xs leading-relaxed"
          >{{ current.stack }}</pre>
      </template>
    </el-drawer>
  </div>
</template>
