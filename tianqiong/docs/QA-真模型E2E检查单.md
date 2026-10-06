# 真模型 E2E 检查单（发布前手动 QA）

> 自动化测试全部使用假上游/ruleSim（确定性所需）。真模型的整条链
> （流式、思考字段自适应、限流重试、向量维度探测）用本检查单在发布前手动过一遍。
> 前置：一个可用的 OpenAI 兼容端点 + Key（DeepSeek 示例）。

## 1. 环境准备（PowerShell）

```powershell
$env:TIANQIONG_GAME_GATEWAY_EMBED='1'
$env:TIANQIONG_GAME_AI_UPSTREAM='https://api.deepseek.com/v1'
$env:TIANQIONG_GAME_AI_KEY_ENV='DEEPSEEK_KEY'      # $env:DEEPSEEK_KEY='sk-...'
$env:TIANQIONG_GAME_AI_WIRE='deepseek-chat'
npm run host:game
```

另开终端：`npm run dev`（session 档默认开启）。

## 2. 检查单

| # | 检查项 | 操作 | 通过标准 |
|---|---|---|---|
| 1 | 网关通道就绪 | `curl http://127.0.0.1:8788/v1/models` | 六角色清单出现（intent/npc/reasoning/narrative/memory/embedding） |
| 2 | 世界裁定 AI 真模型 | 开局后输入自由指令（如「去酒馆看看」） | 行动解析结果自然（非正则模板）；runlog extsync 显示服务端 AI 已启用 |
| 3 | 对话真模型 | 与任意 NPC 打开攀谈并发言 | 回复为模型生成（非三档规则池）；无重复 toast（M1.3 去重生效） |
| 4 | 迟到事实 | 模型回话落定瞬间观察 | 回话内容经 SSE 实时出现在聊天窗与见闻录（无需再点任何东西） |
| 5 | 流式输出 | 设置面板开启流式 → 触发场景叙事/对话 | 逐字输出；思维链字段不出现在正文 |
| 6 | 限流/失败降级 | 故意填错 Key → 保存 | toast「调用失败」但游戏照常（rule 兜底）；修正 Key 后恢复 |
| 7 | 向量记忆 | 向量端点配置后让 NPC 记住一件事，隔天追问 | 追问命中（语义检索生效）；SQLite/localStorage 的 vector 通道有写入 |
| 8 | 编织（客户端） | 配置面板填同一 Key（或走网关档）→ 做一个动作 | 见闻录出现「✦ AI」段落；刷新页面后规则原文显示（覆盖表随刷新重置，符合设计） |
| 9 | 宿主重启韧性 | 游戏中杀掉 host:game → 重启 | 客户端自动回局（快照回灌）、时间/位置一致；命令恢复裁定 |
| 10 | 幂等安全 | 网络面板观察慢命令超时后的重试 | 同一动作不重复结算（commandId 去重生效） |

## 3. 记录

- 日期 / 端点 / 模型：
- 结果（逐项 ✕✓）：
- 异常截图 / runlog 导出附件：
