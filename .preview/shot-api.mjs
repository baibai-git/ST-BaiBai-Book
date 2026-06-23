import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.map':'application/json' };
const server = createServer(async (req,res)=>{try{const u=decodeURIComponent(req.url.split('?')[0]);const f=path.join(ROOT,u==='/'?'.preview/harness.html':u);const d=await readFile(f);res.writeHead(200,{'Content-Type':MIME[path.extname(f)]??'application/octet-stream'});res.end(d);}catch{res.writeHead(404).end('x');}});
await new Promise(r=>server.listen(0,r));
const base=`http://localhost:${server.address().port}/.preview/harness.html`;
const b=await chromium.launch();
const ctx=await b.newContext({viewport:{width:1280,height:900},deviceScaleFactor:2});
const p=await ctx.newPage();
await p.goto(base,{waitUntil:'networkidle'});
const SR=`document.getElementById('bbs-app-host').shadowRoot`;
await p.waitForFunction(`${SR} && ${SR}.querySelector('.bbs-window')`,{timeout:5000});
// 去设置页
await p.evaluate(()=>{const sr=document.getElementById('bbs-app-host').shadowRoot;sr.querySelectorAll('.bbs-nav-item')[3].click();});
await p.waitForTimeout(600);
// 展开副API,添加一个渠道
const expanded = await p.evaluate(()=>{
  const sr=document.getElementById('bbs-app-host').shadowRoot;
  const heads=[...sr.querySelectorAll('.bbs-collapsible-head')];
  const api=heads.find(h=>h.textContent.includes('API'));
  if(api){ api.click(); return api.textContent.trim(); }
  return 'NOT FOUND: ' + heads.map(h=>h.textContent.trim()).join(' | ');
});
console.log('expanded:', expanded);
await p.waitForTimeout(600);
await p.evaluate(()=>{
  const sr=document.getElementById('bbs-app-host').shadowRoot;
  const btns=[...sr.querySelectorAll('.bbs-btn')];
  const add=btns.find(b=>b.textContent.includes('添加渠道'));
  if(add) add.click();
});
await p.waitForTimeout(300);
// 点拉取模型
await p.evaluate(()=>{
  const sr=document.getElementById('bbs-app-host').shadowRoot;
  const refresh=[...sr.querySelectorAll('.bbs-icon-mini')].find(b=>b.title && b.title.includes('拉取'));
  if(refresh) refresh.click();
});
await p.waitForTimeout(500);
await p.screenshot({path:path.join(__dirname,'shot-desktop-day-api.png')});
await b.close();server.close();
console.log('done');
