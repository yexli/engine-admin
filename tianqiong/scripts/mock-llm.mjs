import { createServer } from 'node:http';
/* 假 OpenAI 兼容端点：只为复现"编织有没有真正发出去"。
   必须带 CORS 头——页面在 5273，端点在 8931，缺了它就是 net::ERR_FAILED，
   而那一类失败在浏览器里长得跟"模型挂了"一模一样。 */
let n = 0;
const srv = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    n++;
    let msgs = [];
    try { msgs = JSON.parse(body || '{}').messages || []; } catch { /* 请求体不是 JSON：当成空消息列表 */ }
    const last = String(msgs[msgs.length - 1]?.content || '').replace(/\s+/g, ' ').slice(0, 80);
    console.log('REQ#' + n + ' msgs=' + msgs.length + ' | ' + last);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '【MOCK 织好的第 ' + n + ' 段】' } }] }));
  });
});
srv.listen(8931, '127.0.0.1', () => console.log('mock llm ready on 8931 (cors on)'));
