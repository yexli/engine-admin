/* G1 软暂停/恢复/关闭（1.0.3）：协议适配器纯路由测试
   语义裁定见 docs/G1-PAUSE-DESIGN-REVIEW.md：
   · 暂停中 commands/time → 409 world_paused；读照常；
   · 重复暂停 / 未暂停恢复 → 409；
   · 关闭 = 注册表摘除（V0.9 既有 close）；单世界模式关闭 → 409；
   · WorldInfo.status 入清单；暂停/恢复不写 updatedAt。 */
import { describe, expect, it } from 'vitest';
import { createWorld, createWorldRegistry } from '../src/index';
import { createWorldHttp, type HttpRequest } from '../src/http/index';

const req = (method: string, path: string, body?: unknown): HttpRequest => ({ method, path, body });

function registryHttp() {
  const registry = createWorldRegistry();
  const http = createWorldHttp({ registry });
  return { registry, http };
}

describe('G1 · 世界暂停 / 恢复 / 关闭', () => {
  it('暂停：status=paused 入清单；commands/time 409 world_paused；读操作照常；重复暂停 409', async () => {
    const { http } = registryHttp();
    await http.handle(req('POST', '/v1/worlds', { worldId: 'w-a' }));
    await http.handle(req('POST', '/v1/worlds/w-a/time', { ticks: 3 }));

    const paused = await http.handle(req('POST', '/v1/worlds/w-a/pause'));
    expect(paused.status).toBe(200);
    expect((paused.body as { status: string }).status).toBe('paused');

    const list = await http.handle(req('GET', '/v1/worlds'));
    const row = (list.body as { worlds: { worldId: string; status?: string }[] }).worlds.find((w) => w.worldId === 'w-a');
    expect(row?.status).toBe('paused');

    const cmd = await http.handle(req('POST', '/v1/worlds/w-a/commands', { type: 'move', targetId: 'market' }));
    expect(cmd.status).toBe(409);
    expect((cmd.body as { code?: string }).code).toBe('world_paused');

    const time = await http.handle(req('POST', '/v1/worlds/w-a/time', { ticks: 5 }));
    expect(time.status).toBe(409);
    expect((time.body as { code?: string }).code).toBe('world_paused');

    /* 读操作不受影响 */
    expect((await http.handle(req('GET', '/v1/worlds/w-a/state'))).status).toBe(200);
    expect((await http.handle(req('GET', '/v1/worlds/w-a/events'))).status).toBe(200);
    expect((await http.handle(req('GET', '/v1/worlds/w-a/scheduler'))).status).toBe(200);

    const again = await http.handle(req('POST', '/v1/worlds/w-a/pause'));
    expect(again.status).toBe(409);
    expect((again.body as { error: string }).error).toContain('already paused');
  });

  it('恢复：命令/推进照常；未暂停时恢复 409；暂停/恢复不写 updatedAt', async () => {
    const { http } = registryHttp();
    await http.handle(req('POST', '/v1/worlds', { worldId: 'w-b' }));

    const early = await http.handle(req('POST', '/v1/worlds/w-b/resume'));
    expect(early.status).toBe(409);
    expect((early.body as { error: string }).error).toContain('not paused');

    const beforeInfo = (await http.handle(req('GET', '/v1/worlds/w-b'))).body as { updatedAt?: string };
    await http.handle(req('POST', '/v1/worlds/w-b/pause'));
    const resumed = await http.handle(req('POST', '/v1/worlds/w-b/resume'));
    expect(resumed.status).toBe(200);
    expect((resumed.body as { status: string }).status).toBe('running');

    const afterInfo = (await http.handle(req('GET', '/v1/worlds/w-b'))).body as { updatedAt?: string };
    expect(afterInfo.updatedAt).toBe(beforeInfo.updatedAt); /* 运营动作不冒充世界推进 */

    const cmd = await http.handle(req('POST', '/v1/worlds/w-b/commands', { type: 'move', targetId: 'market' }));
    expect(cmd.status).toBe(200);
    expect((cmd.body as { ok: boolean }).ok).toBe(true);
  });

  it('关闭：注册表摘除（清单消失、访问 404）；暂停标记一并清除；单世界模式关闭 409', async () => {
    const registry = createWorldRegistry();
    const http = createWorldHttp({ registry });
    await http.handle(req('POST', '/v1/worlds', { worldId: 'w-c' }));
    await http.handle(req('POST', '/v1/worlds/w-c/pause'));

    const closed = await http.handle(req('DELETE', '/v1/worlds/w-c'));
    expect(closed.status).toBe(200);
    expect((closed.body as { closed: boolean }).closed).toBe(true);
    expect(registry.get('w-c')).toBeNull();

    const list = await http.handle(req('GET', '/v1/worlds'));
    expect((list.body as { worlds: unknown[] }).worlds).toHaveLength(0);
    expect((await http.handle(req('GET', '/v1/worlds/w-c'))).status).toBe(404);
    expect((await http.handle(req('POST', '/v1/worlds/w-c/commands', { type: 'move' }))).status).toBe(404);

    /* 同一注册表重建同名世界 → 全新 running 世界（暂停标记未残留） */
    await http.handle(req('POST', '/v1/worlds', { worldId: 'w-c' }));
    const info = (await http.handle(req('GET', '/v1/worlds/w-c'))).body as { status?: string };
    expect(info.status).toBe('running');

    /* 单世界模式：关闭不支持 */
    const single = createWorld({ worldId: 'w-single' });
    const singleHttp = createWorldHttp({ world: single });
    const denied = await singleHttp.handle(req('DELETE', '/v1/worlds/w-single'));
    expect(denied.status).toBe(409);
    expect((denied.body as { error: string }).error).toContain('registry mode');
  });
});
