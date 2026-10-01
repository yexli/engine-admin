<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessageBox } from "element-plus";
import { getWorlds, createWorld, advanceWorldTime, pauseWorld, resumeWorld, closeWorld } from "@/api/world";
import type { WorldInfo } from "@/api/types";
import { message } from "@/utils/message";
import { useAsyncData, fmtTime } from "@/composables/useAsyncData";
import { usePolling } from "@/composables/usePolling";

defineOptions({ name: "WorldList" });

const router = useRouter();
const worlds = ref<WorldInfo[]>([]);
const { loading, error, run } = useAsyncData();

/* ---------- 搜索 / 筛选 / 排序（客户端，引擎世界数很小） ---------- */
const keyword = ref("");
const sortBy = ref<"worldId" | "entities" | "time">("worldId");
const filtered = computed(() => {
  const list = worlds.value.filter(
    w => !keyword.value || w.worldId.includes(keyword.value)
  );
  return [...list].sort((a, b) => {
    if (sortBy.value === "entities") return b.entities - a.entities;
    if (sortBy.value === "time")
      return (b.time?.tick ?? 0) - (a.time?.tick ?? 0);
    return a.worldId.localeCompare(b.worldId);
  });
});

async function load() {
  const res = await run(() => getWorlds());
  if (res) worlds.value = res.worlds ?? [];
}

/* ---------- 创建世界 ---------- */
const createDialog = ref(false);
const creating = ref(false);
const createForm = reactive({
  worldId: "",
  name: "",
  description: "",
  playerName: "",
  startLoc: "",
  weather: "",
  labelsJson: ""
});
const labelsError = ref("");

function openCreate() {
  createForm.worldId = "";
  createForm.name = "";
  createForm.description = "";
  createForm.playerName = "";
  createForm.startLoc = "";
  createForm.weather = "";
  createForm.labelsJson = "";
  labelsError.value = "";
  createDialog.value = true;
}

function validateLabels(): Record<string, unknown> | null {
  labelsError.value = "";
  const raw = createForm.labelsJson.trim();
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      labelsError.value = "World Definition 必须是 JSON 对象";
      return null;
    }
    // 引擎侧只接受 labels 白名单字段
    const allowed = [
      "months",
      "shichen",
      "periodOf",
      "baseYear",
      "daysPerMonth"
    ];
    const keys = Object.keys(obj);
    const unknown = keys.filter(k => !allowed.includes(k));
    if (unknown.length) {
      labelsError.value = `不支持的键：${unknown.join("、")}（允许：${allowed.join("、")}）`;
      return null;
    }
    return obj;
  } catch {
    labelsError.value = "JSON 解析失败";
    return null;
  }
}

async function doCreate() {
  if (!createForm.worldId.trim()) {
    message("World ID 必填", { type: "warning" });
    return;
  }
  const labels = validateLabels();
  if (labels === null) return;
  creating.value = true;
  try {
    await createWorld({
      worldId: createForm.worldId.trim(),
      ...(createForm.name.trim() ? { name: createForm.name.trim() } : {}),
      ...(createForm.description.trim()
        ? { description: createForm.description.trim() }
        : {}),
      ...(createForm.playerName ? { playerName: createForm.playerName } : {}),
      ...(createForm.startLoc ? { startLoc: createForm.startLoc } : {}),
      ...(createForm.weather ? { weather: createForm.weather } : {}),
      ...(Object.keys(labels).length ? { labels } : {})
    });
    message(`世界「${createForm.worldId}」创建成功`, { type: "success" });
    createDialog.value = false;
    await load();
    router.push(
      `/worlds/detail/${encodeURIComponent(createForm.worldId.trim())}`
    );
  } catch (e) {
    const msg =
      (e as { response?: { data?: { error?: string; hint?: string } } })
        ?.response?.data?.error ??
      (e instanceof Error ? e.message : "创建失败");
    message(msg, { type: "error" });
  } finally {
    creating.value = false;
  }
}

/* ---------- 推进时间 ---------- */
const timeDialog = ref(false);
const timeTarget = ref("");
const ticks = ref(12);
const advancing = ref(false);

function openAdvance(row: WorldInfo) {
  timeTarget.value = row.worldId;
  ticks.value = 12;
  timeDialog.value = true;
}

function doAdvance() {
  advancing.value = true;
  advanceWorldTime(timeTarget.value, ticks.value)
    .then(res => {
      message(
        res.ok ? `已推进 ${ticks.value} 刻` : `拒绝：${res.reason ?? ""}`,
        { type: res.ok ? "success" : "error" }
      );
      timeDialog.value = false;
      load();
    })
    .catch(() => message("推进失败（引擎不可达？）", { type: "error" }))
    .finally(() => (advancing.value = false));
}

/* ---------- 生命周期（引擎 1.0.3 G1 软暂停；语义见 docs/G1-PAUSE-DESIGN-REVIEW.md） ---------- */
async function togglePause(row: WorldInfo) {
  const pausing = (row.status ?? "running") === "running";
  if (!pausing) {
    await ElMessageBox.confirm(
      `恢复世界「${row.worldId}」？恢复后命令与时间推进照常受理。`,
      "恢复确认",
      { type: "info", confirmButtonText: "恢复", cancelButtonText: "取消" }
    );
  }
  try {
    const res = pausing
      ? await pauseWorld(row.worldId)
      : await resumeWorld(row.worldId);
    row.status = res.status ?? "running";
    message(pausing ? "已暂停（命令与推进被拒绝，读操作照常）" : "已恢复", {
      type: "success"
    });
  } catch (e) {
    message(e instanceof Error ? e.message : "操作失败", { type: "error" });
  }
}

async function close(row: WorldInfo) {
  await ElMessageBox.confirm(
    `关闭世界「${row.worldId}」？关闭后从注册表摘除，一切访问 404，不可恢复。`,
    "关闭确认",
    { type: "warning", confirmButtonText: "关闭", cancelButtonText: "取消" }
  );
  try {
    await closeWorld(row.worldId);
    message("世界已关闭", { type: "success" });
    load();
  } catch (e) {
    message(e instanceof Error ? e.message : "关闭失败", { type: "error" });
  }
}

const { polling, toggle, start } = usePolling(load, 15_000);

onMounted(async () => {
  await load();
  start();
});

function fmtWorldTime(w: WorldInfo): string {
  if (!w.time) return "—";
  return `第${w.time.day}天 ${String(w.time.hour).padStart(2, "0")}:00（${w.time.period}）`;
}
</script>

<template>
  <div class="p-4">
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-input
          v-model="keyword"
          placeholder="搜索 World ID"
          clearable
          class="!w-64"
        />
        <el-select v-model="sortBy" class="!w-44">
          <el-option label="按 ID 排序" value="worldId" />
          <el-option label="按实体数排序" value="entities" />
          <el-option label="按时间排序" value="time" />
        </el-select>
        <el-button :loading="loading" @click="load">
          <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
        </el-button>
        <el-button :type="polling ? 'primary' : 'default'" @click="toggle">
          {{ polling ? "轮询中(15s)" : "已暂停" }}
        </el-button>
        <div class="flex-1" />
        <Perms value="world:write">
          <el-button type="primary" @click="openCreate">
            <IconifyIconOffline icon="ep/plus" class="mr-1" />创建世界
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
          World Engine 不可达：{{ error }}（引擎默认 127.0.0.1:8787）
          <el-button text type="primary" size="small" @click="load"
            >重试</el-button
          >
        </template>
      </el-alert>

      <el-table v-loading="loading" :data="filtered" stripe>
        <el-table-column prop="worldId" min-width="150">
          <template #header><BiText zh="世界 ID" en="World ID" /></template>
          <template #default="{ row }">
            <router-link
              :to="`/worlds/detail/${encodeURIComponent(row.worldId)}`"
            >
              <el-button text type="primary" class="!px-0 font-mono">
                {{ row.worldId }}
              </el-button>
            </router-link>
            <div
              v-if="row.name"
              class="text-xs text-[--el-text-color-secondary] truncate"
            >
              {{ row.name }}
            </div>
          </template>
        </el-table-column>
        <el-table-column min-width="180">
          <template #header
            ><BiText zh="当前时间" en="Current Time"
          /></template>
          <template #default="{ row }">{{
            fmtWorldTime(row as WorldInfo)
          }}</template>
        </el-table-column>
        <el-table-column prop="location" min-width="120">
          <template #header><BiText zh="玩家位置" en="Location" /></template>
          <template #default="{ row }">{{ row.location ?? "—" }}</template>
        </el-table-column>
        <el-table-column prop="entities" width="110" align="center">
          <template #header><BiText zh="实体数" en="Entities" /></template>
        </el-table-column>
        <el-table-column width="120">
          <template #header><BiText zh="运行状态" en="Runtime" /></template>
          <template #default="{ row }">
            <el-tooltip
              :content="(row as WorldInfo).status === 'paused' ? '软暂停：命令与时间推进被拒绝（读操作照常）' : '正常运行（服务面受理命令与推进）'"
              placement="top"
            >
              <el-tag
                :type="(row as WorldInfo).status === 'paused' ? 'warning' : 'success'"
                size="small"
              >
                {{ (row as WorldInfo).status === "paused" ? "paused" : "running" }}
              </el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column min-width="170">
          <template #header>
            <BiText zh="创建 / 更新" en="Created / Updated" />
          </template>
          <template #default="{ row }">
            <template v-if="row.createdAt">
              <div class="text-xs">{{ fmtTime(row.createdAt) }}</div>
              <div
                v-if="row.updatedAt && row.updatedAt !== row.createdAt"
                class="text-xs text-[--el-text-color-secondary]"
              >
                → {{ fmtTime(row.updatedAt) }}
              </div>
            </template>
            <span
              v-else
              class="text-xs text-[--el-text-color-secondary]"
            >
              —（世界创建于 M1 之前）
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <router-link
              :to="`/worlds/detail/${encodeURIComponent(row.worldId)}`"
            >
              <el-button text type="primary" size="small">打开</el-button>
            </router-link>
            <Perms value="world:write">
              <el-button
                text
                type="warning"
                size="small"
                @click="openAdvance(row as WorldInfo)"
              >
                推进时间
              </el-button>
            </Perms>
            <Perms value="world:write">
              <el-button
                text
                :type="(row as WorldInfo).status === 'paused' ? 'success' : 'warning'"
                size="small"
                @click="togglePause(row as WorldInfo)"
              >
                {{ (row as WorldInfo).status === "paused" ? "恢复" : "暂停" }}
              </el-button>
              <el-button
                text
                size="small"
                type="danger"
                @click="close(row as WorldInfo)"
              >
                关闭
              </el-button>
            </Perms>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty
            :description="
              error ? '引擎不可达' : '暂无世界，点击右上角「创建世界」'
            "
            :image-size="72"
          />
        </template>
      </el-table>
    </el-card>

    <!-- 创建世界 -->
    <el-dialog
      v-model="createDialog"
      title="创建世界"
      width="560px"
      @close="validateLabels"
    >
      <el-alert
        type="info"
        :closable="false"
        class="mb-3"
        title="流程：填写 → 校验 Validate → 提交 POST /v1/worlds → 成功后进入世界详情"
      />
      <el-form label-width="130px">
        <el-form-item label="世界 ID World ID" required>
          <el-input
            v-model="createForm.worldId"
            placeholder="如 w-main（必填，唯一）"
            maxlength="64"
          />
        </el-form-item>
        <el-form-item label="名称 Name">
          <el-input
            v-model="createForm.name"
            placeholder="世界显示名（可选，如：云涧大陆）"
            maxlength="128"
          />
        </el-form-item>
        <el-form-item label="描述 Description">
          <el-input
            v-model="createForm.description"
            type="textarea"
            :rows="2"
            placeholder="世界描述（可选，≤512 字）"
            maxlength="512"
          />
        </el-form-item>
        <el-form-item label="玩家名 Name">
          <el-input
            v-model="createForm.playerName"
            placeholder="玩家名（playerName）"
            maxlength="64"
          />
        </el-form-item>
        <el-form-item label="初始位置 Location">
          <el-input
            v-model="createForm.startLoc"
            placeholder="如 tavern"
            maxlength="64"
          />
        </el-form-item>
        <el-form-item label="初始天气 Weather">
          <el-input
            v-model="createForm.weather"
            placeholder="如 sunny"
            maxlength="32"
          />
        </el-form-item>
        <el-form-item label="世界定义 Definition">
          <el-input
            v-model="createForm.labelsJson"
            type="textarea"
            :rows="5"
            class="font-mono"
            placeholder='可选。历法定义 labels，如：
{
  "baseYear": 1024,
  "daysPerMonth": 30,
  "months": ["春", "夏", "秋", "冬"]
}'
          />
          <div v-if="labelsError" class="text-xs text-[--el-color-danger] mt-1">
            {{ labelsError }}
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="doCreate">
          校验并创建 Validate
        </el-button>
      </template>
    </el-dialog>

    <!-- 推进时间 -->
    <el-dialog
      v-model="timeDialog"
      :title="`推进时间 · ${timeTarget}`"
      width="420px"
    >
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        class="mb-3"
        title="推进时间会触发规则与调度事件，直接改变世界状态。"
      />
      <el-form label-width="80px">
        <el-form-item label="刻数">
          <el-input-number v-model="ticks" :min="1" :max="100000" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="timeDialog = false">取消</el-button>
        <el-button type="primary" :loading="advancing" @click="doAdvance">
          确认推进
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
