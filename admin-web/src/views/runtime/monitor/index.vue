<script setup lang="ts">
import { computed } from "vue";
import RuntimePage from "../components/RuntimePage.vue";
import MonitorPanel from "../components/MonitorPanel.vue";
import { useWorldStore } from "@/store/modules/world";

defineOptions({ name: "RuntimeMonitor" });
const worldStore = useWorldStore();
const worldId = computed(() => worldStore.currentWorldId);
</script>

<template>
  <RuntimePage>
    <MonitorPanel :world-id="worldId" />
  </RuntimePage>
</template>
