import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/* 开发期可选的端点转发目标（见 server.proxy）。
   只读环境变量：未设置时一条规则都不注册，构建产物与本文件无关。 */
const LLM_PROXY = (process.env.TQ_LLM_PROXY ?? '').trim();

export default defineConfig({
  plugins: [react()],
  /* 世界书是 900KB 级的 JSON 模块：默认编译成对象字面量，引擎要逐字解析语法；
     走 JSON.parse 有专门的快速路径。vite 8 把它放在顶层而不是 build 下。 */
  json: { stringify: true },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      /* AI World Engine 以 npm 包形态消费（file: 依赖 → node_modules 符号链接 → dist 产物）。
         天穹经 Adapter 层（src/world、src/events 的重接文件）使用它，
         其余模块不得直接 import（分层见 eslint arch-engine）。 */
    },
  },
  server: {
    port: 5273,
    host: '127.0.0.1',
    /* 可选：把没开 CORS 的端点接到同源上。
       对方不回 Access-Control-Allow-Origin 时，浏览器会把**整个响应**丢掉，
       前端只剩一句 TypeError: Failed to fetch —— 连 401 / 403 都看不到
       （实机：某中转站的鉴权/权限错误就是如此，面板与见闻只能一起显示"调用失败"）。
       走本地代理后是同源请求，真实状态码原样回到面板与 toast。
       用法：$env:TQ_LLM_PROXY='https://api.example.com' 后再 npm run dev，
             端点那格填 http://127.0.0.1:5273/__llm/v1 。
       未设置该变量时不注册任何规则——dev server 行为与没有这段代码时相同。 */
    proxy: LLM_PROXY
      ? {
          '/__llm': {
            target: LLM_PROXY,
            changeOrigin: true,
            rewrite: (p: string) => p.replace(/^\/__llm/, ''),
          },
        }
      : undefined,
    watch: {
      // Windows 上 vite 监视器遇 EBUSY 会直接崩溃（不是重试，是退出）。已知触发源：
      //   1) cargo 编译锁住 src-tauri/target 里的 DLL；
      //   2) 文档/脚本被编辑器或 agent 原子替换（ReplaceFileW）时锁住句柄——
      //      应用从不 import docs/** 与 scripts/**，监视它们只有风险没有收益。
      // 实测：写 docs/阶段H-交付说明.md 曾把 dev server 打成 exit 1。
      /* 3) agent / 编辑器的原子替换：写文件时先落一个 .*.tmpdir/*.tmp 再改名，
             watcher 恰好在这个瞬间去 watch 那个临时文件 → EBUSY → 直接退出。
             源码目录必须监视（不像 docs/scripts），所以只能把临时文件的模式排掉。 */
      ignored: [
        '**/src-tauri/**',
        '**/dist/**',
        '**/.npm-cache/**',
        '**/docs/**',
        '**/scripts/**',
        '**/outputs/**',
        '**/*.tmpdir/**',
        '**/*.tmp',
      ],
      /* 上面的 ignored 只挡得住「临时文件名」，挡不住「目标文件本身正在被写」——
         Windows 上对写入中的文件 watch 会抛 EBUSY，而 fs.watch 是**直接退出**不是重试，
         于是 agent 每改一个源文件就可能崩一次 dev server（本项目已中招数次）。
         awaitWriteFinish 让 watcher 等文件稳定下来再处理，从根上避开这个窗口：
         代价是变更处理晚 300ms，换来的是「写文件不再打断会话」。 */
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    },
  },
  preview: {
    port: 5274,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    /* 分包：rolldown 的默认策略把「被主包与动态 chunk 同时引用」的世界书**复制**进各自 chunk
       （实测 index 673KB 与 RuleValidator 409KB 里装着同一份 tables/geo/people/items，
       两边都能搜到 wpn_forbidden_edge 与「灰纹狼」）。显式分组后世界书只留一份，
       第三方库也单独成块，便于浏览器缓存。 */
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'worldbook', test: /src[\\/]data[\\/]/ },
            { name: 'vendor', test: /node_modules/ },
          ],
        },
      },
    },
  },
});
