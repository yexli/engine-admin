<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import {
  listApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  API_KEY_PERMISSIONS,
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
const { loading, error, run } = useAsyncData();
const canManage = hasPerms("gateway:manage");

/** 明文 Key 只出现一次的展示框 */
const plainKey = ref("");
const plainKeyVisible = ref(false);

async function load() {
  const res = await run(() =>
    listApiKeys({
      page: page.value,
      page_size: pageSize.value
    })
  );
  list.value = res?.list ?? [];
  total.value = res?.total ?? 0;
}

/* 创建 */
const createDialog = ref(false);
const creating = ref(false);
const createForm = reactive({
  name: "",
  permissions: [...API_KEY_PERMISSIONS] as string[],
  expiresAt: ""
});

function openCreate() {
  createForm.name = "";
  createForm.permissions = [...API_KEY_PERMISSIONS];
  createForm.expiresAt = "";
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
      permissions: createForm.permissions,
      ...(createForm.expiresAt
        ? { expiresAt: new Date(createForm.expiresAt).toISOString() }
        : {})
    });
    createDialog.value = false;
    plainKey.value = res.plaintext;
    plainKeyVisible.value = true;
    load();
  } finally {
    creating.value = false;
  }
}

async function copyPlain() {
  await navigator.clipboard.writeText(plainKey.value);
  message("已复制到剪贴板", { type: "success" });
}

/* 过期 */
const expireDialog = ref(false);
const expireTarget = ref<ApiKeyRow | null>(null);
const expireValue = ref("");

function openExpire(row: ApiKeyRow) {
  expireTarget.value = row;
  expireValue.value = row.expiresAt ?? "";
  expireDialog.value = true;
}

async function doExpire(clear: boolean) {
  const row = expireTarget.value;
  if (!row) return;
  const res = await run(() =>
    updateApiKey(row.id, {
      expiresAt: clear
        ? null
        : new Date(expireValue.value).toISOString()
    })
  );
  if (res) {
    row.expiresAt = res.key.expiresAt;
    expireDialog.value = false;
    message(clear ? "已清除过期时间" : "已设置过期时间", { type: "success" });
  }
}

/* 删除（硬删） */
async function del(row: ApiKeyRow) {
  await ElMessageBox.confirm(
    `删除 Key「${row.name}」？删除后立即失效且记录彻底移除，不可恢复。`,
    "删除确认",
    { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
  );
  const res = await run(() => deleteApiKey(row.id));
  if (res) {
    message("已删除（该 Key 出站请求即 401）", { type: "success" });
    load();
  }
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
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
        <el-table-column prop="name" min-width="130"
          ><template #header><BiText zh="密钥名称" en="Key Name" /></template>
          <template #default="{ row }">
            <span class="font-medium">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column min-width="160"
          ><template #header><BiText zh="密钥 Key（脱敏）" en="Key" /></template>
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.prefix }}…</span>
          </template>
        </el-table-column>
        <el-table-column min-width="170"
          ><template #header><BiText zh="权限" en="Permissions" /></template>
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
        <el-table-column width="110"
          ><template #header><BiText zh="创建时间" en="Created" /></template>
          <template #default="{ row }">{{
            fmtTime(row.createdAt).slice(0, 10)
          }}</template>
        </el-table-column>
        <el-table-column width="150"
          ><template #header><BiText zh="过期时间" en="Expires" /></template>
          <template #default="{ row }">
            <span v-if="row.expiresAt">{{ fmtTime(row.expiresAt) }}</span>
            <span v-else class="text-xs text-[--el-text-color-secondary]"
              >永不过期</span
            >
          </template>
        </el-table-column>
        <el-table-column width="110"
          ><template #header><BiText zh="最近使用" en="Last Used" /></template>
          <template #default="{ row }">{{ timeAgo(row.lastUsedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <template v-if="canManage">
              <el-button
                text
                size="small"
                @click="openExpire(row as ApiKeyRow)"
              >
                过期
              </el-button>
              <el-button
                text
                size="small"
                type="danger"
                @click="del(row as ApiKeyRow)"
              >
                删除
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
    <el-dialog v-model="createDialog" title="创建 API Key" width="520px">
      <el-form label-width="110px">
        <el-form-item label="密钥名称" required>
          <el-input
            v-model="createForm.name"
            placeholder="如 world-runner"
            maxlength="64"
          />
        </el-form-item>
        <el-form-item label="权限">
          <el-checkbox-group v-model="createForm.permissions">
            <el-checkbox
              v-for="p in API_KEY_PERMISSIONS"
              :key="p"
              :value="p"
            >
              {{ p }}
            </el-checkbox>
          </el-checkbox-group>
          <div class="text-xs text-[--el-text-color-secondary] w-full">
            全不勾选会被后端拒绝；省略选择即缺省全量权限
          </div>
        </el-form-item>
        <el-form-item label="过期时间">
          <el-date-picker
            v-model="createForm.expiresAt"
            type="datetime"
            placeholder="留空 = 永不过期"
            value-format="x"
            class="!w-56"
          />
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
        title="关闭后系统只保存脱敏前缀与哈希，无法再次查看明文。"
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

    <!-- 设置过期 -->
    <el-dialog
      v-model="expireDialog"
      :title="`设置过期时间 · ${expireTarget?.name ?? ''}`"
      width="440px"
    >
      <el-form label-width="90px">
        <el-form-item label="过期时间">
          <el-date-picker
            v-model="expireValue"
            type="datetime"
            placeholder="选择过期时刻"
            value-format="x"
            class="!w-56"
          />
        </el-form-item>
        <div class="text-xs text-[--el-text-color-secondary] px-4">
          过期后该 Key 出站即 401；清除过期时间可恢复使用
        </div>
      </el-form>
      <template #footer>
        <el-button
          v-if="expireTarget?.expiresAt"
          @click="doExpire(true)"
          >清除过期</el-button
        >
        <el-button @click="expireDialog = false">取消</el-button>
        <el-button type="primary" :disabled="!expireValue" @click="doExpire(false)"
          >保存</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>
