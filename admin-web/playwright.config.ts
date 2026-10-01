import { defineConfig } from "@playwright/test";

/** 冒烟测试配置：由 e2e/smoke.mjs 编排器先拉起全栈再运行
 *  （playwright test 本身不启动任何服务；BASE_URL 指向 vite preview） */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1, /* 冒烟流程有先后依赖，禁止并行 */
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:18848",
    trace: "retain-on-failure"
  }
});
