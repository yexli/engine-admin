/* ============================================================
   截图浏览器脚本（由 shots.mjs 以子进程运行）
   环境：SHOTS_BASE_URL / SHOTS_OUT_DIR
   截取：登录页 → 登录 → Dashboard → 世界列表 → 运行时状态 → 系统状态
   ============================================================ */
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE_URL = process.env.SHOTS_BASE_URL;
const OUT_DIR = process.env.SHOTS_OUT_DIR;
mkdirSync(OUT_DIR, { recursive: true });

/** hash 导航 + 整页刷新（绕开 keep-alive 标签缓存脱钩，与 e2e 冒烟一致） */
async function gotoHash(page, hash) {
  await page.goto(`${BASE_URL}/#${hash}`);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

/* 1. 登录页 */
await page.goto(`${BASE_URL}/#/login`);
await page.reload();
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT_DIR}/01-login.png` });

/* 登录（真实管理会话） */
await page.getByRole("textbox", { name: "账号" }).fill("admin");
await page.getByRole("textbox", { name: "密码" }).fill("admin123");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForURL(/#\/(dashboard)?/, { timeout: 20_000 });
await page.waitForTimeout(2500); /* 等数据面加载（世界表/服务探测） */

/* 2. Dashboard 总览 */
await page.screenshot({ path: `${OUT_DIR}/02-dashboard.png` });

/* 3. 世界列表 */
await gotoHash(page, "/worlds/list");
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT_DIR}/03-worlds-list.png` });

/* 4. 运行时 · 状态 */
await gotoHash(page, "/runtime/state");
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT_DIR}/04-runtime-state.png` });

/* 5. 运行监控 · 事件流 */
await gotoHash(page, "/observability/events");
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT_DIR}/05-obs-events.png` });

/* 6. 系统状态 */
await gotoHash(page, "/system/status");
await page.waitForTimeout(2500); /* 等探测轮询首轮 */
await page.screenshot({ path: `${OUT_DIR}/06-system-status.png` });

await browser.close();
console.log("[shots] done");
