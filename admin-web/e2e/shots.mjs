/* ============================================================
   视觉验收截图编排（复用 smoke.mjs 的起栈方式）
   ------------------------------------------------------------
   引擎(18787) + 受管平台(18790/18791, 临时数据目录) + preview(18848)
   → Playwright 截取：登录页 / Dashboard / 世界列表 / 运行时状态 / 系统状态
   输出：admin-web/test-results/shots/*.png
   用法：cd admin-web && node e2e/shots.mjs
   ============================================================ */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(import.meta.url), "..");
const adminDir = resolve(here, "..");
const repoRoot = resolve(adminDir, "..");
const ADMIN_TOKEN = `shots-${Date.now().toString(36)}`;
const PORTS = { engine: 18787, platform: 18790, admin: 18791, preview: 18848 };
const BASE_URL = `http://127.0.0.1:${PORTS.preview}`;
const OUT_DIR = join(adminDir, "test-results", "shots");

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
    if (code !== null && !shutting) console.error(`[shots] ${name} 意外退出（code=${code}）`);
  });
  children.push({ name, child });
  return child;
}

async function waitHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status < 600) return true;
    } catch { /* 未起 */ }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error(`等待 ${url} 超时`);
}

const tmpData = mkdtempSync(join(tmpdir(), "shots-platform-"));
try {
  mkdirSync(OUT_DIR, { recursive: true });
  spawnChild("engine", process.execPath, [resolve(repoRoot, "scripts/run-demo-engine.mjs")], { env: { PORT: String(PORTS.engine) } });
  spawnChild("platform", process.execPath, [resolve(repoRoot, "platform/scripts/run-managed.mjs")], {
    cwd: resolve(repoRoot, "platform"),
    env: {
      PLATFORM_DATA_DIR: tmpData,
      PLATFORM_SECRET_MASTER_KEY: `shots-master-${Date.now()}`,
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

  console.log(`[shots] 截图开始：${BASE_URL} → ${OUT_DIR}`);
  const r = spawnSync(
    process.execPath,
    [join(here, "shots-browser.mjs")],
    {
      cwd: adminDir,
      stdio: "inherit",
      env: {
        ...process.env,
        SHOTS_BASE_URL: BASE_URL,
        SHOTS_OUT_DIR: OUT_DIR
      }
    }
  );
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
