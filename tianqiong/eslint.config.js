// ESLint 扁平配置：常规 TS/React 规则 + 架构分层守卫（依赖方向强制）
// 分层原则（《开发技术栈.md》§16 + 《插件化世界模拟架构方案》§3/§21/§40）：
//   types ← data ← [ world | events | actions | dice | validation | plugins | execution | systems ] ← ai/repo ← store ← ui
//   引擎层（引擎=世界规则权威）禁止依赖 React/Zustand/UI；
//   ui 禁止被引擎层依赖；内容权威层（types/data）零依赖。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/** 引擎层目录（原 src/core 按 §40 拆分为世界基础设施 + 系统插件） */
const ENGINE_DIRS = ['world', 'events', 'actions', 'dice', 'validation', 'plugins', 'execution', 'systems', 'memory'];
const engineFiles = ENGINE_DIRS.map((d) => `src/${d}/**/*.ts`);
const engineSpecifiers = ENGINE_DIRS.flatMap((d) => [`@/${d}`, `@/${d}/*`, `@/${d}/**`]);
/* 写入路径守卫的范围：ENGINE_DIRS 去掉 world —— world/ 是写入层自身的实现处
   （WorldState 容器 / WorldMutate 原语 / WorldAPI 门面），也是天气与时间的既有
   写入点（WorldClock 是 s.weather 的唯一作者）。对它设「不许直接写状态」属自指约束，
   且会逼出 WorldClock → WorldMutate → WorldClock 的环。 */
const guardFiles = ENGINE_DIRS.filter((d) => d !== 'world').map((d) => `src/${d}/**/*.ts`);
/* 表现层依赖的两种写法都要拦：只列 @/ 别名的话，'../../ui/X' 这类相对路径能整体绕过分层守卫
   （探针实证：systems 下 import '../ui/StarField' 与 '../store/useGame' 零报错，
   换成 '@/ui/StarField' 才报 no-restricted-imports）。 */
const presentationSpecifiers = [
  '@/ui',
  '@/ui/*',
  '@/ui/**',
  '@/store',
  '@/store/*',
  '@/store/**',
  '**/ui/**',
  '**/store/**',
];

const noUiDeps = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        { group: ['react', 'react-dom', 'react/*'], message: '引擎层禁止依赖 React（世界规则必须可在无 UI 环境运行）。' },
        { group: ['zustand'], message: '引擎层禁止依赖 Zustand（权威状态在 world/WorldState）。' },
        { group: presentationSpecifiers, message: '引擎层禁止反向依赖表现层/store。' },
      ],
    },
  ],
};

export default tseslint.config(
  /* outputs/ 是验证产物目录（.gitignore 同样忽略它）：截图、运行日志、一次性复测脚本
     都落在那里，跑完即弃，不该按产品代码的规则来查。 */
  { ignores: ['dist/**', '.server-build/**', 'node_modules/**', 'src-tauri/target/**', 'src-tauri/gen/**', '.npm-cache/**', 'outputs/**', '.trash/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      'no-var': 'error',
      // 中文文案与原型 1:1 保真，全角空格（U+3000）是刻意排版，不是笔误
      'no-irregular-whitespace': 'off',
    },
  },
  {
    name: 'scripts-node',
    files: ['scripts/**/*.mjs', 'scripts/**/*.cjs'],
    languageOptions: {
      /* 扫描脚本用 CJS（.cjs）：require / module / __dirname 要一起放行 */
      globals: {
        process: 'readonly',
        console: 'readonly',
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        /* Node 18+ 的全局：脚本在 Node 侧直连 OpenAI 兼容端点时要用
           （项目早期的脚本没有这个需求，所以当时没声明） */
        fetch: 'readonly',
        AbortSignal: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        /* page.evaluate() 的回调在浏览器上下文执行——同一份脚本里两个世界的全局并存，
           不声明就被 no-undef 当成笔误（先例：verify-shards 的 Storage / getComputedStyle）。 */
        getComputedStyle: 'readonly',
        innerWidth: 'readonly',
        Event: 'readonly',
        MutationObserver: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        performance: 'readonly',
        PerformanceObserver: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    name: 'arch-engine',
    files: engineFiles,
    rules: noUiDeps,
  },
  {
    /* 外部连接层（src/world-engine，脱离内置引擎方案 Phase 1）：
       天穹 → 外部 World Engine 的唯一通道。纪律与引擎层相同——
       无 React/Zustand/UI/store 依赖，且不得 import 本地游戏引擎层
       （它镜像的是外部世界的协议，不是本地世界的状态）。 */
    name: 'arch-external-client',
    files: ['src/world-engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-dom', 'react/*'], message: '连接层禁止依赖 React（它必须能在无 UI 环境运行）。' },
            { group: ['zustand'], message: '连接层禁止依赖 Zustand（镜像在 cache/worldCache，不进 store）。' },
            { group: presentationSpecifiers, message: '连接层禁止反向依赖表现层/store。' },
            { group: engineSpecifiers, message: '连接层不得依赖本地游戏引擎层——外部世界的真相只来自 HTTP/WS 协议。' },
          ],
        },
      ],
    },
  },
  {
    name: 'arch-ai',
    files: ['src/ai/**/*.ts'],
    rules: {
      ...noUiDeps.rules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-dom', 'react/*', 'zustand', ...presentationSpecifiers, '@/repo/*', '@/repo/**'], message: 'AI 层只读世界书与 WorldState，禁止依赖 UI/表现/存储。' },
          ],
        },
      ],
    },
  },
  {
    name: 'arch-repo',
    files: ['src/repo/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-dom', 'react/*', 'zustand', ...presentationSpecifiers, '@/ai', '@/ai/*', '@/ai/**'], message: 'Repository 层只做持久化适配，不依赖 UI/AI。' },
          ],
        },
      ],
    },
  },
  {
    /* 运行日志是引擎侧的观测通道：任何层都可以往里写，它自己必须零依赖 */
    name: 'arch-devlog',
    files: ['src/devlog/**/*.ts', 'src/devlog/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              /* 相对路径也要堵：'../../ui/x' 这种绕法同样会把观测通道焊进表现层 */
              group: ['../**', '..', 'react', 'react-dom', 'react/*', 'zustand', ...presentationSpecifiers, ...engineSpecifiers, '@/data', '@/data/*', '@/repo', '@/repo/*'],
              message: '运行日志不得依赖任何层（世界快照由装配方注入），否则会把观测通道焊进被观测的对象。',
            },
          ],
        },
      ],
    },
  },
  {
    /* 状态写入路径守卫：世界状态的字段改动必须经 world/mutate（唯一写入实现点）。
       为什么用 lint 而不是测试：写错状态时，行为测试只会看到「结果不对」，
       看不到「路径不对」——路径约束没有别的机器可表达方式。
       已排除 mutate 自身（它就是实现点）与 core 容器本身。 */
    name: 'arch-state-write',
    files: guardFiles,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "AssignmentExpression > MemberExpression.left[object.object.name='s'][object.property.name='player']",
          message: '世界状态写入必须经 world/mutate：s.player.* 的直接赋值会绕过唯一写入层。',
        },
        {
          selector: "AssignmentExpression > MemberExpression.left[object.object.name='s'][object.property.name='rep']",
          message: '世界状态写入必须经 world/mutate：s.rep[...] 的直接赋值会绕过唯一写入层。',
        },
        {
          selector: "AssignmentExpression > MemberExpression.left[object.name='s'][property.name=/^(logSeq|weather|log)$/]",
          message: '世界状态写入必须经 world/mutate：直接赋值会绕过唯一写入层。',
        },
        /* —— 两条补上原有选择器的盲道（审查 §守卫盲区）——
           上面的选择器只认「静态属性名」和「赋值表达式」，于是两类写入长期逃逸：
             · s.player.flags['x'] = true（计算属性，多一层成员）
             · s.player.crimes++（自增/自减是 UpdateExpression，不是 AssignmentExpression）
           补选择器之前先把存量收编进了 mutate（flags 7 处、crimes 2 处、npc.met 2 处），
           所以这两条一开就是干净的——先有入口，再上锁。 */
        {
          selector:
            "AssignmentExpression > MemberExpression.left[object.object.object.name='s'][object.property.name='flags']",
          message: '世界状态写入必须经 world/mutate：s.player.flags[...] 的直接赋值会绕过唯一写入层（用 mutate.playerFlag）。',
        },
        {
          selector: "UpdateExpression > MemberExpression[object.object.name='s'][object.property.name='player']",
          message: '世界状态写入必须经 world/mutate：s.player.* 的自增/自减会绕过唯一写入层（用 mutate.playerNum）。',
        },
      ],
    },
  },
  {
    name: 'arch-data',
    files: ['src/data/**/*.ts', 'src/types/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: [...engineSpecifiers, ...presentationSpecifiers, 'react', 'zustand'], message: '世界书与类型层必须零依赖（内容权威层）。' },
          ],
        },
      ],
    },
  },
  prettier,
);
