/** Dashboard 总览（M4.1 起平台侧接真：/v1/obs/overview）；
 *  记忆条目数由前端直读 /memory-api（memory 是独立服务，不进平台聚合）。
 *  诚实边界：世界事件无墙钟时间，活动图为「AI 调用按小时」单序列；
 *  无计价来源，不展示成本。
 */
import { http } from "@/utils/http";

export interface DashboardOverview {
  generatedAt: string;
  worlds: {
    total: number;
    running: number;
    paused: number;
  };
  entities: number;
  ai: {
    requests24h: number;
    tokens24h: number;
    successRate: number;
    byProvider: Array<{ provider: string; requests: number }>;
    /** 最近 12 个整点小时（UTC）的 AI 调用次数 */
    hourly: Array<{ hour: string; calls: number }>;
  };
  recentErrors: Array<{
    id: string;
    time: string;
    type: string;
    message: string;
  }>;
}

export const getDashboardOverview = () => {
  return http.request<DashboardOverview>("get", "/control-api/v1/obs/overview");
};
