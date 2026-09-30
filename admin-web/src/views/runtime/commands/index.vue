<script setup lang="ts">
import { computed, ref } from "vue";
import RuntimePage from "../components/RuntimePage.vue";
import CommandConsole from "../components/CommandConsole.vue";
import { useWorldStore } from "@/store/modules/world";

defineOptions({ name: "RuntimeCommands" });
const worldStore = useWorldStore();
const worldId = computed(() => worldStore.currentWorldId);
const consoleRef = ref();
</script>

<template>
  <RuntimePage>
    <CommandConsole ref="consoleRef" :world-id="worldId" />
  </RuntimePage>
</template>
