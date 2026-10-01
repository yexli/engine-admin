/* E2E 脚本化 OpenAI 兼容上游：固定回复 + 请求留痕（仅本地测试用） */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 18900);
const reply = process.argv[3] ?? "（脚本上游回复）pong";
const logFile = process.argv[4] ?? "";
const seen = [];

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
    const auth = req.headers.authorization ?? "(none)";
    seen.push({ path: req.url, model: body.model, auth: auth.slice(0, 24) });
    if (logFile) writeFileSync(logFile, JSON.stringify(seen, null, 2));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: `${reply} [wire=${body.model}]` } }]
    }));
  });
});
server.listen(port, "127.0.0.1", () => console.log(`scripted upstream on http://127.0.0.1:${port}/v1`));
