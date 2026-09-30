<!-- 双语文本：中文主显 + 英文小字副显（菜单 / 标签页 / 卡片头 / 表头通用） -->
<template>
  <span class="inline-flex items-baseline gap-1.5 leading-tight">
    <span>{{ zh }}</span>
    <span v-if="en" class="font-mono text-[11px] font-normal opacity-60">
      {{ en }}
    </span>
  </span>
</template>

<script setup lang="ts">
defineOptions({ name: "BiText" });

defineProps<{
  /** 中文主文案 */
  zh: string;
  /** 英文副文案（小字） */
  en?: string;
}>();
</script>
