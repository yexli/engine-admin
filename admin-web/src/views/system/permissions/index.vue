<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import {
  getPermissions,
  updateRolePermissions,
  type PermissionItem,
  type RoleRow
} from "@/api/system";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { useAsyncData } from "@/composables/useAsyncData";

defineOptions({ name: "SystemPermissions" });

const catalog = ref<PermissionItem[]>([]);
const roles = ref<RoleRow[]>([]);
const { loading, error, run } = useAsyncData();
const canManage = hasPerms("system:manage");

const activeRole = ref<string>("");
const editing = ref<string[]>([]);
const saving = ref(false);

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
  editing.value = [...role.permissions];
}

async function load() {
  const res = await run(() => getPermissions());
  if (res?.data) {
    catalog.value = res.data.catalog;
    roles.value = res.data.roles;
    regroup();
    if (roles.value.length) selectRole(roles.value[0]);
  }
}

async function save() {
  saving.value = true;
  try {
    const res = await updateRolePermissions(activeRole.value, editing.value);
    if (res?.success) {
      const role = roles.value.find(r => r.name === activeRole.value);
      if (role) role.permissions = [...editing.value];
      message("权限已保存（重新登录后生效）", { type: "success" });
    } else {
      message(res?.msg ?? "保存失败", { type: "error" });
    }
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <div class="flex justify-end mb-1">
      <MockTag
        detail="角色权限为 Mock（内置角色第一版不可修改）；权限码与前端按钮级权限一一对应（见 docs/ADMIN-PERMISSION.md）"
      />
    </div>
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
          <el-card shadow="never" header="角色">
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

        <!-- 权限矩阵 -->
        <el-col :md="17" class="mb-3">
          <el-card shadow="never">
            <template #header>
              <div class="flex items-center justify-between">
                <span>权限矩阵 · {{ activeRole }}</span>
                <Perms value="system:manage">
                  <el-button
                    type="primary"
                    size="small"
                    :loading="saving"
                    :disabled="roles.find(r => r.name === activeRole)?.builtin"
                    @click="save"
                  >
                    保存
                  </el-button>
                </Perms>
              </div>
            </template>

            <el-alert
              v-if="roles.find(r => r.name === activeRole)?.builtin"
              type="info"
              :closable="false"
              show-icon
              class="mb-3"
              title="内置角色不可修改（第一版）；admin 拥有 *:*:* 全量权限"
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
                        editing.includes('*:*:*') || editing.includes(p.code)
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
