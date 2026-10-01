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
      page_size: pageSize.value,
      keyword: filters.value.keyword || undefined,
      role: filters.value.role || undefined,
      status: filters.value.status || undefined
    })
  );
  list.value = res?.list ?? [];
  total.value = res?.total ?? 0;
}

/* 创建 */
const createDialog = ref(false);
const creating = ref(false);
const createForm = reactive({
  username: "",
  password: "",
  nickname: "",
  role: "viewer",
  remark: ""
});

function openCreate() {
  createForm.username = "";
  createForm.password = "";
  createForm.nickname = "";
  createForm.role = "viewer";
  createForm.remark = "";
  createDialog.value = true;
}

async function doCreate() {
  if (!createForm.username.trim() || createForm.password.length < 6) {
    message("用户名必填；口令至少 6 位", { type: "warning" });
    return;
  }
  creating.value = true;
  try {
    await createUser({
      username: createForm.username.trim(),
      password: createForm.password,
      nickname: createForm.nickname || undefined,
      role: createForm.role,
      remark: createForm.remark || undefined
    });
    message("用户已创建", { type: "success" });
    createDialog.value = false;
    load();
  } catch (e) {
    message(e instanceof Error ? e.message : "创建失败", { type: "error" });
  } finally {
    creating.value = false;
  }
}

/* 编辑 / 重置口令 / 启停 */
const editDialog = ref(false);
const saving = ref(false);
const editForm = reactive({
  id: "",
  username: "",
  builtin: false,
  nickname: "",
  role: "viewer",
  remark: "",
  password: ""
});

function openEdit(row: UserRow) {
  editForm.id = row.id;
  editForm.username = row.username;
  editForm.builtin = row.builtin;
  editForm.nickname = row.nickname;
  editForm.role = row.role;
  editForm.remark = row.remark;
  editForm.password = "";
  editDialog.value = true;
}

async function saveEdit() {
  saving.value = true;
  try {
    await updateUser(editForm.id, {
      nickname: editForm.nickname,
      role: editForm.role,
      remark: editForm.remark,
      ...(editForm.password ? { password: editForm.password } : {})
    });
    message(editForm.password ? "已保存（该用户全部会话已吊销，需重新登录）" : "已保存", {
      type: "success"
    });
    editDialog.value = false;
    load();
  } catch (e) {
    message(e instanceof Error ? e.message : "保存失败", { type: "error" });
  } finally {
    saving.value = false;
  }
}

async function toggleStatus(row: UserRow) {
  const next = row.status === "active" ? "disabled" : "active";
  try {
    await updateUser(row.id, { status: next });
    row.status = next;
    message(next === "active" ? "已启用" : "已停用（其全部会话已吊销）", {
      type: "success"
    });
  } catch (e) {
    message(e instanceof Error ? e.message : "操作失败", { type: "error" });
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
      title="本地三档用户（admin / operator / viewer），scrypt 加盐哈希存储于 data/users.json；停用与重置口令会即时吊销该用户的全部会话。"
    />
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
            <el-tag
              v-if="row.builtin"
              size="small"
              type="info"
              effect="plain"
              class="ml-1"
              >内置</el-tag
            >
          </template>
        </el-table-column>
        <el-table-column prop="nickname" label="昵称" min-width="110">
          <template #default="{ row }">{{ row.nickname || "—" }}</template>
        </el-table-column>
        <el-table-column label="角色" min-width="110">
          <template #default="{ row }">
            <el-tag size="small">{{ row.role }}</el-tag>
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
        <el-table-column label="创建时间" width="110">
          <template #default="{ row }">{{
            fmtTime(row.createdAt).slice(0, 10)
          }}</template>
        </el-table-column>
        <el-table-column label="最近登录" width="110">
          <template #default="{ row }">{{ timeAgo(row.lastLoginAt) }}</template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="120">
          <template #default="{ row }">{{ row.remark || "—" }}</template>
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
          <el-input
            v-model="createForm.username"
            maxlength="32"
            placeholder="3-32 位字母数字-_"
          />
        </el-form-item>
        <el-form-item label="口令" required>
          <el-input
            v-model="createForm.password"
            type="password"
            show-password
            maxlength="64"
            placeholder="至少 6 位"
          />
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
          <el-input v-model="createForm.remark" maxlength="128" />
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
    <el-dialog
      v-model="editDialog"
      :title="`编辑用户 · ${editForm.username}`"
      width="480px"
    >
      <el-form label-width="90px">
        <el-form-item label="昵称">
          <el-input v-model="editForm.nickname" maxlength="32" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="editForm.role">
            <el-option
              v-for="r in ROLES"
              :key="r.name"
              :label="`${r.label}（${r.name}）`"
              :value="r.name"
            />
          </el-select>
          <div class="text-xs text-[--el-text-color-secondary] w-full">
            改角色会即时吊销该用户全部会话；最后一名启用的 admin 受末位保护
          </div>
        </el-form-item>
        <el-form-item label="重置口令">
          <el-input
            v-model="editForm.password"
            type="password"
            show-password
            maxlength="64"
            placeholder="留空 = 不修改；重置后该用户需重新登录"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="editForm.remark" maxlength="128" />
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
