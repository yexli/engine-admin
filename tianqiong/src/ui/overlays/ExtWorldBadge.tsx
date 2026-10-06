/* ============================================================
   ExtWorldBadge —— 外部 World Engine 连接指示器
   ------------------------------------------------------------
   方案 §22 的 UI 面：外部引擎模式下，连接状态机对玩家可见——
   online 是一枚小徽标；reconnecting/offline 显示醒目横幅
   （世界写操作此时会被拒，玩家应当知道为什么）。

   只在开关打开（extWorld.enabled）时渲染；开关关闭时这个组件
   等价于不存在——绞杀式迁移不改变现有玩家的任何视觉。
   ============================================================ */
import { useGame } from '@/store/useGame';

const LABEL: Record<string, string> = {
  idle: '待连接',
  connecting: '连接中…',
  online: '外擎',
  reconnecting: '重连中…',
  offline: '离线',
  closed: '已断开',
  off: '',
};

export function ExtWorldBadge() {
  const ext = useGame((s) => s.extWorld);
  if (!ext.enabled) return null;
  const label = LABEL[ext.status] ?? ext.status;
  const bad = ext.status === 'reconnecting' || ext.status === 'closed';
  const busy = ext.status === 'connecting';
  const detail =
    ext.status === 'online'
      ? `引擎时间 D${ext.day ?? '?'}·${ext.tick ?? '?'}刻` + (ext.playerLoc ? `·${ext.playerLoc}` : '')
      : (ext.lastError ?? '');
  return (
    <div
      id="ext-world-badge"
      title={detail ? `World Engine（${ext.baseUrl}）：${detail}` : `World Engine（${ext.baseUrl}）`}
      style={{
        position: 'fixed',
        top: 6,
        right: 8,
        zIndex: 1200,
        fontSize: 11,
        letterSpacing: '0.08em',
        padding: '2px 8px',
        borderRadius: 999,
        border: '1px solid ' + (bad ? '#a33' : busy ? '#b8912f' : '#5d7a5d'),
        color: bad ? '#e8b4b4' : busy ? '#d8b45f' : '#a8c8a8',
        background: 'rgba(10, 12, 10, 0.72)',
        pointerEvents: 'none',
        userSelect: 'none',
        maxWidth: '46vw',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
      {busy || bad ? '' : ''}
      {detail && bad ? ` · ${detail}` : ''}
    </div>
  );
}
