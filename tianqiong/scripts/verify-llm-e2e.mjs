/* ============================================================
   真实 LLM 端到端验证（《架构深化方案》二期 H-11）
   读配置 → 直接打一次 OpenAI 兼容端点 → 确认 Key 有效、模型可答。

   配置来源（按优先级）：
     1) 环境变量 TQ_LLM_BASEURL / TQ_LLM_KEY / TQ_LLM_MODEL
     2) --profile=<用户数据目录>：用真实浏览器 profile 启动，于是能读到
        你在游戏里手动配好的 localStorage（注意：该浏览器需先关闭，否则 profile 被锁）
     3) 无参：全新临时 profile（读不到你手配的那份，只适合验证环境变量模式）

   用法：node scripts/verify-llm-e2e.mjs [url] [--profile=C:/.../User Data]
   输出永不回显 Key 内容，只报长度。
   ============================================================ */
import { chromium } from 'playwright-core';

const CFG_KEY = 'tq2_ai_cfg_v1';
const argv = process.argv.slice(2);
const profileArg = argv.find((a) => a.startsWith('--profile='));
const PROFILE = profileArg ? profileArg.slice('--profile='.length) : null;
const URL = argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:5273';

const log = (s) => console.log(s);

let browser;
let page;
if (PROFILE) {
  log('→ 使用持久化 profile：' + PROFILE);
  const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'msedge', headless: true });
  browser = ctx;
  page = ctx.pages()[0] || (await ctx.newPage());
} else {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage();
}

const verify = async (baseUrl, apiKey, model, from) => {
  log('✓ 配置来源：' + from);
  log('  baseUrl = ' + (baseUrl || '(空)'));
  log('  model   = ' + (model || '(空)'));
  log('  apiKey  = ' + (apiKey ? '已填（' + apiKey.length + ' 字符，不回显）' : '(空)'));
  if (!baseUrl || !apiKey || !model) {
    log('✗ 配置不完整，无法验证');
    process.exitCode = 1;
    return;
  }
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回两个字：可用' }], max_tokens: 16 }),
    signal: AbortSignal.timeout(30000),
  });
  const cost = Date.now() - t0;
  if (!res.ok) {
    log('✗ 端点返回 HTTP ' + res.status + '：' + (await res.text()).slice(0, 200));
    process.exitCode = 1;
    return;
  }
  const j = await res.json();
  const text = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  log('✓ 模型应答（' + cost + 'ms）：' + String(text).trim().slice(0, 80));
  log('✓ usage：' + JSON.stringify((j && j.usage) || {}));
  log('✓ 真实模型通道可用——推演层（openaiCompat）与本脚本走同一端点与鉴权');
};

try {
  if (process.env.TQ_LLM_BASEURL || process.env.TQ_LLM_KEY) {
    await verify(process.env.TQ_LLM_BASEURL || '', process.env.TQ_LLM_KEY || '', process.env.TQ_LLM_MODEL || '', '环境变量');
  } else {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    const cfg = await page.evaluate((k) => {
      const raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : null;
    }, CFG_KEY);
    if (!cfg) {
      log('✗ 页面 localStorage 里没有 ' + CFG_KEY);
      log('  可能原因：① 用的是临时 profile（加 --profile= 指向真实用户数据目录）；');
      log('            ② 该浏览器还没在游戏里配过模型与 Key。');
      process.exitCode = 1;
    } else {
      log('配置字段：' + Object.keys(cfg).join(', '));
      await verify(
        String(cfg.baseUrl || cfg.url || cfg.endpoint || ''),
        String(cfg.apiKey || cfg.key || ''),
        String(cfg.model || ''),
        '页面 localStorage',
      );
    }
  }
} catch (e) {
  log('✗ 异常：' + (e && e.message ? e.message : String(e)));
  process.exitCode = 1;
} finally {
  await browser.close();
}
