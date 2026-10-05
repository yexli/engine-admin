/* ============================================================
   Evolution Concurrency（P2 卡片9 自 runtime.ts 提取：世界级串行锁）
   ------------------------------------------------------------
   同一世界的 tick 串行化：冷却与指纹都在 run 收尾时才登记，并发窗口内
   的两个 tick 会双双通过检查、各自完整执行闭环——重复 Mutation。
   锁保证后到者等先到者落账，再重走幂等/冷却检查（方案 §二.3）。

   acquire 的语义（与原实现逐行一致）：
     · 后到者等待前一个 in-flight 完成后再执行 fn（前者的失败已由它自己
       落账，这里吞掉异常照常往下走检查）；
     · 完成后从 inFlight 摘除自己（挂双臂清理：拒绝已交给调用方）。
   ============================================================ */

export interface WorldLock {
  acquire<T>(worldId: string, fn: () => Promise<T>): Promise<T>;
}

export function createWorldLock(): WorldLock {
  const inFlight = new Map<string, Promise<unknown>>();

  return {
    acquire<T>(worldId: string, fn: () => Promise<T>): Promise<T> {
      const prev = inFlight.get(worldId);
      const exec = (async (): Promise<T> => {
        if (prev) {
          try {
            await prev;
          } catch {
            /* 前一任务的失败已由它自己落账（failed）；这里照常执行 */
          }
        }
        return fn();
      })();
      inFlight.set(worldId, exec);
      const cleanup = (): void => {
        if (inFlight.get(worldId) === exec) inFlight.delete(worldId);
      };
      exec.then(cleanup, cleanup); /* 清理挂双臂：拒绝已交给调用方，这里只摘锁 */
      return exec;
    },
  };
}
