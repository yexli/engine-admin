<!-- Scheduler 面板：引擎 V1.0 的调度器无查询 HTTP API（API Gap），此处给出缺口说明与数据契约 -->
<template>
  <div>
    <el-alert type="info" :closable="false" show-icon class="mb-3">
      <template #title>
        引擎 V1.0 内置事件调度器（延迟事件 / 重试 / 死信），但尚未提供 HTTP
        查询接口。本页为缺口占位，缺口已记录在 docs/ADMIN-API-GAP.md。
      </template>
    </el-alert>

    <el-row :gutter="12">
      <el-col :md="14" class="mb-3">
        <el-card shadow="never">
          <template #header>
            <div class="flex items-center justify-between">
              <BiText zh="计划事件（建议接口）" en="Scheduled Events" />
              <el-tooltip
                content="引擎暂无 GET /v1/worlds/{id}/scheduler"
                placement="top"
              >
                <el-tag size="small" type="warning">API Gap</el-tag>
              </el-tooltip>
            </div>
          </template>
          <el-table :data="[]" size="default">
            <el-table-column prop="id" min-width="110">
              <template #header><BiText zh="事件 ID" en="Event ID" /></template>
            </el-table-column>
            <el-table-column prop="type" min-width="140">
              <template #header><BiText zh="类型" en="Type" /></template>
            </el-table-column>
            <el-table-column prop="executeAt" min-width="120">
              <template #header
                ><BiText zh="执行时间" en="Execute At"
              /></template>
            </el-table-column>
            <el-table-column prop="status" width="110">
              <template #header><BiText zh="状态" en="Status" /></template>
            </el-table-column>
            <el-table-column prop="retry" width="70" align="center">
              <template #header><BiText zh="重试" en="Retry" /></template>
            </el-table-column>
            <el-table-column prop="createdAt" min-width="120">
              <template #header
                ><BiText zh="创建时间" en="Created At"
              /></template>
            </el-table-column>
            <template #empty>
              <el-empty
                description="待引擎提供调度器查询 API 后启用"
                :image-size="64"
              />
            </template>
          </el-table>
        </el-card>
      </el-col>

      <el-col :md="10" class="mb-3">
        <el-card shadow="never" header="引擎侧已有能力（代码层）">
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="事件入队">
              WorldEventBus.schedule(e, delayDays) → 到期 due(day) 分发
            </el-descriptions-item>
            <el-descriptions-item label="重试与死信">
              重试计数、deadLetters()、onDeadLetter 钩子
            </el-descriptions-item>
            <el-descriptions-item label="统计">
              stats(): subscribers / scheduled / deadLetters / tickEmitted /
              deferred
            </el-descriptions-item>
            <el-descriptions-item label="当前观测替代">
              Events 面板可观察已分发的事实（含因果链）
            </el-descriptions-item>
          </el-descriptions>
          <div class="mt-3 text-xs text-[--el-text-color-secondary]">
            建议接口：GET /v1/worlds/{id}/scheduler → { scheduled: WorldEvent[],
            deadLetters: WorldEvent[], stats: {...} }（无需修改 Core，仅在 HTTP
            层暴露）
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: "SchedulerPanel" });
defineProps<{ worldId: string }>();
</script>
