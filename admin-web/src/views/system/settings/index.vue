<script setup lang="ts">
import { onMounted, ref } from "vue";
import { listSettings, updateSetting, type SettingRow } from "@/api/system";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "SystemSettings" });

const list = ref<SettingRow[]>([]);
const { loading, error, run } = useAsyncData();
const canManage = hasPerms("system:manage");

const GROUPS = [
  { name: "general", label: "常规" },
  { name: "world", label: "世界" },
  { name: "gateway", label: "AI Gateway" },
  { name: "memory", label: "Memory" },
  { name: "observability", label: "监控" }
];

const drafts = ref<Record<string, string | number | boolean>>({});
const savingKey = ref("");

async function load() {
  const res = await run(() => listSettings());
  if (res) {
    list.value = res.list;
    drafts.value = Object.fromEntries(list.value.map(s => [s.key, s.value]));
  }
}

async function save(row: SettingRow) {
  savingKey.value = row.key;
  try {
    let value = drafts.value[row.key];
    if (row.type === "number") value = Number(value);
    const res = await updateSetting(row.key, value);
    row.value = res.row.value;
    message(`已保存：${row.name}`, { type: "success" });
  } catch (e) {
    message(e instanceof Error ? e.message : "保存失败", { type: "error" });
  } finally {
    savingKey.value = "";
  }
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
      title="设置持久化于 data/settings.json（白名单目录 + 类型/范围校验）；各项说明注明其生效口径——运行时行为项待部署层接线（见说明列）。"
    />
    <div v-loading="loading">
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

      <el-collapse v-if="list.length" model-value="general">
        <el-collapse-item
          v-for="g in GROUPS"
          :key="g.name"
          :name="g.name"
          :title="g.label"
        >
          <el-table :data="list.filter(s => s.group === g.name)" size="small">
            <el-table-column prop="key" label="配置项" min-width="200">
              <template #default="{ row }">
                <span class="font-mono text-xs">{{ row.key }}</span>
                <div class="text-xs text-[--el-text-color-secondary]">
                  {{ row.name }}
                </div>
              </template>
            </el-table-column>
            <el-table-column label="值" min-width="220">
              <template #default="{ row }">
                <el-switch
                  v-if="row.type === 'boolean'"
                  v-model="drafts[row.key]"
                  :disabled="!canManage"
                />
                <el-input-number
                  v-else-if="row.type === 'number'"
                  v-model="drafts[row.key] as number"
                  :disabled="!canManage"
                  size="small"
                />
                <el-input
                  v-else
                  v-model="drafts[row.key] as string"
                  :disabled="!canManage"
                  size="small"
                />
              </template>
            </el-table-column>
            <el-table-column prop="description" label="说明" min-width="260" />
            <el-table-column label="操作" width="90" fixed="right">
              <template #default="{ row }">
                <Perms value="system:manage">
                  <el-button
                    text
                    type="primary"
                    size="small"
                    :loading="savingKey === row.key"
                    :disabled="drafts[row.key] === row.value"
                    @click="save(row as SettingRow)"
                  >
                    保存
                  </el-button>
                </Perms>
              </template>
            </el-table-column>
          </el-table>
        </el-collapse-item>
      </el-collapse>
    </div>
  </div>
</template>
