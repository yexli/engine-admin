/* ============================================================
   AI 流式草稿 → store（显示层的唯一入口）
   ------------------------------------------------------------
   草稿是「正在长出来的那句话」，只在流式开启时才有。这一份钉两条会静态错的口径：
     · 有文本 → 进 store（SceneView / 聊天浮层据此显示）；
     · done / 空文本 / 编织结束 → 清空（否则界面停在半截句子上）。
   草稿**不是状态**：不写进 WorldState，也不会进任何判定。
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus } from '@/world';
import { attachCoreBridge, useGame } from '@/store/useGame';

let off: (() => void) | null = null;
beforeEach(() => {
  useGame.setState({ aiDraft: null });
  off = attachCoreBridge();
});
afterEach(() => {
  off?.();
  off = null;
});

describe('aidraft · 流式草稿进 store', () => {
  it('有文本就进 store（带通道与 NPC 归属，UI 据此分派）', () => {
    bus.emit({ type: 'aidraft', channel: 'chat', npcId: 'lita', text: '“钱在柜上，' });
    expect(useGame.getState().aiDraft).toEqual({ channel: 'chat', npcId: 'lita', text: '“钱在柜上，' });
  });

  it('done 与空文本都清空：界面不能停在半截句子上', () => {
    bus.emit({ type: 'aidraft', channel: 'weave', text: '暮色' });
    bus.emit({ type: 'aidraft', channel: 'weave', text: '', done: true });
    expect(useGame.getState().aiDraft).toBeNull();

    bus.emit({ type: 'aidraft', channel: 'weave', text: '暮色' });
    bus.emit({ type: 'aidraft', channel: 'weave', text: '' });
    expect(useGame.getState().aiDraft).toBeNull();
  });

  it('编织结束（weave from=null）也清草稿：正文才是最终形态', () => {
    bus.emit({ type: 'aidraft', channel: 'weave', text: '暮色' });
    bus.emit({ type: 'weave', from: null });
    expect(useGame.getState().aiDraft).toBeNull();
  });
});
