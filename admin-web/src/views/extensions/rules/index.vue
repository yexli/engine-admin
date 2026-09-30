<script setup lang="ts">
import { onMounted, ref } from "vue";
import { listRules, setRuleStatus, type RuleRow } from "@/api/rule";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "ExtensionRules" });

const list = ref<RuleRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const keyword = ref("");
const extFilter = ref("");
const statusFilter = ref("");
const { loading, error, run } = useAsyncData();

const canManage = hasPerms("system:manage");

async function load() {
  const res = await run(() =>
    listRules({
      page: page.value,
      pageSize: pageSize.value,
      name: keyword.value || undefined,
      extension: extFilter.value || undefined,
      status: statusFilter.value || undefined
    })
  );
  if (res?.data) {
    list.value = res.data.list;
    total.value = res.data.total;
  }
}

async function toggleStatus(row: RuleRow) {
  const next = row.status === "enabled" ? "disabled" : "enabled";
  const res = await run(() => setRuleStatus(row.id, next));
  if (res) {
    row.status = next as RuleRow["status"];
    message(`规则 ${row.name} 已${next === "enabled" ? "启用" : "停用"}`, {
      type: "success"
    });
  }
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <div class="flex justify-end mb-1">
      <MockTag
        detail="第一版 Rules 仅支持查看与启停，不提供 TypeScript 在线编辑（Mock 数据，见 ADMIN-API-GAP.md）"
      />
    </div>
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-input
          v-model="keyword"
          placeholder="搜索规则名 / 命令"
          clearable
          class="!w-60"
          @change="load"
        />
        <el-input
          v-model="extFilter"
          placeholder="扩展名（如 core-rules）"
          clearable
          class="!w-48"
          @change="load"
        />
        <el-select
          v-model="statusFilter"
          placeholder="状态"
          clearable
          class="!w-32"
          @change="load"
        >
          <el-option label="启用" value="enabled" />
          <el-option label="停用" value="disabled" />
        </el-select>
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

      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="name" min-width="140"
          ><template #header><BiText zh="规则" en="Rule Name" /></template>
          <template #default="{ row }">
            <span class="font-mono">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="command" min-width="130"
          ><template #header><BiText zh="命令" en="Command" /></template>
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.command }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="extension" min-width="120"
          ><template #header><BiText zh="扩展" en="Extension" /></template
        ></el-table-column>
        <el-table-column prop="priority" width="90" align="center"
          ><template #header><BiText zh="优先级" en="Priority" /></template
        ></el-table-column>
        <el-table-column width="100" align="center"
          ><template #header><BiText zh="状态" en="Status" /></template>
          <template #default="{ row }">
            <el-tag
              :type="row.status === 'enabled' ? 'success' : 'danger'"
              size="small"
            >
              {{ row.status === "enabled" ? "启用" : "停用" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-tooltip
              v-if="!canManage"
              content="无 system:manage 权限"
              placement="top"
            >
              <span
                ><el-button text size="small" disabled>启停</el-button></span
              >
            </el-tooltip>
            <el-button
              v-else
              text
              size="small"
              type="warning"
              @click="toggleStatus(row as RuleRow)"
            >
              {{ row.status === "enabled" ? "停用" : "启用" }}
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无规则" :image-size="64" />
        </template>
      </el-table>

      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        layout="total, sizes, prev, pager, next"
        :page-sizes="[10, 20, 50]"
        class="mt-3 justify-end"
        @current-change="load"
        @size-change="load"
      />
    </el-card>
  </div>
</template>
