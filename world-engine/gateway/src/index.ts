/* ============================================================
   world-gateway · 公共出口（V0.5 · 方案 §65 AI Cloud Layer）
   OpenAI 兼容网关：协议形状是「OpenAI 兼容」，能力是世界游戏注册的
   AI 提供方——网关不认识任何厂商 SDK（§66），也不触碰世界状态（§45）。
   ============================================================ */
export { createGateway, sseFrame } from './protocol.ts';
export type { GatewayRequest, GatewayResponse, GatewayInit, StreamIo } from './protocol.ts';
export { ProviderRegistry } from './provider.ts';
export type { GatewayProvider, ProviderMessage, RegisteredModel } from './provider.ts';
export { startGatewayServer } from './server.ts';
export type { GatewayServer, GatewayServerOptions } from './server.ts';
export {
  createModelRouter,
  parseRouteConfig,
  RouteConfigError,
  CAPABILITY_TAGS,
  STANDARD_ROUTES,
} from './router.ts';
export type {
  CapabilityTag,
  ApiKeyRef,
  ModelRef,
  RoleRoute,
  RouteConfig,
  RouteDecisionTrace,
  ModelRouter,
  RouterOptions,
} from './router.ts';
export { remoteChat, remoteChatStream, remoteEmbeddings, RemoteModelError } from './remote.ts';
export type { RemoteChatResult } from './remote.ts';
export { routedProvider, routedModels } from './routedProvider.ts';
export type { RoutedProviderOptions } from './routedProvider.ts';
export { createPipeline, parsePipelineSpec, PipelineSpecError } from './pipeline.ts';
export type { PipelineSpec, PipelineNodeSpec, PipelineResult, NodeTrace, PipelineOptions } from './pipeline.ts';
export {
  parseChatCompletionRequest,
  chatCompletionResponse,
  deltaChunk,
  stopChunk,
  modelsResponse,
  parseEmbeddingsRequest,
  embeddingsResponse,
} from './wire.ts';
export type {
  WireRole,
  WireMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ModelInfo,
  EmbeddingsResponse,
} from './wire.ts';
