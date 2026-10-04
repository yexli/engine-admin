<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getEmbeddingInfo, type EmbeddingInfo } from "@/api/memory";
import {
  modelControlApi,
  type RouteLive,
  type TestResult
} from "@/api/modelControl";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "MemoryEmbedding" });

/* Embedding 配置统一治理（2026-10）：本页是**状态 / 诊断页**，不再提供
   任何模型配置表单——Embedding 模型的唯一配置源 = AI 网关 → 模型路由 →
   embedding。这里展示的是路由实况（主/备模型、当前生效、冷却状态）与
   Memory 运行时实况（通道维度 / 检索统计），「测试 Embedding」走真实
   Router 链路（embed 语义，返回实测维度）。 */

const router = useRouter();
const info = ref<EmbeddingInfo | null>(null);
const live = ref<RouteLive | null>(null);
const liveUnavailable = ref(false);
const { loading, error, run } = useAsyncData();
const canManage = hasPerms("gateway:manage");

const testing = ref(false);
const testResult = ref<TestResult | null>(null);

const anyAttached = () => (info.value?.channels ?? []).some(c => c.attached);
const dimChanged = () =>
  (info.value?.channels ?? []).find(c => c.dimensionChanged)?.dimensionChanged ?? null;

async function load() {
  const res = await run(async () => {
    const [infoRes, liveRes] = await Promise.all([
      getEmbeddingInfo(),
      canManage
        ? modelControlApi.getRouteLive("embedding").catch(() => null)
        : Promise.resolve(null)
    ]);
    return { info: infoRes, live: liveRes };
  });
  if (res) {
    info.value = res.info;
    live.value = res.live;
    liveUnavailable.value = canManage && res.live === null;
  }
}

async function doTest() {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await modelControlApi.testRoute("embedding");
  } catch (e) {
    message(e instanceof Error ? e.message : "测试失败", { type: "error" });
  } finally {
    testing.value = false;
  }
}

function gotoRouter() {
  router.push("/gateway/router");
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

    <el-alert
      type="info"
      :closable="false"
      show-icon
      class="mb-3"
      title="本页为向量嵌入的状态 / 诊断页。Embedding 模型的唯一配置源：AI 网关 → 模型路由 → embedding（Memory 只消费 embedding 能力，不再保存 Provider / Endpoint / API Key）。"
    />

    <!-- 路由实况（唯一真相源：Model Router） -->
    <el-card shadow="never" class="mb-3">
      <template #header>
        <div class="flex items-center justify-between">
          <BiText zh="Embedding 路由实况" en="Embedding Route (Live)" />
          <div class="flex items-center gap-2">
            <el-tag
              v-if="live"
              :type="live.route.primary ? 'success' : 'info'"
              size="small"
            >
              {{ live.route.primary ? "已启用" : "未配置" }}
            </el-tag>
            <Perms value="gateway:manage">
              <el-button size="small" @click="gotoRouter">
                前往模型路由
              </el-button>
            </Perms>
          </div>
        </div>
      </template>

      <template v-if="live">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="能力">embedding</el-descriptions-item>
          <el-descriptions-item label="当前生效">
            <template v-if="live.resolved">
              <span class="font-mono">{{ live.resolved.modelId }}</span>
              <el-tag
                v-if="live.resolved.usedFallback"
                type="warning"
                size="small"
                class="ml-2"
                >fallback 接管</el-tag
              >
            </template>
            <span v-else class="text-[--el-text-color-secondary]"
              >—（无可用模型，语义召回关闭，词面召回照常）</span
            >
          </el-descriptions-item>
          <el-descriptions-item label="主模型（primary）">
            <template v-if="live.primary">
              <span class="font-mono">{{ live.primary.modelId }}</span>
              <span
                v-if="live.primary.wireModel"
                class="text-xs text-[--el-text-color-secondary] ml-1"
                >({{ live.primary.wireModel }})</span
              >
              <el-tag
                v-if="live.primary.coolingDown"
                type="danger"
                size="small"
                class="ml-2"
                >冷却中</el-tag
              >
              <div
                v-if="live.primary.providerName"
                class="text-xs text-[--el-text-color-secondary]"
              >
                Provider：{{ live.primary.providerName }}
              </div>
            </template>
            <span v-else class="text-[--el-text-color-secondary]">未指派</span>
          </el-descriptions-item>
          <el-descriptions-item label="备模型（fallback）">
            <template v-if="live.fallback">
              <span class="font-mono">{{ live.fallback.modelId }}</span>
              <el-tag
                v-if="live.fallback.coolingDown"
                type="danger"
                size="small"
                class="ml-2"
                >冷却中</el-tag
              >
              <div
                v-if="live.fallback.providerName"
                class="text-xs text-[--el-text-color-secondary]"
              >
                Provider：{{ live.fallback.providerName }}
              </div>
            </template>
            <span v-else class="text-[--el-text-color-secondary]">无</span>
          </el-descriptions-item>
        </el-descriptions>

        <div class="mt-3 flex items-center gap-2">
          <Perms value="gateway:manage">
            <el-button
              type="primary"
              :disabled="!live.route.primary"
              :loading="testing"
              @click="doTest"
              >测试 Embedding</el-button
            >
          </Perms>
          <span
            v-if="!canManage"
            class="text-xs text-[--el-text-color-secondary]"
            >当前角色无 gateway:manage 权限，测试与跳转不可用。</span
          >
        </div>

        <el-alert
          v-if="testResult"
          :type="testResult.ok ? 'success' : 'error'"
          :closable="false"
          show-icon
          class="mt-2"
          :title="
            testResult.ok
              ? `测试通过 ✓ 能力 embedding · 模型 ${testResult.modelId} · 维度 ${testResult.dimension ?? '—'} · ${testResult.elapsedMs}ms`
              : `测试失败：${testResult.error?.message ?? '未知原因'}（${testResult.elapsedMs}ms）`
          "
        />
      </template>
      <el-alert
        v-else
        type="warning"
        :closable="false"
        show-icon
        title="无法读取路由实况（需要 gateway:manage 权限或平台管理面可达）。Memory 运行时实况仍正常展示。"
      />
    </el-card>

    <el-alert
      v-if="info && !anyAttached()"
      type="info"
      :closable="false"
      class="mb-3"
      show-icon
    >
      <template #title>
        当前未接入向量通道（检索为纯词面 + 新近度 + 重要度 + 置信度）。在模型路由配置
        embedding 能力并确保 EmbeddingService 接入后即生效。
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

    <el-alert
      v-if="dimChanged()"
      type="warning"
      :closable="false"
      class="mb-3"
      show-icon
    >
      <template #title>
        检测到向量维度变化（{{ dimChanged()!.from }} →
        {{ dimChanged()!.to }}）：本引擎向量按检索实时计算、无持久向量需要重建，但语义分将按新模型重算。
      </template>
    </el-alert>

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
              row.name ?? "platform-model-router"
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
        <el-table-column width="140" align="center"
          ><template #header
            ><BiText zh="引擎实测维度" en="Engine Dim" /></template
          >
          <template #default="{ row }">{{
            row.engineDimension ?? "—"
          }}</template>
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
