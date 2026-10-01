/** 通用异步请求状态：Loading / Empty / Error 三态（方案执行指令第 8 条） */
import { ref } from "vue";
import { message } from "@/utils/message";

/**
 * 包装异步数据加载：run(loadFn) 自动维护 loading/error，失败弹提示。
 * 返回的 error 供页面渲染错误态（重试按钮等）。
 */
export function useAsyncData() {
  const loading = ref(false);
  const error = ref("");
  const loaded = ref(false);

  async function run<T>(
    fn: () => Promise<T>,
    opts?: { silent?: boolean }
  ): Promise<T | undefined> {
    loading.value = true;
    if (!opts?.silent) error.value = "";
    try {
      const res = await fn();
      loaded.value = true;
      return res;
    } catch (e) {
      const err = e as {
        response?: { data?: { error?: { message?: string } | string } };
      };
      const raw = err?.response?.data?.error;
      /* 兼容两种真实错误契约：引擎 {error: string} 与管理监听 {error:{message}} */
      const msg = typeof raw === "string" ? raw : raw?.message;
      error.value =
        msg || (e instanceof Error ? e.message : String(e)) || "请求失败";
      if (!opts?.silent) message(error.value, { type: "error" });
      return undefined;
    } finally {
      loading.value = false;
    }
  }

  return { loading, error, loaded, run };
}

/** 时间显示辅助：ISO → 本地可读；空值占位 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 相对时间（几分钟前…） */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return String(iso);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

/** 截断长文本 */
export function truncate(text: string, n = 60): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}
