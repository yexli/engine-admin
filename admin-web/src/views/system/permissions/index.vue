<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { getPermissions, type PermissionItem, type RoleRow } from "@/api/system";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "SystemPermissions" });

const catalog = ref<PermissionItem[]>([]);
const roles = ref<RoleRow[]>([]);
const { loading, error, run } = useAsyncData();

const activeRole = ref<string>("");

const grouped = ref<Record<string, PermissionItem[]>>({});
const openGroups = ref<string[]>([]);

watch(grouped, g => {
  openGroups.value = Object.keys(g ?? {});
});

function regroup() {
  const g: Record<string, PermissionItem[]> = {};
  for (const p of catalog.value) {
    (g[p.group] ??= []).push(p);
  }
  grouped.value = g;
}

function selectRole(role: RoleRow) {
  activeRole.value = role.name;
}

async function load() {
  const res = await run(() => getPermissions());
  if (res) {
    catalog.value = res.catalog;
    roles.value = res.roles;
    regroup();
    if (roles.value.length) selectRole(roles.value[0]);
  }
}

onMounted(load);
</script>

<template>
  <div class="p-4">
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

      <el-row v-if="roles.length" :gutter="12">
        <!-- 角色列表 -->
        <el-col :md="7" class="mb-3">
          <el-card shadow="never" header="角色（固定三档）">
            <div class="space-y-2">
              <div
                v-for="role in roles"
                :key="role.name"
                class="cursor-pointer rounded border p-3 transition-colors"
                :class="
                  activeRole === role.name
                    ? 'border-[--el-color-primary] bg-[--el-color-primary-light-9]'
                    : 'border-[--el-border-color-lighter] hover:bg-[--el-fill-color-light]'
                "
                @click="selectRole(role)"
              >
                <div class="flex items-center justify-between">
                  <span class="font-medium"
                    >{{ role.nickname }}（{{ role.name }}）</span
                  >
                  <el-tag v-if="role.builtin" size="small" type="info"
                    >内置</el-tag
                  >
                </div>
                <div class="text-xs text-[--el-text-color-secondary] mt-1">
                  {{ role.description }}
                </div>
                <div class="text-xs mt-1">
                  {{
                    role.permissions.includes("*:*:*")
                      ? "全部权限"
                      : `${role.permissions.length} 项权限`
                  }}
                </div>
              </div>
            </div>
          </el-card>
        </el-col>

        <!-- 权限矩阵（只读；服务端按同一目录强制） -->
        <el-col :md="17" class="mb-3">
          <el-card shadow="never">
            <template #header>
              <div class="flex items-center justify-between">
                <span>权限矩阵 · {{ activeRole }}</span>
              </div>
            </template>

            <el-alert
              type="info"
              :closable="false"
              show-icon
              class="mb-3"
              title="三档内置角色固定不可在线编辑（完整角色体系归平台 Phase 2）；管理监听按同一权限码目录做服务端强制——viewer 会话直访写端点 403。"
            />

            <el-collapse v-model="openGroups">
              <el-collapse-item
                v-for="(items, group) in grouped"
                :key="group"
                :name="group"
                :title="group"
              >
                <div class="space-y-2">
                  <div
                    v-for="p in items"
                    :key="p.code"
                    class="flex items-start justify-between gap-3 rounded border border-[--el-border-color-lighter] px-3 py-2"
                  >
                    <div>
                      <div class="text-sm">
                        <span
                          class="font-mono text-xs text-[--el-color-primary]"
                          >{{ p.code }}</span
                        >
                        <span class="ml-2 font-medium">{{ p.name }}</span>
                      </div>
                      <div
                        class="text-xs text-[--el-text-color-secondary] mt-0.5"
                      >
                        {{ p.description }}
                      </div>
                    </div>
                    <el-checkbox
                      :model-value="
                        (roles.find(r => r.name === activeRole)?.permissions ?? []).includes('*:*:*') ||
                        (roles.find(r => r.name === activeRole)?.permissions ?? []).includes(p.code)
                      "
                      disabled
                    />
                  </div>
                </div>
              </el-collapse-item>
            </el-collapse>
          </el-card>
        </el-col>
      </el-row>
    </div>
  </div>
</template>
