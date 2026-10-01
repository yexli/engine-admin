/* ============================================================
   Task 4 测试：Model Control Plane 前端客户端与草稿变换
   ------------------------------------------------------------
   用脚本化控制面 HTTP 服务器验证：保存带 If-Match、409 冲突、
   凭证写请求形状、探测失败折叠为 ok:false 结果（不抛异常）；
   纯函数：removeModelDeep / removeProviderDeep / clientValidate。

   运行方式（复用 platform 已安装的 vitest，零新增依赖）：
     cd admin-web && ../platform/node_modules/.bin/vitest run tests/
   ============================================================ */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  modelControlApi,
  setControlApiBase,
  ControlApiError,
  removeModelDeep,
  removeProviderDeep,
  clientValidate,
  emptyRoutes,
  type AdminModelConfig
} from "../src/api/modelControl";

function doc(): AdminModelConfig {
  return {
    version: 1,
    revision: 3,
    providers: [
      { id: "prov-a", name: "a", endpoint: "https://api.example.com/v1", auth: { kind: "secret", hasCredential: true }, enabled: true },
      { id: "prov-b", name: "b", endpoint: "http://127.0.0.1:9/v1", auth: { kind: "none", hasCredential: false }, enabled: false }
    ],
    models: [
      { id: "mdl-a", providerId: "prov-a", wireModel: "wire-a", tags: ["fast"], enabled: true },
      { id: "mdl-b", providerId: "prov-a", wireModel: "wire-b", tags: ["reasoning"], enabled: false },
      { id: "mdl-c", providerId: "prov-b", wireModel: "wire-c", tags: ["memory"], enabled: false }
    ],
    routes: {
      ...emptyRoutes(),
      fast: { primary: "mdl-a", fallback: "mdl-b" },
      memory: { primary: null, fallback: "mdl-c" }
    }
  };
}

interface ScriptState {
  ifMatchRequired: number;
  putResponse: { status: number; body: unknown };
  credentialRequests: Array<{ id: string; body: any }>;
  testOutcome: { status: number; body: unknown };
  requests: Array<{ method: string; path: string; ifMatch?: string }>;
}

let server: Server;
let baseUrl = "";

beforeEach(async () => {
  const state: ScriptState = {
    ifMatchRequired: 3,
    putResponse: { status: 200, body: { revision: 4 } },
    credentialRequests: [],
    testOutcome: { status: 200, body: { ok: true, modelId: "mdl-a", elapsedMs: 12, reply: "pong" } },
    requests: []
  };
  (globalThis as any).__scriptState = state;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s = (globalThis as any).__scriptState as ScriptState;
      const raw = Buffer.concat(chunks).toString("utf8");
      s.requests.push({ method: req.method ?? "", path: req.url ?? "", ifMatch: req.headers["if-match"] as string | undefined });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/v1/admin/model-config" && req.method === "GET") {
        return json(200, doc());
      }
      if (req.url === "/v1/admin/model-config" && req.method === "PUT") {
        if (req.headers["if-match"] !== String(s.ifMatchRequired)) {
          return json(409, { error: { code: "revision_conflict", message: "revision 冲突" } });
        }
        return json(s.putResponse.status, s.putResponse.body);
      }
      if (req.url?.startsWith("/v1/admin/providers/") && req.method === "PUT") {
        const id = decodeURIComponent(req.url.split("/")[4] ?? "");
        s.credentialRequests.push({ id, body: JSON.parse(raw) });
        return json(200, { revision: 5, hasCredential: true });
      }
      if (req.url?.includes("/test") && req.method === "POST") {
        return json(s.testOutcome.status, s.testOutcome.body);
      }
      json(404, { error: { code: "not_found", message: "no route" } });
    });
  });
  await new Promise<void>(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1/admin`;
      resolve();
    });
  });
  setControlApiBase(baseUrl);
});

afterEach(async () => {
  setControlApiBase("/control-api/v1/admin");
  await new Promise<void>(r => server.close(() => r()));
});

describe("modelControlApi（前端控制面客户端）", () => {
  it("putConfig 携带 If-Match 与完整文档；成功返回新 revision", async () => {
    const out = await modelControlApi.putConfig(doc(), 3);
    expect(out).toEqual({ revision: 4 });

    const s = (globalThis as any).__scriptState as ScriptState;
    const put = s.requests.find(r => r.method === "PUT" && r.path === "/v1/admin/model-config");
    expect(put?.ifMatch).toBe("3");
  });

  it("revision 冲突 → ControlApiError(status=409, code=revision_conflict)", async () => {
    try {
      await modelControlApi.putConfig(doc(), 2);
      expect.unreachable("应当抛出 409");
    } catch (e) {
      expect(e).toBeInstanceOf(ControlApiError);
      expect((e as ControlApiError).status).toBe(409);
      expect((e as ControlApiError).code).toBe("revision_conflict");
    }
  });

  it("putCredential 发送 {value} 且不携带任何令牌头", async () => {
    const out = await modelControlApi.putCredential("prov-a", "test-value");
    expect(out).toEqual({ revision: 5, hasCredential: true });

    const s = (globalThis as any).__scriptState as ScriptState;
    expect(s.credentialRequests[0].id).toBe("prov-a");
    expect(Object.keys(s.credentialRequests[0].body)).toEqual(["value"]);
  });

  it("testModel：成功原样返回；非 2xx 探测失败折叠为 ok:false（不抛）", async () => {
    const ok = await modelControlApi.testModel("mdl-a");
    expect(ok.ok).toBe(true);
    expect(ok.reply).toBe("pong");

    const s = (globalThis as any).__scriptState as ScriptState;
    s.testOutcome = {
      status: 502,
      body: { ok: false, modelId: "mdl-a", elapsedMs: 30, error: { code: "upstream_test_failed", message: "上游失败（已脱敏）" } }
    };
    const fail = await modelControlApi.testModel("mdl-a");
    expect(fail.ok).toBe(false);
    expect(fail.error?.code).toBe("upstream_test_failed");
    expect(fail.elapsedMs).toBe(30);
  });
});

describe("草稿变换（纯函数）", () => {
  it("removeModelDeep：删模型并清空指向它的两个路由槽位", () => {
    const d = doc();
    removeModelDeep(d, "mdl-a");
    expect(d.models.map(m => m.id)).toEqual(["mdl-b", "mdl-c"]);
    expect(d.routes.fast.primary).toBeNull();
    expect(d.routes.fast.fallback).toBe("mdl-b");
  });

  it("removeProviderDeep：连带删除供应商全部模型并清空相关路由", () => {
    const d = doc();
    removeProviderDeep(d, "prov-a");
    expect(d.providers.map(p => p.id)).toEqual(["prov-b"]);
    expect(d.models.map(m => m.id)).toEqual(["mdl-c"]);
    expect(d.routes.fast).toEqual({ primary: null, fallback: null });
  });

  it("clientValidate：重复 ID / 悬挂引用 / 启用不一致被拦截", () => {
    expect(clientValidate(doc())).toEqual([]);

    const dup = doc();
    dup.models.push({ id: "mdl-a", providerId: "prov-a", wireModel: "x", tags: ["fast"], enabled: false });
    expect(clientValidate(dup).join()).toContain("模型 ID 重复");

    const dangling = doc();
    dangling.routes.roleplay!.primary = "mdl-ghost";
    expect(clientValidate(dangling).join()).toContain("mdl-ghost");

    const inconsistent = doc();
    inconsistent.providers.find(p => p.id === "prov-a")!.enabled = false;
    expect(clientValidate(inconsistent).join()).toContain("供应商处于禁用状态");
  });
});
