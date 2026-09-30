<script setup lang="ts">
import { computed } from "vue";
import RuntimePage from "../components/RuntimePage.vue";
import EntitiesPanel from "../components/EntitiesPanel.vue";
import { useWorldStore } from "@/store/modules/world";

defineOptions({ name: "RuntimeEntities" });
const worldStore = useWorldStore();
const worldId = computed(() => worldStore.currentWorldId);
</script>

<template>
  <RuntimePage>
    <EntitiesPanel :world-id="worldId" />
  </RuntimePage>
</template>
