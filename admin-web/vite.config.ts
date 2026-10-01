import { getPluginsList } from "./build/plugins";
import { include, exclude } from "./build/optimize";
import { type UserConfigExport, type ConfigEnv, loadEnv } from "vite";
import {
  root,
  alias,
  wrapperEnv,
  pathResolve,
  __APP_INFO__
} from "./build/utils";

export default ({ mode }: ConfigEnv): UserConfigExport => {
  const { VITE_CDN, VITE_PORT, VITE_COMPRESSION, VITE_PUBLIC_PATH } =
    wrapperEnv(loadEnv(mode, root));
  const env = loadEnv(mode, root);
  return {
    base: VITE_PUBLIC_PATH,
    root,
    resolve: {
      alias
    },
    // 服务端渲染
    server: {
      // 端口号
      port: VITE_PORT,
      // 仅回环：Model Control Plane 工作流要求管理面不做局域网暴露
      host: process.env.VITE_DEV_HOST ?? "127.0.0.1",
      // 本地跨域代理 https://cn.vitejs.dev/config/server-options.html#server-proxy
      proxy: {
        // World Engine HTTP API（规则见 world-engine/src/http/protocol.ts）
        // ws: true —— G3 实时事件流（/world-api/v1/stream 等 Upgrade 请求同源代理）
        "/world-api": {
          target: env.VITE_WORLD_API_URL ?? "http://127.0.0.1:8787",
          changeOrigin: true,
          ws: true,
          rewrite: p => p.replace(/^\/world-api/, "")
        },
        // World Memory HTTP API（M1.1：适配层见 world-engine/memory/src/http/protocol.ts）
        "/memory-api": {
          target: env.VITE_MEMORY_API_URL ?? "http://127.0.0.1:8789",
          changeOrigin: true,
          rewrite: p => p.replace(/^\/memory-api/, "")
        },
        // AI Gateway HTTP API
        "/gateway-api": {
          target: env.VITE_GATEWAY_API_URL ?? "http://127.0.0.1:8788",
          changeOrigin: true,
          rewrite: p => p.replace(/^\/gateway-api/, "")
        },
        // Model Control Plane 私有管理面（真实 API，见 src/api/modelControl.ts）：
        // 改写到受管 Platform 的 loopback 管理监听，并在【服务端】注入管理令牌。
        // 令牌只从本进程环境变量读取（PLATFORM_ADMIN_TOKEN），绝不使用 VITE_* 前缀、
        // 不进前端产物、不下发浏览器。
        // M3 起会话感知：浏览器带 x-admin-session（登录会话）时不再注入主令牌，
        // 服务端按会话角色做权限强制；无会话的运维请求（curl/脚本）仍走主令牌。
        "/control-api": {
          target: process.env.PLATFORM_ADMIN_TARGET ?? "http://127.0.0.1:8791",
          changeOrigin: true,
          rewrite: p => p.replace(/^\/control-api/, ""),
          configure: proxy => {
            proxy.on("proxyReq", (proxyReq, req) => {
              if (req.headers["x-admin-session"]) {
                proxyReq.removeHeader("x-admin-token");
              } else if (process.env.PLATFORM_ADMIN_TOKEN) {
                proxyReq.setHeader(
                  "x-admin-token",
                  process.env.PLATFORM_ADMIN_TOKEN
                );
              }
            });
          }
        }
      },
      // 预热文件以提前转换和缓存结果，降低启动期间的初始页面加载时长并防止转换瀑布
      warmup: {
        clientFiles: ["./index.html", "./src/{views,components}/*"]
      }
    },
    plugins: getPluginsList(VITE_CDN, VITE_COMPRESSION),
    // https://cn.vitejs.dev/config/dep-optimization-options.html#dep-optimization-options
    optimizeDeps: {
      include,
      exclude
    },
    build: {
      // https://cn.vitejs.dev/guide/build.html#browser-compatibility
      target: "es2015",
      sourcemap: false,
      // 消除打包大小超过500kb警告
      chunkSizeWarningLimit: 4000,
      rollupOptions: {
        input: {
          index: pathResolve("./index.html", import.meta.url)
        },
        // 静态资源分类打包
        output: {
          chunkFileNames: "static/js/[name]-[hash].js",
          entryFileNames: "static/js/[name]-[hash].js",
          assetFileNames: "static/[ext]/[name]-[hash].[ext]"
        }
      }
    },
    define: {
      __INTLIFY_PROD_DEVTOOLS__: false,
      __APP_INFO__: JSON.stringify(__APP_INFO__)
    }
  };
};
