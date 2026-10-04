#!/usr/bin/env node
/* ============================================================
   Publish -> Gitee: yeli52/world-engine-admin  (白名单模式)
   ------------------------------------------------------------
   仓库内容 = 下列条目，其余一律不发布：
     world-engine/  platform/(不含 data)  admin-web/  scripts/  deploy/  docs/
     tianqiong/（参考游戏；按其自身 .gitignore 排除 outputs、
       src-tauri/gen、src-tauri/Cargo.lock、界面截图-*、shot-*.png）
     publish-to-gitee.mjs   .dockerignore
   绝对红线：任何 .env / .env.*  与  platform/data 永不入库（复制后还会自检）。
   用法：
     node publish-to-gitee.mjs
     node publish-to-gitee.mjs "提交信息"
     node publish-to-gitee.mjs --message-file=MSG.txt
     node publish-to-gitee.mjs --dry-run
   ============================================================ */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, '.publish');
const REMOTE = 'https://gitee.com/yeli52/world-engine-admin.git';

const INCLUDE_DIRS = ['world-engine', 'platform', 'admin-web', 'scripts', 'deploy', 'docs', 'tianqiong'];
const INCLUDE_FILES = ['README.md', 'publish-to-gitee.mjs', '.dockerignore'];

const SKIP_DIR = new Set([
  'node_modules', 'dist', '.git', '.mimosa', '.npm-cache', '.pnpm-store',
  '.turbo', 'coverage', 'test-results', 'playwright-report', '.trash'
]);
const SKIP_EXT = new Set(['.log', '.tsbuildinfo']);
const SKIP_FILE = new Set(['.eslintcache', '.icon-src.png']);

// tianqiong 自身 .gitignore 的发布版映射：再生成的产物不入库
const TQ_SKIP_PREFIX = ['tianqiong/outputs', 'tianqiong/src-tauri/gen', 'tianqiong/界面截图-'];
const TQ_SKIP_FILE = new Set(['tianqiong/src-tauri/Cargo.lock']);

// 红线 1：任何 .env / .env.local / .env.production ...
const ENV_RE = /^\.env(\.|$)/;

function relOf(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function shouldCopy(src) {
  const base = path.basename(src);
  if (ENV_RE.test(base)) return false;                       // 红线：任何 .env*
  if (SKIP_DIR.has(base) || SKIP_FILE.has(base)) return false;
  if (SKIP_EXT.has(path.extname(base))) return false;
  const rel = relOf(src);
  if (rel === 'platform/data') return false;                 // 红线：平台运行时数据
  if (TQ_SKIP_PREFIX.some((p) => rel === p || rel.startsWith(p + '/'))) return false;
  if (TQ_SKIP_FILE.has(rel)) return false;
  if (rel.startsWith('tianqiong/') && /^shot-.*\.png$/.test(base)) return false;
  if (rel.startsWith('tianqiong/') && base.endsWith('.local')) return false;
  return true;
}

// 复制完成后自检：命中红线立即中止，绝不推送
function assertNoRedlines() {
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(PUB, p).split(path.sep).join('/');
      if (ENV_RE.test(e.name)) hits.push(rel);
      if (rel === 'platform/data') hits.push(rel + '/');
      if (rel === 'tianqiong/outputs' || rel.startsWith('tianqiong/src-tauri/gen')) hits.push(rel + '/');
      if (e.isDirectory() && rel !== 'platform/data') walk(p);
    }
  };
  walk(PUB);
  if (hits.length) {
    console.error('[publish] 红线命中，已中止，未提交未推送：');
    for (const h of hits) console.error('  ' + h);
    process.exit(1);
  }
  console.log('[publish] 红线自检通过：无 .env*、无 platform/data。');
}

function git(args) {
  return execFileSync('git', args, { cwd: PUB, stdio: 'inherit' });
}

const dryRun = process.argv.includes('--dry-run');
const msgFileArg = process.argv.find(a => a.startsWith('--message-file='));
const inlineMsg = process.argv.slice(2).find(a => !a.startsWith('--'));

if (!existsSync(path.join(PUB, '.git'))) {
  rmSync(PUB, { recursive: true, force: true });
  mkdirSync(PUB, { recursive: true });
  git(['clone', REMOTE, '.']);
}

// 白名单模式：先清空 .publish（保留 .git），再按白名单重建
for (const entry of readdirSync(PUB)) {
  if (entry === '.git') continue;
  rmSync(path.join(PUB, entry), { recursive: true, force: true });
}

// .publish 被清掉后是全新 clone，local 身份会丢失 —— 从 world-engine 继承，缺失则用缺省值
function ensureIdentity() {
  const readLocal = (k) => {
    try { return execFileSync('git', ['config', '--local', k], { cwd: PUB, encoding: 'utf8' }).trim(); }
    catch { return ''; }
  };
  const inherit = (k, fallback) => {
    try { return execFileSync('git', ['-C', path.join(ROOT, 'world-engine'), 'config', k], { encoding: 'utf8' }).trim() || fallback; }
    catch { return fallback; }
  };
  if (!readLocal('user.name')) git(['config', 'user.name', process.env.PUBLISH_GIT_NAME || inherit('user.name', 'yeli52')]);
  if (!readLocal('user.email')) git(['config', 'user.email', process.env.PUBLISH_GIT_EMAIL || inherit('user.email', 'yeli52@gitee.com')]);
  console.log('[publish] 提交身份 ' + readLocal('user.name') + ' <' + readLocal('user.email') + '>');
}

ensureIdentity();

for (const dir of INCLUDE_DIRS) {
  const from = path.join(ROOT, dir);
  if (!existsSync(from)) { console.log('[publish] 跳过（不存在） ' + dir); continue; }
  cpSync(from, path.join(PUB, dir), { recursive: true, filter: shouldCopy });
  console.log('[publish] staged ' + dir);
}
for (const file of INCLUDE_FILES) {
  const from = path.join(ROOT, file);
  if (!existsSync(from) || !statSync(from).isFile()) { console.log('[publish] 跳过（不存在） ' + file); continue; }
  cpSync(from, path.join(PUB, file));
  console.log('[publish] staged ' + file);
}

assertNoRedlines();

git(['add', '-A']);
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: PUB, encoding: 'utf8' })
  .split('\n').filter(Boolean);

if (!dirty.length) {
  console.log('[publish] 无变更，远端已是最新。');
  process.exit(0);
}

console.log('[publish] ' + dirty.length + ' 个路径有差异：');
for (const line of dirty) console.log('  ' + line);

if (dryRun) {
  console.log('[publish] dry-run：未提交、未推送。');
  process.exit(0);
}

if (msgFileArg) {
  git(['commit', '-F', msgFileArg.replace('--message-file=', '')]);
} else {
  const msg = inlineMsg || 'sync: ' + new Date().toISOString().slice(0, 19).replace('T', ' ');
  git(['commit', '-m', msg]);
}
git(['push', 'origin', 'master']);
console.log('[publish] done -> ' + REMOTE);

// 同步 GitHub（main 分支；失败不影响 gitee 发布结果）
const GH = 'https://github.com/yexli/engine-admin.git';
if (process.env.PUBLISH_SKIP_GITHUB !== '1') {
  try {
    if (!gitRemotes().includes('github')) {
      git(['remote', 'add', 'github', GH]);
    }
    git(['push', 'github', 'master:main']);
    console.log('[publish] synced -> ' + GH + ' (main)');
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
    console.warn('[publish] ⚠ GitHub 同步失败（不影响本次发布）：' + msg);
  }
}

function gitRemotes() {
  return execFileSync('git', ['remote'], { cwd: PUB, encoding: 'utf8' }).split('\n').filter(Boolean);
}