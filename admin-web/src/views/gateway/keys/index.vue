<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import {
  listApiKeys,
  createApiKey,
  setApiKeyStatus,
  regenerateApiKey,
  type ApiKeyRow
} from "@/api/apiKey";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { useAsyncData, fmtTime, timeAgo } from "@/composables/useAsyncData";
import { ElMessageBox } from "element-plus";

defineOptions({ name: "GatewayKeys" });

const list = ref<ApiKeyRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const statusFilter = ref("");
const { loading, error, run } = useAsyncData();
const canManage = hasPerms("gateway:manage");

/** 明文 Key 只出现一次的展示框 */
const plainKey = ref("");
const plainKeyVisible = ref(false);

async function load() {
  const res = await run(() =>
    listApiKeys({
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

/* 创建 */
const createDialog = ref(false);
const creating = ref(false);
const createForm = reactive({
  name: "",
  owner: "admin",
  permissions: ["chat:completions"] as string[]
});

function openCreate() {
  createForm.name = "";
  createForm.owner = "admin";
  createForm.permissions = ["chat:completions"];
  createDialog.value = true;
}

async function doCreate() {
  if (!createForm.name.trim()) {
    message("Key Name 必填", { type: "warning" });
    return;
  }
  creating.value = true;
  try {
    const res = await createApiKey({
      name: createForm.name.trim(),
      owner: createForm.owner,
      permissions: createForm.permissions
    });
    if (res?.data) {
      createDialog.value = false;
      plainKey.value = res.data.plainKey;
      plainKeyVisible.value = true;
      load();
    }
  } finally {
    creating.value = false;
  }
}

async function copyPlain() {
  await navigator.clipboard.writeText(plainKey.value);
  message("已复制到剪贴板", { type: "success" });
}

/* 状态 */
async function setStatus(row: ApiKeyRow, status: string) {
  const res = await run(() => setApiKeyStatus(row.id, status));
  if (res) {
    row.status = status as ApiKeyRow["status"];
    message("已更新", { type: "success" });
  }
}

async function revoke(row: ApiKeyRow) {
  await ElMessageBox.confirm(
    `撤销 Key「${row.name}」？撤销后不可恢复（历史明文不再显示）。`,
    "撤销确认",
    { type: "warning", confirmButtonText: "撤销", cancelButtonText: "取消" }
  );
  await setStatus(row, "revoked");
}

async function regenerate(row: ApiKeyRow) {
  await ElMessageBox.confirm(
    `重新生成 Key「${row.name}」？旧 Key 立即失效。`,
    "重新生成确认",
    { type: "warning" }
  );
  const res = await run(() => regenerateApiKey(row.id));
  if (res?.data) {
    plainKey.value = res.data.plainKey;
    plainKeyVisible.value = true;
    load();
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
      title="Key 全程脱敏展示（sk-****xxxx），明文仅在创建/重新生成时出现一次；历史明文不可查看（Mock 数据）"
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
          <el-option label="active" value="active" />
          <el-option label="disabled" value="disabled" />
          <el-option label="revoked" value="revoked" />
        </el-select>
        <el-button :loading="loading" @click="load">
          <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
        </el-button>
        <div class="flex-1" />
        <Perms value="gateway:manage">
          <el-button type="primary" @click="openCreate">
            <IconifyIconOffline icon="ep/plus" class="mr-1" />创建 Key
          </el-button>
        </Perms>
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
        <el-table-column prop="name" label="密钥名称 Key Name" min-width="130">
          <template #default="{ row }">
            <span class="font-medium">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column
          prop="maskedKey"
          label="密钥 Key（脱敏）"
          min-width="200"
        >
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.maskedKey }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="owner" label="所有者 Owner" width="100" />
        <el-table-column label="权限 Permissions" min-width="150">
          <template #default="{ row }">
            <el-tag
              v-for="p in row.permissions"
              :key="p"
              size="small"
              type="info"
              class="mr-1"
            >
              {{ p }}
            </el-tag>
            <span
              v-if="!row.permissions.length"
              class="text-xs text-[--el-text-color-secondary]"
              >—</span
            >
          </template>
        </el-table-column>
        <el-table-column label="创建时间 Created" width="110">
          <template #default="{ row }">{{
            fmtTime(row.createdAt).slice(0, 10)
          }}</template>
        </el-table-column>
        <el-table-column label="最近使用 Last Used" width="110">
          <template #default="{ row }">{{ timeAgo(row.lastUsedAt) }}</template>
        </el-table-column>
        <el-table-column label="状态 Status" width="100" align="center">
          <template #default="{ row }">
            <el-tag
              :type="
                row.status === 'active'
                  ? 'success'
                  : row.status === 'disabled'
                    ? 'info'
                    : 'danger'
              "
              size="small"
            >
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <template v-if="canManage">
              <el-button
                v-if="row.status === 'active'"
                text
                size="small"
                type="warning"
                @click="setStatus(row as ApiKeyRow, 'disabled')"
              >
                禁用
              </el-button>
              <el-button
                v-if="row.status === 'disabled'"
                text
                size="small"
                type="success"
                @click="setStatus(row as ApiKeyRow, 'active')"
              >
                启用
              </el-button>
              <el-button text size="small" @click="regenerate(row as ApiKeyRow)"
                >重新生成</el-button
              >
              <el-button
                v-if="row.status !== 'revoked'"
                text
                size="small"
                type="danger"
                @click="revoke(row as ApiKeyRow)"
              >
                撤销
              </el-button>
            </template>
            <span v-else class="text-xs text-[--el-text-color-secondary]"
              >无 gateway:manage 权限</span
            >
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无 API Key" :image-size="64" />
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

    <!-- 创建 Key -->
    <el-dialog v-model="createDialog" title="创建 API Key" width="480px">
      <el-form label-width="100px">
        <el-form-item label="密钥名称 Key Name" required>
          <el-input
            v-model="createForm.name"
            placeholder="如 world-runner"
            maxlength="64"
          />
        </el-form-item>
        <el-form-item label="所有者 Owner">
          <el-select v-model="createForm.owner">
            <el-option label="admin" value="admin" />
            <el-option label="operator" value="operator" />
            <el-option label="service" value="service" />
          </el-select>
        </el-form-item>
        <el-form-item label="权限 Permissions">
          <el-checkbox-group v-model="createForm.permissions">
            <el-checkbox value="chat:completions">chat:completions</el-checkbox>
            <el-checkbox value="embedding">embedding</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="doCreate"
          >创建</el-button
        >
      </template>
    </el-dialog>

    <!-- 明文一次性展示 -->
    <el-dialog
      v-model="plainKeyVisible"
      title="请立即保存 Key（仅此一次）"
      width="480px"
      :close-on-click-modal="false"
    >
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        class="mb-3"
        title="关闭后系统只保存脱敏形式，无法再次查看明文。"
      />
      <div class="flex items-center gap-2">
        <el-input :model-value="plainKey" readonly class="font-mono" />
        <el-button type="primary" @click="copyPlain">复制</el-button>
      </div>
      <template #footer>
        <el-button type="primary" @click="plainKeyVisible = false"
          >我已保存</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>
