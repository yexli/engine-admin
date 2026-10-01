<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { getEmbeddingInfo, type EmbeddingInfo } from "@/api/memory";
import {
  getEmbeddingConfig,
  updateEmbeddingConfig,
  testEmbedding,
  type EmbeddingConfig,
  type EmbeddingTestResult
} from "@/api/memoryConfig";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "MemoryEmbedding" });

const info = ref<EmbeddingInfo | null>(null);
const cfg = ref<EmbeddingConfig | null>(null);
const { loading, error, run } = useAsyncData();
const canManage = hasPerms("system:manage");

const anyAttached = () => (info.value?.channels ?? []).some(c => c.attached);

/* 配置表单（草稿；apiKey 留空 = 不修改已存密钥） */
const form = reactive({
  enabled: false,
  endpoint: "",
  model: "",
  apiKey: ""
});
const saving = ref(false);
const testing = ref(false);
const testResult = ref<EmbeddingTestResult | null>(null);

async function load() {
  const res = await run(async () => {
    const [infoRes, cfgRes] = await Promise.all([
      getEmbeddingInfo(),
      getEmbeddingConfig().catch(() => null)
    ]);
    return { info: infoRes, cfg: cfgRes };
  });
  if (res) {
    info.value = res.info;
    if (res.cfg) {
      cfg.value = res.cfg;
      form.enabled = res.cfg.enabled;
      form.endpoint = res.cfg.endpoint;
      form.model = res.cfg.model;
      form.apiKey = "";
    }
  }
}

async function save() {
  if (form.enabled && (!form.endpoint.trim() || !form.model.trim())) {
    message("启用时 Endpoint 与模型名必填", { type: "warning" });
    return;
  }
  saving.value = true;
  try {
    const out = await updateEmbeddingConfig({
      enabled: form.enabled,
      endpoint: form.endpoint.trim(),
      model: form.model.trim(),
      ...(form.apiKey ? { apiKey: form.apiKey } : {})
    });
    cfg.value = out;
    form.apiKey = "";
    message(`已保存并热应用（通道 ${out.enabled ? "启用" : "停用"}）`, {
      type: "success"
    });
    load();
  } catch (e) {
    message(e instanceof Error ? e.message : "保存失败", { type: "error" });
  } finally {
    saving.value = false;
  }
}

async function doTest() {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await testEmbedding();
  } catch (e) {
    message(e instanceof Error ? e.message : "测试失败", { type: "error" });
  } finally {
    testing.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
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

    <!-- 嵌入模型配置（可写；system:manage） -->
    <el-card shadow="never" class="mb-3">
      <template #header>
        <div class="flex items-center justify-between">
          <BiText zh="嵌入模型配置" en="Embedding Config" />
          <el-tag
            v-if="cfg"
            :type="cfg.enabled ? 'success' : 'info'"
            size="small"
          >
            {{ cfg.enabled ? "已启用" : "未启用" }}
          </el-tag>
        </div>
      </template>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="mb-3"
        title="任意 OpenAI 兼容 /embeddings 端点（云上或本地推理均可）。保存后热应用（无需重启），检索语义相似度 ×0.2 并入总分；向量化失败自动回退纯词面。apiKey 加密边界：明文只存记忆服务侧配置，界面不回显。"
      />
      <el-form
        v-if="cfg"
        label-width="110px"
        :disabled="!canManage"
        class="max-w-[720px]"
      >
        <el-form-item label="启用">
          <el-switch v-model="form.enabled" />
        </el-form-item>
        <el-form-item label="Endpoint" required>
          <el-input
            v-model="form.endpoint"
            :placeholder="form.enabled ? '如 https://api.openai.com/v1 或 http://127.0.0.1:11434/v1' : '停用状态下可留空'"
            maxlength="256"
            class="font-mono"
          />
        </el-form-item>
        <el-form-item label="模型名" required>
          <el-input
            v-model="form.model"
            :placeholder="form.enabled ? '如 text-embedding-3-small / bge-m3' : ''"
            maxlength="128"
            class="font-mono"
          />
        </el-form-item>
        <el-form-item label="API Key">
          <el-input
            v-model="form.apiKey"
            type="password"
            show-password
            maxlength="4096"
            :placeholder="
              cfg.hasApiKey ? '已保存（留空 = 不修改；输入新值 = 覆盖）' : '本地推理可留空'
            "
          />
        </el-form-item>
        <el-form-item>
          <Perms value="system:manage">
            <el-button type="primary" :loading="saving" @click="save">
              保存并热应用
            </el-button>
            <el-button :loading="testing" @click="doTest">连通性测试</el-button>
          </Perms>
        </el-form-item>
      </el-form>
      <el-alert
        v-else
        type="warning"
        :closable="false"
        show-icon
        title="记忆服务未装配嵌入配置回调（旧版本或配置端点不可达）。"
      />
      <el-alert
        v-if="testResult"
        :type="testResult.ok ? 'success' : 'error'"
        :closable="false"
        show-icon
        class="mt-2 max-w-[720px]"
        :title="
          testResult.ok
            ? `连通 ✓ 维度 ${testResult.dimension} · ${testResult.ms}ms`
            : `测试失败：${testResult.error ?? '未知原因'}（${testResult.ms}ms）`
        "
      />
      <div
        v-if="!canManage"
        class="text-xs text-[--el-text-color-secondary] mt-1"
      >
        当前角色无 system:manage 权限，仅可查看。
      </div>
    </el-card>

    <el-alert
      v-if="info && !anyAttached()"
      type="info"
      :closable="false"
      class="mb-3"
      show-icon
    >
      <template #title>
        当前未接入向量通道（检索为纯词面 + 新近度 + 重要度 + 置信度）。在上方启用并保存后即热接入。
      </template>
    </el-alert>

    <el-row v-if="info" :gutter="12" class="mb-3">
      <el-col :xs="12" :md="6">
        <el-card shadow="never">
          <div class="text-xs text-[--el-text-color-secondary]">
            检索调用总数（本服务）
          </div>
          <div class="text-xl font-semibold">
            {{ info.stats.total.toLocaleString() }}
          </div>
        </el-card>
      </el-col>
      <el-col :xs="12" :md="6">
        <el-card shadow="never">
          <div class="text-xs text-[--el-text-color-secondary]">近 24h</div>
          <div class="text-xl font-semibold">{{ info.stats.last24h }}</div>
        </el-card>
      </el-col>
      <el-col :xs="12" :md="6">
        <el-card shadow="never">
          <div class="text-xs text-[--el-text-color-secondary]">平均延迟</div>
          <div class="text-xl font-semibold">
            {{ info.stats.avgLatencyMs }}ms
          </div>
        </el-card>
      </el-col>
      <el-col :xs="12" :md="6">
        <el-card shadow="never">
          <div class="text-xs text-[--el-text-color-secondary]">失败率</div>
          <div class="text-xl font-semibold">
            {{ (info.stats.failureRate * 100).toFixed(2) }}%
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card v-if="info" shadow="never">
      <template #header>
        <BiText zh="各 Store 向量通道" en="Embed Channels" />
      </template>
      <el-table :data="info.channels" stripe>
        <el-table-column prop="store" min-width="160"
          ><template #header><BiText zh="Store" en="Store" /></template>
          <template #default="{ row }">
            <span class="font-mono">{{ row.store }}</span>
          </template>
        </el-table-column>
        <el-table-column min-width="180"
          ><template #header><BiText zh="通道" en="Channel" /></template>
          <template #default="{ row }">
            <span v-if="row.attached" class="font-mono">{{
              row.name ?? "attached"
            }}</span>
            <span v-else class="text-xs text-[--el-text-color-secondary]"
              >—</span
            >
          </template>
        </el-table-column>
        <el-table-column width="110" align="center"
          ><template #header><BiText zh="维度" en="Dimension" /></template>
          <template #default="{ row }">{{ row.dimension ?? "—" }}</template>
        </el-table-column>
        <el-table-column width="120" align="center"
          ><template #header><BiText zh="状态" en="Status" /></template>
          <template #default="{ row }">
            <el-tag :type="row.attached ? 'success' : 'info'" size="small">
              {{ row.attached ? "attached" : "not-attached" }}
            </el-tag>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无 Store" :image-size="64" />
        </template>
      </el-table>
      <div class="mt-2 text-xs text-[--el-text-color-secondary]">
        统计口径：覆盖经 Memory HTTP 服务的检索调用；引擎内嵌向量钩子的调用细节未经插桩，不展示编造数字。
      </div>
    </el-card>
  </div>
</template>
