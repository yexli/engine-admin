<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  dispatchEvolutionIntent,
  getEvolutionRun,
  listEvolutionRuns,
  listEvolutionWorlds,
  tickEvolution,
  traceEvolutionEvent,
  type ChangeOutcome,
  type EvolutionRun,
  type EvolutionTrace,
  type EvolutionWorldRow
} from "@/api/evolution";
import { useAsyncData } from "@/composables/useAsyncData";
import { message } from "@/utils/message";

defineOptions({ name: "EvolutionConsole" });

const { loading, error, run } = useAsyncData();

/* ---------- 世界清单 ---------- */
const worlds = ref<EvolutionWorldRow[]>([]);
const worldId = ref("");

async function loadWorlds() {
  const res = await run(() => listEvolutionWorlds());
  worlds.value = res?.worlds ?? [];
  if (!worldId.value && worlds.value.length) worldId.value = worlds.value[0].worldId;
}

/* ---------- 运行留痕 ---------- */
const runs = ref<EvolutionRun[]>([]);
async function loadRuns() {
  if (!worldId.value) return;
  const res = await run(() => listEvolutionRuns(worldId.value, 50));
  runs.value = res?.runs ?? [];
}

/* ---------- 因果链详情 ---------- */
const detail = ref<EvolutionRun | null>(null);
const detailVisible = ref(false);
async function openRun(id: string) {
  const res = await run(() => getEvolutionRun(worldId.value, id), { silent: false });
  if (!res) return;
  detail.value = res;
  detailVisible.value = true;
}

/* ---------- 触发演化 ---------- */
const ticking = ref(false);
async function onTick() {
  if (!worldId.value) return;
  ticking.value = true;
  try {
    const runRes = await tickEvolution(worldId.value);
    if (runRes.status === "completed") {
      message(
        `演化完成：${runRes.acceptedCount ?? 0} 条放行，${runRes.rejectedCount ?? 0} 条被拒`,
        { type: "success" }
      );
    } else {
      message(`演化失败：${runRes.error ?? "未知错误"}（世界未被改动）`, {
        type: "warning"
      });
    }
    await loadRuns();
    detail.value = runRes;
    detailVisible.value = true;
  } finally {
    ticking.value = false;
  }
}

/* ---------- 意图处置（OOC 隔离演示） ---------- */
const intentKind = ref<"ic_action" | "ooc" | "narrative">("ic_action");
const intentText = ref("");
const intentCommandType = ref("change_weather");
const intentSending = ref(false);
const INTENT_META: Record<string, { label: string; tag: "primary" | "warning" | "info"; desc: string }> = {
  ic_action: { label: "IC 行动", tag: "primary", desc: "会翻译成命令，经 Rules 校验后进入世界" },
  ooc: { label: "OOC 场外", tag: "warning", desc: "只留档，永远不会成为世界事实" },
  narrative: { label: "叙事文本", tag: "info", desc: "只留档，永远不会成为世界事实" }
};

async function onSendIntent() {
  if (!worldId.value || !intentText.value.trim()) {
    message("请先填写意图文本", { type: "warning" });
    return;
  }
  intentSending.value = true;
  try {
    const isIc = intentKind.value === "ic_action";
    const res = await dispatchEvolutionIntent(worldId.value, {
      kind: intentKind.value,
      text: intentText.value.trim(),
      ...(isIc ? { command: { type: intentCommandType.value, text: "rain" } } : {})
    });
    if (isIc) {
      const ok = res.commandResult?.ok;
      message(
        ok
          ? `IC 行动已执行：事实 ${res.commandResult?.events.join("、")}`
          : `命令被拒绝：${res.commandResult?.reason ?? "未知原因"}`,
        { type: ok ? "success" : "warning" }
      );
    } else {
      message(`${INTENT_META[intentKind.value].label}已留档，未进入世界`, { type: "info" });
    }
    intentText.value = "";
    await loadRuns();
  } finally {
    intentSending.value = false;
  }
}

onMounted(async () => {
  await loadWorlds();
  await loadRuns();
});

/* ---------- 展示辅助 ---------- */
const statusTag = (s: EvolutionRun["status"]) =>
  s === "completed"
    ? "success"
    : s === "partially_applied"
      ? "warning"
      : s === "failed" || s === "rejected"
        ? "danger"
        : "info";
const verdictOf = (o: ChangeOutcome) => {
  if (o.status === "accepted") return { text: "Rules 放行", tag: "success" as const };
  if (o.status === "duplicate") return { text: "幂等跳过", tag: "info" as const };
  if (o.rejectedBy === "policy") return { text: "策略拒绝", tag: "warning" as const };
  if (o.rejectedBy === "translate") return { text: "白名单拒绝", tag: "warning" as const };
  return { text: "Rules 拒绝", tag: "danger" as const };
};
const ctxSummary = computed(() => {
  const c = detail.value?.context;
  if (!c) return "";
  return `第 ${c.day} 天 · ${c.tick} 刻 · ${c.weather || "未知天气"} · 玩家 ${c.player.name}@${c.player.loc} · 在场 ${Object.keys(c.entities).length} · 名册 ${c.otherEntities.length} · 相关关系 ${c.relations.length}`;
});

/* ---------- 事件反向追溯（V2 §九） ---------- */
const traceEventId = ref("");
const traceResult = ref<EvolutionTrace | null>(null);
const traceMissing = ref(false);
const traceLoading = ref(false);
async function onTrace() {
  if (!worldId.value || !traceEventId.value.trim()) return;
  traceLoading.value = true;
  traceMissing.value = false;
  traceResult.value = null;
  try {
    traceResult.value = await traceEvolutionEvent(worldId.value, traceEventId.value.trim());
    detail.value = traceResult.value.run;
    detailVisible.value = true;
  } catch {
    traceMissing.value = true;
  } finally {
    traceLoading.value = false;
  }
}
</script>

<template>
  <div class="p-4">
    <el-alert
      type="info"
      :closable="false"
      show-icon
      class="mb-3"
      title="AI 世界演化运行时：观察世界 → 组装上下文 → AI 提案 → 白名单翻译 → 引擎 Rules 校验 → Mutation → 事件。AI 只能建议，Rules 说了算；每次运行的完整因果链（含「AI 当时看到了什么、为什么这么建议、哪些被拒绝」）可反向追溯。"
    />

    <el-card shadow="never" class="mb-3">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm font-medium">世界</span>
        <el-select
          v-model="worldId"
          filterable
          placeholder="选择世界"
          class="!w-64"
          @change="loadRuns"
        >
          <el-option
            v-for="w in worlds"
            :key="w.worldId"
            :value="w.worldId"
            :label="`${w.worldId}${w.inEngine ? '' : '（引擎外·历史账本）'}`"
          />
        </el-select>
        <el-button
          type="primary"
          :loading="ticking"
          :disabled="!worldId"
          @click="onTick"
        >
          <IconifyIconOffline icon="ep/magic-stick" class="mr-1" />演化一次
        </el-button>
        <el-button :loading="loading" @click="loadRuns">
          <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新留痕
        </el-button>
        <el-divider direction="vertical" />
        <el-input
          v-model="traceEventId"
          placeholder="事件 id 反向追溯（evt_...）"
          class="!w-56 font-mono"
          @keyup.enter="onTrace"
        />
        <el-button :loading="traceLoading" :disabled="!traceEventId.trim()" @click="onTrace">
          <IconifyIconOffline icon="ep/search" class="mr-1" />查因果
        </el-button>
        <el-alert
          v-if="traceMissing"
          type="warning"
          :closable="false"
          show-icon
          title="该事件不在演化账本中（可能不是演化产生的，或窗口外）"
          class="!py-1"
        />
        <span v-if="error" class="text-xs" style="color: var(--el-color-danger)">
          {{ error }}
        </span>
      </div>
    </el-card>

    <el-card shadow="never" class="mb-3">
      <template #header>
        <div class="flex items-center gap-2">
          <span class="font-medium">意图处置</span>
          <span class="text-xs text-[--el-text-color-secondary]">
            OOC / 叙事永不成为世界事实（方案 §七 隔离闸）
          </span>
        </div>
      </template>
      <div class="flex flex-wrap items-center gap-2">
        <el-radio-group v-model="intentKind">
          <el-radio-button value="ic_action">IC 行动</el-radio-button>
          <el-radio-button value="ooc">OOC 场外</el-radio-button>
          <el-radio-button value="narrative">叙事文本</el-radio-button>
        </el-radio-group>
        <el-input
          v-model="intentText"
          placeholder="意图文本（如：我想让天下雨）"
          class="!w-72"
          @keyup.enter="onSendIntent"
        />
        <el-select
          v-if="intentKind === 'ic_action'"
          v-model="intentCommandType"
          class="!w-44"
        >
          <el-option value="change_weather" label="change_weather（text=rain）" />
          <el-option value="advance_time" label="advance_time（+1 刻）" />
          <el-option value="move" label="move（→ tavern）" />
        </el-select>
        <el-button :loading="intentSending" @click="onSendIntent">提交</el-button>
        <span class="text-xs text-[--el-text-color-secondary]">
          {{ INTENT_META[intentKind].desc }}
        </span>
      </div>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <span class="font-medium">演化运行留痕（新 → 旧）</span>
      </template>
      <el-table
        v-loading="loading"
        :data="runs"
        stripe
        size="small"
        @row-click="(row: EvolutionRun) => openRun(row.id)"
      >
        <el-table-column prop="id" min-width="200"
          ><template #header><span>Run</span></template>
          <template #default="{ row }">
            <el-link type="primary" class="font-mono text-xs">{{ row.id }}</el-link>
          </template>
        </el-table-column>
        <el-table-column width="100" align="center">
          <template #header><span>状态</span></template>
          <template #default="{ row }">
            <el-tag :type="statusTag(row.status)" size="small">
              {{ row.status }}<template v-if="row.deduplicated">·幂等</template>
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column width="90" align="center">
          <template #header><span>触发</span></template>
          <template #default="{ row }">{{ row.trigger }}</template>
        </el-table-column>
        <el-table-column min-width="180">
          <template #header><span>AI 判断 / 错误</span></template>
          <template #default="{ row }">
            <span class="text-xs">{{ row.proposal?.reason ?? row.error ?? "—" }}</span>
          </template>
        </el-table-column>
        <el-table-column width="100" align="center">
          <template #header><span>模型/驱动</span></template>
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.modelUsed ?? "—" }}</span>
          </template>
        </el-table-column>
        <el-table-column width="90" align="center">
          <template #header><span>放行/被拒</span></template>
          <template #default="{ row }">
            <span class="text-xs">
              {{ row.acceptedCount ?? 0 }} /
              <span style="color: var(--el-color-danger)">{{ row.rejectedCount ?? 0 }}</span>
            </span>
          </template>
        </el-table-column>
        <el-table-column width="110" align="center">
          <template #header><span>产生事实</span></template>
          <template #default="{ row }">
            <span class="font-mono text-xs">{{ row.eventIds.length }} 条</span>
          </template>
        </el-table-column>
        <el-table-column min-width="120">
          <template #header><span>影响实体</span></template>
          <template #default="{ row }">
            <span class="font-mono text-xs">
              {{ (row.entitiesAffected ?? []).join("、") || "—" }}
            </span>
          </template>
        </el-table-column>
        <el-table-column width="90" align="center">
          <template #header><span>耗时</span></template>
          <template #default="{ row }">{{ row.tookMs ?? 0 }}ms</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && runs.length === 0" description="尚无演化留痕——点上方「演化一次」触发闭环" />
    </el-card>

    <el-drawer
      v-model="detailVisible"
      :title="`演化因果链 · ${detail?.id ?? ''}`"
      size="56%"
    >
      <template v-if="detail">
        <el-descriptions :column="2" size="small" border class="mb-3">
          <el-descriptions-item label="状态">
            <el-tag :type="statusTag(detail.status)" size="small">{{ detail.status }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="开始时间">{{ detail.startedAt }}</el-descriptions-item>
          <el-descriptions-item label="驱动/模型">{{ detail.modelUsed ?? "—" }}</el-descriptions-item>
          <el-descriptions-item label="观察窗口">
            最近 {{ detail.observationWindow.eventCount }} 条事实
            <span v-if="detail.observationWindow.latestEventId" class="font-mono text-xs">
              （head: {{ detail.observationWindow.latestEventId }}）
            </span>
          </el-descriptions-item>
          <el-descriptions-item label="世界快照" :span="2">{{ ctxSummary || "（无）" }}</el-descriptions-item>
        </el-descriptions>

        <el-alert
          v-if="detail.error"
          type="error"
          :closable="false"
          show-icon
          class="mb-3"
          :title="`驱动失败：${detail.error}（世界未被改动）`"
        />

        <template v-if="detail.proposal">
          <h4 class="mb-1 font-medium">AI 的整体判断</h4>
          <p class="mb-1 text-sm">{{ detail.proposal.reason }}</p>
          <p class="mb-3 text-xs text-[--el-text-color-secondary]">
            置信度 {{ detail.proposal.confidence ?? "—" }} · 来源 {{ detail.proposal.source.model ?? "—" }}
          </p>

          <h4 class="mb-1 font-medium">依据的观察（只引用真实事实）</h4>
          <ul class="mb-3 pl-5 text-sm list-disc">
            <li v-for="o in detail.proposal.observations" :key="o.ref" class="font-mono text-xs">
              [{{ o.ref }}] {{ o.kind }} · {{ o.summary }}
            </li>
            <li v-if="!detail.proposal.observations.length" class="text-xs text-[--el-text-color-secondary]">
              （提案未声明观察依据）
            </li>
          </ul>

          <h4 class="mb-1 font-medium">逐条裁决（白名单 → 引擎 Rules）</h4>
          <el-timeline class="pl-1">
            <el-timeline-item
              v-for="(o, i) in detail.outcomes ?? []"
              :key="i"
              :type="verdictOf(o).tag"
              :timestamp="`${verdictOf(o).text} · ${o.changeId}`"
            >
              <p class="text-sm">
                <span class="font-mono text-xs">{{ o.change.action }}</span>
                → <span class="font-mono text-xs">{{ o.change.targetId }}</span>
                <span class="text-xs text-[--el-text-color-secondary]">（{{ o.change.reason }}）</span>
              </p>
              <p v-if="o.command" class="font-mono text-xs text-[--el-text-color-secondary]">
                {{ o.commandId }}: {{ JSON.stringify(o.command) }}
              </p>
              <p v-if="o.reason && o.status === 'rejected'" class="text-xs" style="color: var(--el-color-danger)">
                拒绝原因：{{ o.reason }}
              </p>
              <p v-if="o.status === 'duplicate'" class="text-xs text-[--el-text-color-secondary]">
                同一提案内的重复变化，幂等跳过（未重复 Mutation）
              </p>
              <p v-if="o.eventIds.length" class="font-mono text-xs" style="color: var(--el-color-success)">
                产生事实：{{ o.eventIds.join("、") }}
              </p>
            </el-timeline-item>
          </el-timeline>
        </template>
      </template>
    </el-drawer>
  </div>
</template>
