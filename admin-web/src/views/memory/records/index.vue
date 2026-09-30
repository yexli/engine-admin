<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  listMemoryRecords,
  deleteMemoryRecord,
  type MemoryRecordRow
} from "@/api/memory";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { useAsyncData, fmtTime, truncate } from "@/composables/useAsyncData";
import { ElMessageBox } from "element-plus";

defineOptions({ name: "MemoryRecords" });

const list = ref<MemoryRecordRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const filters = ref({ entity: "", type: "", store: "", keyword: "" });
const { loading, error, run } = useAsyncData();
const canWrite = hasPerms("memory:write");

const TYPES = ["observation", "conversation", "event", "preference"];
const STORES = ["main", "world-events", "npc-personas"];

const drawer = ref(false);
const current = ref<MemoryRecordRow | null>(null);

async function load() {
  const res = await run(() =>
    listMemoryRecords({
      page: page.value,
      pageSize: pageSize.value,
      entity: filters.value.entity || undefined,
      type: filters.value.type || undefined,
      store: filters.value.store || undefined,
      keyword: filters.value.keyword || undefined
    })
  );
  if (res?.data) {
    list.value = res.data.list;
    total.value = res.data.total;
  }
}

async function remove(row: MemoryRecordRow) {
  await ElMessageBox.confirm(
    `删除记忆 ${row.id}？删除后不可恢复。`,
    "删除确认",
    { type: "warning" }
  );
  const res = await run(() => deleteMemoryRecord(row.id));
  if (res) {
    message("已删除", { type: "success" });
    load();
  }
}

function reset() {
  filters.value = { entity: "", type: "", store: "", keyword: "" };
  page.value = 1;
  load();
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <el-alert
      type="info"
      :closable="false"
      show-icon
      class="mb-3"
      title="记忆记录为 Mock（Memory HTTP API 待建）；删除按钮需要 memory:write 权限"
    />
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-input
          v-model="filters.keyword"
          placeholder="内容关键词"
          clearable
          class="!w-48"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        />
        <el-input
          v-model="filters.entity"
          placeholder="实体（如 npc-blacksmith）"
          clearable
          class="!w-52"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        />
        <el-select
          v-model="filters.type"
          placeholder="类型"
          clearable
          class="!w-40"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        >
          <el-option v-for="t in TYPES" :key="t" :label="t" :value="t" />
        </el-select>
        <el-select
          v-model="filters.store"
          placeholder="Store"
          clearable
          class="!w-40"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        >
          <el-option v-for="s in STORES" :key="s" :label="s" :value="s" />
        </el-select>
        <el-button :loading="loading" @click="load">
          <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
        </el-button>
        <el-button @click="reset">重置</el-button>
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
        <el-table-column prop="id" label="记忆 ID Memory ID" min-width="100">
          <template #default="{ row }">
            <el-button
              text
              type="primary"
              size="small"
              class="!px-0 font-mono"
              @click="
                current = row as MemoryRecordRow;
                drawer = true;
              "
            >
              {{ row.id }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column
          prop="entity"
          label="实体 Entity"
          min-width="130"
          show-overflow-tooltip
        />
        <el-table-column label="类型 Type" width="110">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="内容 Content" min-width="260">
          <template #default="{ row }">{{
            truncate(row.content, 46)
          }}</template>
        </el-table-column>
        <el-table-column label="重要度 Importance" width="110" align="center">
          <template #default="{ row }">
            <el-rate
              :model-value="row.importance * 2.5"
              disabled
              size="small"
            />
          </template>
        </el-table-column>
        <el-table-column label="创建时间 Created" width="150">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <Perms value="memory:write">
              <el-button
                text
                size="small"
                type="danger"
                @click="remove(row as MemoryRecordRow)"
                >删除</el-button
              >
            </Perms>
            <span
              v-if="!canWrite"
              class="text-xs text-[--el-text-color-secondary]"
              >只读</span
            >
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无记忆记录" :image-size="64" />
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

    <!-- 详情 -->
    <el-drawer
      v-model="drawer"
      :title="`记忆详情 · ${current?.id ?? ''}`"
      size="480px"
    >
      <el-descriptions v-if="current" :column="1" border size="small">
        <el-descriptions-item label="ID">{{ current.id }}</el-descriptions-item>
        <el-descriptions-item label="所属库 Store">{{
          current.store
        }}</el-descriptions-item>
        <el-descriptions-item label="实体 Entity">{{
          current.entity
        }}</el-descriptions-item>
        <el-descriptions-item label="类型 Type">{{
          current.type
        }}</el-descriptions-item>
        <el-descriptions-item label="重要度 Importance">{{
          current.importance
        }}</el-descriptions-item>
        <el-descriptions-item label="创建时间 Created">{{
          fmtTime(current.createdAt)
        }}</el-descriptions-item>
        <el-descriptions-item label="更新时间 Updated">{{
          fmtTime(current.updatedAt)
        }}</el-descriptions-item>
        <el-descriptions-item label="内容 Content">{{
          current.content
        }}</el-descriptions-item>
      </el-descriptions>
    </el-drawer>
  </div>
</template>
