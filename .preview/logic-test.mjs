// 纯逻辑测试:apply 增量语义 + JSON 提取健壮性。
// 直接内联被测纯函数的等价实现?不——我们用 esbuild 把 TS 源编译进来,避免逻辑漂移。
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const esbuildEntry = path.join(ROOT, 'node_modules/.pnpm/esbuild@0.27.7/node_modules/esbuild/lib/main.js');
const { build } = await import(pathToFileURL(esbuildEntry).href);

// 把 apply.ts 和 json.ts 各自打包成可 import 的 ESM(剥离对 store/vue 的依赖:
// applyDeltaTo 和 extractJsonObject 都是纯函数,但 apply.ts 顶部 import 了 store。
// 用 esbuild 的 external + 我们只调用纯函数 —— 仍会执行模块顶层 import。
// 简单起见:直接 bundle,store.ts 里对 getContext 的调用只在函数内,不在顶层,安全。)
// vue 垫片:测试只用普通对象,reactive 透传即可
const VUE_SHIM = path.join(__dirname, 'vue-shim.mjs');

async function load(entry) {
  const result = await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'node',
    alias: { '@': path.join(ROOT, 'src'), vue: VUE_SHIM },
  });
  const code = result.outputFiles[0].text;
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  return import(dataUrl);
}

/**
 * 把多个模块打进**同一个** bundle,让它们共享单例(apiSettings / memory)。
 * 单独 load() 每个模块会各自 bundle 一份副本,跨模块的单例不互通——
 * 测试滑动窗口/注入这类「读共享单例」的逻辑必须用这个。
 */
async function loadShared(reexports) {
  const stdin = Object.entries(reexports)
    .map(([ns, entry]) => `export * as ${ns} from '${path.join(ROOT, entry).replace(/\\/g, '/')}';`)
    .join('\n');
  const result = await build({
    stdin: { contents: stdin, resolveDir: ROOT, sourcefile: 'shared.mjs', loader: 'js' },
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'node',
    alias: { '@': path.join(ROOT, 'src'), vue: VUE_SHIM },
  });
  const code = result.outputFiles[0].text;
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  return import(dataUrl);
}

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`); }

async function main() {
  // —— 测试 extractJsonObject ——
  const { extractJsonObject } = await load('src/memory/json.ts');
  console.log('extractJsonObject:');
  eq(extractJsonObject('{"a":1}'), { a: 1 }, '纯 JSON');
  eq(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 }, '去围栏');
  eq(extractJsonObject('<think>想一下</think>{"a":2}'), { a: 2 }, '去思维链');
  eq(extractJsonObject('说明文字\n{"a":3}\n后缀'), { a: 3 }, '去前后缀');
  eq(extractJsonObject('{"a":1,}'), { a: 1 }, '尾随逗号');
  eq(extractJsonObject('{“a”:“中”}'), { a: '中' }, '智能引号');
  ok(extractJsonObject('not json') === null, '无 JSON 返回 null');

  // —— 测试 applyDeltaTo ——
  const applyMod = await load('src/memory/apply.ts');
  const { applyDeltaTo } = applyMod;
  console.log('applyDeltaTo:');

  const mem = { version: 1, state: { time: '', location: '' }, items: [], plans: [], summaries: [] };
  // 覆盖型
  applyDeltaTo(mem, { time: '第一天 早晨', location: '酒馆' }, 1000);
  eq(mem.state, { time: '第一天 早晨', location: '酒馆' }, '覆盖型写值');
  applyDeltaTo(mem, { time: '第一天 中午' }, 1001);
  eq(mem.state.time, '第一天 中午', '覆盖型更新时间');
  eq(mem.state.location, '酒馆', '未提供的覆盖字段保持不变');

  // 物品增删改
  applyDeltaTo(mem, { items: { add: [{ name: '铁剑', qty: 1 }, { name: '金币', qty: 50 }] } }, 1002);
  eq(mem.items.length, 2, '物品 add 两件');
  applyDeltaTo(mem, { items: { add: [{ name: '金币', qty: 30 }] } }, 1003);
  eq(mem.items.find(i => i.name === '金币').qty, 80, '同名物品累加数量');
  applyDeltaTo(mem, { items: { update: [{ name: '铁剑', desc: '生锈了' }] } }, 1004);
  eq(mem.items.find(i => i.name === '铁剑').desc, '生锈了', '物品 update 描述');
  applyDeltaTo(mem, { items: { remove: ['铁剑'] } }, 1005);
  ok(!mem.items.find(i => i.name === '铁剑'), '物品 remove');
  applyDeltaTo(mem, { items: { remove: ['不存在'] } }, 1006);
  eq(mem.items.length, 1, 'remove 不存在的项不报错');

  // 计划/悬念
  applyDeltaTo(mem, { plans: { add: [{ kind: 'plan', content: '找到宝藏' }, { kind: 'suspense', content: '谁是凶手' }] } }, 1007);
  eq(mem.plans.length, 2, '计划 add 两条');
  applyDeltaTo(mem, { plans: { add: [{ kind: 'plan', content: '找到宝藏' }] } }, 1008);
  eq(mem.plans.length, 2, '同内容 open 计划去重');
  // resolve by short ref:open 顺序 p1=找到宝藏, p2=谁是凶手
  applyDeltaTo(mem, { plans: { resolve: ['p1'] } }, 1009);
  eq(mem.plans.find(p => p.content === '找到宝藏').status, 'resolved', 'resolve p1 了结计划');
  eq(mem.plans.find(p => p.content === '谁是凶手').status, 'open', 'p2 仍未了结');

  // —— 测试滑动窗口逻辑(engine 纯函数)——
  // engine.ts 顶部 import 了 settings(读 localStorage,node 下 catch→defaults,keepRecent=5)、
  // client/store/inject 的调用都在函数体内,模块加载安全。
  // 共享 bundle:engine/settings/inject/store 共用同一份 apiSettings & memory 单例
  const shared = await loadShared({
    engine: 'src/memory/engine.ts',
    settings: 'src/api/settings.ts',
    inject: 'src/memory/inject.ts',
    store: 'src/memory/store.ts',
    apply: 'src/memory/apply.ts',
  });
  const { isAiFloor, resolveKeepStart, pendingAiFloors, coalesceRanges } = shared.engine;
  const { apiSettings } = shared.settings;
  console.log('coalesceRanges:');
  eq(coalesceRanges([0, 1, 2, 5, 7, 8]), [[0, 2], [5, 5], [7, 8]], '合并连续区间');
  eq(coalesceRanges([3, 1, 2, 1]), [[1, 3]], '乱序去重后合并');
  eq(coalesceRanges([]), [], '空数组');
  console.log('isAiFloor 三态:');
  ok(isAiFloor({ is_user: false, is_system: false, mes: '你好' }) === true, '可见 AI 楼 → true');
  ok(isAiFloor({ is_user: true, is_system: false, mes: '嗨' }) === false, '用户楼 → false');
  ok(isAiFloor({ is_user: false, is_system: true, mes: '欢迎', extra: { bbs_hidden: true } }) === true, '我们隐藏的旧 AI 楼 → 仍 true');
  ok(isAiFloor({ is_user: false, is_system: true, mes: '系统提示' }) === false, 'ST 原生系统楼 → false');
  ok(isAiFloor({ is_user: false, is_system: false, mes: '   ' }) === false, '空内容 AI 楼 → false');

  console.log('resolveKeepStart / pendingAiFloors:');
  // chat: u0 a1 u2 a3 u4 a5  (3 条 AI 楼:idx 1,3,5)
  const U = m => ({ is_user: true, is_system: false, mes: m });
  const A = m => ({ is_user: false, is_system: false, mes: m });
  const chat = [U('u0'), A('a1'), U('u2'), A('a3'), U('u4'), A('a5')];

  // keepStart 只决定「隐藏」边界,不决定「生成」——pendingAiFloors 返回所有未覆盖 AI 楼
  apiSettings.keepRecent = 2; // 保留最近 2 条 AI 楼 → a3,a5;keepStart = idx(a3) = 3
  eq(resolveKeepStart(chat), 3, 'keepRecent=2 → keepStart 指向倒数第2个AI楼(idx3)');
  eq(pendingAiFloors(chat), [1, 3, 5], '生成与使用解耦 → 所有未覆盖 AI 楼都待摘要');

  apiSettings.keepRecent = 5; // AI 楼数(3) <= keep(5) → 全保留,无隐藏
  eq(resolveKeepStart(chat), 0, 'AI 楼不足 keep → keepStart=0(全保留)');
  eq(pendingAiFloors(chat), [1, 3, 5], 'keepStart=0 也照常生成所有 AI 楼摘要');

  apiSettings.keepRecent = 1; // 保留 a5;keepStart = idx(a5) = 5
  eq(resolveKeepStart(chat), 5, 'keepRecent=1 → keepStart=idx(a5)=5');
  eq(pendingAiFloors(chat), [1, 3, 5], 'keepRecent=1 也生成所有 AI 楼摘要');

  apiSettings.keepRecent = 5; // 复原默认

  // —— 测试 isSummaryActive 门控(生成与使用解耦)——
  const { buildInjectionText, isSummaryActive } = shared.inject;
  const { memory } = shared.store;
  console.log('isSummaryActive(门控):');
  const hidden = m => ({ is_user: false, is_system: true, mes: m, extra: { bbs_hidden: true } });
  const shown = m => ({ is_user: false, is_system: false, mes: m });
  const c1 = [shown('u'), hidden('a1'), shown('u2'), shown('a3')];
  ok(isSummaryActive([1], c1) === true, '覆盖楼层已隐藏 → 启用');
  ok(isSummaryActive([3], c1) === false, '覆盖楼层仍发全文 → 不启用');
  ok(isSummaryActive([1, 3], c1) === false, '部分未隐藏 → 不启用(避免与全文重复)');
  ok(isSummaryActive([1], null) === true, '无 chat(ST未就绪)→ 回退全部启用');
  console.log('buildInjectionText:');
  eq(buildInjectionText(), '', '空记忆 → 空串(等于清除注入)');
  memory.summaries.push({ id: 's1', text: '主角抵达酒馆,与老板交谈。', coveredIndices: [0, 1], depth: 1, createdAt: 100, auto: true, timeLabel: '第一天 早晨' });
  memory.state.time = '第一天 中午';
  memory.state.location = '酒馆';
  memory.items.push({ id: 'i1', name: '铁剑', qty: 1, createdAt: 1, updatedAt: 1 });
  memory.plans.push({ id: 'p1', kind: 'plan', content: '找到宝藏', status: 'open', createdAt: 1 });
  memory.plans.push({ id: 'p2', kind: 'plan', content: '已完成事项', status: 'resolved', createdAt: 1 });
  const text = buildInjectionText();
  ok(text.includes('历史剧情摘要'), '注入含「历史剧情摘要」标题');
  ok(text.includes('第一天 早晨') && text.includes('抵达酒馆'), '注入含摘要正文与时间标签');
  ok(text.includes('当前状态') && text.includes('酒馆') && text.includes('铁剑'), '注入含当前状态/地点/物品');
  ok(text.includes('找到宝藏'), '注入含未了结计划');
  ok(!text.includes('已完成事项'), 'resolved 计划不注入');

  // —— 测试 deleteSummary(删摘要 + 连带衍生数据,原文不动)——
  const { deleteSummary } = shared.apply;
  console.log('deleteSummary:');
  // 重置 memory,构造:摘要 sumA 产生 item 钢笔、plan 调查命案;另有无来源的 item 不受影响
  memory.summaries.length = 0; memory.items.length = 0; memory.plans.length = 0;
  memory.summaries.push({ id: 'sumA', text: 'A', coveredIndices: [0, 1], depth: 1, createdAt: 1, auto: true });
  memory.summaries.push({ id: 'sumB', text: 'B', coveredIndices: [2, 3], depth: 1, createdAt: 2, auto: true });
  memory.items.push({ id: 'itA', name: '钢笔', createdAt: 1, updatedAt: 1, sourceId: 'sumA' });
  memory.items.push({ id: 'itX', name: '无主物品', createdAt: 1, updatedAt: 1 });
  memory.plans.push({ id: 'plA', kind: 'plan', content: '调查命案', status: 'open', createdAt: 1, sourceId: 'sumA' });
  memory.plans.push({ id: 'plB', kind: 'plan', content: '别的计划', status: 'open', createdAt: 1, sourceId: 'sumB' });
  ok(deleteSummary('sumA') === true, '删除存在的摘要返回 true');
  ok(!memory.summaries.find(s => s.id === 'sumA'), '摘要 sumA 已删');
  ok(memory.summaries.find(s => s.id === 'sumB'), '其他摘要 sumB 保留');
  ok(!memory.items.find(i => i.id === 'itA'), 'sumA 衍生物品已删');
  ok(memory.items.find(i => i.id === 'itX'), '无来源物品不受影响');
  ok(!memory.plans.find(p => p.id === 'plA'), 'sumA 衍生计划已删');
  ok(memory.plans.find(p => p.id === 'plB'), 'sumB 衍生计划保留');
  ok(deleteSummary('不存在') === false, '删除不存在的摘要返回 false');

  console.log(`\n结果:${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
