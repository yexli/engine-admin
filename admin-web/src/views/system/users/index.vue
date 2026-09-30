<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { listUsers, createUser, updateUser, type UserRow } from "@/api/system";
import { hasPerms } from "@/utils/auth";
import { message } from "@/utils/message";
import { useAsyncData, fmtTime, timeAgo } from "@/composables/useAsyncData";

defineOptions({ name: "SystemUsers" });

const list = ref<UserRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const filters = ref({ keyword: "", role: "", status: "" });
const { loading, error, run } = useAsyncData();
const canManage = hasPerms("system:manage");

const ROLES = [
  { name: "admin", label: "管理员" },
  { name: "operator", label: "运营" },
  { name: "viewer", label: "观察员" }
];

async function load() {
  const res = await run(() =>
    listUsers({
      page: page.value,
      pageSize: pageSize.value,
      keyword: filters.value.keyword || undefined,
      role: filters.value.role || undefined,
      status: filters.value.status || undefined
    })
  );
  if (res?.data) {
    list.value = res.data.list;
    total.value = res.data.total;
  }
}

/* 创建 */
const createDialog = ref(false);
const creating = ref(false);
const createForm = reactive({
  username: "",
  nickname: "",
  role: "viewer",
  remark: ""
});

function openCreate() {
  createForm.username = "";
  createForm.nickname = "";
  createForm.role = "viewer";
  createForm.remark = "";
  createDialog.value = true;
}

async function doCreate() {
  if (!createForm.username.trim()) {
    message("用户名必填", { type: "warning" });
    return;
  }
  creating.value = true;
  try {
    const res = await createUser({
      username: createForm.username.trim(),
      nickname: createForm.nickname || undefined,
      roles: [createForm.role],
      remark: createForm.remark || undefined
    });
    if (res?.success) {
      message(
        "用户已创建（初始密码请通过安全渠道发放，第一版 Mock 未实现密码）",
        { type: "success" }
      );
      createDialog.value = false;
      load();
    } else {
      message(res?.msg ?? "创建失败", { type: "error" });
    }
  } finally {
    creating.value = false;
  }
}

/* 编辑 / 启停 */
const editDialog = ref(false);
const saving = ref(false);
const editForm = reactive({
  id: "",
  nickname: "",
  roles: [] as string[],
  remark: ""
});

function openEdit(row: UserRow) {
  editForm.id = row.id;
  editForm.nickname = row.nickname;
  editForm.roles = [...row.roles];
  editForm.remark = row.remark;
  editDialog.value = true;
}

async function saveEdit() {
  saving.value = true;
  try {
    const res = await updateUser(editForm.id, {
      nickname: editForm.nickname,
      roles: editForm.roles,
      remark: editForm.remark
    });
    if (res?.success) {
      message("已保存", { type: "success" });
      editDialog.value = false;
      load();
    } else {
      message(res?.msg ?? "保存失败", { type: "error" });
    }
  } finally {
    saving.value = false;
  }
}

async function toggleStatus(row: UserRow) {
  const next = row.status === "active" ? "disabled" : "active";
  const res = await run(() => updateUser(row.id, { status: next }));
  if (res) {
    row.status = next;
    message(next === "active" ? "已启用" : "已停用", { type: "success" });
  }
}

onMounted(load);
</script>

<template>
  <div class="p-4">
    <div class="flex justify-end mb-1">
      <MockTag
        detail="用户服务为 Mock（登录账号 admin/admin123、operator/operator123、viewer/viewer123）；真实用户体系待建（ADMIN-API-GAP.md）"
      />
    </div>
    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-input
          v-model="filters.keyword"
          placeholder="用户名 / 昵称"
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
          v-model="filters.role"
          placeholder="角色"
          clearable
          class="!w-36"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        >
          <el-option
            v-for="r in ROLES"
            :key="r.name"
            :label="r.label"
            :value="r.name"
          />
        </el-select>
        <el-select
          v-model="filters.status"
          placeholder="状态"
          clearable
          class="!w-32"
          @change="
            () => {
              page = 1;
              load();
            }
          "
        >
          <el-option label="active" value="active" />
          <el-option label="disabled" value="disabled" />
        </el-select>
        <el-button :loading="loading" @click="load">
          <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
        </el-button>
        <div class="flex-1" />
        <Perms value="system:manage">
          <el-button type="primary" @click="openCreate">
            <IconifyIconOffline icon="ep/plus" class="mr-1" />新增用户
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
          加载失败：{{ error }}
          <el-button text type="primary" size="small" @click="load"
            >重试</el-button
          >
        </template>
      </el-alert>

      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="username" label="用户名" min-width="120">
          <template #default="{ row }">
            <span class="font-medium">{{ row.username }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="nickname" label="昵称" min-width="120" />
        <el-table-column label="角色" min-width="140">
          <template #default="{ row }">
            <el-tag v-for="r in row.roles" :key="r" size="small" class="mr-1">{{
              r
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag
              :type="row.status === 'active' ? 'success' : 'info'"
              size="small"
            >
              {{ row.status === "active" ? "启用" : "停用" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="最近登录" width="120">
          <template #default="{ row }">{{ timeAgo(row.lastLoginAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <template v-if="canManage">
              <el-button
                text
                size="small"
                type="primary"
                @click="openEdit(row as UserRow)"
                >编辑</el-button
              >
              <el-button
                text
                size="small"
                :type="row.status === 'active' ? 'warning' : 'success'"
                @click="toggleStatus(row as UserRow)"
              >
                {{ row.status === "active" ? "停用" : "启用" }}
              </el-button>
            </template>
            <span v-else class="text-xs text-[--el-text-color-secondary]"
              >无 system:manage 权限</span
            >
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无用户" :image-size="64" />
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

    <!-- 创建 -->
    <el-dialog v-model="createDialog" title="新增用户" width="480px">
      <el-form label-width="90px">
        <el-form-item label="用户名" required>
          <el-input v-model="createForm.username" maxlength="32" />
        </el-form-item>
        <el-form-item label="昵称">
          <el-input v-model="createForm.nickname" maxlength="32" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="createForm.role">
            <el-option
              v-for="r in ROLES"
              :key="r.name"
              :label="`${r.label}（${r.name}）`"
              :value="r.name"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="createForm.remark" maxlength="100" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="doCreate"
          >创建</el-button
        >
      </template>
    </el-dialog>

    <!-- 编辑 -->
    <el-dialog v-model="editDialog" title="编辑用户" width="480px">
      <el-form label-width="90px">
        <el-form-item label="昵称">
          <el-input v-model="editForm.nickname" maxlength="32" />
        </el-form-item>
        <el-form-item label="角色">
          <el-checkbox-group v-model="editForm.roles">
            <el-checkbox v-for="r in ROLES" :key="r.name" :value="r.name">{{
              r.label
            }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="editForm.remark" maxlength="100" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveEdit"
          >保存</el-button
        >
      </template>
    </el-dialog>
  </div>
</template>
