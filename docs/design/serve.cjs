// 极简静态文件服务器 - 仅用于 demo 预览
// 用法：node serve.cjs
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const server = http.createServer((req, res) => {
  // 解析 URL，根路径指向 chapter-editor-demo.html
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/chapter-editor-demo.html';

  // 防路径遍历
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 Not Found: ${urlPath}`);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Demo 服务器已启动：`);
  console.log(`  http://127.0.0.1:${PORT}/`);
  console.log(`  http://127.0.0.1:${PORT}/chapter-editor-demo.html`);
  console.log(`按 Ctrl+C 停止`);
});
