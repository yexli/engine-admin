<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useModelControl } from "@/composables/useModelControl";
import {
  removeModelDeep,
  ALLOWED_TAGS,
  detectVendorOf,
  type AdminModel
} from "@/api/modelControl";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { ElMessageBox } from "element-plus";

defineOptions({ name: "GatewayModels" });

const mc = useModelControl();
const canManage = hasPerms("gateway:manage");

const models = computed(() => mc.config.value?.models ?? []);
const providers = computed(() => mc.config.value?.providers ?? []);

/* ---------- 思考强度（厂商画像由服务端配置投影下发，前端零改动扩展） ---------- */

function vendorOf(wireModel: string) {
  return detectVendorOf(mc.config.value?.thinking, wireModel);
}

function setThinking(row: AdminModel, level: string | null) {
  if (!mc.config.value) return;
  const m = mc.config.value.models.find(x => x.id === row.id);
  if (!m) return;
  if (level) m.thinking = level;
  else delete m.thinking;
  mc.markDirty();
}

function providerName(id: string): string {
  return providers.value.find(p => p.id === id)?.name ?? id;
}

function capTag(c: string) {
  const map: Record<string, string> = {
    fast: "success",
    cheap: "info",
    reasoning: "warning",
    roleplay: "danger",
    narrative: "primary",
    memory: "success",
    embedding: "info",
    "structured-output": "warning",
    "long-context": "primary"
  };
  return (map[c] ?? "info") as "success" | "info" | "warning" | "danger" | "primary";
}

/* ---------- 新建/编辑模型（草稿） ---------- */
const editDialog = ref(false);
const editIsNew = ref(true);
const editForm = reactive({
  id: "",
  providerId: "",
  wireModel: "",
  tags: [] as string[],
  enabled: false
});

function openCreate() {
  editIsNew.value = true;
  Object.assign(editForm, {
    id: "",
    providerId: providers.value[0]?.id ?? "",
    wireModel: "",
    tags: ["fast"],
    enabled: false
  });
  editDialog.value = true;
}

function openEdit(row: AdminModel) {
  editIsNew.value = false;
  Object.assign(editForm, {
    id: row.id,
    providerId: row.providerId,
    wireModel: row.wireModel,
    tags: [...row.tags],
    enabled: row.enabled
  });
  editDialog.value = true;
}

function submitEdit() {
  if (!mc.config.value) return;
  const id = editForm.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    message("模型 ID 必须以字母/数字开头，仅含字母、数字、._-（≤64 字符）", { type: "warning" });
    return;
  }
  if (!editForm.providerId) {
    message("请选择所属供应商（先到「供应商」页建档）", { type: "warning" });
    return;
  }
  if (!editForm.wireModel.trim()) {
    message("出站模型名（wireModel）必填：发送给上游的精确模型串", { type: "warning" });
    return;
  }
  if (editForm.tags.length === 0) {
    message("至少选择一个能力标签", { type: "warning" });
    return;
  }
  const existing = mc.config.value.models.find(m => m.id === id);
  if (editIsNew.value && existing) {
    message(`模型 ID 已存在：${id}`, { type: "warning" });
    return;
  }
  if (existing) {
    existing.providerId = editForm.providerId;
    existing.wireModel = editForm.wireModel.trim();
    existing.tags = [...editForm.tags];
    mc.markDirty();
  } else {
    mc.config.value.models.push({
      id,
      providerId: editForm.providerId,
      wireModel: editForm.wireModel.trim(),
      tags: [...editForm.tags],
      enabled: false /* 新模型禁用态：先实测再启用 */
    });
    mc.markDirty();
  }
  editDialog.value = false;
  message("已写入草稿，点「保存全部」生效", { type: "success" });
}

/* ---------- 实测（有界真实调用） ---------- */
interface TestDisplay {
  modelId: string;
  ok: boolean;
  elapsedMs: number;
  reply: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}
const testDialog = ref(false);
const testing = ref(false);
const testOutcome = ref<TestDisplay | null>(null);

async function test(row: AdminModel) {
  testing.value = true;
  testOutcome.value = null;
  testDialog.value = true;
  try {
    /* 实测只作用于已提交配置中的模型：草稿模型先自动「保存全部」建档 */
    const committedOk = await mc.ensureModelCommitted(row.id);
    if (!committedOk) {
      testDialog.value = false;
      return;
    }
    const r = await mc.testModel(row.id);
    if (r) {
      testOutcome.value = {
        modelId: r.modelId ?? row.id,
        ok: r.ok,
        elapsedMs: r.elapsedMs,
        reply: r.reply ?? null,
        errorCode: r.error?.code ?? null,
        errorMessage: r.error?.message ?? null
      };
    }
  } finally {
    testing.value = false;
  }
}

/* ---------- 草稿内编辑：启用/删除 ---------- */
function toggleEnabled(row: AdminModel) {
  if (!mc.config.value) return;
  const target = mc.config.value.models.find(m => m.id === row.id);
  if (!target) return;
  if (!target.enabled) {
    const p = mc.config.value.providers.find(x => x.id === target.providerId);
    if (p && !p.enabled) {
      message("其供应商处于禁用状态：请先在「供应商」页启用供应商", { type: "warning" });
      return;
    }
    if (p?.auth.kind === "secret" && !p.auth.hasCredential) {
      message("其供应商还没有凭证：请先上传凭证", { type: "warning" });
      return;
    }
  }
  target.enabled = !target.enabled;
  mc.markDirty();
}

async function remove(row: AdminModel) {
  if (!mc.config.value) return;
  await ElMessageBox.confirm(
    `删除模型「${row.id}」？指向它的能力路由槽位将清空。改动需点「保存全部」才会生效。`,
    "删除确认",
    { type: "warning" }
  );
  removeModelDeep(mc.config.value, row.id);
  mc.markDirty();
  message("已在草稿中删除，点「保存全部」生效", { type: "success" });
}

onMounted(() => mc.ensureLoaded());
</script>

<template>
  <div class="p-4">
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-tag size="small" effect="plain">revision {{ mc.revision.value }}</el-tag>
        <el-badge :value="mc.dirty.value" :hidden="mc.dirty.value === 0" type="warning">
          <span class="text-xs text-[--el-text-color-secondary]">草稿未保存改动</span>
        </el-badge>
        <el-alert
          v-if="mc.conflict.value"
          title="配置已被其他人更新：已为你加载最新版本，请在最新配置上重做改动"
          type="warning"
          :closable="false"
          class="!py-1"
          show-icon
        />
        <div class="flex-1" />
        <Perms value="gateway:manage">
          <el-button type="primary" :loading="mc.saving.value" @click="mc.save()">
            <IconifyIconOffline icon="ep/check" class="mr-1" />
            保存全部
          </el-button>
          <el-button @click="openCreate">
            <IconifyIconOffline icon="ep/plus" class="mr-1" />新增模型
          </el-button>
        </Perms>
        <el-button :loading="mc.loading.value" @click="mc.refresh()">
          <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
        </el-button>
      </div>

      <el-alert
        v-if="mc.dirty.value > 0"
        type="warning"
        :closable="false"
        class="mb-3"
        show-icon
        :title="`有 ${mc.dirty.value} 项未保存改动：切换页面不会丢失，但刷新、关闭浏览器或点「刷新」会丢弃；点「保存全部」提交到服务端并即时生效。`"
      />

      <el-alert
        v-if="mc.loadError.value"
        type="error"
        :closable="false"
        class="mb-3"
        show-icon
      >
        <template #title>
          管理面连接失败：{{ mc.loadError.value }}
          <el-button text type="primary" size="small" @click="mc.load()">重试</el-button>
        </template>
      </el-alert>

      <el-table v-loading="mc.loading.value" :data="models" stripe>
        <el-table-column prop="id" min-width="150"
          ><template #header><BiText zh="内部 ID" en="ID" /></template>
          <template #default="{ row }">
            <span class="font-mono text-sm font-medium">{{ row.id }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="wireModel" min-width="170"
          ><template #header><BiText zh="出站模型名 (wireModel)" en="Wire Model" /></template>
          <template #default="{ row }">
            <span class="font-mono text-sm text-[--el-text-color-secondary]">{{ row.wireModel }}</span>
          </template>
        </el-table-column>
        <el-table-column min-width="120"
          ><template #header><BiText zh="所属供应商" en="Provider" /></template>
          <template #default="{ row }">{{ providerName(row.providerId) }}</template>
        </el-table-column>
        <el-table-column min-width="200"
          ><template #header><BiText zh="标签" en="Tags" /></template>
          <template #default="{ row }">
            <el-tag
              v-for="c in row.tags"
              :key="c"
              size="small"
              :type="capTag(c)"
              class="mr-1"
            >
              {{ c }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column width="90" align="center"
          ><template #header><BiText zh="启用" en="Enabled" /></template>
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
              {{ row.enabled ? "启用" : "禁用" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column width="170"
          ><template #header
            ><BiText zh="思考强度" en="Thinking" /></template>
          <template #default="{ row }">
            <el-select
              :model-value="row.thinking ?? null"
              clearable
              placeholder="未配置"
              size="small"
              class="!w-full"
              :disabled="!canManage"
              @update:model-value="v => setThinking(row as AdminModel, (v as string | null) || null)"
            >
              <el-option
                v-for="lv in vendorOf(row.wireModel).levels"
                :key="lv"
                :value="lv"
                :label="lv"
              />
            </el-select>
            <div
              v-if="vendorOf(row.wireModel).hints[row.thinking ?? '']"
              class="text-[10px] text-[--el-text-color-secondary] leading-tight mt-0.5"
            >
              {{ vendorOf(row.wireModel).hints[row.thinking ?? ""] }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button
              text
              size="small"
              type="primary"
              :loading="testing && testDialog"
              @click="test(row as AdminModel)"
            >
              实测
            </el-button>
            <template v-if="canManage">
              <el-button text size="small" @click="openEdit(row as AdminModel)">编辑</el-button>
              <el-button text size="small" @click="toggleEnabled(row as AdminModel)">
                {{ (row as AdminModel).enabled ? "禁用" : "启用" }}
              </el-button>
              <el-button text size="small" type="danger" @click="remove(row as AdminModel)">删除</el-button>
            </template>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无模型：先到「供应商」页建档，再点「新增模型」" :image-size="64" />
        </template>
      </el-table>
    </el-card>

    <!-- 实测结果（真实上游调用） -->
    <el-dialog
      :model-value="testDialog"
      :title="`模型实测 · ${testOutcome?.modelId ?? ''}`"
      width="520px"
      @update:model-value="v => !v && (testDialog = false)"
      @closed="testOutcome = null"
    >
      <div v-loading="testing" element-loading-text="正在向配置端点发起一次有界真实请求…">
        <el-descriptions v-if="testOutcome" :column="1" border size="small">
          <el-descriptions-item label="结果">
            <el-tag :type="testOutcome.ok ? 'success' : 'danger'" size="small">
              {{ testOutcome.ok ? "成功" : "失败" }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="耗时">{{ testOutcome.elapsedMs }}ms</el-descriptions-item>
          <el-descriptions-item v-if="testOutcome.reply" label="上游回复">
            <span class="font-mono text-sm">{{ testOutcome.reply }}</span>
          </el-descriptions-item>
          <el-descriptions-item v-if="testOutcome.errorCode" label="错误码">
            <span class="font-mono text-sm">{{ testOutcome.errorCode }}</span>
          </el-descriptions-item>
          <el-descriptions-item v-if="testOutcome.errorMessage" label="错误信息">
            {{ testOutcome.errorMessage }}
          </el-descriptions-item>
        </el-descriptions>
      </div>
      <template #footer>
        <el-button @click="testDialog = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 新增/编辑模型 -->
    <el-dialog v-model="editDialog" :title="editIsNew ? '新增模型（禁用态）' : `编辑模型 · ${editForm.id}`" width="540px">
      <el-form label-width="150px">
        <el-form-item label="内部 ID" required>
          <el-input
            v-model="editForm.id"
            :disabled="!editIsNew"
            placeholder="如 mdl-deepseek-chat（路由引用它，非上游模型名）"
          />
        </el-form-item>
        <el-form-item label="所属供应商" required>
          <el-select v-model="editForm.providerId" class="!w-full" placeholder="选择供应商">
            <el-option
              v-for="p in providers"
              :key="p.id"
              :label="`${p.name}（${p.id}${p.enabled ? '' : '，禁用'}）`"
              :value="p.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="出站模型名" required>
          <el-input v-model="editForm.wireModel" placeholder="如 deepseek-chat——发给上游的精确 model 串" />
        </el-form-item>
        <el-form-item label="能力标签" required>
          <el-select v-model="editForm.tags" multiple class="!w-full" placeholder="至少一个">
            <el-option v-for="t in ALLOWED_TAGS" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="editIsNew" label="初始状态">
          <el-tag size="small">禁用（建议先「实测」再启用）</el-tag>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialog = false">取消</el-button>
        <el-button type="primary" @click="submitEdit">写入草稿</el-button>
      </template>
    </el-dialog>
  </div>
</template>
