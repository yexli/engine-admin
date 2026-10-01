/* ============================================================
   本地开发栈一键启动（受管 Platform + Admin Web）
   ------------------------------------------------------------
   读取/初始化 platform/data/dev-env.json（该目录已 gitignore）：
     masterKey    凭证加密主密钥——一旦凭证入库就不可再换，换则凭证全部
                  需要重新上传
     adminToken   管理面令牌（由 Vite 服务端注入，绝不进浏览器）
     bootstrapKey 公开 API 运维主密钥（不落盘语义见 README；此处为本地
                  开发便利持久化在 gitignore 目录）

   用法：
     node scripts/dev-stack.mjs [--vite-port 8848]
   停止：Ctrl+C（两个子进程一起退出）。
   ============================================================ */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const platformDir = resolve(here, '..');
const repoRoot = resolve(platformDir, '..');
const adminWebDir = join(repoRoot, 'admin-web');
const dataDir = join(platformDir, 'data');
const envPath = join(dataDir, 'dev-env.json');

const args = process.argv.slice(2);
const argOf = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const vitePort = argOf('--vite-port', '8848');

function loadOrCreateEnv() {
  if (existsSync(envPath)) {
    return JSON.parse(readFileSync(envPath, 'utf8'));
  }
  const env = {
    masterKey: randomBytes(24).toString('hex'),
    adminToken: `dev-${randomBytes(12).toString('hex')}`,
    bootstrapKey: `sk-world-dev-${randomBytes(12).toString('hex')}`,
  };
  writeFileSync(envPath, `${JSON.stringify(env, null, 2)}\n`);
  console.log('[dev-stack] 已初始化 platform/data/dev-env.json（gitignore 目录；更换 masterKey 需重新上传全部凭证）');
  return env;
}

const env = loadOrCreateEnv();
const children = [];

function spawnChild(name, cmd, cmdArgs, cwd, extraEnv, useShell) {
  const child = spawn(cmd, cmdArgs, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'inherit', 'inherit'],
    /* node 自身是带空格的绝对路径（C:\Program Files\...），绝不能过 shell；
       npx 是 .cmd 脚本，Windows 必须过 shell。 */
    shell: useShell === true,
  });
  child.on('exit', (code) => {
    if (code !== null && !shuttingDown) {
      console.error(`[dev-stack] ${name} 退出（code=${code}）`);
    }
  });
  children.push({ name, child });
  return child;
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[dev-stack] 正在停止全部子进程…');
  for (const { name, child } of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* Windows 下可能直接终止 */
    }
    void name;
  }
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (process.platform === 'win32') {
  process.on('SIGBREAK', shutdown);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const node = process.execPath;

/* M1 起 dev-stack 拉起全栈演示面：引擎（8787）→ 记忆（8789）→ 平台 → Admin Web。
   引擎/记忆是 scripts/ 下的宿主集成示例；缺席 dist 时对应子进程会失败，
   先在 world-engine 与 world-engine/memory 各跑一次 npm run build。 */
spawnChild('world-engine-demo', node, [join(repoRoot, 'scripts', 'run-demo-engine.mjs')], repoRoot);
spawnChild('memory-demo', node, [join(repoRoot, 'scripts', 'run-demo-memory.mjs')], repoRoot);
spawnChild('managed-platform', node, [join(platformDir, 'scripts', 'run-managed.mjs')], platformDir, {
  PLATFORM_DATA_DIR: dataDir,
  PLATFORM_SECRET_MASTER_KEY: env.masterKey,
  PLATFORM_ADMIN_TOKEN: env.adminToken,
  PLATFORM_BOOTSTRAP_KEY: env.bootstrapKey,
  PLATFORM_UPSTREAM_ALLOW_LOOPBACK: '1',
});
spawnChild('admin-web', npx, ['vite', '--port', vitePort], adminWebDir, {
  PLATFORM_ADMIN_TOKEN: env.adminToken,
  PLATFORM_ADMIN_TARGET: 'http://127.0.0.1:8791',
}, true);

console.log('[dev-stack] 启动中…');
console.log(`[dev-stack]   World Engine: http://127.0.0.1:8787  （演示世界 w-main / w-test）`);
console.log(`[dev-stack]   Memory API  : http://127.0.0.1:8789  （每世界一个 store，事件轮询摄取）`);
console.log(`[dev-stack]   公开 API : http://127.0.0.1:8790  （bootstrapKey 见 data/dev-env.json）`);
console.log(`[dev-stack]   管理监听 : http://127.0.0.1:8791  （仅回环；令牌由 Vite 注入）`);
console.log(`[dev-stack]   Admin Web: http://127.0.0.1:${vitePort}  （/world-api /memory-api /control-api 自动改写）`);
