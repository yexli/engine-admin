<script setup lang="ts">
import { computed } from "vue";
import RuntimePage from "../components/RuntimePage.vue";
import EventsPanel from "../components/EventsPanel.vue";
import { useWorldStore } from "@/store/modules/world";

defineOptions({ name: "RuntimeEvents" });
const worldStore = useWorldStore();
const worldId = computed(() => worldStore.currentWorldId);
</script>

<template>
  <RuntimePage>
    <EventsPanel :world-id="worldId" />
  </RuntimePage>
</template>
