import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { bus, world, savePort, sceneTime } from '@/world';
import { gateway } from '@/ai/gateway';
import { aiHelpers } from '@/ai/helpers';
import { LLM_TIMEOUT_MAX, LLM_TIMEOUT_MIN, REASONING_LEVELS, REASONING_PARAMS, loadLlmConfig, saveLlmConfig, llmUsable } from '@/ai/llmConfig';
import { resolveThinkingStyle } from '@/ai/chatParams';
import { weaveDiag } from '@/world/Narration';
import {
  buildPromptBlock,
  DEFAULT_EMBEDS,
  newEmbedId,
  newOptionId,
  CHANNEL_LABEL,
  type EmbedPrompt,
  type NarrativePerson,
  type PromptChannel,
  type PromptConfig,
} from '@/ai/promptPreset';

/** 通道顺序即面板里的排列顺序：前三个是「讲故事」的，后三个输出 JSON */
const CHANNELS: PromptChannel[] = ['weave', 'recap', 'narrative', 'chat', 'greet', 'intent', 'decide', 'reason'];
const PERSON_OPTS: [NarrativePerson, string][] = [
  ['first', '第一人称'],
  ['second', '第二人称'],
  ['third', '第三人称'],
];
import { useGame } from '@/store/useGame';

/* ============================================================
   系统面板 · 方案 D「印玺权柄」落地
   （设计定稿：outputs/系统设置-5方案/方案D-印玺权柄.html；样式在 styles/sysseal.css，
     新文件承载新观感，不碰冻结的 app.css，也不动其它面板共用的区块原语。）
   控件即器物：开关=落印（息/启金印），分段=度量衡滑签，超时=印石刻度，
   Key=封缄（揭/封），重置世界=火漆按压（按住 1.2 秒蜡满才落印，松手即回；
   落印后仍走引擎的二次确认单——火漆是第一道闸，不是最后一道）。
   业务逻辑（cfg 读写 / cmd / gateway / layers）与原实现逐条对应，只换呈现。
   ============================================================ */

/** 印玺开关：金印「盖下去」的那一侧播 stamp 动画，抬起不播 */
function SealToggle({ on, onToggle, label }: { on: boolean; onToggle: (v: boolean) => void; label: string }) {
  const [stamping, setStamping] = useState(false);
  return (
    <button
      type="button"
      className={'sysd-seal' + (on ? ' on' : '') + (stamping ? ' stamp' : '')}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => {
        if (!on) setStamping(true);
        onToggle(!on);
      }}
      onAnimationEnd={() => setStamping(false)}
    >
      {on ? '启' : '息'}
    </button>
  );
}

/** 度量衡滑签：金签滑到当前项。每次渲染后重测——页签显隐切换时，
    隐藏侧的宽度会从 0 恢复，依赖数组会漏掉这一次（实测会滑到 0 位）。 */
function Gauge<T extends string>({ options, value, onPick, ariaLabel }: {
  options: { id: T; label: string }[];
  value: T;
  onPick: (id: T) => void;
  ariaLabel: string;
}) {
  const boxRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const move = () => {
      const b = box.querySelector<HTMLButtonElement>('.sysd-gauge-b.on');
      const token = box.querySelector<HTMLElement>('.sysd-gauge-token');
      if (!b || !token) return;
      token.style.width = b.offsetWidth + 'px';
      token.style.transform = 'translateX(' + b.offsetLeft + 'px)';
    };
    move();
    window.addEventListener('resize', move);
    return () => window.removeEventListener('resize', move);
  });
  return (
    <span className="sysd-gauge" role="tablist" aria-label={ariaLabel} ref={boxRef}>
      <span className="sysd-gauge-token" aria-hidden="true" />
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          className={'sysd-gauge-b' + (value === o.id ? ' on' : '')}
          onClick={() => onPick(o.id)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** 火漆按压：按住 1.2s 蜡满落印（linear，慢而刻意），松手即回（200ms ease-out）。
    指针走 hold；键盘无「按住」语义，走两步确认（再按一次），3 秒不按自动解除。 */
function WaxReset({ onConfirm }: { onConfirm: () => void }) {
  const [holding, setHolding] = useState(false);
  const [done, setDone] = useState(false);
  const [armed, setArmed] = useState(false);
  const holdT = useRef<number | undefined>(undefined);
  const doneT = useRef<number | undefined>(undefined);
  const armT = useRef<number | undefined>(undefined);
  const stopHold = () => {
    clearTimeout(holdT.current);
    setHolding(false);
  };
  const fire = () => {
    setDone(true);
    doneT.current = window.setTimeout(() => setDone(false), 2200);
    onConfirm();
  };
  useEffect(() => () => {
    clearTimeout(holdT.current);
    clearTimeout(doneT.current);
    clearTimeout(armT.current);
  }, []);
  return (
    <button
      type="button"
      className={'sysd-wax' + (holding ? ' holding' : '') + (done ? ' done' : '')}
      disabled={done}
      onPointerDown={(e) => {
        if (done) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setHolding(true);
        holdT.current = window.setTimeout(() => {
          stopHold();
          fire();
        }, 1200);
      }}
      onPointerUp={stopHold}
      onPointerCancel={stopHold}
      onContextMenu={(e) => {
        if (holding) e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (done || e.repeat || (e.key !== ' ' && e.key !== 'Enter')) return;
        e.preventDefault();
        if (armed) {
          clearTimeout(armT.current);
          setArmed(false);
          fire();
        } else {
          setArmed(true);
          armT.current = window.setTimeout(() => setArmed(false), 3000);
        }
      }}
    >
      <span className="sysd-wax-fill" aria-hidden="true" />
      <span>{done ? '封印已落' : armed ? '再按一次确认' : '按住以重置'}</span>
    </button>
  );
}

/** 封缄：Key 输入框 + 揭/封。揭封状态只在本面板内存活，不落任何存储。 */
function KeyField({ id, value, onChange, disabled }: { id: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <span className="sysd-field">
      <input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder="sk-…"
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="sysd-wax-x"
        title={show ? '加封（隐藏）' : '揭封（显示）'}
        aria-label={show ? '隐藏 API Key' : '显示 API Key'}
        disabled={disabled}
        onClick={() => setShow(!show)}
      >
        {show ? '封' : '揭'}
      </button>
    </span>
  );
}

/** 印石刻度：已走部分染金（--sysd-track 由 onChange/effect 实时写） */
function TimeoutRange({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const paint = (el: HTMLInputElement | null) => {
    if (!el) return;
    const p = ((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100;
    el.style.setProperty('--sysd-track', 'linear-gradient(90deg,var(--gold) ' + p + '%,#2c3b5e ' + p + '%)');
  };
  useEffect(() => {
    paint(ref.current);
  }, [value]);
  return (
    <input
      ref={ref}
      className="sysd-range"
      type="range"
      min={LLM_TIMEOUT_MIN}
      max={LLM_TIMEOUT_MAX}
      step={500}
      value={value}
      aria-label="单次调用超时（毫秒）"
      onChange={(e) => {
        onChange(Number(e.target.value));
        paint(e.currentTarget);
      }}
    />
  );
}

export function SysPanel() {
  const S = world.query.get_world_state()!;
  const cmd = useGame((s) => s.cmd);
  const autoFlow = useGame((s) => s.autoFlow);
  const setAutoFlow = useGame((s) => s.setAutoFlow);
  const fileRef = useRef<HTMLInputElement>(null);
  const [cfg, setCfg] = useState(() => loadLlmConfig());
  const [testing, setTesting] = useState(false);
  /* 连通性结果内联常驻（2026-09-29 实测）：toast 两秒即逝，玩家点完测试只剩
     按钮恢复原样——通没通全靠运气记。结果同时落在这行小字里，一直可读。 */
  const [testLine, setTestLine] = useState<{ ok: boolean; text: string } | null>(null);
  /* 网关卡的两个页签：对话模型 / 向量模型（两者独立配置，互不影响） */
  const [aiTab, setAiTab] = useState<'llm' | 'emb'>('llm');
  /* 提示词配置的局部更新：条目与选项都是数组，改一处就整组替换（不可变更新） */
  const setPrompts = (patch: Partial<PromptConfig>) => setCfg({ ...cfg, prompts: { ...cfg.prompts, ...patch } });
  const setEmbed = (id: string, patch: Partial<EmbedPrompt>) =>
    setPrompts({ embeds: cfg.prompts.embeds.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
  const toggleChannel = (e: EmbedPrompt, c: PromptChannel) => {
    const cur = e.channels === 'all' ? [...CHANNELS] : [...e.channels];
    const next = cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c];
    /* 全不选没有意义（那条提示词永远不生效），退回「全部通道」 */
    setEmbed(e.id, { channels: next.length === 0 ? 'all' : next });
  };
  /* F-42：分层快照原在渲染体内重算（每次渲染 8 层全量组装）——改 useMemo + 按需刷新 */
  const rev = useGame((s) => s.rev);
  const [ctxNonce, setCtxNonce] = useState(0);
  const layers = useMemo(() => gateway.active().contextLayers(S, aiHelpers), [S, rev, ctxNonce]);
  /* 面板要把「这一档到底往请求里发了什么字段」讲清楚：三家端点的参数名不一样
     （Gemini 认 reasoning_effort，DeepSeek / GLM 认 thinking.type），
     玩家不该靠猜来确定自己选的那一档有没有生效。 */
  const levelHint = REASONING_LEVELS.find((l) => l.id === cfg.reasoningEffort)?.hint ?? '';
  const style = resolveThinkingStyle(cfg);
  const styleWord =
    style === 'effort'
      ? 'reasoning_effort（OpenAI / Gemini 系）'
      : style === 'thinking'
        ? 'thinking.type（DeepSeek / GLM 系）'
        : 'reasoning_effort + thinking.type（两种都发）';
  const paramHint = (REASONING_PARAMS.find((p) => p.id === cfg.reasoningParam)?.hint ?? '') + ' · 当前按端点识别为：' + styleWord;
  /* 状态印与 llmUsable 同判据：填没填 Key、开没开开关，一眼可辨（原 UI 藏在小字里） */
  const aiOn = llmUsable(cfg);
  const medium = savePort()?.medium ?? 'memory';
  const mediumWord = medium === 'sqlite' ? '桌面 · SQLite' : medium === 'localStorage' ? '本机浏览器 · localStorage' : medium;

  const doSave = () => {
    saveLlmConfig(cfg);
    gateway.reload();
    bus.emit({ type: 'toast', text: '⚙ AI 配置已保存 · ' + gateway.provider, cls: 'gold' });
  };
  const doTest = async () => {
    saveLlmConfig(cfg);
    gateway.reload();
    setTesting(true);
    if (aiTab === 'emb') {
      const r = await gateway.testEmbedding();
      setTesting(false);
      setTestLine({
        ok: r.ok,
        text: r.ok ? '✓ 向量端点连通 ' + r.ms + 'ms · 维度 ' + (r.dim ?? '?') : '✗ 向量端点测试失败：' + (r.reply || '无响应'),
      });
      bus.emit({
        type: 'toast',
        text: r.ok
          ? '✓ 向量端点连通 ' + r.ms + 'ms · 维度 ' + (r.dim ?? '?')
          : '✗ 向量端点测试失败：' + (r.reply || '无响应'),
        cls: r.ok ? 'gain' : 'bad',
      });
      return;
    }
    const r = await gateway.test();
    setTesting(false);
    setTestLine({
      ok: r.ok,
      text: r.ok ? '✓ 连通 ' + r.ms + 'ms · ' + (r.reply || '').slice(0, 20) : '✗ 测试失败：' + (r.reply || '无响应'),
    });
    bus.emit({
      type: 'toast',
      text: r.ok ? '✓ 连通 ' + r.ms + 'ms · ' + (r.reply || '').slice(0, 20) : '✗ 测试失败：' + (r.reply || '无响应'),
      cls: r.ok ? 'gain' : 'bad',
    });
  };

  const doExport = () => {
    const t = sceneTime(S);
    const blob = new Blob([JSON.stringify(S)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '天穹纪元2.0存档_' + t.year + '年' + t.month + t.date + '日.json';
    a.click();
    URL.revokeObjectURL(a.href);
    bus.emit({ type: 'toast', text: '存档已导出', cls: 'gain' });
  };

  const doImport = (f: File) => {
    const rd = new FileReader();
    rd.onload = () => cmd({ type: 'importState', json: String(rd.result) });
    rd.readAsText(f);
  };

  return (
    <div className="sysd">
      <div className="sysd-grid">
        {/* —— 时序之权 —— */}
        <section className="sysd-dossier">
          <div className="sysd-dt">
            <span className="sysd-dg" aria-hidden="true">时</span>
            <b>时序之权</b>
            <small>一日四十八刻</small>
          </div>
          <div className="sysd-db">
            <div className="sysd-dr">
              <span className="lb">
                自动流逝
                <small>{autoFlow ? '启 — 每 1.6 秒走一刻，约七十七秒过一天' : '息 — 世界停在你合眼的此刻'}</small>
              </span>
              <SealToggle on={autoFlow} onToggle={setAutoFlow} label="自动流逝" />
            </div>
            <div className="sysd-dr">
              <span className="lb">
                停摆守则
                <small>检定、对话、商店、战斗、意图解析与叙事编织期间自动暂停</small>
              </span>
            </div>
          </div>
        </section>

        {/* —— 库房之权 —— */}
        <section className="sysd-dossier">
          <div className="sysd-dt">
            <span className="sysd-dg" aria-hidden="true">匣</span>
            <b>库房之权</b>
            <small>{mediumWord} · 只读</small>
          </div>
          <div className="sysd-db">
            <div className="sysd-dr">
              <span className="lb">
                封缄钥匙
                <small>导出 JSON 随身携带，导入凭 JSON 归位</small>
              </span>
              <span className="sysd-btnrow">
                <button type="button" className="sysd-btn" onClick={doExport} aria-label="导出存档（JSON）">导出</button>
                <button type="button" className="sysd-btn ghost" onClick={() => fileRef.current?.click()} aria-label="导入存档">导入</button>
              </span>
            </div>
            <div className="sysd-dr">
              <span className="lb">
                重置世界
                <small>回到扉页 · 按住火漆一秒二才落印，松手即回</small>
              </span>
              <WaxReset onConfirm={() => cmd({ type: 'ui', a: 'reset', p: {} })} />
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files?.[0]) doImport(e.target.files[0]);
                e.target.value = '';
              }}
            />
          </div>
        </section>

        {/* —— 星桥网关（整行） —— */}
        <section className="sysd-dossier sysd-wide">
          <div className="sysd-dt">
            <span className="sysd-dg" aria-hidden="true">枢</span>
            <b>星桥网关</b>
            <small>AI 只产文本与判断 · 状态改写归规则引擎</small>
          </div>
          <div className="sysd-db">
            <div className="sysd-dr">
              <span className="lb">印信分册</span>
              <Gauge
                ariaLabel="AI 网关配置"
                options={[
                  { id: 'llm', label: '对话模型' },
                  { id: 'emb', label: '向量模型' },
                ]}
                value={aiTab}
                onPick={setAiTab}
              />
              <span className={'sysd-state' + (aiOn ? '' : ' off')}>
                {aiOn ? '通' : '息'}
                <small>{aiOn ? cfg.model : '降级规则模拟'}</small>
              </span>
            </div>

            <div hidden={aiTab !== 'llm'}>
              <p className="sysd-note">
                四通道（意图解析 · 场景叙事 · NPC 权衡 · 自由对话）已接入 LLM；关闭或调用失败时自动降级规则模拟。状态改写永远经规则引擎——AI 只产文本与判断。
              </p>
              <div className="sysd-dr tall">
                <span className="lb">
                  Base URL
                  <small>任意 OpenAI 兼容端点</small>
                </span>
              </div>
              <div className="sysd-dr full" style={{ paddingTop: 0 }}>
                <input id="ai-base" value={cfg.baseURL} onChange={(e) => setCfg({ ...cfg, baseURL: e.target.value })} placeholder="https://api.deepseek.com/v1" spellCheck={false} />
              </div>
              <div className="sysd-dr tall">
                <span className="lb">模型名</span>
              </div>
              <div className="sysd-dr full" style={{ paddingTop: 0 }}>
                <input id="ai-model" value={cfg.model} onChange={(e) => setCfg({ ...cfg, model: e.target.value })} placeholder="deepseek-chat" spellCheck={false} />
              </div>
              <div className="sysd-dr tall">
                <span className="lb">
                  API Key
                  <small>存本机 localStorage，不进仓库、不外发</small>
                </span>
              </div>
              <div className="sysd-dr full" style={{ paddingTop: 0 }}>
                <KeyField id="ai-key" value={cfg.apiKey} onChange={(v) => setCfg({ ...cfg, apiKey: v })} />
              </div>
              <div className="sysd-dr">
                <span className="lb">
                  单次调用超时
                  <small className="num" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {cfg.timeoutMs.toLocaleString()} ms · {LLM_TIMEOUT_MIN.toLocaleString()}–{LLM_TIMEOUT_MAX.toLocaleString()}
                  </small>
                </span>
                <TimeoutRange value={cfg.timeoutMs} onChange={(v) => setCfg({ ...cfg, timeoutMs: v })} />
              </div>
              <div className="sysd-dr tall">
                <span className="lb">
                  思考等级
                  <small>{levelHint}</small>
                </span>
                <Gauge ariaLabel="思考等级" options={REASONING_LEVELS.map((l) => ({ id: l.id, label: l.label }))} value={cfg.reasoningEffort} onPick={(id) => setCfg({ ...cfg, reasoningEffort: id })} />
              </div>
              <div className="sysd-dr tall">
                <span className="lb">
                  思考参数
                  <small>{paramHint}</small>
                </span>
                <Gauge ariaLabel="思考参数" options={REASONING_PARAMS.map((p) => ({ id: p.id, label: p.label }))} value={cfg.reasoningParam} onPick={(id) => setCfg({ ...cfg, reasoningParam: id })} />
              </div>
              <div className="sysd-dr">
                <span className="lb">
                  流式输出
                  <small>SSE 逐字上屏，首字即刻可见（思维链不进正文）；端点不认 stream（400 等）时自动回退整包重发一次——开不开都拿同一份文本。</small>
                </span>
                <SealToggle on={cfg.stream} onToggle={(v) => setCfg({ ...cfg, stream: v })} label="流式输出" />
              </div>
              <div className="sysd-dr">
                <span className="lb">
                  启用真实模型
                  <small>关 = 纯规则模拟，断网可玩</small>
                </span>
                <SealToggle on={cfg.enabled} onToggle={(v) => setCfg({ ...cfg, enabled: v })} label="启用真实模型" />
              </div>
              <div className="sysd-dr end">
                <span className="sysd-btnrow">
                  <button type="button" className="sysd-btn" onClick={doSave}>保存配置</button>
                  <button type="button" className="sysd-btn ghost" disabled={testing} onClick={doTest}>
                    {testing ? '测试中…' : '连通性测试'}
                  </button>
                </span>
              </div>
              {testLine && (
                <div className="sysd-dr" style={{ fontSize: 11.5, color: testLine.ok ? 'var(--jade, #57c08a)' : 'var(--crimson, #e0605a)' }}>
                  <span style={{ minWidth: 0, wordBreak: 'break-all' }}>{testLine.text}</span>
                </div>
              )}
              {/* 编织诊断：把"点了没反应"变成可读的一行。
                  编织失败以前完全静默——界面上原文留着、控制台什么都没有，
                  只能靠猜。这里直接摆出最近几次的结果与原因。 */}
              <div className="sysd-dr tall">
                <span className="lb">叙事编织诊断<small>最近 {weaveDiag().length} 次，新在上</small></span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, minWidth: 0 }}>
                  {(() => {
                    const d = weaveDiag();
                    if (!d.length)
                      return <span className="sysd-note" style={{ margin: 0 }}>还没有记录。回到世界页做一次操作（观察环境 / 调查搜索），再回来看这里。</span>;
                    return d.map((x, i) => (
                      <span key={i} style={{ color: x.ok ? 'var(--jade)' : 'var(--crimson)' }}>
                        {(x.ok ? '✓ ' : '✗ ') + '见闻 ' + x.from + '–' + x.end + ' · ' + x.why}
                      </span>
                    ));
                  })()}
                </span>
              </div>
            </div>

            <div hidden={aiTab !== 'emb'}>
              <p className="sysd-note">
                向量模型只服务记忆检索的语义召回——装上它，AI 才能按「意思相近」想起旧事。没装也能照常运转：检索会自动退回关键词与结构化匹配，其余功能不受影响。
              </p>
              <div className="sysd-dr">
                <span className="lb">
                  沿用对话模型
                  <small>省得填两遍端点与 Key</small>
                </span>
                <SealToggle
                  on={cfg.embedding.reuseLlm}
                  onToggle={(v) => setCfg({ ...cfg, embedding: { ...cfg.embedding, reuseLlm: v } })}
                  label="沿用对话模型的端点与 Key"
                />
              </div>
              <div className="sysd-dr tall">
                <span className="lb">
                  Base URL
                  <small>{cfg.embedding.reuseLlm ? '沿用对话模型端点' : 'OpenAI 兼容端点'}</small>
                </span>
              </div>
              <div className="sysd-dr full" style={{ paddingTop: 0 }}>
                <input
                  id="emb-base"
                  value={cfg.embedding.reuseLlm ? cfg.baseURL : cfg.embedding.baseURL}
                  disabled={cfg.embedding.reuseLlm}
                  onChange={(e) => setCfg({ ...cfg, embedding: { ...cfg.embedding, baseURL: e.target.value } })}
                  placeholder="https://api.siliconflow.cn/v1"
                  spellCheck={false}
                />
              </div>
              <div className="sysd-dr tall">
                <span className="lb">向量模型名</span>
              </div>
              <div className="sysd-dr full" style={{ paddingTop: 0 }}>
                <input id="emb-model" value={cfg.embedding.model} onChange={(e) => setCfg({ ...cfg, embedding: { ...cfg.embedding, model: e.target.value } })} placeholder="BAAI/bge-m3" spellCheck={false} />
              </div>
              <div className="sysd-dr tall">
                <span className="lb">
                  API Key
                  <small>存本机 localStorage，不随工程分发</small>
                </span>
              </div>
              <div className="sysd-dr full" style={{ paddingTop: 0 }}>
                <KeyField
                  id="emb-key"
                  value={cfg.embedding.reuseLlm ? cfg.apiKey : cfg.embedding.apiKey}
                  disabled={cfg.embedding.reuseLlm}
                  onChange={(v) => setCfg({ ...cfg, embedding: { ...cfg.embedding, apiKey: v } })}
                />
              </div>
              <div className="sysd-dr">
                <span className="lb">
                  启用向量模型
                  <small>关 = 退回关键词检索</small>
                </span>
                <SealToggle
                  on={cfg.embedding.enabled}
                  onToggle={(v) => setCfg({ ...cfg, embedding: { ...cfg.embedding, enabled: v } })}
                  label="启用向量模型"
                />
              </div>
              <div className="sysd-dr end">
                <span className="sysd-btnrow">
                  <button type="button" className="sysd-btn" onClick={doSave}>保存配置</button>
                  <button type="button" className="sysd-btn ghost" disabled={testing} onClick={doTest}>
                    {testing ? '测试中…' : '测试向量端点'}
                  </button>
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* —— 言灵书（提示词） —— */}
        <section className="sysd-dossier sysd-wide">
          <div className="sysd-dt">
            <span className="sysd-dg" aria-hidden="true">言</span>
            <b>言灵书</b>
            <small>叙事方式 · 人称 · 嵌入条目</small>
          </div>
          <div className="sysd-db">
            <div className="sysd-dr">
              <span className="lb">
                提示词注入
                <small>关 = 只用内置提示词；单条可按通道限定</small>
              </span>
              <SealToggle on={cfg.prompts.enabled} onToggle={(v) => setPrompts({ enabled: v })} label="启用提示词注入" />
            </div>
            <p className="sysd-note">
              以下内容会附在各 AI 通道系统提示的最前面（内置的「只输出 JSON」这类格式约束留在最后，免得被盖住），不替换内置提示词。
            </p>
            <div className="sysd-dr tall">
              <span className="lb">系统提示词<small>附加在全部通道最前</small></span>
            </div>
            <div className="sysd-dr full" style={{ paddingTop: 0 }}>
              <textarea
                id="pr-sys"
                rows={3}
                value={cfg.prompts.systemPrompt}
                onChange={(e) => setPrompts({ systemPrompt: e.target.value })}
                placeholder="例：这是一个慢热的悬疑故事，冲突藏在对话里，别急着揭底。"
              />
            </div>
            <div className="sysd-dr tall">
              <span className="lb">叙事人称</span>
              <Gauge
                ariaLabel="叙事人称"
                options={PERSON_OPTS.map(([k, lb]) => ({ id: k, label: lb }))}
                value={cfg.prompts.person}
                onPick={(id) => setPrompts({ person: id })}
              />
            </div>
            <div className="sysd-dr tall">
              <span className="lb">
                嵌入提示词
                <small>权重越大越靠前；通道可逐个限定</small>
              </span>
            </div>
            <div className="sysd-dr full" style={{ paddingTop: 0, gap: 8 }}>
              {cfg.prompts.embeds.map((e) => (
                <div className="sysd-embed" key={e.id}>
                  <div className="sysd-embed-hd">
                    <input type="checkbox" checked={e.enabled} onChange={(ev) => setEmbed(e.id, { enabled: ev.target.checked })} title="启用" aria-label="启用这条嵌入" />
                    <input className="sysd-embed-name" value={e.name} onChange={(ev) => setEmbed(e.id, { name: ev.target.value })} placeholder="名称（只用于列表识别）" />
                    <label className="sysd-embed-w">
                      权重
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={e.weight}
                        onChange={(ev) => setEmbed(e.id, { weight: Math.max(0, Math.min(100, Number(ev.target.value) || 0)) })}
                      />
                    </label>
                    <button type="button" className="sysd-embed-x" title="删除这条" aria-label="删除这条嵌入" onClick={() => setPrompts({ embeds: cfg.prompts.embeds.filter((x) => x.id !== e.id) })}>
                      ×
                    </button>
                  </div>
                  <textarea rows={2} value={e.text} onChange={(ev) => setEmbed(e.id, { text: ev.target.value })} placeholder="这条提示词的正文" />
                  <div className="sysd-chips">
                    <button type="button" className={e.channels === 'all' ? 'on' : ''} onClick={() => setEmbed(e.id, { channels: 'all' })}>
                      全部通道
                    </button>
                    {CHANNELS.map((c) => (
                      <button key={c} type="button" className={e.channels !== 'all' && e.channels.includes(c) ? 'on' : ''} onClick={() => toggleChannel(e, c)}>
                        {CHANNEL_LABEL[c]}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <span className="sysd-btnrow">
                <button
                  type="button"
                  className="sysd-btn ghost"
                  onClick={() =>
                    setPrompts({ embeds: [...cfg.prompts.embeds, { id: newEmbedId(), name: '新条目', text: '', weight: 50, enabled: true, channels: 'all' }] })
                  }
                >
                  ＋ 新增嵌入条目
                </button>
                {cfg.prompts.embeds.length === 0 && (
                  <button type="button" className="sysd-btn ghost" onClick={() => setPrompts({ embeds: DEFAULT_EMBEDS.map((e) => ({ ...e, id: newEmbedId() })) })}>
                    载入示例条目（文风 / 不出戏 / 后果落在人身上）
                  </button>
                )}
              </span>
            </div>
            <div className="sysd-dr tall">
              <span className="lb">
                剧情推进选项
                <small>显示在主界面底部，点一下直接提交</small>
              </span>
            </div>
            <div className="sysd-dr full" style={{ paddingTop: 0, gap: 6 }}>
              {cfg.prompts.options.map((o) => (
                <div className="sysd-opt" key={o.id}>
                  <input className="sysd-opt-label" value={o.label} onChange={(ev) => setPrompts({ options: cfg.prompts.options.map((x) => (x.id === o.id ? { ...x, label: ev.target.value } : x)) })} placeholder="按钮文字" />
                  <input className="sysd-opt-text" value={o.text} onChange={(ev) => setPrompts({ options: cfg.prompts.options.map((x) => (x.id === o.id ? { ...x, text: ev.target.value } : x)) })} placeholder="点下去提交的那句话，如「我盘膝坐下，调息一个时辰」" />
                  <button type="button" className="sysd-opt-x" title="删除这个选项" aria-label="删除这个选项" onClick={() => setPrompts({ options: cfg.prompts.options.filter((x) => x.id !== o.id) })}>
                    ×
                  </button>
                </div>
              ))}
              <span className="sysd-btnrow">
                <button type="button" className="sysd-btn ghost" onClick={() => setPrompts({ options: [...cfg.prompts.options, { id: newOptionId(), label: '新选项', text: '' }] })}>
                  ＋ 新增剧情选项
                </button>
              </span>
            </div>
            <div className="sysd-dr end">
              <span className="sysd-btnrow">
                <button type="button" className="sysd-btn" onClick={doSave}>保存提示词</button>
              </span>
            </div>
            {/* 组装预览：把「自由对话」通道的最终注入块摊开，配置到底拼出了什么一眼可见 */}
            <div className="sysd-line">
              <b>组装预览 · 自由对话通道</b>
              <pre>{buildPromptBlock(cfg.prompts, 'chat') || '（空 —— 当前不会注入任何内容）'}</pre>
            </div>
          </div>
        </section>

        {/* —— 星层图（上下文分层） —— */}
        <section className="sysd-dossier sysd-wide">
          <div className="sysd-dt">
            <span className="sysd-dg" aria-hidden="true">层</span>
            <b>星层图</b>
            <small>AI 上下文分层 · 动态组装</small>
          </div>
          <div className="sysd-db">
            <div className="sysd-dr">
              <span className="lb">
                快照
                <small>把此刻喂给推演通道的八层上下文摊开</small>
              </span>
              <button type="button" className="sysd-btn ghost" onClick={() => setCtxNonce((x) => x + 1)}>刷新分层快照</button>
            </div>
            <div className="sysd-dr full" style={{ gap: 8 }}>
              {layers.map((l) => (
                <div className="sysd-line" key={l[0]}>
                  <b>{l[0]}</b>
                  <pre>{l[1].join('\n')}</pre>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* —— 试炼名录（验收指南） —— */}
        <section className="sysd-dossier sysd-wide">
          <div className="sysd-dt">
            <span className="sysd-dg" aria-hidden="true">鉴</span>
            <b>试炼名录</b>
            <small>验收测试指南 · 五道试炼</small>
          </div>
          <div className="sysd-db">
            <div className="sysd-line">
              <pre>{'测试一 · 自由行动：在世界页输入框打「我观察有没有人盯着我」等自由语句\n' +
                '测试二 · NPC 独立性：任意对话 → 「提出请求」→ 威胁，看 NPC 的权衡与拒绝\n' +
                '测试三 · 世界因果：第 2 日商队被袭 → 药价上涨五成 → 夺回货物 → 药价回落\n' +
                '测试四 · 持续世界：等待/睡到天亮推进时间，NPC 按作息出没，事件按日历触发\n' +
                '测试五 · 规则一致性：战斗数值均由规则引擎判定，叙事不可改写任何状态'}</pre>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
