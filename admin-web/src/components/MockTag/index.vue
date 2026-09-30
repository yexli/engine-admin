<!-- Mock 数据徽标：诚实标注数据口径，但不占据整条 alert 的视觉重量 -->
<template>
  <el-tooltip
    :content="`该页数据为 Mock（演示形状，与真实契约一致）。${detail}`"
    placement="top"
  >
    <span
      class="mock-tag inline-flex items-center gap-1 rounded-full border border-dashed border-[--el-color-warning] text-[--el-color-warning] text-[11px] leading-none px-2 py-1 cursor-help select-none"
    >
      <IconifyIconOffline icon="ep/info-filled" class="text-[11px]" />
      Mock
    </span>
  </el-tooltip>
</template>

<script setup lang="ts">
defineOptions({ name: "MockTag" });

withDefaults(
  defineProps<{
    /** 补充说明（tooltip 内展示） */
    detail?: string;
  }>(),
  { detail: "" }
);
</script>
