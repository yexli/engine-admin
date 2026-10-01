<!-- 命令调试台：选择命令 → 填参数 → Preview → Execute → 结果
     执行走真实引擎；执行前强制确认（可能修改 World State） -->
<template>
  <div class="flex flex-wrap gap-3">
    <!-- 命令目录 -->
    <el-card shadow="never" class="w-[280px]" header="命令目录（引擎内置规则）">
      <el-input
        v-model="typeFilter"
        placeholder="搜索命令"
        clearable
        class="mb-2"
      />
      <div class="space-y-1 max-h-[480px] overflow-auto">
        <div
          v-for="spec in filteredSpecs"
          :key="spec.type"
          class="cursor-pointer rounded px-3 py-2 transition-colors"
          :class="
            selected?.type === spec.type
              ? 'bg-[--el-color-primary-light-9] text-[--el-color-primary]'
              : 'hover:bg-[--el-fill-color-light]'
          "
          @click="select(spec)"
        >
          <div class="font-medium text-sm font-mono">{{ spec.type }}</div>
          <div class="text-xs text-[--el-text-color-secondary] truncate">
            {{ spec.label }} · {{ spec.extension }}
          </div>
        </div>
      </div>
    </el-card>

    <!-- 参数与执行 -->
    <div class="flex-1 min-w-[420px]">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        class="mb-3"
        title="命令会直接修改 World State（经 Command → Rules → Mutation）。执行前请确认参数。"
      />

      <el-card v-if="!selected" shadow="never">
        <el-empty description="从左侧选择一个命令" :image-size="72" />
      </el-card>

      <template v-else>
        <el-card shadow="never" class="mb-3">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="font-mono">{{ selected.type }}</span>
              <span class="text-xs text-[--el-text-color-secondary]">
                {{ selected.description }}
              </span>
            </div>
          </template>

          <el-form label-width="120px">
            <el-form-item
              v-for="field in selected.fields"
              :key="field.key"
              :label="field.label"
              :required="field.required"
            >
              <el-input-number
                v-if="field.key === 'amount'"
                v-model="form.amount"
                :placeholder="field.placeholder"
                class="!w-48"
              />
              <el-input
                v-else-if="field.key === 'text'"
                v-model="form.text"
                :placeholder="field.placeholder"
              />
              <el-input
                v-else-if="field.key === 'actorId'"
                v-model="form.actorId"
                :placeholder="field.placeholder ?? '缺省 player'"
              />
              <el-input
                v-else-if="field.key === 'targetId'"
                v-model="form.targetId"
                :placeholder="field.placeholder"
              />
              <template v-else-if="field.key === 'payload'">
                <el-input
                  v-model="payloadText"
                  type="textarea"
                  :rows="4"
                  class="font-mono"
                  placeholder='{"key": "value"}（一层基本类型）'
                />
                <div
                  v-if="payloadError"
                  class="text-xs text-[--el-color-danger] mt-1"
                >
                  {{ payloadError }}
                </div>
                <div
                  v-if="field.payloadKeys?.length"
                  class="text-xs text-[--el-text-color-secondary] mt-1"
                >
                  引擎读取的键：{{ field.payloadKeys.join(" / ") }}
                </div>
              </template>
            </el-form-item>

            <el-form-item>
              <Perms value="command:execute">
                <el-button
                  type="danger"
                  :loading="executing"
                  :disabled="!!payloadError"
                  @click="confirmExecute"
                >
                  <IconifyIconOffline icon="ep/position" class="mr-1" />
                  执行 Execute
                </el-button>
              </Perms>
              <el-button @click="resetForm">重置</el-button>
              <span
                v-if="!hasPerms('command:execute')"
                class="text-xs text-[--el-text-color-secondary] self-center ml-2"
              >
                当前角色无 command:execute 权限，仅可预览
              </span>
            </el-form-item>
          </el-form>

          <el-divider content-position="left"
            >预览（发送给引擎的命令）Preview</el-divider
          >
          <JsonView :data="previewCommand" height="160px" />
        </el-card>

        <!-- 执行结果 -->
        <el-card v-if="result" shadow="never">
          <template #header
            ><BiText zh="执行结果" en="Command Result"
          /></template>
          <el-result
            :icon="result.ok ? 'success' : 'error'"
            :title="result.ok ? '执行成功' : '命令被拒绝'"
            :sub-title="result.ok ? undefined : result.reason"
            style="padding: 12px 0"
          />
          <template v-if="result.events?.length">
            <el-divider content-position="left"
              >产生事件（{{ result.events.length }}）Generated
              Events</el-divider
            >
            <el-tag
              v-for="ev in result.events"
              :key="ev"
              class="mr-1 mb-1"
              size="small"
              type="warning"
            >
              {{ ev }}
            </el-tag>
          </template>
          <div class="mt-2 text-xs text-[--el-text-color-secondary]">
            状态变更请到 State / Entities 查看；事件详情见 Events。
          </div>
        </el-card>
      </template>
    </div>

    <!-- 命令历史（M1.4 起真实：Runtime 侧环形缓冲，新 → 旧） -->
    <el-card shadow="never" class="w-[300px]">
      <template #header>
        <div class="flex items-center justify-between">
          <BiText zh="历史记录" en="History" />
          <el-button
            size="small"
            text
            type="primary"
            :loading="historyLoading"
            @click="loadHistory"
          >
            刷新
          </el-button>
        </div>
      </template>
      <div v-loading="historyLoading" class="space-y-2 max-h-[520px] overflow-auto">
        <div
          v-for="h in history"
          :key="h.seq"
          class="rounded px-2 py-1.5 cursor-pointer transition-colors hover:bg-[--el-fill-color-light]"
          :class="h.ok ? '' : 'bg-[--el-color-danger-light-9]'"
          @click="showHistoryEntry(h)"
        >
          <div class="flex items-center gap-2">
            <el-tag :type="h.ok ? 'success' : 'danger'" size="small">
              {{ h.ok ? "ok" : "rejected" }}
            </el-tag>
            <span class="font-mono text-xs truncate">{{ h.command.type }}</span>
            <span class="text-xs text-[--el-text-color-secondary] ml-auto">
              D{{ h.day }}·{{ h.tick }}
            </span>
          </div>
          <div
            v-if="h.reason"
            class="text-xs text-[--el-color-danger] truncate mt-0.5"
            :title="h.reason"
          >
            {{ h.reason }}
          </div>
        </div>
        <el-empty
          v-if="!history.length && !historyLoading"
          description="本世界还没有命令留痕"
          :image-size="56"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import {
  COMMAND_SPECS,
  executeCommand,
  getCommandHistory,
  type CommandSpec
} from "@/api/command";
import type { CommandHistoryEntry, WorldCommand } from "@/api/types";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { useAsyncData } from "@/composables/useAsyncData";
import JsonView from "@/components/JsonView/index.vue";

defineOptions({ name: "CommandConsole" });

const props = defineProps<{ worldId: string }>();
const emit = defineEmits<{ (e: "executed"): void }>();

const typeFilter = ref("");
const selected = ref<CommandSpec | null>(null);
const form = reactive<{
  actorId: string;
  targetId: string;
  amount: number | undefined;
  text: string;
}>({ actorId: "", targetId: "", amount: undefined, text: "" });
const payloadText = ref("{}");

const { loading: executing, error: execError, run } = useAsyncData();
const result = ref<{ ok: boolean; events: string[]; reason?: string } | null>(
  null
);

const filteredSpecs = computed(() =>
  COMMAND_SPECS.filter(
    s =>
      !typeFilter.value ||
      s.type.includes(typeFilter.value) ||
      s.label.includes(typeFilter.value)
  )
);

const payload = computed<Record<string, string | number | boolean> | null>(
  () => {
    const raw = payloadText.value.trim();
    if (!raw || raw === "{}") return {};
    try {
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
      for (const v of Object.values(obj)) {
        if (!["string", "number", "boolean"].includes(typeof v)) return null;
      }
      return obj;
    } catch {
      return null;
    }
  }
);

const payloadError = computed(() => {
  const raw = payloadText.value.trim();
  if (!raw || raw === "{}") return "";
  return payload.value === null
    ? "载荷必须是单层对象（string/number/boolean）"
    : "";
});

const previewCommand = computed<WorldCommand>(() => ({
  type: selected.value?.type ?? "",
  ...(form.actorId ? { actorId: form.actorId } : {}),
  ...(form.targetId ? { targetId: form.targetId } : {}),
  ...(form.amount !== undefined && form.amount !== null
    ? { amount: form.amount }
    : {}),
  ...(form.text ? { text: form.text } : {}),
  ...(payload.value && Object.keys(payload.value).length
    ? { payload: payload.value }
    : {})
}));

function select(spec: CommandSpec) {
  selected.value = spec;
  resetForm();
  const payloadField = spec.fields.find(f => f.key === "payload");
  if (payloadField?.payloadKeys?.length) {
    const skeleton: Record<string, string> = {};
    for (const k of payloadField.payloadKeys) skeleton[k] = "";
    payloadText.value = JSON.stringify(skeleton, null, 2);
  }
}

function resetForm() {
  form.actorId = "";
  form.targetId = "";
  form.amount = undefined;
  form.text = "";
  payloadText.value = "{}";
  result.value = null;
}

function confirmExecute() {
  if (!props.worldId) {
    message("请先选择世界", { type: "warning" });
    return;
  }
  if (!selected.value) return;
  const missing = selected.value.fields.find(f => {
    if (!f.required) return false;
    if (f.key === "payload")
      return !payload.value || !Object.keys(payload.value).length;
    return !form[f.key];
  });
  if (missing) {
    message(`请填写必填参数：${missing.label}`, { type: "warning" });
    return;
  }
  ElMessageBox.confirm(
    `即将对世界「${props.worldId}」执行 ${selected.value.type}。该操作会通过规则改变世界状态，且不可自动撤销。`,
    "执行确认",
    { type: "warning", confirmButtonText: "确认执行", cancelButtonText: "取消" }
  ).then(() => doExecute());
}

async function doExecute() {
  if (!selected.value) return;
  const res = await run(() =>
    executeCommand(props.worldId, previewCommand.value)
  );
  if (res) {
    result.value = res;
    message(
      res.ok ? "命令执行成功" : `命令被拒绝：${res.reason ?? "未知原因"}`,
      {
        type: res.ok ? "success" : "error"
      }
    );
    emit("executed");
    loadHistory();
  }
}

/* ---------- 命令历史（真实环形缓冲） ---------- */
const history = ref<CommandHistoryEntry[]>([]);
const { loading: historyLoading, run: runHistory } = useAsyncData();

async function loadHistory() {
  if (!props.worldId) return;
  const res = await runHistory(() => getCommandHistory(props.worldId, 20));
  if (res) history.value = res.commands;
}

function showHistoryEntry(h: CommandHistoryEntry) {
  selected.value =
    COMMAND_SPECS.find(s => s.type === h.command.type) ?? null;
  if (selected.value) {
    form.actorId = h.command.actorId ?? "";
    form.targetId = h.command.targetId ?? "";
    form.amount = h.command.amount;
    form.text = h.command.text ?? "";
    payloadText.value = h.command.payload
      ? JSON.stringify(h.command.payload, null, 2)
      : "{}";
  }
  result.value = { ok: h.ok, events: h.events, reason: h.reason };
}

watch(
  () => props.worldId,
  () => {
    result.value = null;
    history.value = [];
    loadHistory();
  },
  { immediate: true }
);
</script>
