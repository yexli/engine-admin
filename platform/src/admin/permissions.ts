/* ============================================================
   角色-权限模型（M3.2 · 与 docs/ADMIN-PERMISSION.md 同源）
   ------------------------------------------------------------
   三档内置角色（admin/operator/viewer），权限码目录固定八项；
   角色不支持在线编辑（避免两套角色表——完整租户体系归平台 Phase 2）。
   服务端强制是安全边界；前端 hasPerms 仅是 UX。
   ============================================================ */

export const ADMIN_ROLES = ['admin', 'operator', 'viewer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** 权限码目录（展示 + 服务端校验同一份词表） */
export const PERMISSION_CATALOG: { code: string; name: string; group: string; description: string }[] = [
  { code: 'world:read', name: 'World 读取', group: 'World', description: '查看世界、状态、实体、事件' },
  { code: 'world:write', name: 'World 写入', group: 'World', description: '创建世界、推进时间、变更天气、暂停/恢复' },
  { code: 'command:execute', name: '命令执行', group: 'World', description: '通过 Command 调试台执行命令（影响世界状态）' },
  { code: 'gateway:manage', name: 'Gateway 管理', group: 'AI Gateway', description: '管理 Provider / Model / Router / Pipeline / API Key' },
  { code: 'memory:read', name: 'Memory 读取', group: 'Memory', description: '查看记忆库与记录，执行检索测试' },
  { code: 'memory:write', name: 'Memory 写入', group: 'Memory', description: '删除记忆记录' },
  { code: 'observability:read', name: '监控读取', group: 'Observability', description: '查看日志、AI 调用、错误' },
  { code: 'system:manage', name: '系统管理', group: 'System', description: '用户、角色、系统设置管理' },
];

/** 三档角色的权限集合（admin = 超权通配，与前端登录返回口径一致） */
export const ROLE_PERMISSIONS: Record<AdminRole, readonly string[]> = {
  admin: ['*:*:*'],
  operator: ['world:read', 'world:write', 'command:execute', 'memory:read', 'memory:write', 'observability:read'],
  viewer: ['world:read', 'memory:read', 'observability:read'],
};

export const ROLE_NICKNAME: Record<AdminRole, string> = {
  admin: '平台管理员',
  operator: '世界运营',
  viewer: '只读观察员',
};

export function isAdminRole(v: unknown): v is AdminRole {
  return typeof v === 'string' && (ADMIN_ROLES as readonly string[]).includes(v);
}

/** 通配超权（*:*:*）语义与前端 hasPerms 一致 */
export function hasPerm(perms: readonly string[], code: string): boolean {
  return perms.includes('*:*:*') || perms.includes(code);
}

/** 角色 → 登录响应/会话用的权限数组（新数组，防外部改内部常量） */
export function permissionsOfRole(role: AdminRole): string[] {
  return [...ROLE_PERMISSIONS[role]];
}
