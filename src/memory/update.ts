/**
 * 检测更新:对比「本地 manifest.json 的 version」与「远端 GitHub 仓库 manifest.json 的 version」,
 * 有新版本则在设置 tab 亮角标 + 设置页给「立即更新」入口,确认后走 ST 扩展更新 API 自动更新并刷新。
 *
 * ⚠️ 刻意不持久化「有更新」结果(不写 localStorage):
 *   旧做法把 updateAvailable 缓存进 localStorage,只有点更新按钮才清——结果是更新完仍提示有更新,
 *   必须手点一次才消。这里改为每次都实时比对两份 manifest 的 version:本地装上新版后 version 自然变大,
 *   下次比对即不再提示。只用内存标记 checkedThisSession 防一次会话内重复请求,页面一刷新就重查。
 */

import { reactive } from 'vue';
import { getContext } from '@/st/context';

/**
 * 本地版本号:直接写死在代码里(发版时与 manifest.json 的 version 一并改)。
 * 比 fetch 本地 manifest 省一次请求、无路径/缓存坑;更新装上新版后这串自然变大,下次比对即不再提示。
 */
const CURRENT_VERSION = '0.6';

/** 远端 manifest:GitHub raw(带时间戳绕缓存)。homePage 指向 baibai-git/ST-BaiBai-Book。 */
const REMOTE_MANIFEST_URL = 'https://raw.githubusercontent.com/baibai-git/ST-BaiBai-Book/main/manifest.json';

/** 对外响应式状态:驱动设置 tab 角标与设置页版本区块。 */
export const updateState = reactive<{
  current: string; // 本地版本(代码内常量)
  latest: string; // 远端版本(空=未查到/请求失败)
  available: boolean; // 远端 > 本地
  checking: boolean;
  updating: boolean;
}>({
  current: CURRENT_VERSION,
  latest: '',
  available: false,
  checking: false,
  updating: false,
});

// 一次会话内只主动查一次(刷新页面即重置 → 重查),避免重复打 GitHub。
let checkedThisSession = false;

/** 解析「a 是否比 b 新」:按 . 分段比较数字,缺段补 0(如 0.0.1 vs 0.1)。非数字段按 0 处理。 */
function isNewer(a: string, b: string): boolean {
  if (!a || !b) return false;
  const pa = a.split('.').map(n => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/** 读远端 manifest.json 的 version。请求失败/超时返回空串(静默,不打扰用户)。 */
async function readRemoteVersion(): Promise<string> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const resp = await fetch(`${REMOTE_MANIFEST_URL}?t=${Date.now()}`, {
        method: 'GET',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (!resp.ok) return '';
      const json = (await resp.json()) as { version?: string };
      return String(json?.version ?? '').trim();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return '';
  }
}

/**
 * 检测更新:实时比对本地与远端 manifest 版本,刷新 updateState。
 * 一次会话只主动查一次;force=true 跳过该限制(供「重新检查」手动触发)。
 */
export async function checkForUpdate(force = false): Promise<void> {
  if (updateState.checking) return;
  if (checkedThisSession && !force) return;
  updateState.checking = true;
  try {
    const latest = await readRemoteVersion();
    if (latest) {
      updateState.latest = latest;
      updateState.available = isNewer(latest, CURRENT_VERSION);
    }
    // 远端拿不到则保持上次结论(不误报、不误清)。
    checkedThisSession = true;
  } finally {
    updateState.checking = false;
  }
}

/** 本扩展文件夹名(third-party 下的目录名)。据模块 URL 解析,取不到回退已知名。 */
function extensionFolderName(): string {
  try {
    const path = new URL(import.meta.url).pathname;
    const marker = '/third-party/';
    const idx = path.indexOf(marker);
    if (idx >= 0) {
      const rest = path.slice(idx + marker.length);
      const folder = rest.split('/')[0];
      if (folder) return folder;
    }
  } catch {
    /* 解析失败回退 */
  }
  return 'ST-BaiBai-Book';
}

/** 探测本扩展安装类型(global/local/system),决定更新 API 的 global 参数。取不到当 local。 */
async function discoverExtensionType(folder: string): Promise<'global' | 'local' | 'system' | null> {
  try {
    const headers = getContext()?.getRequestHeaders?.() ?? {};
    const resp = await fetch('/api/extensions/discover', { method: 'GET', headers, cache: 'no-store' });
    if (!resp.ok) return null;
    const list = (await resp.json()) as Array<{ name?: string; type?: string }>;
    if (!Array.isArray(list)) return null;
    const target = `third-party/${folder}`;
    const hit = list.find(x => x?.name === target);
    const type = hit?.type;
    return type === 'global' || type === 'local' || type === 'system' ? type : null;
  } catch {
    return null;
  }
}

/**
 * 执行更新:调 ST 的 /api/extensions/update 拉取最新代码,成功后刷新页面生效。
 * 失败抛错(由调用方提示)。全局扩展需管理员权限,后端会自行校验并返回错误文案。
 */
export async function performUpdate(): Promise<void> {
  if (updateState.updating) return;
  updateState.updating = true;
  try {
    const folder = extensionFolderName();
    const type = await discoverExtensionType(folder);
    const headers = getContext()?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' };
    const resp = await fetch('/api/extensions/update', {
      method: 'POST',
      headers,
      body: JSON.stringify({ extensionName: folder, global: type === 'global' }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(text || resp.statusText || `HTTP ${resp.status}`);
    }
    // 更新成功:本地代码已换新版,刷新页面加载新产物(刷新后比对自然不再提示)。
    updateState.available = false;
    setTimeout(() => location.reload(), 800);
  } finally {
    updateState.updating = false;
  }
}
