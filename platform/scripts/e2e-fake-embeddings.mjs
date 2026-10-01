/* E2E 脚本化 OpenAI 兼容 /embeddings 上游：确定性向量（仅本地测试用）
   向量由文本哈希派生（同文本同向量、异文本异向量），维度可经 argv 指定。 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 18901);
const dim = Number(process.argv[3] ?? 8);

function embedOne(text) {
  const v = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) + i) % dim] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => Number((x / norm).toFixed(6)));
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
    const input = Array.isArray(body.input) ? body.input : [String(body.input ?? "")];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: input.map((t, index) => ({ index, embedding: embedOne(String(t)) })),
      model: body.model,
      usage: { prompt_tokens: 0, total_tokens: 0 }
    }));
  });
});
server.listen(port, "127.0.0.1", () =>
  console.log(`scripted embeddings on http://127.0.0.1:${port} (dim=${dim})`)
);
