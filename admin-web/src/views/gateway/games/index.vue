<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  getGameAggregates,
  PLATFORM_BUCKET,
  type GameRow
} from "@/api/gameStudio";
import { useAsyncData, fmtTime, timeAgo } from "@/composables/useAsyncData";

defineOptions({ name: "GatewayGames" });

const games = ref<GameRow[]>([]);
const { loading, error, run } = useAsyncData();

async function load() {
  const res = await run(() => getGameAggregates());
  games.value = res ?? [];
}

const summary = computed(() => {
  const totalWorlds = games.value.reduce((n, g) => n + g.worldCount, 0);
  const running = games.value.reduce((n, g) => n + g.running, 0);
  const paused = games.value.reduce((n, g) => n + g.paused, 0);
  const keyCount = games.value.reduce((n, g) => n + g.keys.length, 0);
  return { games: games.value.length, totalWorlds, running, paused, keyCount };
});

const isPlatform = (g: GameRow) => g.gameId === PLATFORM_BUCKET;
const gameLabel = (g: GameRow) => (isPlatform(g) ? "平台托管（未归属）" : g.gameId);

const activeWorlds = (g: GameRow) => g.worlds;

onMounted(load);
</script>

<template>
  <div class="p-4">
    <!-- 概览条 -->
    <div class="flex flex-wrap gap-3 mb-4">
      <el-card shadow="never" class="min-w-[140px] flex-1">
        <div class="text-xs text-[--el-text-color-secondary] mb-1">
          <BiText zh="接入游戏方" en="Games" />
        </div>
        <div class="text-2xl font-semibold tabular-nums">
          {{ summary.games }}
        </div>
      </el-card>
      <el-card shadow="never" class="min-w-[140px] flex-1">
        <div class="text-xs text-[--el-text-color-secondary] mb-1">
          <BiText zh="托管世界" en="Worlds" />
        </div>
        <div class="text-2xl font-semibold tabular-nums">
          {{ summary.totalWorlds }}
        </div>
      </el-card>
      <el-card shadow="never" class="min-w-[140px] flex-1">
        <div class="text-xs text-[--el-text-color-secondary] mb-1">
          <BiText zh="运行中 / 暂停" en="Running / Paused" />
        </div>
        <div class="text-2xl font-semibold tabular-nums">
          <span class="text-[--el-color-success]">{{ summary.running }}</span>
          <span class="text-sm text-[--el-text-color-secondary]"> / </span>
          <span class="text-[--el-color-warning]">{{ summary.paused }}</span>
        </div>
      </el-card>
      <el-card shadow="never" class="min-w-[140px] flex-1">
        <div class="text-xs text-[--el-text-color-secondary] mb-1">
          <BiText zh="接入钥匙" en="Keys" />
        </div>
        <div class="text-2xl font-semibold tabular-nums">
          {{ summary.keyCount }}
        </div>
      </el-card>
    </div>

    <el-card shadow="never">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <el-button :loading="loading" @click="load">
          <IconifyIconOffline icon="ep/refresh" class="mr-1" />刷新
        </el-button>
        <div class="flex-1" />
        <span class="text-xs text-[--el-text-color-secondary]">
          <BiText
            zh="世界按 ownerGame 归属、钥匙按 gameId 归组；游戏方之间世界互不可见（引擎鉴权中间件）"
            en="Worlds grouped by ownerGame, keys by gameId; games are isolated by the engine auth middleware"
          />
        </span>
      </div>

      <el-alert v-if="error" type="error" :closable="false" class="mb-3" show-icon>
        <template #title>
          加载失败：{{ error }}
          <el-button text type="primary" size="small" @click="load"
            >重试</el-button
          >
        </template>
      </el-alert>

      <el-table
        v-loading="loading"
        :data="games"
        stripe
        row-key="gameId"
      >
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="p-4">
              <div class="font-medium mb-2">
                <BiText zh="旗下世界" en="Worlds" />
              </div>
              <el-table :data="activeWorlds(row as GameRow)" size="small" border>
                <el-table-column prop="worldId" min-width="140">
                  <template #header><BiText zh="世界 ID" en="World" /></template>
                </el-table-column>
                <el-table-column min-width="150">
                  <template #header><BiText zh="名称" en="Name" /></template>
                  <template #default="{ row: w }">
                    {{ w.name ?? "—" }}
                  </template>
                </el-table-column>
                <el-table-column width="100">
                  <template #header><BiText zh="状态" en="Status" /></template>
                  <template #default="{ row: w }">
                    <el-tag
                      size="small"
                      :type="w.status === 'paused' ? 'warning' : 'success'"
                    >
                      {{ w.status === "paused" ? "暂停" : "运行中" }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column width="90" prop="entities">
                  <template #header><BiText zh="实体" en="Entities" /></template>
                </el-table-column>
                <el-table-column width="110">
                  <template #header><BiText zh="玩家位置" en="Location" /></template>
                  <template #default="{ row: w }">
                    <span class="font-mono text-xs">{{ w.location }}</span>
                  </template>
                </el-table-column>
                <el-table-column width="160">
                  <template #header><BiText zh="最近推进" en="Updated" /></template>
                  <template #default="{ row: w }">
                    <span v-if="w.updatedAt">{{ timeAgo(w.updatedAt) }}</span>
                    <span
                      v-else
                      class="text-xs text-[--el-text-color-secondary]"
                      >从未推进</span
                    >
                  </template>
                </el-table-column>
              </el-table>

              <div class="font-medium mt-4 mb-2">
                <BiText zh="接入钥匙" en="Keys" />
              </div>
              <el-table :data="row.keys" size="small" border>
                <el-table-column prop="name" min-width="140">
                  <template #header><BiText zh="名称" en="Name" /></template>
                </el-table-column>
                <el-table-column min-width="140">
                  <template #header><BiText zh="Key（脱敏）" en="Key" /></template>
                  <template #default="{ row: k }">
                    <span class="font-mono text-xs">{{ k.prefix }}…</span>
                  </template>
                </el-table-column>
                <el-table-column min-width="180">
                  <template #header><BiText zh="权限" en="Permissions" /></template>
                  <template #default="{ row: k }">
                    <el-tag
                      v-for="p in k.permissions"
                      :key="p"
                      size="small"
                      type="info"
                      class="mr-1"
                    >
                      {{ p }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column width="120">
                  <template #header><BiText zh="最近使用" en="Last Used" /></template>
                  <template #default="{ row: k }">{{ timeAgo(k.lastUsedAt) }}</template>
                </el-table-column>
              </el-table>
              <div
                v-if="!row.keys.length"
                class="text-xs text-[--el-text-color-secondary] mt-1"
              >
                <BiText
                  zh="尚无钥匙——在「API 密钥」页创建时填写 gameId 即归属本游戏方"
                  en="No keys yet — create one on the Keys page with gameId to attach"
                />
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column min-width="160">
          <template #header><BiText zh="游戏方" en="Game" /></template>
          <template #default="{ row }">
            <span class="font-medium font-mono">{{ gameLabel(row as GameRow) }}</span>
          </template>
        </el-table-column>
        <el-table-column width="100" align="center">
          <template #header><BiText zh="世界" en="Worlds" /></template>
          <template #default="{ row }">
            <span class="tabular-nums">{{ row.worldCount }}</span>
          </template>
        </el-table-column>
        <el-table-column width="150">
          <template #header><BiText zh="健康" en="Health" /></template>
          <template #default="{ row }">
            <el-tag v-if="row.running" size="small" type="success" class="mr-1">
              运行 {{ row.running }}
            </el-tag>
            <el-tag v-if="row.paused" size="small" type="warning">
              暂停 {{ row.paused }}
            </el-tag>
            <span
              v-if="!row.worldCount"
              class="text-xs text-[--el-text-color-secondary]"
              >仅钥匙</span
            >
          </template>
        </el-table-column>
        <el-table-column width="90" align="center">
          <template #header><BiText zh="实体" en="Entities" /></template>
          <template #default="{ row }">
            <span class="tabular-nums">{{ row.entityCount }}</span>
          </template>
        </el-table-column>
        <el-table-column width="90" align="center">
          <template #header><BiText zh="钥匙" en="Keys" /></template>
          <template #default="{ row }">
            <span class="tabular-nums">{{ row.keys.length }}</span>
          </template>
        </el-table-column>
        <el-table-column width="150">
          <template #header><BiText zh="最近活动" en="Last Active" /></template>
          <template #default="{ row }">
            <span v-if="row.lastActiveAt">{{ timeAgo(row.lastActiveAt) }}</span>
            <span v-else class="text-xs text-[--el-text-color-secondary]">—</span>
          </template>
        </el-table-column>
        <el-table-column width="170">
          <template #header><BiText zh="归属时间" en="First Seen" /></template>
          <template #default="{ row }">
            {{ fmtTime(row.worlds[0]?.createdAt ?? row.keys[0]?.createdAt ?? "").slice(0, 10) }}
          </template>
        </el-table-column>
      </el-table>

      <el-empty
        v-if="!loading && !games.length"
        description="暂无游戏方数据——世界需带 ownerGame 元数据（hostGameWorld 种子或创建时指定），钥匙需填 gameId"
      />
    </el-card>
  </div>
</template>
