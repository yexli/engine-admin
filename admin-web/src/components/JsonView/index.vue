<!-- JSON 查看器：格式化展示 + 一键复制（State Raw JSON / Raw Data 等场景） -->
<template>
  <div class="json-view relative">
    <el-button
      class="absolute right-2 top-2 z-10"
      size="small"
      :type="copied ? 'success' : 'default'"
      @click="copy"
    >
      <IconifyIconOffline
        :icon="copied ? 'ep/circle-check' : 'ep/copy-document'"
        class="mr-1"
      />
      {{ copied ? "已复制" : "复制" }}
    </el-button>
    <pre
      class="overflow-auto rounded border border-[--el-border-color-light] bg-[--el-fill-color-lighter] p-3 text-[13px] leading-relaxed"
      :style="{ maxHeight: height }"
      >{{ pretty }}</pre>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

defineOptions({ name: "JsonView" });

const props = withDefaults(
  defineProps<{
    data: unknown;
    /** 最大高度（CSS 值） */
    height?: string;
  }>(),
  { height: "480px" }
);

const copied = ref(false);
const pretty = computed(() => {
  if (props.data === undefined || props.data === null) return "（无数据）";
  try {
    return JSON.stringify(props.data, null, 2);
  } catch {
    return String(props.data);
  }
});

async function copy() {
  try {
    await navigator.clipboard.writeText(pretty.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    copied.value = false;
  }
}
</script>
