<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useModelControl } from "@/composables/useModelControl";
import {
  MANAGED_CAPABILITIES,
  CAPABILITY_META,
  type ManagedCapability
} from "@/api/modelControl";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";

defineOptions({ name: "GatewayRouter" });

const mc = useModelControl();
const canManage = hasPerms("gateway:manage");

/** el-table 行用对象包装（readonly 元组不能直接当 data） */
const capabilityRows = MANAGED_CAPABILITIES.map(cap => ({ cap }));
type CapRow = (typeof capabilityRows)[number];

const models = computed(() => mc.config.value?.models ?? []);
const enabledModels = computed(() => models.value.filter(m => m.enabled));

function modelLabel(id: string | null): string {
  if (!id) return "（未指派）";
  const m = models.value.find(x => x.id === id);
  return m ? `${m.id}（${m.wireModel}）` : id;
}

function setSlot(cap: ManagedCapability, slot: "primary" | "fallback", value: string | null) {
  if (!mc.config.value) return;
  mc.config.value.routes[cap][slot] = value || null;
  mc.markDirty();
}

/* ---------- 有界实测（只用当前生效 primary） ---------- */
interface TestDisplay {
  capability: ManagedCapability;
  ok: boolean;
  modelId: string | null;
  elapsedMs: number;
  reply: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}
const testingCap = ref<ManagedCapability | null>(null);
const testResult = ref<TestDisplay | null>(null);

async function test(cap: ManagedCapability) {
  testingCap.value = cap;
  testResult.value = null;
  try {
    const r = await mc.testRoute(cap);
    if (r) {
      testResult.value = {
        capability: cap,
        ok: r.ok,
        modelId: r.modelId,
        elapsedMs: r.elapsedMs,
        reply: r.reply ?? null,
        errorCode: r.error?.code ?? null,
        errorMessage: r.error?.message ?? null
      };
      message(
        r.ok
          ? `能力「${CAPABILITY_META[cap].zh}」路由测试通过`
          : `能力「${CAPABILITY_META[cap].zh}」路由测试失败`,
        {
          type: r.ok ? "success" : "error"
        }
      );
    }
  } finally {
    testingCap.value = null;
  }
}

/** 草稿内整体清空某能力路由（诚实 503：宁缺毋滥） */
function clearRoute(cap: ManagedCapability) {
  if (!mc.config.value) return;
  mc.config.value.routes[cap] = { primary: null, fallback: null };
  mc.markDirty();
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
          <el-button
            :loading="mc.saving.value"
            :disabled="mc.revision.value === 0"
            @click="mc.rollback()"
          >
            <IconifyIconOffline icon="ep/refresh-right" class="mr-1" />
            回滚上一版
          </el-button>
          <el-button type="primary" :loading="mc.saving.value" @click="mc.save()">
            <IconifyIconOffline icon="ep/check" class="mr-1" />
            保存全部
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
        title="六个能力固定：主模型失败自动降级到备模型；未指派的能力对 world-agent 诚实返回 503。保存成功即时生效，无需重启。鼠标悬停能力名可查看其触发语义（由平台任务分析决定）。"
      />

      <el-table v-loading="mc.loading.value" :data="capabilityRows" stripe>
        <el-table-column width="190"
          ><template #header><BiText zh="能力" en="Capability" /></template>
          <template #default="{ row }">
            <el-tooltip
              :content="CAPABILITY_META[(row as CapRow).cap].desc"
              placement="top"
            >
              <div>
                <el-tag size="small">{{
                  CAPABILITY_META[(row as CapRow).cap].zh
                }}</el-tag>
                <span
                  class="text-xs text-[--el-text-color-secondary] font-mono ml-1"
                  >{{ (row as CapRow).cap }}</span
                >
              </div>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column min-width="220"
          ><template #header><BiText zh="主模型（仅启用模型可选）" en="Primary" /></template>
          <template #default="{ row }">
            <el-select
              :model-value="mc.config.value?.routes[(row as CapRow).cap]?.primary ?? null"
              filterable
              clearable
              placeholder="未指派（503）"
              class="!w-full"
              :disabled="!canManage"
              @update:model-value="v => setSlot((row as CapRow).cap, 'primary', (v as string | null) || null)"
            >
              <el-option
                v-for="m in enabledModels"
                :key="m.id"
                :label="`${m.id}（${m.wireModel}）`"
                :value="m.id"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column min-width="220"
          ><template #header><BiText zh="备模型" en="Fallback" /></template>
          <template #default="{ row }">
            <el-select
              :model-value="mc.config.value?.routes[(row as CapRow).cap]?.fallback ?? null"
              filterable
              clearable
              placeholder="—"
              class="!w-full"
              :disabled="!canManage"
              @update:model-value="v => setSlot((row as CapRow).cap, 'fallback', (v as string | null) || null)"
            >
              <el-option
                v-for="m in enabledModels"
                :key="m.id"
                :label="`${m.id}（${m.wireModel}）`"
                :value="m.id"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button
              text
              size="small"
              type="primary"
              :loading="testingCap === (row as CapRow).cap"
              @click="test((row as CapRow).cap)"
            >
              测试
            </el-button>
            <Perms value="gateway:manage">
              <el-button text size="small" @click="clearRoute((row as CapRow).cap)">清空</el-button>
            </Perms>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 测试结果（真实上游调用，只打当前生效 primary 链路） -->
    <el-dialog
      :model-value="!!testResult"
      :title="`路由测试 · ${testResult ? CAPABILITY_META[testResult.capability].zh : ''}（${testResult?.capability ?? ''}）`"
      width="520px"
      @update:model-value="v => !v && (testResult = null)"
      @closed="testResult = null"
    >
      <el-descriptions v-if="testResult" :column="1" border size="small">
        <el-descriptions-item label="结果">
          <el-tag :type="testResult.ok ? 'success' : 'danger'" size="small">
            {{ testResult.ok ? "通过" : "失败" }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="实测模型">{{
          testResult.modelId ?? "—"
        }}</el-descriptions-item>
        <el-descriptions-item label="耗时">{{ testResult.elapsedMs }}ms</el-descriptions-item>
        <el-descriptions-item v-if="testResult.reply" label="回复">
          <span class="font-mono text-sm">{{ testResult.reply }}</span>
        </el-descriptions-item>
        <el-descriptions-item v-if="testResult.errorCode" label="错误码">
          <span class="font-mono text-sm">{{ testResult.errorCode }}</span>
        </el-descriptions-item>
        <el-descriptions-item v-if="testResult.errorMessage" label="错误信息">
          {{ testResult.errorMessage }}
        </el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="testResult = null">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>
