<script setup lang="ts">
import { computed } from "vue";
import RuntimePage from "../components/RuntimePage.vue";
import LocationsPanel from "../components/LocationsPanel.vue";
import { useWorldStore } from "@/store/modules/world";

defineOptions({ name: "RuntimeLocations" });
const worldStore = useWorldStore();
const worldId = computed(() => worldStore.currentWorldId);
</script>

<template>
  <RuntimePage>
    <LocationsPanel :world-id="worldId" />
  </RuntimePage>
</template>
