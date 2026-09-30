<!-- 全局世界选择器：Runtime 各页面共享当前世界上下文（worldStore） -->
<template>
  <div class="flex items-center gap-2">
    <span class="text-sm text-[--el-text-color-secondary] whitespace-nowrap">
      当前世界
    </span>
    <el-select
      v-model="selected"
      :loading="worldStore.loading"
      placeholder="选择世界"
      class="!w-56"
      filterable
      @visible-change="onOpen"
      @change="onChange"
    >
      <el-option
        v-for="w in worldStore.worlds"
        :key="w.worldId"
        :label="`${w.worldId}（实体 ${w.entities}）`"
        :value="w.worldId"
      />
      <template #empty>
        <div class="px-3 py-2 text-sm text-[--el-text-color-secondary]">
          <template v-if="worldStore.error">
            引擎不可达：{{ worldStore.error }}
          </template>
          <template v-else>暂无世界，请先在「世界列表」创建</template>
        </div>
      </template>
    </el-select>
    <el-tooltip content="刷新世界清单" placement="top">
      <el-button :loading="worldStore.loading" circle @click="refresh">
        <IconifyIconOffline icon="ep/refresh" />
      </el-button>
    </el-tooltip>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useWorldStore } from "@/store/modules/world";

defineOptions({ name: "WorldSelect" });

const emit = defineEmits<{ (e: "change", worldId: string): void }>();

const worldStore = useWorldStore();
const selected = computed({
  get: () => worldStore.currentWorldId,
  set: (v: string) => worldStore.setCurrent(v)
});

onMounted(() => {
  void worldStore.fetchWorlds();
});

function onOpen(visible: boolean) {
  if (visible) void worldStore.fetchWorlds(true);
}

function refresh() {
  void worldStore.fetchWorlds(true);
}

function onChange(id: string) {
  emit("change", id);
}
</script>
