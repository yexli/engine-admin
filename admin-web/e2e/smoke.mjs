/* ============================================================
   E2E 冒烟编排器（M5.2 · 管理后台生产构建冒烟）
   ------------------------------------------------------------
   一条命令拉起完整被测环境并跑 Playwright：

     脚本化 OpenAI 上游(18900) + World Engine 演示宿主(18787)
     + 受管 Platform（临时数据目录，公共 18790 / 管理 18791）
     + 模型配置种子（prov-smoke / mdl-smoke 指向脚本上游）
     + admin-web 生产构建的 vite preview(18848)
     → playwright test（登录 → 世界详情 → 执行命令 → 修改路由 → 回滚）

   前置：world-engine / world-engine/gateway / platform 的 dist（缺则自动构建）、
   admin-web 依赖已安装；chromium 由 `pnpm exec playwright install chromium` 安装。
   用法：cd admin-web && pnpm test:e2e
   端口全部避开开发栈（8787/8789/8790/8791/8848），可与其并存。
   ============================================================ */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(import.meta.url), "..");
const adminDir = resolve(here, "..");
const repoRoot = resolve(adminDir, "..");
const ADMIN_TOKEN = `e2e-${Date.now().toString(36)}`;
const PORTS = { upstream: 18900, engine: 18787, platform: 18790, admin: 18791, preview: 18848 };
const BASE_URL = `http://127.0.0.1:${PORTS.preview}`;

const children = [];
let shutting = false;
function spawnChild(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["ignore", opts.quiet ? "ignore" : "inherit", "inherit"],
    shell: opts.shell === true
  });
  child.on("exit", code => {
    if (code !== null && !shutting) console.error(`[e2e] ${name} 意外退出（code=${code}）`);
  });
  children.push({ name, child });
  return child;
}

async function waitHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status < 600) return true; /* 任何应答都算可达 */
    } catch { /* 未起 */ }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error(`等待 ${url} 超时`);
}

function buildIfNeeded(dir, marker) {
  if (existsSync(marker)) return;
  console.log(`[e2e] 构建缺失的产物：${dir}`);
  const r = spawnSync("npm", ["run", "build"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`${dir} 构建失败`);
}

async function seedModelConfig() {
  const admin = `http://127.0.0.1:${PORTS.admin}`;
  const headers = { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN };
  const put = async (path, body, extra = {}) => {
    const r = await fetch(`${admin}${path}`, {
      method: "PUT", headers: { ...headers, ...extra }, body: JSON.stringify(body)
    });
    if (r.status !== 200) throw new Error(`seed ${path} -> ${r.status}: ${await r.text()}`);
    return r.json();
  };
  const get = async () => (await fetch(`${admin}/v1/admin/model-config`, { headers })).json();

  /* 建档（禁用态）→ 传凭证 → 启用 + 路由（revision 0→3） */
  const doc = (upstream, enabled) => ({
    version: 1,
    providers: [{ id: "prov-smoke", name: "scripted", endpoint: upstream, auth: { kind: "secret" }, enabled }],
    models: [{ id: "mdl-smoke", providerId: "prov-smoke", wireModel: "wire-smoke", tags: ["fast", "narrative", "reasoning", "roleplay", "memory", "cheap"], enabled }],
    routes: Object.fromEntries(["roleplay", "narrative", "reasoning", "fast", "cheap", "memory"].map(c => [c, { primary: enabled ? "mdl-smoke" : null, fallback: null }]))
  });
  const rev0 = (await get()).revision;
  await put("/v1/admin/model-config", doc(`http://127.0.0.1:${PORTS.upstream}/v1`, false), { "if-match": String(rev0) });
  const cred = await fetch(`${admin}/v1/admin/providers/prov-smoke/credential`, {
    method: "PUT", headers, body: JSON.stringify({ value: `sk-e2e-${Date.now()}` })
  });
  if (cred.status !== 200) throw new Error(`seed credential -> ${cred.status}`);
  const rev2 = (await get()).revision;
  await put("/v1/admin/model-config", doc(`http://127.0.0.1:${PORTS.upstream}/v1`, true), { "if-match": String(rev2) });
  console.log("[e2e] 模型配置已种子化（prov-smoke/mdl-smoke → 脚本上游）");
}

/* ---------------- 主流程 ---------------- */
const tmpData = mkdtempSync(join(tmpdir(), "smoke-platform-"));
try {
  /* 0. 产物预检（缺则构建） */
  buildIfNeeded(resolve(repoRoot, "world-engine"), resolve(repoRoot, "world-engine/dist/index.js"));
  buildIfNeeded(resolve(repoRoot, "world-engine/gateway"), resolve(repoRoot, "world-engine/gateway/dist/index.js"));
  buildIfNeeded(resolve(repoRoot, "platform"), resolve(repoRoot, "platform/dist/index.js"));
  console.log("[e2e] 构建 admin-web 生产产物…");
  {
    /* 直调 vite（绕开 Windows cmd 下 `NODE_OPTIONS=x vite` env 前缀不可用的问题）；
       vite build 自带 outDir 清空，无需 rimraf */
    const r = spawnSync(
      process.execPath,
      [join(adminDir, "node_modules/vite/bin/vite.js"), "build"],
      {
        cwd: adminDir,
        stdio: "inherit",
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" }
      }
    );
    if (r.status !== 0) throw new Error("admin-web 构建失败");
  }

  /* 1. 脚本化上游 */
  spawnChild("fake-upstream", process.execPath, [resolve(repoRoot, "platform/scripts/e2e-fake-upstream.mjs"), String(PORTS.upstream), "smoke-reply"]);
  /* 2. 引擎演示宿主 */
  spawnChild("engine", process.execPath, [resolve(repoRoot, "scripts/run-demo-engine.mjs")], { env: { PORT: String(PORTS.engine) } });
  /* 3. 受管平台（临时数据目录） */
  spawnChild("platform", process.execPath, [resolve(repoRoot, "platform/scripts/run-managed.mjs")], {
    cwd: resolve(repoRoot, "platform"),
    env: {
      PLATFORM_DATA_DIR: tmpData,
      PLATFORM_SECRET_MASTER_KEY: `e2e-master-${Date.now()}`,
      PLATFORM_ADMIN_TOKEN: ADMIN_TOKEN,
      PLATFORM_PORT: String(PORTS.platform),
      PLATFORM_ADMIN_PORT: String(PORTS.admin),
      ENGINE_BASE_URL: `http://127.0.0.1:${PORTS.engine}`,
      PLATFORM_UPSTREAM_ALLOW_LOOPBACK: "1",
      PLATFORM_ACCESS_LOG: "0"
    },
    quiet: true
  });
  await waitHttp(`http://127.0.0.1:${PORTS.engine}/v1/worlds`);
  await waitHttp(`http://127.0.0.1:${PORTS.admin}/healthz`);
  await seedModelConfig();

  /* 4. admin-web 生产构建 preview（代理继承 vite.config server.proxy） */
  spawnChild("preview", process.execPath, [join(adminDir, "node_modules/vite/bin/vite.js"), "preview", "--port", String(PORTS.preview), "--host", "127.0.0.1"], {
    cwd: adminDir,
    env: { PLATFORM_ADMIN_TOKEN: ADMIN_TOKEN, PLATFORM_ADMIN_TARGET: `http://127.0.0.1:${PORTS.admin}` },
    quiet: true
  });
  await waitHttp(BASE_URL);

  /* 5. Playwright */
  console.log(`[e2e] 冒烟开始：${BASE_URL}`);
  const r = spawnSync("pnpm", ["exec", "playwright", "test"], {
    cwd: adminDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, SMOKE_BASE_URL: BASE_URL }
  });
  console.log(r.status === 0 ? "[e2e] 冒烟通过 ✓" : `[e2e] 冒烟失败（exit=${r.status}）`);
  process.exitCode = r.status ?? 1;
} finally {
  shutting = true;
  for (const { child } of children) {
    try { child.kill(); } catch { /* Windows 可能直接终止 */ }
  }
  setTimeout(() => {
    rmSync(tmpData, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 500);
}
