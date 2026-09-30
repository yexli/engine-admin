<!-- Runtime 页面骨架：世界选择器 + 无世界空态 -->
<template>
  <div class="p-4">
    <el-card shadow="never" class="mb-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <WorldSelect />
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
import { useWorldStore } from "@/store/modules/world";
import WorldSelect from "@/components/WorldSelect/index.vue";

defineOptions({ name: "RuntimePage" });

const worldStore = useWorldStore();
</script>
