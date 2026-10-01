/* ============================================================
   API Key 运维 CLI（Phase 1 · Phase 2 将由 Admin API 承接）
   ------------------------------------------------------------
   用法（在 platform/ 目录下，需先 pnpm build）：
     node scripts/keyctl.mjs create --name demo [--perms chat:completions,worlds:read]
     node scripts/keyctl.mjs list
     node scripts/keyctl.mjs delete <key-id>
   ============================================================ */
import { resolvePlatformConfig } from '../dist/config.js';
import { KeyStore, PLATFORM_PERMISSIONS } from '../dist/index.js';

const config = resolvePlatformConfig(process.env, process.cwd());
const store = new KeyStore(config.keysFile, config.bootstrapKey ?? undefined);
const [command, ...rest] = process.argv.slice(2);

function die(msg) {
  console.error(`[keyctl] ${msg}`);
  process.exit(1);
}

function argValue(flag, argv) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

switch (command) {
  case 'create': {
    const name = argValue('--name', rest);
    if (!name) die('create 需要 --name <名称>');
    const permsArg = argValue('--perms', rest);
    const permissions = permsArg
      ? permsArg.split(',').map((s) => s.trim())
      : [...PLATFORM_PERMISSIONS];
    const { record, plaintext } = store.create({ name, permissions });
    store.flush();
    console.log(`[keyctl] 已创建密钥 ${record.id}（${record.name}）`);
    console.log(`  permissions: ${record.permissions.join(', ')}`);
    console.log(`  明文（仅此一次，请立即保存）:\n\n  ${plaintext}\n`);
    break;
  }
  case 'list': {
    const keys = store.list();
    if (!keys.length) {
      console.log('[keyctl]（空）尚无密钥');
      break;
    }
    for (const k of keys) {
      console.log(
        `${k.id}  ${k.prefix}…  ${k.name}  [${k.permissions.join(',')}]${k.expiresAt ? `  过期=${k.expiresAt}` : ''}${k.lastUsedAt ? `  lastUsed=${k.lastUsedAt}` : ''}`,
      );
    }
    break;
  }
  case 'delete': {
    const id = rest[0];
    if (!id) die('delete 需要 <key-id>（从 list 获取）');
    if (store.remove(id)) {
      store.flush();
      console.log(`[keyctl] 已删除 ${id}（该 Key 立即失效，记录已移除）`);
    } else {
      die(`未找到密钥 ${id}`);
    }
    break;
  }
  default:
    die('用法：keyctl.mjs create --name <名称> [--perms a,b] | list | delete <id>');
}
