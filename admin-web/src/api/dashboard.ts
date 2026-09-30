/** Dashboard 总览（聚合层：Worlds/Entities 来自真实引擎，平台指标当前 Mock） */
import { http } from "@/utils/http";

export interface DashboardOverview {
  stats: {
    worlds: number;
    activeWorlds: number;
    entities: number;
    eventsPerMin: number;
    aiRequests24h: number;
    memoryRecords: number;
  };
  activity: {
    hours: string[];
    events: number[];
    aiCalls: number[];
  };
  aiUsage24h: {
    costUsd: number;
    tokens: number;
    successRate: number;
    byProvider: Array<{ provider: string; requests: number }>;
  };
  recentErrors: Array<{
    id: string;
    time: string;
    type: string;
    message: string;
    status: string;
  }>;
}

export const getDashboardOverview = () => {
  return http.request<{ success: boolean; data: DashboardOverview }>(
    "get",
    "/admin-api/dashboard/overview"
  );
};
