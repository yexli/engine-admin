/* ============================================================
   管理面错误类型（Model Control Plane 共用）
   ============================================================ */

/** 配置/密钥文件损坏、形状不识别——拒绝服务而非静默回退 */
export class ConfigCorruptError extends Error {}

/** If-Match revision 不匹配（并发写冲突） */
export class RevisionConflictError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`revision 冲突：请求基于 ${expected}，当前已是 ${actual}；请刷新后重试`);
  }
}

/** 候选配置未通过校验（issues 为逐条原因，可直呈 UI） */
export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`配置校验失败：${issues.join('；')}`);
  }
}
