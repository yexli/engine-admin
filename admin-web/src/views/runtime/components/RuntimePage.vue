<!-- Runtime 页面骨架：世界上下文头（状态/世界历/天气/实体数）+ 无世界空态
     八个子页共享 worldStore 的当前世界上下文；状态徽标走引擎 1.0.3 G1 软暂停 -->
<template>
  <div class="p-4">
    <el-card shadow="never" class="mb-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-3">
          <WorldSelect @change="loadContext" />
          <template v-if="ctx">
            <el-tooltip
              :content="
                ctx.status === 'paused'
                  ? '软暂停：命令与时间推进被拒绝（读操作照常）'
                  : '正常运行（服务面受理命令与推进）'
              "
              placement="top"
            >
              <el-tag
                :type="ctx.status === 'paused' ? 'warning' : 'success'"
                effect="dark"
                size="small"
              >
                {{ ctx.status === "paused" ? "已暂停" : "运行中" }}
              </el-tag>
            </el-tooltip>
            <span
              v-if="ctx.time"
              class="text-sm text-[--el-text-color-regular] tabular-nums"
            >
              第{{ ctx.time.day }}天
              {{ String(ctx.time.hour).padStart(2, "0") }}:00（{{
                ctx.time.period
              }}）
            </span>
            <span class="text-sm text-[--el-text-color-regular]">
              天气：{{ ctx.time?.weather || "—" }}
            </span>
            <span class="text-sm text-[--el-text-color-regular]">
              实体 {{ ctx.entities }}
            </span>
          </template>
        </div>
        <slot name="actions" />
      </div>
    </el-card>

    <slot v-if="worldStore.hasWorld" />
    <el-card v-else shadow="never">
      <el-empty description="请先在上方选择一个世界（或到「世界列表」创建）">
        <router-link to="/worlds/list">
          <el-button type="primary">前往世界列表</el-button>
        </router-link>
      </el-empty>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useWorldStore } from "@/store/modules/world";
import WorldSelect from "@/components/WorldSelect/index.vue";
import { getWorld } from "@/api/world";
import type { WorldInfo } from "@/api/types";

defineOptions({ name: "RuntimePage" });

const worldStore = useWorldStore();

/** 世界上下文徽标（引擎 1.0.3：status 软暂停真实） */
const ctx = ref<WorldInfo | null>(null);

async function loadContext() {
  const id = worldStore.currentWorldId;
  if (!id) {
    ctx.value = null;
    return;
  }
  ctx.value = await getWorld(id).catch(() => null);
}

watch(
  () => worldStore.currentWorldId,
  () => loadContext(),
  { immediate: true }
);
</script>
