/* Tauri 桌面窗口真实画面截图。
 * 关键坑：WebView2 走 GPU 合成，GDI 截屏(PrintWindow/CopyFromScreen)常抓到空帧——
 * 必须经 WebView2 远程调试端口用 CDP screencast 抓帧。
 * 启动：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" npm run tauri dev
 * 用法：node scripts/shot-tauri.mjs <outPng>
 */
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const out = process.argv[2] || 'tauri-shot.png';
const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) if ((p.url() || '').includes('5273')) page = p;
if (!page) {
  console.log('NO_PAGE（确认 tauri dev 已带调试端口启动）');
  process.exit(1);
}
const client = await page.context().newCDPSession(page);
await client.send('Page.enable');
let got = null;
client.on('Page.screencastFrame', async (f) => {
  got = f.data;
  await client.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
await page.waitForTimeout(1200);
await client.send('Page.stopScreencast');
if (!got) {
  console.log('NO_FRAME');
  process.exit(1);
}
writeFileSync(out, Buffer.from(got, 'base64'));
console.log('SAVED', out);
await b.close();
