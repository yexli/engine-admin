/** 跨页面共享的世界上下文：世界清单 + 当前选中世界
 *  Runtime 各页面与 World Detail 依赖此 store；清单来自引擎真实 API
 */
import { defineStore } from "pinia";
import { storageLocal } from "@pureadmin/utils";
import { getWorlds } from "@/api/world";
import type { WorldInfo } from "@/api/types";

const CURRENT_WORLD_KEY = "world-admin-current-world";

export const useWorldStore = defineStore("world-admin-world", {
  state: () => ({
    worlds: [] as WorldInfo[],
    loaded: false,
    loading: false,
    error: "",
    /** 当前世界（Runtime 页面共享上下文；空串 = 未选择） */
    currentWorldId: (storageLocal().getItem<string>(CURRENT_WORLD_KEY) || "") as string
  }),
  getters: {
    hasWorld: state => state.currentWorldId !== "",
    currentWorld: state =>
      state.worlds.find(w => w.worldId === state.currentWorldId) ?? null
  },
  actions: {
    async fetchWorlds(force = false) {
      if (this.loading) return;
      if (this.loaded && !force) return;
      this.loading = true;
      this.error = "";
      try {
        const res = await getWorlds();
        this.worlds = res.worlds ?? [];
        this.loaded = true;
        // 选中的世界可能已被删除：回落到第一个
        if (
          this.currentWorldId &&
          !this.worlds.some(w => w.worldId === this.currentWorldId)
        ) {
          this.setCurrent(this.worlds[0]?.worldId ?? "");
        } else if (!this.currentWorldId) {
          this.setCurrent(this.worlds[0]?.worldId ?? "");
        }
      } catch (e) {
        this.error =
          (e as { response?: { data?: { error?: string } } })?.response?.data
            ?.error ??
          (e instanceof Error ? e.message : String(e));
      } finally {
        this.loading = false;
      }
    },
    setCurrent(id: string) {
      this.currentWorldId = id ?? "";
      storageLocal().setItem(CURRENT_WORLD_KEY, this.currentWorldId);
    }
  }
});
