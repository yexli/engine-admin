<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import {
  listRouter,
  createRouterEntry,
  updateRouterEntry,
  deleteRouterEntry,
  testRouterEntry,
  type RouterRow,
  type RouterTestResult
} from "@/api/router";
import { listModels, type ModelRow } from "@/api/model";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { useAsyncData } from "@/composables/useAsyncData";
import { ElMessageBox } from "element-plus";

defineOptions({ name: "GatewayRouter" });

const list = ref<RouterRow[]>([]);
const models = ref<ModelRow[]>([]);
const { loading, error, run } = useAsyncData();
const canManage = hasPerms("gateway:manage");

const testingId = ref("");
const testResult = ref<(RouterTestResult & { capability: string }) | null>(
  null
);

async function load() {
  const [routerRes, modelRes] = await Promise.all([
    run(() => listRouter()),
    run(() => listModels({ pageSize: 100 }), { silent: true })
  ]);
  if (routerRes?.data) list.value = routerRes.data.list;
  if (modelRes?.data) models.value = modelRes.data.list;
}

const editDialog = ref(false);
const editForm = reactive({
  id: "",
  capability: "",
  primary: "",
  fallback: "",
  priority: 1,
  budgetPerDay: 1,
  status: "enabled" as "enabled" | "disabled"
});
const saving = ref(false);

function openCreate() {
  Object.assign(editForm, {
    id: "",
    capability: "",
    primary: "",
    fallback: "",
    priority: 1,
    budgetPerDay: 1,
    status: "enabled"
  });
  editDialog.value = true;
}

function openEdit(row: RouterRow) {
  Object.assign(editForm, {
    id: row.id,
    capability: row.capability,
    primary: row.primary ?? "",
    fallback: row.fallback ?? "",
    priority: row.priority,
    budgetPerDay: row.budgetPerDay,
    status: row.status
  });
  editDialog.value = true;
}

async function save() {
  if (!editForm.capability.trim()) {
    message("Capability 必填", { type: "warning" });
    return;
  }
  saving.value = true;
  try {
    const payload = {
      capability: editForm.capability.trim(),
      primary: editForm.primary || null,
      fallback: editForm.fallback || null,
      priority: editForm.priority,
      budgetPerDay: editForm.budgetPerDay,
      status: editForm.status
    };
    const res = editForm.id
      ? await updateRouterEntry(editForm.id, payload)
      : await createRouterEntry(payload);
    if (res) {
      message(editForm.id ? "已保存" : "已新增路由规则", { type: "success" });
      editDialog.value = false;
      load();
    }
  } finally {
    saving.value = false;
  }
}

async function remove(row: RouterRow) {
  await ElMessageBox.confirm(
    `删除路由规则「${row.capability}」？该能力调用将失去主备模型。`,
    "删除确认",
    { type: "warning" }
  );
  const res = await run(() => deleteRouterEntry(row.id));
  if (res) {
    message("已删除", { type: "success" });
    load();
  }
}

async function toggleStatus(row: RouterRow) {
  const next = row.status === "enabled" ? "disabled" : "enabled";
  const res = await run(() => updateRouterEntry(row.id, { status: next }));
  if (res) {
    row.status = next;
    message(`已${next === "enabled" ? "启用" : "禁用"}`, { type: "success" });
  }
}

async function test(row: RouterRow) {
  testingId.value = row.id;
  testResult.value = null;
  try {
    const res = await run(() => testRouterEntry(row.id), { silent: true });
    if (res?.data) {
      testResult.value = { ...res.data, capability: row.capability };
      message(res.data.ok ? "路由测试通过" : "路由测试失败", {
        type: res.data.ok ? "success" : "error"
      });
    }
  } finally {
    testingId.value = "";
  }
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <div class="flex justify-end mb-1">
      <MockTag
        detail="Model Router 数据为 Mock：Capability → Primary / Fallback；管理面 API 待建（ADMIN-API-GAP.md）"
      />
    </div>
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-button :loading="loading" @click="load">
          <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
        </el-button>
        <div class="flex-1" />
        <Perms value="gateway:manage">
          <el-button type="primary" @click="openCreate">
            <IconifyIconOffline icon="ep/plus" class="mr-1" />新增路由
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
        <el-table-column prop="capability" min-width="110"
          ><template #header><BiText zh="能力" en="Capability" /></template>
          <template #default="{ row }">
            <el-tag size="small">{{ row.capability }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column min-width="150"
          ><template #header><BiText zh="主模型" en="Primary" /></template>
          <template #default="{ row }">
            <span class="font-mono text-sm">{{
              row.primary ?? "（未设置）"
            }}</span>
          </template>
        </el-table-column>
        <el-table-column min-width="150"
          ><template #header><BiText zh="备模型" en="Fallback" /></template>
          <template #default="{ row }">
            <span class="font-mono text-sm text-[--el-text-color-secondary]">
              {{ row.fallback ?? "—" }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="priority" width="90" align="center"
          ><template #header><BiText zh="优先级" en="Priority" /></template
        ></el-table-column>
        <el-table-column label="Budget/日" width="100" align="right">
          <template #default="{ row }">${{ row.budgetPerDay }}</template>
        </el-table-column>
        <el-table-column width="90" align="center"
          ><template #header><BiText zh="状态" en="Status" /></template>
          <template #default="{ row }">
            <el-tag
              :type="row.status === 'enabled' ? 'success' : 'danger'"
              size="small"
            >
              {{ row.status === "enabled" ? "启用" : "禁用" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button
              text
              size="small"
              type="primary"
              :loading="testingId === row.id"
              @click="test(row as RouterRow)"
            >
              测试
            </el-button>
            <template v-if="canManage">
              <el-button text size="small" @click="openEdit(row as RouterRow)"
                >编辑</el-button
              >
              <el-button
                text
                size="small"
                type="warning"
                @click="toggleStatus(row as RouterRow)"
              >
                {{ row.status === "enabled" ? "禁用" : "启用" }}
              </el-button>
              <el-button
                text
                size="small"
                type="danger"
                @click="remove(row as RouterRow)"
                >删除</el-button
              >
            </template>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无路由规则" :image-size="64" />
        </template>
      </el-table>
    </el-card>

    <!-- 测试结果 -->
    <el-dialog
      :model-value="!!testResult"
      :title="`路由测试 · ${testResult?.capability}`"
      width="480px"
      @update:model-value="v => !v && (testResult = null)"
      @closed="testResult = null"
    >
      <template v-if="testResult">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="结果">
            <el-tag :type="testResult.ok ? 'success' : 'danger'" size="small">
              {{ testResult.ok ? "通过" : "失败" }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="模型">{{
            testResult.model ?? "—"
          }}</el-descriptions-item>
          <el-descriptions-item label="延迟"
            >{{ testResult.latencyMs }}ms</el-descriptions-item
          >
          <el-descriptions-item label="回复">{{
            testResult.reply
          }}</el-descriptions-item>
        </el-descriptions>
      </template>
    </el-dialog>

    <!-- 编辑 -->
    <el-dialog
      v-model="editDialog"
      :title="editForm.id ? '编辑路由' : '新增路由'"
      width="520px"
    >
      <el-form label-width="120px">
        <el-form-item label="能力 Capability" required>
          <el-input
            v-model="editForm.capability"
            placeholder="如 roleplay / narrative / fast"
            :disabled="!!editForm.id"
          />
        </el-form-item>
        <el-form-item label="主模型 Primary">
          <el-select
            v-model="editForm.primary"
            filterable
            clearable
            placeholder="选择主模型"
            class="!w-full"
          >
            <el-option
              v-for="m in models"
              :key="m.id"
              :label="`${m.name}（${m.provider}）`"
              :value="m.name"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="备模型 Fallback">
          <el-select
            v-model="editForm.fallback"
            filterable
            clearable
            placeholder="选择备模型"
            class="!w-full"
          >
            <el-option
              v-for="m in models"
              :key="m.id"
              :label="`${m.name}（${m.provider}）`"
              :value="m.name"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="优先级 Priority">
          <el-input-number v-model="editForm.priority" :min="1" :max="99" />
        </el-form-item>
        <el-form-item label="Budget/日 (USD)">
          <el-input-number
            v-model="editForm.budgetPerDay"
            :min="0"
            :max="1000"
            :precision="2"
          />
        </el-form-item>
        <el-form-item label="状态 Status">
          <el-switch
            v-model="editForm.status"
            active-value="enabled"
            inactive-value="disabled"
            active-text="启用"
            inactive-text="禁用"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save"
          >保存</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>
