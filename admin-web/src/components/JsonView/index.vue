<!-- JSON 查看器：语法高亮 + 行号 + 行数统计 + 一键复制（零依赖 tokenizer） -->
<template>
  <div class="json-view relative">
    <div
      class="absolute right-2 top-2 z-10 flex items-center gap-2 rounded bg-[--el-bg-color-overlay] px-2 py-1 border border-[--el-border-color-lighter] shadow-sm"
    >
      <span class="text-xs text-[--el-text-color-secondary] tabular-nums">
        {{ lineCount }} 行
      </span>
      <el-divider direction="vertical" />
      <el-button
        text
        size="small"
        :type="copied ? 'success' : 'primary'"
        class="!px-1"
        @click="copy"
      >
        <IconifyIconOffline
          :icon="copied ? 'ep/circle-check' : 'ep/copy-document'"
          class="mr-1"
        />
        {{ copied ? "已复制" : "复制" }}
      </el-button>
    </div>
    <pre
      class="json-pre overflow-auto rounded border border-[--el-border-color-light] bg-[--el-fill-color-lighter] p-3 m-0 text-[13px] leading-relaxed"
      :style="{ maxHeight: height }"
      ><code v-html="highlighted" /></pre>
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
  if (props.data === undefined || props.data === null) return "";
  try {
    return JSON.stringify(props.data, null, 2);
  } catch {
    return String(props.data);
  }
});

const lineCount = computed(() =>
  pretty.value ? pretty.value.split("\n").length : 0
);

/** 极简 JSON 高亮：先把字符串字面量占位，再着色键/字符串/数字/字面量。
 *  输出经 escapeHtml，v-html 无注入面（内容全部来自 JSON.stringify）。 */
const highlighted = computed(() => {
  if (!pretty.value) return '<span class="jx-empty">（无数据）</span>';
  const esc = pretty.value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc.replace(
    /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, str, colon, literal, num) => {
      if (str) {
        return colon
          ? `<span class="jx-key">${str}</span>${colon}`
          : `<span class="jx-str">${str}</span>`;
      }
      if (literal) return `<span class="jx-lit">${literal}</span>`;
      if (num) return `<span class="jx-num">${num}</span>`;
      return match;
    }
  );
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

<style scoped lang="scss">
.json-pre {
  font-family:
    ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
    "Liberation Mono", monospace;
  font-variant-numeric: tabular-nums;
}

/* 浅色主题配色（GitHub Light 风） */
:deep(.jx-key) {
  color: #0550ae;
}

:deep(.jx-str) {
  color: #116329;
}

:deep(.jx-num) {
  color: #953800;
}

:deep(.jx-lit) {
  color: #8250df;
}

:deep(.jx-empty) {
  color: var(--el-text-color-secondary);
}

/* 深色主题跟随 */
html.dark {
  .json-pre {
    background: var(--el-fill-color-darker);
  }

  :deep(.jx-key) {
    color: #79c0ff;
  }

  :deep(.jx-str) {
    color: #7ee787;
  }

  :deep(.jx-num) {
    color: #ffa657;
  }

  :deep(.jx-lit) {
    color: #d2a8ff;
  }
}
</style>
