<script setup lang="ts">
import { computed } from "vue";
import RuntimePage from "../components/RuntimePage.vue";
import RelationsPanel from "../components/RelationsPanel.vue";
import { useWorldStore } from "@/store/modules/world";

defineOptions({ name: "RuntimeRelations" });
const worldStore = useWorldStore();
const worldId = computed(() => worldStore.currentWorldId);
</script>

<template>
  <RuntimePage>
    <RelationsPanel :world-id="worldId" />
  </RuntimePage>
</template>
