import { useEffect, type RefObject } from 'react';

/* ============================================================
   浮层通用焦点管理（F-38 的第二处实现被抽到这里）
   —— 行囊浮层与 SheetHost 的可聚焦集合、Tab 循环规则本来就该一致，
      各写一份迟早漂移（本项目已经为"两份实现漂移"付过代价：TabBar/GameShell
      的页集合、Adventuring 手抄的等级映射）。这里只管焦点，
      ESC 由各自的调用方处理——SheetHost 要走 cmd 的 ui close，行囊只关自己。
   ============================================================ */

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * @param ref    浮层根节点
 * @param active 是否处于打开态
 *
 * 打开时把焦点移进来：根节点自带 tabindex（行囊浮层用 tabIndex={-1} 接键盘）
 * 就聚焦根节点，否则聚焦第一个可聚焦元素（SheetHost 的行为）。
 * 关闭时归还给打开前的元素，脚本与键盘用户都不会"丢焦点"。
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    const items = (): HTMLElement[] =>
      Array.from(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null);

    const prev = document.activeElement as HTMLElement | null;
    const first = root?.hasAttribute('tabindex') ? root : items()[0];
    first?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = items();
      if (!list.length) return;
      const head = list[0];
      const tail = list[list.length - 1];
      const now = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (now === head || !now || !root?.contains(now))) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && (now === tail || !now || !root?.contains(now))) {
        e.preventDefault();
        head.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [ref, active]);
}
