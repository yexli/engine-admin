<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  listProviders,
  checkProvider,
  gatewayChatProbe,
  type ProviderRow
} from "@/api/provider";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { useAsyncData, timeAgo } from "@/composables/useAsyncData";
import { ElMessageBox } from "element-plus";

defineOptions({ name: "GatewayProviders" });

const list = ref<ProviderRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const statusFilter = ref("");
const { loading, error, run } = useAsyncData();
const checkingId = ref("");

const canManage = hasPerms("gateway:manage");

async function load() {
  const res = await run(() =>
    listProviders({
      page: page.value,
      pageSize: pageSize.value,
      status: statusFilter.value || undefined
    })
  );
  if (res?.data) {
    list.value = res.data.list;
    total.value = res.data.total;
  }
}

async function check(row: ProviderRow) {
  checkingId.value = row.id;
  try {
    await run(() => checkProvider(row.id), { silent: true });
    message(`已对 ${row.name} 发起健康检查`, { type: "success" });
    await load();
  } finally {
    checkingId.value = "";
  }
}

/** 直连网关联通性测试（真实 /gateway-api，引擎在线时可用） */
const probing = ref(false);
async function probe() {
  const { value } = await ElMessageBox.prompt(
    "发送一条测试消息到 /v1/chat/completions（模型填网关已配置的模型名）",
    "Gateway 联通性测试",
    {
      confirmButtonText: "发送",
      cancelButtonText: "取消",
      inputPlaceholder: "如 gpt-4o-mini",
      inputValue: "gpt-4o-mini"
    }
  );
  probing.value = true;
  try {
    const res = await gatewayChatProbe({
      model: value || "gpt-4o-mini",
      message: "ping"
    });
    message(`网关可达：${JSON.stringify(res).slice(0, 80)}…`, {
      type: "success"
    });
  } catch (e) {
    message(`网关不可达：${(e as Error).message}`, { type: "error" });
  } finally {
    probing.value = false;
  }
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
      title="Provider 清单为 Mock；「联通性测试」直连真实 Gateway（127.0.0.1:8788，在线时可用）。管理面 API 待建（ADMIN-API-GAP.md）"
    />
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-select
          v-model="statusFilter"
          placeholder="状态"
          clearable
          class="!w-36"
          @change="load"
        >
          <el-option label="在线" value="online" />
          <el-option label="离线" value="offline" />
          <el-option label="异常" value="error" />
        </el-select>
        <el-button :loading="loading" @click="load">
          <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
        </el-button>
        <div class="flex-1" />
        <el-button :loading="probing" @click="probe">
          <IconifyIconOffline icon="ep/connection" class="mr-1" />网关联通测试
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
        <el-table-column prop="name" label="提供方 Provider" min-width="130">
          <template #default="{ row }">
            <span class="font-medium">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="type" label="类型 Type" min-width="130">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column
          prop="endpoint"
          label="端点 Endpoint"
          min-width="220"
          show-overflow-tooltip
        />
        <el-table-column label="状态 Status" width="100" align="center">
          <template #default="{ row }">
            <el-tag
              :type="
                row.status === 'online'
                  ? 'success'
                  : row.status === 'offline'
                    ? 'info'
                    : 'danger'
              "
              size="small"
            >
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="模型 Models" min-width="180">
          <template #default="{ row }">
            <el-tag
              v-for="m in row.models.slice(0, 2)"
              :key="m"
              size="small"
              class="mr-1"
              type="info"
            >
              {{ m }}
            </el-tag>
            <span
              v-if="row.models.length > 2"
              class="text-xs text-[--el-text-color-secondary]"
            >
              +{{ row.models.length - 2 }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="最近检查 Last Check" min-width="130">
          <template #default="{ row }">
            {{ timeAgo(row.lastCheckAt) }}
            <span
              v-if="row.latencyMs"
              class="text-xs text-[--el-text-color-secondary]"
            >
              （{{ row.latencyMs }}ms）
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-tooltip
              v-if="!canManage"
              content="无 gateway:manage 权限"
              placement="top"
            >
              <span
                ><el-button text size="small" disabled>检查</el-button></span
              >
            </el-tooltip>
            <el-button
              v-else
              text
              size="small"
              type="primary"
              :loading="checkingId === row.id"
              @click="check(row as ProviderRow)"
            >
              健康检查
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无 Provider" :image-size="64" />
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
