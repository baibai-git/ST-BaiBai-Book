import { chromium } from 'playwright';
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

// shadow root 在 #bbs-app-host 下,所有查询都要穿透它
const SR = `document.getElementById('bbs-app-host').shadowRoot`;

async function shoot(name, viewport, theme, page_id) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(`${SR} && ${SR}.querySelector('.bbs-window')`, { timeout: 5000 });
  if (theme) await page.evaluate(`${SR}.querySelector('.bbs-root').setAttribute('data-theme', '${theme}')`);
  if (page_id) {
    await page.evaluate(id => {
      const sr = document.getElementById('bbs-app-host').shadowRoot;
      const btns = [...sr.querySelectorAll('.bbs-nav-item')];
      // 顺序与 registry 一致
      const order = ['summary', 'items', 'plans', 'settings'];
      const b = btns[order.indexOf(id)];
      if (b) b.click();
    }, page_id);
  }
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(__dirname, `shot-${name}.png`) });
  await ctx.close();
  console.log('shot', name);
}

await shoot('desktop-day-summary', { width: 1280, height: 800 }, 'day', 'summary');
await shoot('desktop-night-summary', { width: 1280, height: 800 }, 'night', 'summary');
await shoot('desktop-day-items', { width: 1280, height: 800 }, 'day', 'items');
await shoot('desktop-day-plans', { width: 1280, height: 800 }, 'day', 'plans');
await shoot('desktop-day-settings', { width: 1280, height: 800 }, 'day', 'settings');
await shoot('mobile-day-summary', { width: 390, height: 780 }, 'day', 'summary');
await shoot('mobile-night-plans', { width: 390, height: 780 }, 'night', 'plans');

await browser.close();
server.close();
