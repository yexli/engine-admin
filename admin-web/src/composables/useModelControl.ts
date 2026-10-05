/**
 * useModelControl —— Model Control Plane 页面共享状态（真实 API）
 * ------------------------------------------------------------
 * 【模块级共享草稿】三个页面（供应商/模型/路由）共用同一份状态：
 * 页面切换不丢改动；浏览器刷新/关闭由 beforeunload 拦截提醒；
 * 「刷新」按钮在存在未保存改动时先确认再丢弃。
 *
 * 草稿模型：config 即草稿（页面直接改字段 + markDirty），「保存全部」
 * 携带当前 revision 整体提交；409 冲突时自动重载最新配置并提示，
 * 丢弃本地草稿（服务端配置是权威）。
 *
 * 提交时机约定：
 * · 草稿操作（增/删/改供应商、模型、路由）→ 只改本地，等「保存全部」；
 * · 凭证上传 → 独立写路径立即提交（服务端硬约束：先建档后传凭证），
 *   成功后只把凭证状态与 revision 补进草稿，不整页重载（保草稿）；
 * · 实测 → 只作用于已提交配置；草稿实体先自动「保存全部」建档。
 */
import { computed, ref, type Ref } from "vue";
import { ElMessageBox } from "element-plus";
import {
  modelControlApi,
  ControlApiError,
  cloneConfig,
  clientValidate,
  type AdminModelConfig,
  type ManagedCapability,
  type TestResult
} from "@/api/modelControl";
import { message } from "@/utils/message";

/* ---------------- 模块级共享状态（跨页面单例） ---------------- */

const config: Ref<AdminModelConfig | null> = ref(null);
/** 最近一次从服务端加载的已提交快照（判断草稿项是否已建档） */
const committed: Ref<AdminModelConfig | null> = ref(null);
const loading = ref(false);
const saving = ref(false);
const loadError = ref("");
const conflict = ref(false);
/** 草稿未保存改动数（用于「保存」按钮角标与常驻横幅） */
const dirty = ref(0);

const revision = computed(() => config.value?.revision ?? 0);
const enabledModels = computed(() =>
  (config.value?.models ?? []).filter(m => m.enabled)
);

/* ---------------- 刷新/关闭拦截（注册一次） ---------------- */

let guardRegistered = false;
function registerUnloadGuard(): void {
  if (guardRegistered || typeof window === "undefined") return;
  guardRegistered = true;
  window.addEventListener("beforeunload", e => {
    if (dirty.value > 0) {
      e.preventDefault();
      e.returnValue = ""; /* 触发浏览器原生"确定离开？"对话框 */
    }
  });
}

/* ---------------- 加载与刷新 ---------------- */

/** 强制从服务端重载（丢弃草稿）——保存成功后与显式刷新用 */
async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    config.value = await modelControlApi.getConfig();
    committed.value = cloneConfig(config.value);
    dirty.value = 0;
    conflict.value = false;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/** 页面挂载用：已有共享状态（含草稿）则不重载——切页不丢改动 */
async function ensureLoaded(): Promise<void> {
  if (config.value === null) await load();
}

/** 工具栏「刷新」：有未保存改动时先确认，再丢弃重载 */
async function refresh(): Promise<void> {
  if (config.value !== null && dirty.value > 0) {
    try {
      await ElMessageBox.confirm(
        `有 ${dirty.value} 项未保存改动，刷新将从服务端重新加载并丢弃这些改动。`,
        "丢弃未保存改动？",
        { type: "warning", confirmButtonText: "丢弃并刷新", cancelButtonText: "取消" }
      );
    } catch {
      return; /* 用户取消 */
    }
  }
  await load();
}

function markDirty(): void {
  dirty.value += 1;
}

/* ---------------- 保存 ---------------- */

/**
 * 保存当前草稿（完整配置 + If-Match）。
 * 422 → 逐条原因提示（服务端权威校验）；409 → 重载最新并显式告知。
 */
async function save(): Promise<boolean> {
  if (!config.value || saving.value) return false;
  const localIssues = clientValidate(config.value);
  if (localIssues.length > 0) {
    message(localIssues[0], { type: "warning" });
    return false;
  }
  saving.value = true;
  try {
    await modelControlApi.putConfig(
      cloneConfig(config.value),
      config.value.revision
    );
    dirty.value = 0;
    conflict.value = false;
    /* 先刷新拿服务端真实 revision，再提示（QA #13：本地预计算在并发写入/
       凭证上传推进 revision 时会与实际不符） */
    await load();
    message(`配置已保存并即时生效（revision ${config.value?.revision ?? "?"}）`, {
      type: "success"
    });
    return true;
  } catch (e) {
    if (e instanceof ControlApiError && e.status === 409) {
      conflict.value = true;
      message("配置已被其他人更新（revision 冲突）：已加载最新版本，请在最新配置上重做改动", {
        type: "error"
      });
      await load();
    } else if (e instanceof ControlApiError) {
      message(`保存失败：${e.message}`, { type: "error" });
    } else {
      message(`保存失败：${e instanceof Error ? e.message : String(e)}`, {
        type: "error"
      });
    }
    return false;
  } finally {
    saving.value = false;
  }
}

/* ---------------- 回滚（M5.2 补齐 UI 入口；API 自 M2 起可用） ---------------- */

/** 回滚到上一版本备份（revision 继续前进）；无备份（revision 0/1）时服务端 409/422 */
async function rollback(): Promise<boolean> {
  if (!config.value || saving.value) return false;
  try {
    await ElMessageBox.confirm(
      `回滚到上一版本备份？当前 revision ${config.value.revision} 将被上一版本替代（revision 继续前进，可再次回滚），加密凭证引用同步还原并即时生效。`,
      "回滚确认",
      { type: "warning", confirmButtonText: "回滚", cancelButtonText: "取消" }
    );
  } catch {
    return false; /* 用户取消 */
  }
  saving.value = true;
  try {
    const out = await modelControlApi.rollback(config.value.revision);
    dirty.value = 0;
    conflict.value = false;
    message(`已回滚到上一版本（revision ${out.revision}），即时生效`, {
      type: "success"
    });
    await load();
    return true;
  } catch (e) {
    if (e instanceof ControlApiError && e.status === 409) {
      conflict.value = true;
      message("配置已被其他人更新（revision 冲突）：已加载最新版本", {
        type: "error"
      });
      await load();
    } else if (e instanceof ControlApiError) {
      message(`回滚失败：${e.message}`, { type: "error" });
    } else {
      message(`回滚失败：${e instanceof Error ? e.message : String(e)}`, {
        type: "error"
      });
    }
    return false;
  } finally {
    saving.value = false;
  }
}

/* ---------------- 建档辅助 ---------------- */

/**
 * 确保供应商已在服务端建档：已在已提交快照中 → true；
 * 仅在草稿中 → 自动执行一次「保存全部」（成功 true，失败 false）。
 * 凭证写接口要求供应商已存在——先建档再传凭证是服务端的硬约束。
 */
async function ensureProviderCommitted(providerId: string): Promise<boolean> {
  if (committed.value?.providers.some(p => p.id === providerId)) return true;
  message("该供应商还未建档：正在自动「保存全部」…", { type: "info" });
  return await save();
}

/** 同上：实测接口只作用于已提交配置中的模型——草稿模型先自动建档 */
async function ensureModelCommitted(modelId: string): Promise<boolean> {
  if (committed.value?.models.some(m => m.id === modelId)) return true;
  message("该模型还未建档：正在自动「保存全部」…", { type: "info" });
  return await save();
}

/* ---------------- 凭证（独立提交路径，保草稿） ---------------- */

/** 上传/替换供应商凭证：立即提交；成功后只补草稿的凭证状态与 revision */
async function uploadCredential(providerId: string, value: string): Promise<boolean> {
  try {
    const out = await modelControlApi.putCredential(providerId, value);
    /* 更新已提交快照（独立 GET，不触碰草稿） */
    try {
      committed.value = await modelControlApi.getConfig();
    } catch {
      /* 快照刷新失败不影响本次凭证结果 */
    }
    if (config.value) {
      const p = config.value.providers.find(x => x.id === providerId);
      if (p) p.auth = { kind: p.auth.kind, hasCredential: true };
      /* 凭证写推进了服务端 revision，草稿必须对齐，否则下次保存 409 */
      config.value.revision = out.revision;
    }
    message(`凭证已加密保存（revision ${out.revision}）`, { type: "success" });
    return true;
  } catch (e) {
    message(
      `凭证保存失败：${e instanceof ControlApiError ? e.message : String(e)}`,
      { type: "error" }
    );
    return false;
  }
}

/* ---------------- 有界实测 ---------------- */

async function testModel(modelId: string): Promise<TestResult | null> {
  try {
    return await modelControlApi.testModel(modelId);
  } catch (e) {
    message(`测试请求失败：${e instanceof Error ? e.message : String(e)}`, {
      type: "error"
    });
    return null;
  }
}

async function testRoute(capability: ManagedCapability): Promise<TestResult | null> {
  try {
    return await modelControlApi.testRoute(capability);
  } catch (e) {
    message(`测试请求失败：${e instanceof Error ? e.message : String(e)}`, {
      type: "error"
    });
    return null;
  }
}

export function useModelControl() {
  registerUnloadGuard();
  return {
    config,
    committed,
    loading,
    saving,
    loadError,
    conflict,
    dirty,
    revision,
    enabledModels,
    load,
    ensureLoaded,
    refresh,
    markDirty,
    save,
    rollback,
    ensureProviderCommitted,
    ensureModelCommitted,
    uploadCredential,
    testModel,
    testRoute
  };
}
