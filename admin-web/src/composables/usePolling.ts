/** 简单轮询：实时数据第一版用 Polling（方案 §12），组件卸载自动停止 */
import { onActivated, onBeforeUnmount, onDeactivated, ref } from "vue";

export function usePolling(fn: () => void | Promise<void>, intervalMs = 5000) {
  const polling = ref(false);
  let timer: ReturnType<typeof setInterval> | null = null;

  function start() {
    if (polling.value) return;
    polling.value = true;
    timer = setInterval(() => {
      void fn();
    }, intervalMs);
  }

  function stop() {
    polling.value = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function toggle() {
    polling.value ? stop() : start();
  }

  /** keep-alive 场景下暂停/恢复；未缓存页面无副作用 */
  onActivated(() => polling.value && start());
  onDeactivated(stop);
  onBeforeUnmount(stop);

  return { polling, start, stop, toggle };
}
