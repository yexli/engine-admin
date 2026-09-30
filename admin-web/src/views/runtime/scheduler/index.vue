<script setup lang="ts">
import { computed } from "vue";
import RuntimePage from "../components/RuntimePage.vue";
import SchedulerPanel from "../components/SchedulerPanel.vue";
import { useWorldStore } from "@/store/modules/world";

defineOptions({ name: "RuntimeScheduler" });
const worldStore = useWorldStore();
const worldId = computed(() => worldStore.currentWorldId);
</script>

<template>
  <RuntimePage>
    <SchedulerPanel :world-id="worldId" />
  </RuntimePage>
</template>
