<script setup lang="ts">
import { onMounted, ref } from "vue";
import { listExtensionCommands, type ExtensionCommandRow } from "@/api/rule";
import { COMMAND_SPECS } from "@/api/command";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "ExtensionCommands" });

const list = ref<ExtensionCommandRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const typeFilter = ref("");
const extFilter = ref("");
const { loading, error, run } = useAsyncData();

/** 引擎真实可执行的命令类型（用于核对 mock 目录） */
const realTypes = new Set(COMMAND_SPECS.map(s => s.type));

async function load() {
  const res = await run(() =>
    listExtensionCommands({
      page: page.value,
      pageSize: pageSize.value,
      type: typeFilter.value || undefined,
      extension: extFilter.value || undefined
    })
  );
  if (res?.data) {
    list.value = res.data.list;
    total.value = res.data.total;
  }
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <div class="flex justify-end mb-1">
      <MockTag
        detail="扩展命令目录为 Mock；带「引擎可执行」标记的命令与引擎内置规则一致，可在命令调试台真实执行"
      />
    </div>
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-input
          v-model="typeFilter"
          placeholder="搜索命令类型"
          clearable
          class="!w-56"
          @change="load"
        />
        <el-input
          v-model="extFilter"
          placeholder="扩展名"
          clearable
          class="!w-44"
          @change="load"
        />
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
        <el-table-column prop="type" label="命令类型" min-width="150">
          <template #default="{ row }">
            <span class="font-mono">{{ row.type }}</span>
            <el-tag
              v-if="realTypes.has(row.type)"
              size="small"
              type="success"
              class="ml-2"
            >
              引擎可执行
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="extension" min-width="120"
          ><template #header><BiText zh="扩展" en="Extension" /></template
        ></el-table-column>
        <el-table-column
          prop="description"
          label="说明"
          min-width="280"
          show-overflow-tooltip
        />
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
        <template #empty>
          <el-empty description="暂无命令" :image-size="64" />
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
