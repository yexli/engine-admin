<script setup lang="ts">
import { computed } from "vue";
import RuntimePage from "../components/RuntimePage.vue";
import StatePanel from "../components/StatePanel.vue";
import { useWorldStore } from "@/store/modules/world";

defineOptions({ name: "RuntimeState" });
const worldStore = useWorldStore();
const worldId = computed(() => worldStore.currentWorldId);
</script>

<template>
  <RuntimePage>
    <StatePanel :world-id="worldId" />
  </RuntimePage>
</template>
