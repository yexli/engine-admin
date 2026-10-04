import { Component, type ReactNode } from 'react';
import { world, resetWorld } from '@/world';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/* ============================================================
   F-22 · 全站错误边界：任一组件抛错不再白屏。
   兜底页只给两个出口——"导出当前存档"（保住进度）与"重置世界"（回到扉页），
   不做自动恢复：状态已被污染时，静默继续比停下更危险。
   ============================================================ */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[天穹纪元] 运行期异常：', error);
  }

  private exportSave = () => {
    const S = world.query.get_world_state();
    if (!S) return;
    const blob = new Blob([JSON.stringify(S)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '天穹纪元2.0_异常救援存档.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  private reset = () => {
    this.setState({ error: null });
    resetWorld();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 999,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          padding: 24,
          background: 'rgba(8,10,16,.94)',
          color: '#e8e2d4',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 30, letterSpacing: '.3em' }}>穹</div>
        <h2 style={{ margin: 0, letterSpacing: '.1em' }}>世界运行中断</h2>
        <p style={{ margin: 0, opacity: 0.8, maxWidth: 460, lineHeight: 1.8 }}>
          引擎抛出过一次异常，已停住以免状态继续被改写。可先导出当前存档留底，再重置世界重来。
        </p>
        <pre
          style={{
            maxWidth: 460,
            whiteSpace: 'pre-wrap',
            fontSize: 11,
            opacity: 0.6,
            border: '1px solid rgba(255,255,255,.14)',
            borderRadius: 8,
            padding: '8px 12px',
          }}
        >
          {String(this.state.error.message || this.state.error)}
        </pre>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="sysbtn" onClick={this.exportSave}>
            导出当前存档
          </button>
          <button className="sysbtn warn" onClick={this.reset}>
            重置世界
          </button>
        </div>
      </div>
    );
  }
}
