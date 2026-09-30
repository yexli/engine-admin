/* ============================================================
   routedProvider：把 Model Router 桥接成网关提供方（V0.6）
   ------------------------------------------------------------
   组合 V0.5 与 V0.6：路由器为每个角色选远端模型，包装成
   GatewayProvider 挂进 startGatewayServer——于是 OpenAI 客户端选
   model='narrative'，网关经路由器命中带 narrative 标签的远端端点。
   失败语义照旧：远端错误如实 503/错误帧，不假装修好。
   ============================================================ */
import type { GatewayProvider, ProviderMessage } from './provider.ts';
import type { ModelRouter } from './router.ts';
import { remoteChat, remoteChatStream, remoteEmbeddings } from './remote.ts';

export interface RoutedProviderOptions {
  /** 出站超时（毫秒）：complete 缺省 60s，stream 缺省 120s */
  timeoutMs?: { complete?: number; stream?: number };
}

/** 暴露路由器可服务的角色清单（= 客户端看到的「模型名」，§65 角色即通道） */
export function routedModels(router: ModelRouter): string[] {
  return router.roles();
}

export function routedProvider(router: ModelRouter, opts: RoutedProviderOptions = {}): GatewayProvider {
  const toProviderMessages = (messages: readonly ProviderMessage[]): ProviderMessage[] =>
    messages.map((m) => ({ role: m.role, content: m.content }));

  return {
    owner: 'model-router',
    models: routedModels(router),

    async complete(model, messages) {
      const hit = router.route(model);
      if (!hit) return null;
      const out = await remoteChat(hit.model, hit.apiKey, toProviderMessages(messages), {
        timeoutMs: opts.timeoutMs?.complete,
      });
      return out.text;
    },

    async completeStream(model, messages, onDelta) {
      const hit = router.route(model);
      if (!hit) throw new Error(`通道 '${model}' 没有可用路由`);
      await remoteChatStream(hit.model, hit.apiKey, toProviderMessages(messages), onDelta, {
        timeoutMs: opts.timeoutMs?.stream,
      });
    },

    async embed(model, input) {
      const hit = router.route(model);
      if (!hit) return null;
      return remoteEmbeddings(hit.model, hit.apiKey, input);
    },
  };
}
