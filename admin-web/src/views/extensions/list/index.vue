<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  listExtensions,
  setExtensionStatus,
  type ExtensionRow
} from "@/api/extension";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "ExtensionList" });

const list = ref<ExtensionRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const keyword = ref("");
const statusFilter = ref("");
const { loading, error, run } = useAsyncData();

const canManage = hasPerms("system:manage");

async function load() {
  const res = await run(() =>
    listExtensions({
      page: page.value,
      pageSize: pageSize.value,
      name: keyword.value || undefined,
      status: statusFilter.value || undefined
    })
  );
  if (res?.data) {
    list.value = res.data.list;
    total.value = res.data.total;
  }
}

async function toggleStatus(row: ExtensionRow) {
  const next = row.status === "enabled" ? "disabled" : "enabled";
  const res = await run(() => setExtensionStatus(row.id, next));
  if (res) {
    row.status = next as ExtensionRow["status"];
    message(`已${next === "enabled" ? "启用" : "停用"} ${row.name}`, {
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
        detail="当前扩展数据为 Mock（引擎规则经代码注册，运行时清单 API 待建，见 docs/ADMIN-API-GAP.md）"
      />
    </div>
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-input
          v-model="keyword"
          placeholder="搜索扩展名"
          clearable
          class="!w-56"
          @change="load"
        />
        <el-select
          v-model="statusFilter"
          placeholder="状态"
          clearable
          class="!w-36"
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
          ><template #header><BiText zh="名称" en="Name" /></template>
          <template #default="{ row }">
            <span class="font-mono">{{ row.name }}</span>
            <el-tag size="small" class="ml-2" effect="plain"
              >v{{ row.version }}</el-tag
            >
          </template>
        </el-table-column>
        <el-table-column
          prop="description"
          min-width="240"
          show-overflow-tooltip
          ><template #header><BiText zh="描述" en="Description" /></template
        ></el-table-column>
        <el-table-column min-width="240"
          ><template #header><BiText zh="能力" en="Capabilities" /></template>
          <template #default="{ row }">
            <el-tag
              v-for="c in row.capabilities.slice(0, 3)"
              :key="c"
              size="small"
              type="info"
              class="mr-1"
            >
              {{ c }}
            </el-tag>
            <span
              v-if="row.capabilities.length > 3"
              class="text-xs text-[--el-text-color-secondary]"
            >
              +{{ row.capabilities.length - 3 }}
            </span>
          </template>
        </el-table-column>
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
              @click="toggleStatus(row as ExtensionRow)"
            >
              {{ row.status === "enabled" ? "停用" : "启用" }}
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无扩展" :image-size="64" />
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
