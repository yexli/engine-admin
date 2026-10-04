import { rich } from '@/world';
import { useGame } from '@/store/useGame';

/* Toast 队列（原型 #toast：2300ms 淡出、2800ms 移除）
   F-01：出口统一净化——AI 网关回显、错误信息、事件文案都可能夹带标签。 */
export function ToastHost() {
  const toasts = useGame((s) => s.toasts);
  return (
    <div id="toast" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={'t-e' + (t.cls ? ' ' + t.cls : '')}
          style={{ opacity: t.fade ? 0 : 1, transition: 'opacity .4s' }}
          dangerouslySetInnerHTML={{ __html: rich(t.text) }}
        />
      ))}
    </div>
  );
}
