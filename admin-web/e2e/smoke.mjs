/* ============================================================
   E2E 冒烟编排器（M5.2 · 管理后台生产构建冒烟）
   ------------------------------------------------------------
   一条命令拉起完整被测环境并跑 Playwright：

     World Engine 演示宿主(18787)
     + 受管 Platform（临时数据目录，公共 18790 / 管理 18791）
     + admin-web 生产构建的 vite preview(18848)
     → playwright test（登录 → 世界详情 → 执行命令）

   Control Plane 收束（docs/ENGINE-CORE-SCOPE.md §3.5）：
   原脚本化 OpenAI 上游(18900)与模型配置种子（prov-smoke/mdl-smoke）随
   AI 网关页面移除而删除；受管平台仍整体拉起（Extension 装配不动）。

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
const PORTS = { engine: 18787, platform: 18790, admin: 18791, preview: 18848 };
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

  /* 1. 引擎演示宿主 */
  spawnChild("engine", process.execPath, [resolve(repoRoot, "scripts/run-demo-engine.mjs")], { env: { PORT: String(PORTS.engine) } });
  /* 2. 受管平台（临时数据目录） */
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

  /* 3. admin-web 生产构建 preview（代理继承 vite.config server.proxy）
     VITE_WORLD_API_URL 显式指向 e2e 引擎：覆盖本机 .env 的个人化指向
     （如 8797 天穹 game-host），保证冒烟自密闭、不碰真实栈。 */
  spawnChild("preview", process.execPath, [join(adminDir, "node_modules/vite/bin/vite.js"), "preview", "--port", String(PORTS.preview), "--host", "127.0.0.1"], {
    cwd: adminDir,
    env: {
      PLATFORM_ADMIN_TOKEN: ADMIN_TOKEN,
      PLATFORM_ADMIN_TARGET: `http://127.0.0.1:${PORTS.admin}`,
      VITE_WORLD_API_URL: `http://127.0.0.1:${PORTS.engine}`
    },
    quiet: true
  });
  await waitHttp(BASE_URL);

  /* 4. Playwright */
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
