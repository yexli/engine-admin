<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  listPipelines,
  setPipelineEnabled,
  testPipeline,
  type PipelineRow,
  type PipelineTestResult
} from "@/api/pipeline";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { useAsyncData, timeAgo } from "@/composables/useAsyncData";

defineOptions({ name: "GatewayPipelines" });

const list = ref<PipelineRow[]>([]);
const { loading, error, run } = useAsyncData();
const canManage = hasPerms("gateway:manage");
const testingId = ref("");
const testResult = ref<(PipelineTestResult & { name: string }) | null>(null);

async function load() {
  const res = await run(() => listPipelines());
  if (res?.data) list.value = res.data.list;
}

async function toggle(row: PipelineRow) {
  const res = await run(() => setPipelineEnabled(row.id, !row.enabled));
  if (res) {
    row.enabled = !row.enabled;
    message(`Pipeline ${row.name} 已${row.enabled ? "启用" : "禁用"}`, {
      type: "success"
    });
  }
}

async function test(row: PipelineRow) {
  testingId.value = row.id;
  testResult.value = null;
  try {
    const res = await run(() => testPipeline(row.id), { silent: true });
    if (res?.data) {
      testResult.value = { ...res.data, name: row.name };
      message("Pipeline 测试完成", { type: "success" });
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
        detail="第一版 Pipeline 只做查看 / 启停 / 测试，不做 DAG 在线编辑器（Mock 数据，见 ADMIN-API-GAP.md）"
      />
    </div>
    <el-row :gutter="12">
      <el-col v-for="row in list" :key="row.id" :md="8" :xs="24" class="mb-3">
        <el-card shadow="never" class="h-full">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="font-mono font-medium">{{ row.name }}</span>
              <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
                {{ row.enabled ? "启用" : "禁用" }}
              </el-tag>
            </div>
          </template>
          <div class="text-sm text-[--el-text-color-regular] mb-3 min-h-[42px]">
            {{ row.description }}
          </div>

          <!-- 阶段链（只读展示） -->
          <div class="mb-3">
            <div
              v-for="(s, i) in row.stages"
              :key="s.name"
              class="flex items-center gap-2 text-xs mb-1"
            >
              <span
                class="w-5 h-5 rounded-full bg-[--el-color-primary-light-9] text-[--el-color-primary] flex items-center justify-center font-mono"
              >
                {{ i + 1 }}
              </span>
              <span class="font-mono">{{ s.name }}</span>
              <el-tag size="small" type="info" effect="plain">{{
                s.type
              }}</el-tag>
            </div>
          </div>

          <div class="text-xs text-[--el-text-color-secondary] mb-3">
            最近测试：{{
              row.lastTestAt
                ? `${timeAgo(row.lastTestAt)}（${row.lastTestStatus}）`
                : "未测试"
            }}
          </div>

          <div class="flex items-center gap-2">
            <Perms value="gateway:manage">
              <el-button
                size="small"
                :type="row.enabled ? 'warning' : 'success'"
                @click="toggle(row)"
              >
                {{ row.enabled ? "禁用" : "启用" }}
              </el-button>
            </Perms>
            <el-button
              size="small"
              type="primary"
              :loading="testingId === row.id"
              @click="test(row)"
            >
              测试
            </el-button>
            <span
              v-if="!canManage"
              class="text-xs text-[--el-text-color-secondary]"
            >
              无 gateway:manage 权限
            </span>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card v-if="!list.length && !loading" shadow="never">
      <el-empty v-if="!error" description="暂无 Pipeline" />
      <el-alert v-else type="error" :closable="false" show-icon>
        <template #title>
          加载失败：{{ error }}
          <el-button text type="primary" size="small" @click="load"
            >重试</el-button
          >
        </template>
      </el-alert>
    </el-card>

    <!-- 测试结果 -->
    <el-dialog
      :model-value="!!testResult"
      :title="`Pipeline 测试 · ${testResult?.name}`"
      width="520px"
      @update:model-value="v => !v && (testResult = null)"
      @closed="testResult = null"
    >
      <template v-if="testResult">
        <el-table :data="testResult.stageResults" size="small">
          <el-table-column prop="stage" label="阶段" min-width="180" />
          <el-table-column label="结果" width="90" align="center">
            <template #default="{ row }">
              <el-tag :type="row.ok ? 'success' : 'danger'" size="small">
                {{ row.ok ? "通过" : "失败" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="ms" label="耗时" width="90" align="right">
            <template #default="{ row }">{{ row.ms }}ms</template>
          </el-table-column>
        </el-table>
      </template>
    </el-dialog>
  </div>
</template>
