import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, url === '/' ? '.preview/harness.html' : url);
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}/.preview/harness.html`;

const browser = await chromium.launch();
// 真·移动设备配置:hasTouch + isMobile,触发 touch→click 合成
const iPhone = devices['iPhone 13'];
const ctx = await browser.newContext({ ...iPhone });
const page = await ctx.newPage();

// 用我们自己的 harness 但不自动打开(去掉 auto open)——直接 tap 菜单项,模拟真实手指
await page.goto(base.replace('harness.html', 'harness-manual.html'), { waitUntil: 'networkidle' });

await page.waitForSelector('#bbs-menu-item', { timeout: 5000 });

// 真实触摸点击菜单项(会产生 touchstart/end + 合成 mouse/click)
await page.tap('#bbs-menu-item');

// 等过了 350ms 守卫窗 + 动画
await page.waitForTimeout(700);

const open = await page.evaluate(() => !!document.querySelector('.bbs-window'));
console.log(open ? 'PASS: 窗口在触摸点击后保持打开' : 'FAIL: 窗口被秒关');

// 再测:点遮罩应能关闭
if (open) {
  await page.tap('.bbs-overlay', { position: { x: 10, y: 10 } });
  await page.waitForTimeout(500);
  const stillOpen = await page.evaluate(() => !!document.querySelector('.bbs-window'));
  console.log(!stillOpen ? 'PASS: 点遮罩可正常关闭' : 'FAIL: 点遮罩未关闭');
}

await browser.close();
server.close();
