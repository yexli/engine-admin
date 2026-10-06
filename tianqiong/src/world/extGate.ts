/* ============================================================
   extGate —— 外部裁定端口（注入槽，模式同 setSavePort/setAiPort）
   ------------------------------------------------------------
   Phase 9/10 终局形态：session 档是唯一裁定通道，dispatch 的全部
   命令（124 条，含 newGame/continueSave 等元命令）经本端口转投
   服务端会话宿主（server/game-host.ts）——客户端不在本地裁定任何
   事，收到「事实流 + 快照 + CB/curShop」后整体回灌 core
   （plugins/extSession 负责翻译与回灌）。

   端口由组合根（main.tsx → plugins/extSession）注入，与
   SavePort / AiPort 同一手法；未注入（逃生门关闭外部模式的开发
   形态 / 测试）= dispatch 走本地路径。

   断线停摆（方案 §22）：端口激活后断线，命令就地拒收
   （plugins/extSession 里 toast + 自动重连），本地不兜底。
   ============================================================ */
import type { GameCommand } from '@/types/uispec';

export interface ExternalCommandPort {
  /** session 档恒为 true（唯一裁定通道；断线由 sendCommand 拒收） */
  isActive: () => boolean;
  sendCommand: (cmd: GameCommand) => void;
}

let commandPort: ExternalCommandPort | null = null;

/** 组合根装配（session 档调用一次；传 null 拆除） */
export function setExternalCommandPort(port: ExternalCommandPort | null): void {
  commandPort = port;
}

/** dispatch 内部使用：未注入 = null（本地裁定） */
export function externalCommandPort(): ExternalCommandPort | null {
  return commandPort;
}
