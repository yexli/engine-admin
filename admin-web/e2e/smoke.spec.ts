/* ============================================================
   管理后台生产构建冒烟（M5.2 · ADMIN-TEST-REPORT 建议落地）
   ------------------------------------------------------------
   流程（对 world-engine 生产构建的 vite preview 跑，非 dev server）：
     登录 → 世界详情 → 执行命令 → 修改路由（保存 revision+1）→ 回滚
   选择器约定：优先角色/文案定位；pure-admin 多标签缓存会导致 hash 直跳
   与视图脱节，故每次 hash 导航后强制 reload（与人工操作一致）。
   环境由 e2e/smoke.mjs 编排（脚本化上游 + 引擎 + 受管平台 + preview）。
   ============================================================ */
import { expect, test } from "@playwright/test";

/** hash 导航 + 整页刷新（绕开 keep-alive 标签缓存脱钩） */
async function gotoHash(page: import("@playwright/test").Page, hash: string) {
  await page.goto(`/#${hash}`);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
}

test("冒烟：登录 → 世界详情 → 执行命令 → 修改路由 → 回滚", async ({ page }) => {
  /* ---------- 登录（真实管理会话） ---------- */
  await page.goto("/#/login");
  await page.reload();
  await page.getByRole("textbox", { name: "账号" }).fill("admin");
  await page.getByRole("textbox", { name: "密码" }).fill("admin123");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveTitle(/总览/, { timeout: 20_000 });

  /* ---------- 世界详情 ---------- */
  await gotoHash(page, "/worlds/detail/w-main");
  await expect(page.getByRole("tab", { name: "状态 State" })).toBeVisible();
  await expect(page.getByText("w-main").first()).toBeVisible();

  /* ---------- 执行命令（推进时间 advance_time） ---------- */
  await gotoHash(page, "/runtime/commands");
  await page.getByText("advance_time", { exact: true }).first().click();
  await page.getByRole("spinbutton").fill("2"); /* 必填参数：刻数 */
  await page.getByRole("button", { name: "执行 Execute" }).click();
  await page.getByRole("button", { name: "确认执行" }).click();
  await expect(
    page.getByText("执行成功", { exact: true })
  ).toBeVisible({ timeout: 20_000 });

  /* ---------- 修改路由（改 快速响应 primary → 保存，revision +1） ---------- */
  await gotoHash(page, "/gateway/router");
  /* 等配置从服务端加载完成（种子化后 revision ≥ 1）再取基线 */
  await expect(page.getByText(/^revision [1-9]\d*$/)).toBeVisible({
    timeout: 20_000
  });
  const revisionText = () => page.getByText(/^revision \d+$/).innerText();
  const revBefore = Number((await revisionText()).replace("revision ", ""));

  const fastRow = page.getByRole("row", { name: /快速响应/ });
  await fastRow.locator(".el-select").first().click();
  await page
    .getByRole("option")
    .filter({ hasText: "mdl-smoke" })
    .first()
    .click();
  await page.getByRole("button", { name: "保存全部" }).click();
  await expect(page.getByText(/^revision \d+$/)).toHaveText(
    `revision ${revBefore + 1}`,
    { timeout: 20_000 }
  );

  /* ---------- 回滚（revision 再 +1，路由还原为上一版） ---------- */
  await page.getByRole("button", { name: "回滚上一版" }).click();
  await page
    .getByRole("button", { name: "回滚", exact: true })
    .last()
    .click();
  await expect(page.getByText(/^revision \d+$/)).toHaveText(
    `revision ${revBefore + 2}`,
    { timeout: 20_000 }
  );
});
