<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useModelControl } from "@/composables/useModelControl";
import {
  removeProviderDeep,
  modelIdsOf,
  type AdminProvider
} from "@/api/modelControl";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { ElMessageBox } from "element-plus";

defineOptions({ name: "GatewayProviders" });

const mc = useModelControl();
const canManage = hasPerms("gateway:manage");

const providers = computed(() => mc.config.value?.providers ?? []);
const modelCount = (p: AdminProvider) =>
  mc.config.value ? modelIdsOf(mc.config.value, p.id).length : 0;

/* ---------- 新建供应商（禁用态建档：先建档、再传凭证、后启用） ---------- */
const createDialog = ref(false);
const createForm = reactive({
  id: "",
  name: "",
  endpoint: "",
  authKind: "secret" as "secret" | "none"
});

function openCreate() {
  Object.assign(createForm, { id: "", name: "", endpoint: "", authKind: "secret" });
  createDialog.value = true;
}

function submitCreate() {
  const id = createForm.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    message("供应商 ID 必须以字母/数字开头，仅含字母、数字、._-（≤64 字符）", { type: "warning" });
    return;
  }
  if (!createForm.name.trim()) {
    message("请填写显示名称", { type: "warning" });
    return;
  }
  if (!/^https?:\/\//.test(createForm.endpoint.trim())) {
    message("端点必须是 http/https 的 OpenAI 兼容 base URL（如 https://api.deepseek.com/v1）", { type: "warning" });
    return;
  }
  if (!mc.config.value) return;
  if (mc.config.value.providers.some(p => p.id === id)) {
    message(`供应商 ID 已存在：${id}`, { type: "warning" });
    return;
  }
  mc.config.value.providers.push({
    id,
    name: createForm.name.trim(),
    endpoint: createForm.endpoint.trim().replace(/\/+$/, ""),
    auth: { kind: createForm.authKind, hasCredential: false },
    enabled: false /* 新供应商一律禁用态建档，配好凭证后手动启用 */
  });
  mc.markDirty();
  createDialog.value = false;
  message(`供应商 ${id} 已加入草稿（禁用态）：上传凭证后手动启用，再点「保存全部」`, { type: "success" });
}

/* ---------- 凭证上传（独立写路径，立即生效不占草稿） ---------- */
const credDialog = ref(false);
const credTarget = ref<AdminProvider | null>(null);
const credValue = ref("");
const credSaving = ref(false);

function openCredential(row: AdminProvider) {
  credTarget.value = row;
  credValue.value = "";
  credDialog.value = true;
}

async function submitCredential() {
  if (!credTarget.value || !credValue.value) {
    message("请输入凭证值", { type: "warning" });
    return;
  }
  credSaving.value = true;
  const providerId = credTarget.value.id;
  /* 凭证写接口要求供应商已存在：草稿中的供应商先自动「保存全部」建档 */
  const committedOk = await mc.ensureProviderCommitted(providerId);
  if (!committedOk) {
    credSaving.value = false;
    return;
  }
  const ok = await mc.uploadCredential(providerId, credValue.value);
  credSaving.value = false;
  if (ok) credDialog.value = false;
}

/* ---------- 草稿内编辑：启用/删除 ---------- */
function toggleEnabled(row: AdminProvider) {
  if (!mc.config.value) return;
  const target = mc.config.value.providers.find(p => p.id === row.id);
  if (!target) return;
  if (!target.enabled && target.auth.kind === "secret" && !target.auth.hasCredential) {
    message("该供应商还没有凭证：请先「上传凭证」再启用（避免保存被拒绝）", { type: "warning" });
    return;
  }
  target.enabled = !target.enabled;
  mc.markDirty();
}

async function remove(row: AdminProvider) {
  if (!mc.config.value) return;
  const models = modelIdsOf(mc.config.value, row.id).length;
  await ElMessageBox.confirm(
    `删除供应商「${row.name}」？${models > 0 ? `其下 ${models} 个模型将一并删除，相关能力路由槽位清空。` : ""}改动需点「保存全部」才会生效。`,
    "删除确认",
    { type: "warning" }
  );
  removeProviderDeep(mc.config.value, row.id);
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
            <IconifyIconOffline icon="ep/plus" class="mr-1" />新建供应商
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

      <el-alert
        type="info"
        :closable="false"
        class="mb-3"
        show-icon
        title="工作流：新建供应商 → 「保存全部」建档（自动） → 上传凭证 → 到「模型」页添加并实测模型 → 启用供应商与模型 → 「保存全部」。保存成功即时生效，无需重启。"
      />

      <el-table v-loading="mc.loading.value" :data="providers" stripe>
        <el-table-column prop="id" min-width="130"
          ><template #header><BiText zh="ID" en="ID" /></template>
          <template #default="{ row }">
            <span class="font-mono text-sm">{{ row.id }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="name" min-width="120"
          ><template #header><BiText zh="名称" en="Name" /></template>
          <template #default="{ row }">
            <span class="font-medium">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="endpoint" min-width="240" show-overflow-tooltip
          ><template #header><BiText zh="端点" en="Endpoint" /></template
        ></el-table-column>
        <el-table-column width="150" align="center"
          ><template #header><BiText zh="认证" en="Auth" /></template>
          <template #default="{ row }">
            <el-tag size="small" effect="plain" class="mr-1">
              {{ row.auth.kind === "secret" ? "凭证" : "免密" }}
            </el-tag>
            <el-tag
              v-if="row.auth.kind === 'secret'"
              :type="row.auth.hasCredential ? 'success' : 'danger'"
              size="small"
            >
              {{ row.auth.hasCredential ? "已配置" : "未配置" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column width="90" align="center"
          ><template #header><BiText zh="模型数" en="Models" /></template>
          <template #default="{ row }">{{ modelCount(row as AdminProvider) }}</template>
        </el-table-column>
        <el-table-column width="90" align="center"
          ><template #header><BiText zh="启用" en="Enabled" /></template>
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
              {{ row.enabled ? "启用" : "禁用" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <Perms value="gateway:manage">
              <el-button text size="small" type="primary" @click="openCredential(row as AdminProvider)">
                {{ (row as AdminProvider).auth.hasCredential ? "换凭证" : "上传凭证" }}
              </el-button>
              <el-button text size="small" @click="toggleEnabled(row as AdminProvider)">
                {{ (row as AdminProvider).enabled ? "禁用" : "启用" }}
              </el-button>
              <el-button text size="small" type="danger" @click="remove(row as AdminProvider)">删除</el-button>
            </Perms>
            <el-tooltip v-if="!canManage" content="无 gateway:manage 权限" placement="top">
              <span><el-button text size="small" disabled>只读</el-button></span>
            </el-tooltip>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无供应商：点「新建供应商」开始（OpenAI 兼容端点）" :image-size="64" />
        </template>
      </el-table>
    </el-card>

    <!-- 新建供应商 -->
    <el-dialog v-model="createDialog" title="新建供应商（禁用态建档）" width="540px">
      <el-form label-width="110px">
        <el-form-item label="ID" required>
          <el-input v-model="createForm.id" placeholder="如 prov-deepseek（唯一，保存后作为内部引用）" />
        </el-form-item>
        <el-form-item label="显示名称" required>
          <el-input v-model="createForm.name" placeholder="如 deepseek" />
        </el-form-item>
        <el-form-item label="端点" required>
          <el-input v-model="createForm.endpoint" placeholder="https://api.deepseek.com/v1 或 http://127.0.0.1:11434/v1" />
        </el-form-item>
        <el-form-item label="认证方式">
          <el-radio-group v-model="createForm.authKind">
            <el-radio value="secret">API 凭证（后续上传，服务端加密存储）</el-radio>
            <el-radio value="none">免密（本地推理服务器）</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" @click="submitCreate">加入草稿</el-button>
      </template>
    </el-dialog>

    <!-- 上传凭证 -->
    <el-dialog
      v-model="credDialog"
      :title="`上传凭证 · ${credTarget?.name ?? ''}`"
      width="480px"
      @closed="credValue = ''"
    >
      <el-alert
        type="info"
        :closable="false"
        class="mb-3"
        show-icon
        title="凭证经 AES-256-GCM 加密落盘，任何页面/接口/日志都不回显明文；每次替换生成新密钥版本，旧版本保留用于回滚。"
      />
      <el-input
        v-model="credValue"
        type="password"
        show-password
        placeholder="粘贴该供应商的 API Key（仅提交一次，不回显）"
      />
      <template #footer>
        <el-button @click="credDialog = false">取消</el-button>
        <el-button type="primary" :loading="credSaving" @click="submitCredential">加密保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
