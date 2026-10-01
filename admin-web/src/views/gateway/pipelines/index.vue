<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import {
  listPipelines,
  testPipeline,
  inputKeysOf,
  outputZh,
  type PipelineRow,
  type PipelineNode,
  type PipelineTestResponse
} from "@/api/pipeline";
import { CAPABILITY_META, type ManagedCapability } from "@/api/modelControl";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { useAsyncData, truncate } from "@/composables/useAsyncData";

defineOptions({ name: "GatewayPipelines" });

const list = ref<PipelineRow[]>([]);
const { loading, error, run } = useAsyncData();
const canManage = hasPerms("gateway:manage");

/** 角色 → 中文指代与着色（六能力词表内的才映射，未知角色如实展示原文） */
function roleZh(role: string): string {
  return role in CAPABILITY_META
    ? CAPABILITY_META[role as ManagedCapability].zh
    : role;
}

const ROLE_COLOR: Record<string, string> = {
  roleplay: "#e6a23c",
  narrative: "#409eff",
  reasoning: "#9a66e4",
  fast: "#67c23a",
  cheap: "#909399",
  memory: "#00b2a9"
};

function roleColor(role: string): string {
  return ROLE_COLOR[role] ?? "#909399";
}

async function load() {
  const res = await run(() => listPipelines());
  list.value = res?.pipelines ?? [];
}

/* ---------------- 分层 DAG（最长路径分层；连线箭头按层聚合） ---------------- */

interface DagLayer {
  nodes: PipelineNode[];
}

function layersOf(row: PipelineRow): DagLayer[] {
  const depth = new Map<string, number>();
  const byId = new Map(row.nodes.map(n => [n.id, n]));
  const depthOf = (n: PipelineNode): number => {
    if (depth.has(n.id)) return depth.get(n.id)!;
    const deps = (n.dependsOn ?? []).map(id => byId.get(id)).filter(Boolean) as PipelineNode[];
    const d = deps.length ? Math.max(...deps.map(depthOf)) + 1 : 0;
    depth.set(n.id, d);
    return d;
  };
  row.nodes.forEach(depthOf);
  const maxLayer = Math.max(0, ...row.nodes.map(n => depth.get(n.id) ?? 0));
  const layers: DagLayer[] = Array.from({ length: maxLayer + 1 }, () => ({ nodes: [] }));
  for (const n of row.nodes) (layers[depth.get(n.id) ?? 0]!.nodes).push(n);
  return layers;
}

/* ---------------- 试跑状态（按管线缓存最近一次结果，直接标注在图上） ---------------- */

const lastResults = reactive(new Map<string, PipelineTestResponse>());
const runningId = ref("");

type NodeState = "idle" | "success" | "failed";

function nodeStateOf(row: PipelineRow, nodeId: string): { state: NodeState; ms?: number; why?: string; modelId?: string } {
  const res = lastResults.get(row.id);
  if (!res) return { state: "idle" };
  const t = res.result.trace.find(x => x.id === nodeId);
  if (!t) return { state: "idle" };
  return t.ok
    ? { state: "success", ms: t.ms, modelId: t.modelId }
    : { state: "failed", ms: t.ms, why: t.why };
}

const resultChipOf = (row: PipelineRow) => {
  const res = lastResults.get(row.id);
  if (!res) return null;
  const ok = res.result.trace.filter(t => t.ok).length;
  return `${ok}/${res.result.trace.length} 节点产出 · ${res.elapsedMs}ms${res.timedOut ? " · 触发熔断" : ""}`;
};

/* ---------------- 有界试跑 ---------------- */
const testDialog = ref(false);
const testing = ref(false);
const target = ref<PipelineRow | null>(null);
const inputRows = reactive<{ key: string; value: string }[]>([]);
const deadlineInput = ref<number | null>(null);

const testResult = ref<PipelineTestResponse | null>(null);
const dialogLayers = computed(() => (target.value ? layersOf(target.value) : []));

function nodeTooltip(node: PipelineNode): string {
  const deps = node.dependsOn?.length ? `\n依赖：${node.dependsOn.join(", ")}` : "\n依赖：无（入口节点）";
  const sys = node.system ? `\nsystem：${truncate(node.system, 80)}` : "";
  return `${node.user}${deps}${sys}`;
}

function openTest(row: PipelineRow) {
  target.value = row;
  testResult.value = lastResults.get(row.id) ?? null;
  inputRows.length = 0;
  for (const key of inputKeysOf(row)) {
    inputRows.push({ key, value: lastInputs.get(`${row.id}:${key}`) ?? "" });
  }
  deadlineInput.value = null;
  testDialog.value = true;
}

/** 记住每条管线最近一次的入参（会话内） */
const lastInputs = reactive(new Map<string, string>());

async function doTest() {
  const row = target.value;
  if (!row) return;
  testing.value = true;
  testResult.value = null;
  try {
    const input: Record<string, string> = {};
    for (const r of inputRows) {
      if (r.key.trim() && r.value) input[r.key.trim()] = r.value;
      lastInputs.set(`${row.id}:${r.key.trim()}`, r.value);
    }
    const res = await run(
      () =>
        testPipeline(row.id, {
          ...(Object.keys(input).length ? { input } : {}),
          ...(deadlineInput.value ? { deadlineMs: deadlineInput.value! } : {})
        }),
      { silent: true }
    );
    if (res) {
      testResult.value = res;
      lastResults.set(row.id, res);
      message(res.ok ? "试跑完成：必需节点全部产出" : "试跑完成：存在降级/失败节点（图上已标注）", {
        type: res.ok ? "success" : "warning"
      });
    }
  } finally {
    testing.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <div class="flex items-center justify-between gap-2 mb-3">
      <span class="text-sm text-[--el-text-color-secondary]">
        管线为只读展示 + 有界试跑（数据源
        <span class="font-mono">data/pipelines.json</span>，经 gateway V0.7
        校验）；不做 DAG 在线编辑器。试跑真实调用模型。
      </span>
      <el-button :loading="loading" @click="load">
        <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
      </el-button>
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

    <el-row v-if="list.length" :gutter="12">
      <el-col
        v-for="row in list"
        :key="row.id"
        :md="list.length === 1 ? 24 : 12"
        :xs="24"
        class="mb-3"
      >
        <el-card shadow="never" class="h-full">
          <template #header>
            <div class="flex items-center justify-between gap-2">
              <span class="font-medium font-mono truncate">{{ row.id }}</span>
              <div class="flex items-center gap-1.5 shrink-0">
                <el-tag size="small" effect="plain"
                  >{{ row.nodes.length }} 节点</el-tag
                >
                <el-tooltip
                  v-if="row.deadlineMs"
                  :content="`全管线时延预算 ${row.deadlineMs}ms（试跑硬封顶 30s）`"
                  placement="top"
                >
                  <el-tag size="small" type="info" effect="plain"
                    >⏱ {{ row.deadlineMs }}ms</el-tag
                  >
                </el-tooltip>
                <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
                  {{ row.enabled ? "启用" : "停用" }}
                </el-tag>
              </div>
            </div>
          </template>

          <div class="text-sm text-[--el-text-color-regular] mb-3">
            {{ row.description ?? "—" }}
          </div>

          <!-- 分层 DAG（试跑后节点上色：绿=产出 / 红=失败 / 灰=未运行） -->
          <div
            class="flex items-stretch gap-1 overflow-x-auto pb-1 mb-2"
            v-loading="testing && target?.id === row.id"
          >
            <template v-for="(layer, li) in layersOf(row)" :key="li">
              <div class="flex flex-col gap-2 min-w-[128px]">
                <el-tooltip
                  v-for="node in layer.nodes"
                  :key="node.id"
                  :content="nodeTooltip(node)"
                  placement="top"
                  :show-after="150"
                >
                  <div
                    class="rounded-md border px-2 py-1.5 cursor-default transition-colors"
                    :style="{
                      borderColor:
                        nodeStateOf(row, node.id).state === 'success'
                          ? '#67c23a'
                          : nodeStateOf(row, node.id).state === 'failed'
                            ? '#f56c6c'
                            : `${roleColor(node.role)}55`,
                      background:
                        nodeStateOf(row, node.id).state === 'success'
                          ? 'rgba(103,194,58,.08)'
                          : nodeStateOf(row, node.id).state === 'failed'
                            ? 'rgba(245,108,108,.08)'
                            : 'transparent'
                    }"
                  >
                    <div class="flex items-center gap-1">
                      <span
                        class="w-1.5 h-1.5 rounded-full shrink-0"
                        :style="{ background: roleColor(node.role) }"
                      />
                      <span class="font-mono text-xs font-medium truncate">{{
                        node.id
                      }}</span>
                      <span
                        v-if="nodeStateOf(row, node.id).state === 'success'"
                        class="text-[10px] leading-none"
                        style="color: #67c23a"
                        >✓{{ nodeStateOf(row, node.id).ms }}ms</span
                      >
                      <span
                        v-else-if="nodeStateOf(row, node.id).state === 'failed'"
                        class="text-[10px] leading-none"
                        style="color: #f56c6c"
                        >✗ 失败</span
                      >
                      <el-tag
                        v-if="node.optional"
                        size="small"
                        effect="plain"
                        class="ml-auto shrink-0"
                        >可选</el-tag
                      >
                    </div>
                    <div class="flex items-center justify-between gap-1 mt-0.5">
                      <span
                        class="text-[11px] truncate"
                        :style="{ color: roleColor(node.role) }"
                        >{{ roleZh(node.role) }}</span
                      >
                      <span
                        class="text-[10px] text-[--el-text-color-secondary] shrink-0"
                        >{{ outputZh(node.output) }}</span
                      >
                    </div>
                  </div>
                </el-tooltip>
              </div>
              <div
                v-if="li < layersOf(row).length - 1"
                class="self-center text-[--el-text-color-secondary] shrink-0 px-0.5"
              >
                <IconifyIconOffline icon="ep/arrow-right" />
              </div>
            </template>
          </div>

          <!-- 试跑结果摘要 / 降级原因 -->
          <div
            v-if="resultChipOf(row)"
            class="text-xs mb-2"
            :style="{
              color: lastResults.get(row.id)?.ok ? '#67c23a' : '#e6a23c'
            }"
          >
            上次试跑：{{ resultChipOf(row) }}
            <span
              v-for="d in lastResults.get(row.id)!.result.degraded"
              :key="d.id"
              class="text-[--el-color-danger] ml-2"
              >{{ d.id }}：{{ d.why }}</span
            >
          </div>

          <div class="flex items-center gap-2">
            <el-button
              size="small"
              type="primary"
              :disabled="!row.enabled"
              @click="openTest(row)"
            >
              <IconifyIconOffline icon="ep/video-play" class="mr-1" />有界试跑
            </el-button>
            <div class="flex flex-wrap items-center gap-1">
              <el-tag
                v-for="k in inputKeysOf(row)"
                :key="k"
                size="small"
                effect="plain"
                class="font-mono"
                >入参 {{ k }}</el-tag
              >
            </div>
            <span
              v-if="!row.enabled"
              class="text-xs text-[--el-text-color-secondary] ml-auto"
              >已停用（编辑 pipelines.json 后刷新生效）</span
            >
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card v-if="!list.length && !loading && !error" shadow="never">
      <el-empty
        description="暂无管线描述（在 data/pipelines.json 登记 spec 后刷新）"
        :image-size="64"
      />
    </el-card>

    <!-- 有界试跑 -->
    <el-dialog
      v-model="testDialog"
      :title="`有界试跑 · ${target?.id ?? ''}`"
      width="760px"
      :close-on-click-modal="false"
    >
      <template v-if="target">
        <el-alert
          type="warning"
          :closable="false"
          show-icon
          class="mb-3"
          title="试跑经当前生效配置真实调用模型（时延封顶 30s、调用数封顶 32）；出站校验未通过的模型会被剔除并留痕。"
        />

        <el-form label-width="90px" class="mb-2">
          <el-form-item label="入参">
            <div v-if="inputRows.length" class="w-full">
              <div
                v-for="(r, i) in inputRows"
                :key="i"
                class="flex items-center gap-2 mb-1"
              >
                <el-input v-model="r.key" disabled class="!w-40 font-mono" />
                <el-input
                  v-model="r.value"
                  placeholder="值（≤2000 字符）"
                  maxlength="2000"
                />
              </div>
            </div>
            <span v-else class="text-xs text-[--el-text-color-secondary]"
              >该管线的模板未引用 input.* 形式的入参</span
            >
          </el-form-item>
          <el-form-item label="时延预算">
            <el-input-number
              v-model="deadlineInput"
              :min="1000"
              :max="30000"
              :step="1000"
              placeholder="缺省用 spec 预算"
              class="!w-44"
            />
            <span class="text-xs text-[--el-text-color-secondary] ml-2"
              >毫秒（≤30000）</span
            >
          </el-form-item>
        </el-form>

        <div class="flex items-center gap-2 mb-3">
          <el-button type="primary" :loading="testing" @click="doTest">
            执行试跑
          </el-button>
        </div>

        <template v-if="testResult">
          <!-- 结果直接标注在 DAG 上 -->
          <div class="flex items-stretch gap-1 overflow-x-auto pb-1 mb-3">
            <template v-for="(layer, li) in dialogLayers" :key="li">
              <div class="flex flex-col gap-2 min-w-[128px]">
                <div
                  v-for="node in layer.nodes"
                  :key="node.id"
                  class="rounded-md border px-2 py-1.5"
                  :style="{
                    borderColor: nodeStateOf(target, node.id).state === 'success'
                      ? '#67c23a'
                      : nodeStateOf(target, node.id).state === 'failed'
                        ? '#f56c6c'
                        : '#dcdfe6'
                  }"
                >
                  <div class="font-mono text-xs font-medium">
                    {{ node.id }}
                    <span
                      v-if="nodeStateOf(target, node.id).state === 'success'"
                      style="color: #67c23a"
                      >✓</span
                    >
                    <span
                      v-else-if="
                        nodeStateOf(target, node.id).state === 'failed'
                      "
                      style="color: #f56c6c"
                      >✗</span
                    >
                  </div>
                  <div class="text-[11px] text-[--el-text-color-secondary]">
                    {{
                      nodeStateOf(target, node.id).modelId ??
                      nodeStateOf(target, node.id).why ??
                      "未运行"
                    }}
                  </div>
                  <div
                    v-if="nodeStateOf(target, node.id).ms !== undefined"
                    class="text-[10px] text-[--el-text-color-secondary]"
                  >
                    {{ nodeStateOf(target, node.id).ms }}ms
                  </div>
                </div>
              </div>
              <div
                v-if="li < dialogLayers.length - 1"
                class="self-center text-[--el-text-color-secondary] shrink-0 px-0.5"
              >
                <IconifyIconOffline icon="ep/arrow-right" />
              </div>
            </template>
          </div>

          <div class="flex items-center gap-2 mb-2">
            <el-tag :type="testResult.ok ? 'success' : 'danger'" size="small">
              {{ testResult.ok ? "全部必需节点产出" : "存在降级/失败" }}
            </el-tag>
            <span class="text-xs text-[--el-text-color-secondary]">
              总耗时 {{ testResult.elapsedMs }}ms
              <template v-if="testResult.timedOut"> · 已触发时延熔断</template>
            </span>
          </div>

          <el-alert
            v-for="ex in testResult.excludedModels"
            :key="ex.id"
            type="info"
            :closable="false"
            class="mb-2"
            :title="`模型 ${ex.id} 未参与试跑：${ex.why}`"
          />

          <el-table
            :data="testResult.result.trace"
            size="small"
            class="mb-2"
          >
            <el-table-column label="节点" min-width="80">
              <template #default="{ row: t }">
                <span class="font-mono text-xs">{{ t.id }}</span>
              </template>
            </el-table-column>
            <el-table-column label="角色" width="90">
              <template #default="{ row: t }">{{ roleZh(t.role) }}</template>
            </el-table-column>
            <el-table-column label="结果" width="80" align="center">
              <template #default="{ row: t }">
                <el-tag :type="t.ok ? 'success' : 'danger'" size="small">
                  {{ t.ok ? "成功" : "失败" }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column
              v-if="testResult.result.trace.some(t => t.modelId)"
              label="模型"
              min-width="110"
            >
              <template #default="{ row: t }">
                <span class="font-mono text-xs">{{ t.modelId ?? "—" }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="ms" label="耗时" width="80" align="right" />
            <el-table-column label="原因" min-width="140">
              <template #default="{ row: t }">
                <span class="text-xs text-[--el-text-color-secondary]">{{
                  t.why ?? "—"
                }}</span>
              </template>
            </el-table-column>
          </el-table>

          <template v-if="Object.keys(testResult.result.outputs).length">
            <div class="text-xs font-medium mb-1">节点产出</div>
            <div
              v-for="(text, id) in testResult.result.outputs"
              :key="id"
              class="mb-2"
            >
              <div
                class="font-mono text-xs text-[--el-text-color-secondary] mb-0.5"
              >
                {{ id }}
              </div>
              <pre
                class="whitespace-pre-wrap rounded bg-[--el-fill-color-lighter] p-2 text-xs leading-relaxed max-h-40 overflow-auto"
                >{{ text }}</pre
              >
            </div>
          </template>

          <el-alert
            v-for="d in testResult.result.degraded"
            :key="d.id"
            type="warning"
            :closable="false"
            class="mt-1"
            :title="`节点 ${d.id} 降级：${d.why}`"
          />
        </template>
      </template>
    </el-dialog>
  </div>
</template>
