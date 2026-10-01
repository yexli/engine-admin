/* ============================================================
   DeepSeek 全链路诊断（Model Control Plane）
   ------------------------------------------------------------
   走与浏览器完全相同的控制面 API，验证：建档 → 凭证 → 模型实测
   （真实计费调用）→ 启用 → 路由指派 → 路由实测 → 公开 world-agent。

   用法（密钥经环境变量传入，绝不写进源码/日志/配置投影）：
     DEEPSEEK_KEY=sk-xxx node scripts/e2e-deepseek-check.mjs \
       [--admin http://127.0.0.1:8899/control-api/v1/admin] \
       [--public http://127.0.0.1:18790] [--pubkey sk-e2e-bootstrap-key]

   结束态：deepseek 供应商/模型启用，narrative 能力指向 deepseek-chat。
   ============================================================ */
import process from 'node:process';

const args = process.argv.slice(2);
const argOf = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const ADMIN = argOf('--admin', 'http://127.0.0.1:8899/control-api/v1/admin');
const PUBLIC = argOf('--public', 'http://127.0.0.1:18790');
const PUBKEY = argOf('--pubkey', 'sk-e2e-bootstrap-key');
const KEY = process.env.DEEPSEEK_KEY;

if (!KEY) {
  console.error('[deepseek-check] 缺少环境变量 DEEPSEEK_KEY=sk-xxx');
  process.exit(1);
}

let step = 0;
function ok(name, detail) {
  step += 1;
  console.log(`✅ [${step}] ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, e) {
  console.error(`❌ [${step + 1}] ${name} — ${e}`);
  process.exit(1);
}

async function api(method, path, { body, ifMatch } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (ifMatch !== undefined) headers['if-match'] = String(ifMatch);
  const res = await fetch(`${ADMIN}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const err = payload?.error ?? {};
    throw new Error(`HTTP ${res.status} ${err.code ?? ''}: ${err.message ?? text.slice(0, 120)}`);
  }
  return payload;
}

try {
  /* 1. 读当前配置 */
  const cfg = await api('GET', '/model-config');
  ok('读取配置', `revision ${cfg.revision}`);

  /* 2. 建档：追加 deepseek 供应商（禁用）与模型（禁用） */
  const rev0 = cfg.revision;
  const doc = JSON.parse(JSON.stringify(cfg));
  delete doc.revision;
  if (!doc.providers.some((p) => p.id === 'prov-deepseek')) {
    doc.providers.push({
      id: 'prov-deepseek',
      name: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1',
      auth: { kind: 'secret' },
      enabled: false,
    });
  }
  if (!doc.models.some((m) => m.id === 'mdl-deepseek')) {
    doc.models.push({
      id: 'mdl-deepseek',
      providerId: 'prov-deepseek',
      wireModel: 'deepseek-chat',
      tags: ['fast', 'cheap', 'narrative', 'reasoning'],
      enabled: false,
    });
  }
  const r1 = await api('PUT', '/model-config', { body: doc, ifMatch: rev0 });
  ok('建档（禁用态）', `revision → ${r1.revision}`);

  /* 3. 凭证写入（加密落盘） */
  const r2 = await api('PUT', '/providers/prov-deepseek/credential', { body: { value: KEY } });
  if (!r2.hasCredential) throw new Error('凭证写入后 hasCredential=false');
  ok('凭证写入', `revision → ${r2.revision}，已加密`);

  /* 4. 模型实测：对配置端点发起一次真实有界调用 */
  const t0 = Date.now();
  const probe = await api('POST', '/models/mdl-deepseek/test');
  if (!probe.ok) throw new Error(`实测失败：${probe.error?.code} ${probe.error?.message}`);
  ok('模型实测（真实调用 deepseek-chat）', `${probe.elapsedMs}ms，回复「${String(probe.reply).slice(0, 60)}」`);

  /* 5. 启用供应商与模型，narrative → deepseek（不动 fast 既有路由） */
  const cfg2 = await api('GET', '/model-config');
  const doc2 = JSON.parse(JSON.stringify(cfg2));
  const revisionBeforeEnable = cfg2.revision;
  delete doc2.revision;
  doc2.providers.find((p) => p.id === 'prov-deepseek').enabled = true;
  doc2.models.find((m) => m.id === 'mdl-deepseek').enabled = true;
  doc2.routes.narrative = { primary: 'mdl-deepseek', fallback: null };
  const r3 = await api('PUT', '/model-config', { body: doc2, ifMatch: revisionBeforeEnable });
  ok('启用 + 指派 narrative 路由', `revision → ${r3.revision}`);

  /* 6. 路由实测（只打生效 primary 链路） */
  const routeProbe = await api('POST', '/routes/narrative/test');
  if (!routeProbe.ok) throw new Error(`路由实测失败：${routeProbe.error?.code} ${routeProbe.error?.message}`);
  ok('路由实测（narrative → mdl-deepseek）', `${routeProbe.elapsedMs}ms`);

  /* 7. 公开端点全链路：world-agent（不重启） */
  const chat = await fetch(`${PUBLIC}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${PUBKEY}` },
    body: JSON.stringify({
      model: 'world-agent',
      capability: 'narrative',
      messages: [{ role: 'user', content: '用一句话描写风沙起时的边塞。' }],
    }),
  });
  const chatBody = await chat.json();
  if (chat.status !== 200) throw new Error(`world-agent HTTP ${chat.status}: ${JSON.stringify(chatBody).slice(0, 160)}`);
  ok('公开 world-agent 全链路', `model_used=${chatBody.platform?.model_used}，内容「${String(chatBody.choices?.[0]?.message?.content).slice(0, 60)}」`);

  /* 8. 边界复查：/v1/models 仍只暴露 world-agent */
  const models = await (await fetch(`${PUBLIC}/v1/models`, { headers: { authorization: `Bearer ${PUBKEY}` } })).json();
  const ids = (models.data ?? []).map((m) => m.id).join(',');
  if (ids !== 'world-agent') throw new Error(`/v1/models 泄漏了底层模型：${ids}`);
  ok('公开 /v1/models 边界', '仅 world-agent');

  console.log('\n[deepseek-check] 全链路通过 ✅（deepseek-chat 现为 narrative 能力的主模型）');
} catch (e) {
  fail('链路中断', e instanceof Error ? e.message : String(e));
}
