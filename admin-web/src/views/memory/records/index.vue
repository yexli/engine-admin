<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  listMemoryRecords,
  listMemoryStores,
  type MemoryRecordRow
} from "@/api/memory";
import { useAsyncData, fmtTime, truncate } from "@/composables/useAsyncData";

defineOptions({ name: "MemoryRecords" });

const list = ref<MemoryRecordRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const filters = ref({ entity: "", type: "", store: "", keyword: "" });
const storeOptions = ref<string[]>([]);
const { loading, error, run } = useAsyncData();

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
      q: filters.value.keyword || undefined
    })
  );
  if (res) {
    list.value = res.list;
    total.value = res.total;
  }
}

async function loadStores() {
  const res = await run(() => listMemoryStores());
  if (res) storeOptions.value = (res.stores ?? []).map(s => s.name);
}

function reset() {
  filters.value = { entity: "", type: "", store: "", keyword: "" };
  page.value = 1;
  load();
}

onMounted(() => {
  load();
  loadStores();
});
</script>

<template>
  <div class="p-4">
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
          placeholder="记忆主人（ownerId）"
          clearable
          class="!w-52"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        />
        <el-input
          v-model="filters.type"
          placeholder="类别 kind（如 observation）"
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
          <el-option
            v-for="s in storeOptions"
            :key="s"
            :label="s"
            :value="s"
          />
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
        <el-table-column prop="id" min-width="100"
          ><template #header><BiText zh="记忆" en="Memory ID" /></template>
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
        <el-table-column prop="store" width="110" show-overflow-tooltip
          ><template #header><BiText zh="Store" en="Store" /></template
        ></el-table-column>
        <el-table-column prop="entity" min-width="120" show-overflow-tooltip
          ><template #header><BiText zh="主人" en="Owner" /></template
        ></el-table-column>
        <el-table-column width="110"
          ><template #header><BiText zh="类别" en="Kind" /></template>
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column min-width="240"
          ><template #header><BiText zh="内容" en="Content" /></template>
          <template #default="{ row }">{{
            truncate(row.content, 46)
          }}</template>
        </el-table-column>
        <el-table-column width="90" align="center"
          ><template #header><BiText zh="路径" en="Via" /></template>
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="
                row.via === 'witness'
                  ? 'success'
                  : row.via === 'rumor'
                    ? 'warning'
                    : 'info'
              "
              >{{ row.via }}</el-tag
            >
          </template>
        </el-table-column>
        <el-table-column width="100" align="center"
          ><template #header><BiText zh="世界日" en="Day" /></template>
          <template #default="{ row }">D{{ row.day }}</template>
        </el-table-column>
        <el-table-column width="150"
          ><template #header><BiText zh="摄取时间" en="Created" /></template>
          <template #default="{ row }">{{
            row.createdAt ? fmtTime(row.createdAt) : "—"
          }}</template>
        </el-table-column>
        <template #empty>
          <el-empty
            description="暂无记忆记录（世界事件被摄取后出现）"
            :image-size="64"
          />
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
        <el-descriptions-item label="主人 Owner">{{
          current.entity
        }}</el-descriptions-item>
        <el-descriptions-item label="类别 Kind">{{
          current.type
        }}</el-descriptions-item>
        <el-descriptions-item label="摄取路径 Via">{{
          current.via
        }}</el-descriptions-item>
        <el-descriptions-item label="重要度 Importance">{{
          current.importance
        }}</el-descriptions-item>
        <el-descriptions-item label="置信度 Confidence">{{
          current.confidence
        }}</el-descriptions-item>
        <el-descriptions-item label="世界日 Day">{{
          current.day
        }}</el-descriptions-item>
        <el-descriptions-item label="关联实体 Entities">{{
          current.entities.join("、") || "—"
        }}</el-descriptions-item>
        <el-descriptions-item label="召回次数 Recall">{{
          current.recallCount
        }}</el-descriptions-item>
        <el-descriptions-item label="最近召回日 Last Recall">{{
          current.lastRecalledDay ?? "—"
        }}</el-descriptions-item>
        <el-descriptions-item label="摄取时间 Created">{{
          current.createdAt ? fmtTime(current.createdAt) : "—（旧快照条目无时间戳）"
        }}</el-descriptions-item>
        <el-descriptions-item label="内容 Content">{{
          current.content
        }}</el-descriptions-item>
      </el-descriptions>
    </el-drawer>
  </div>
</template>
