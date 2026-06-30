<script setup lang="ts">
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import { fetchModels, testChannel } from '@/api/client';
import { apiSettings, newChannel, resolveVectorModel, sanitizeTagName, type ApiChannel } from '@/api/settings';
import { getContext } from '@/st/context';
import {
  JAILBREAK_PROMPT,
  RESUMMARY2_MACROS,
  RESUMMARY2_PROMPT,
  RESUMMARY_MACROS,
  RESUMMARY_PROMPT,
  SUMMARY_MACROS,
  SUMMARY_PROMPT,
  type PromptMacro,
} from '@/memory/prompts';
import { TIME_TAG_PROMPT } from '@/memory/timeTag';
import { clearVectorIndex, syncVectorIndex } from '@/memory/vector';
import { resetVectorStoreProbe, vectorBackendKind } from '@/memory/vector/store';
import { checkForUpdate, performUpdate, updateState } from '@/memory/update';
import { recallDebug } from '@/memory/vector/debug';
import { computeCarryoverPlan, createNewChatWithCarryover, type CarryoverPlan } from '@/memory/carryover';
import { computeMigrationPlan, runHoraeMigration, type MigrationPlan } from '@/memory/migrate';
import { ui, THEMES, ORB_SHAPES, type NavPosition } from '@/state/ui';
import { uploadOrbImage } from '@/st/upload';
import { toast } from '@/st/toast';
import { computed, nextTick, onMounted, ref } from 'vue';

const navOptions: { value: NavPosition; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'top', label: '顶部' },
  { value: 'bottom', label: '底部' },
];

/* —— 悬浮球自定义图标:选图 → 压缩上传到 ST 服务器 → 存路径串(跨设备同步) —— */
const orbFileInput = ref<HTMLInputElement | null>(null);
const orbUploading = ref(false);
function pickOrbImage() {
  orbFileInput.value?.click();
}
async function onOrbFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // 复位,允许重复选同一文件
  if (!file) return;
  orbUploading.value = true;
  try {
    ui.orbImage = await uploadOrbImage(file);
    toast('悬浮球图标已更新', 'success');
  } catch (err) {
    toast(err instanceof Error ? err.message : '上传失败', 'error');
  } finally {
    orbUploading.value = false;
  }
}
function resetOrbImage() {
  ui.orbImage = '';
}

/* —— 渠道:列表只读展示,编辑/新建都在弹窗里进行,避免一长列表平铺误触。
   两套独立渠道:'api'=副 API(摘要/总结),'vector'=向量记忆。弹窗按 scope 操作对应列表。 —— */
type ChannelScope = 'api' | 'vector';
// editingId:正在编辑的「已有渠道」id;新建时为 null。仅用于「完成」时定位写回目标。
const editingId = ref<string | null>(null);
const editingScope = ref<ChannelScope>('api');
// 当前 scope 对应的渠道数组(增删/查找都走它)。向量已改扁平端点,只剩副 API 用渠道。
function channelsOf(_scope: ChannelScope): ApiChannel[] {
  return apiSettings.channels;
}
// 编辑用「草稿副本」:v-model 全改在草稿上,只有点「完成」才写回 apiSettings(避免每敲一字就触发存盘)。
// 弹窗开关也以它为准:草稿存在 = 弹窗打开。
const editingChannel = ref<ApiChannel | null>(null);
// 深拷贝渠道(纯数据,JSON 即可),切断与 apiSettings 真身的引用
function cloneChannel(ch: ApiChannel): ApiChannel {
  return JSON.parse(JSON.stringify(ch)) as ApiChannel;
}
// 密钥默认隐藏;每次打开/关闭弹窗都复位,避免密钥意外保持明文
const showKey = ref(false);

// 排除参数:内部存 string[],编辑时用逗号分隔的单行文本承载,读/写两向转换。
const excludeParamsText = computed<string>({
  get: () => editingChannel.value?.excludeParams.join(', ') ?? '',
  set: v => {
    const ch = editingChannel.value;
    if (!ch) return;
    ch.excludeParams = v
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  },
});

function addChannel(scope: ChannelScope = 'api') {
  showKey.value = false;
  editingScope.value = scope;
  editingId.value = null; // null = 新建,完成时 push
  editingChannel.value = newChannel(); // 草稿,尚未进 apiSettings
}
function openChannel(id: string, scope: ChannelScope = 'api') {
  const src = channelsOf(scope).find(c => c.id === id);
  if (!src) return;
  showKey.value = false;
  editingScope.value = scope;
  editingId.value = id;
  editingChannel.value = cloneChannel(src); // 编辑草稿副本,不动真身
}
/** 取消(× / 点遮罩):丢弃草稿,不写回 apiSettings(无论新建还是编辑,改动都作废)。 */
function closeChannel() {
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
/** 完成:把草稿写回 apiSettings —— 新建则 push,编辑则按 id 覆盖。此时才触发存盘。 */
function confirmChannel() {
  const draft = editingChannel.value;
  if (draft) {
    const list = channelsOf(editingScope.value);
    if (editingId.value) {
      const idx = list.findIndex(c => c.id === editingId.value);
      if (idx >= 0) list[idx] = draft;
      else list.push(draft); // 编辑期间原渠道被删等异常 → 兜底为新增
    } else {
      list.push(draft);
    }
  }
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
// 删除渠道前的二次确认:点删除先开确认弹窗,确认后才真正删。
const confirmDeleteOpen = ref(false);
function askRemoveChannel() {
  confirmDeleteOpen.value = true;
}
function confirmRemoveChannel() {
  confirmDeleteOpen.value = false;
  // 删除针对「已有渠道」(editingId);新建草稿尚未入库,等同直接丢弃草稿
  if (editingId.value) removeChannel(editingId.value);
  editingId.value = null;
  editingChannel.value = null;
}
function removeChannel(id: string) {
  const scope = editingScope.value;
  const list = channelsOf(scope);
  const idx = list.findIndex(c => c.id === id);
  if (idx >= 0) list.splice(idx, 1);
  // 清理指派:副 API 清两类摘要指派(向量已改扁平端点,不再走渠道系统)
  if (scope === 'api') {
    if (apiSettings.assignments.summary === id) apiSettings.assignments.summary = '';
    if (apiSettings.assignments.resummary === id) apiSettings.assignments.resummary = '';
  }
}

const testing = ref<Record<string, string>>({});
async function doTest(ch: ApiChannel) {
  testing.value[ch.id] = '测试中…';
  const r = await testChannel(ch);
  testing.value[ch.id] = r.message;
}

// 各渠道拉取到的模型列表 + 拉取状态
const models = ref<Record<string, string[]>>({});
const loadingModels = ref<Record<string, boolean>>({});
async function pullModels(ch: ApiChannel) {
  loadingModels.value[ch.id] = true;
  testing.value[ch.id] = '';
  try {
    const list = await fetchModels(ch);
    models.value[ch.id] = list;
    if (list.length && !ch.model) ch.model = list[0];
    if (!list.length) testing.value[ch.id] = '未返回任何模型';
  } catch (e) {
    testing.value[ch.id] = e instanceof Error ? e.message : String(e);
  } finally {
    loadingModels.value[ch.id] = false;
  }
}

/* —— 模型可搜索下拉(combobox):输入框既是当前值也是过滤词,聚焦弹出过滤列表 —— */
const modelMenuOpen = ref(false);
const modelQuery = ref(''); // 聚焦后用户输入的过滤词;失焦时清空
// 已拉取到的当前渠道模型列表
const modelList = computed<string[]>(() => {
  const id = editingChannel.value?.id;
  return id ? models.value[id] ?? [] : [];
});
// 过滤:有 query 按子串(大小写不敏感)过滤;为空则显示全部。性能上限 200 条,避免超长列表卡顿。
const filteredModels = computed<string[]>(() => {
  const q = modelQuery.value.trim().toLowerCase();
  const list = modelList.value;
  const out = q ? list.filter(m => m.toLowerCase().includes(q)) : list;
  return out.slice(0, 200);
});
function openModelMenu() {
  modelQuery.value = '';
  modelMenuOpen.value = true;
}
function pickModel(m: string) {
  if (editingChannel.value) editingChannel.value.model = m;
  modelMenuOpen.value = false;
  modelQuery.value = '';
}
// 失焦延迟关闭,让 option 的 mousedown/click 先生效
function closeModelMenuSoon() {
  setTimeout(() => {
    modelMenuOpen.value = false;
    modelQuery.value = '';
  }, 150);
}

/* —— 自定义提示词:列表(摘要/总结/破限/时间标签),点开在弹窗里编辑大文本 —— */
type PromptKey = 'summary' | 'resummary' | 'resummary2' | 'jailbreak' | 'timeTag';
interface PromptMeta {
  key: PromptKey;
  label: string;
  hint: string;
  builtin: string;
  macros: PromptMacro[];
}
const PROMPT_METAS: PromptMeta[] = [
  {
    key: 'summary',
    label: '摘要提示词',
    hint: '把单楼对话整理成结构化记忆(摘要正文 + 时间/地点/物品/计划)。',
    builtin: SUMMARY_PROMPT,
    macros: SUMMARY_MACROS,
  },
  {
    key: 'resummary',
    label: '总结提示词',
    hint: '把多条楼层摘要压成一条 L1 总结(普通总结,固定 300-500 字)。',
    builtin: RESUMMARY_PROMPT,
    macros: RESUMMARY_MACROS,
  },
  {
    key: 'resummary2',
    label: '二次总结提示词',
    hint: '把多条总结再压一层(L1+ → 更上层)。目标字数按输入规模动态放宽({{target}}),少丢信息。',
    builtin: RESUMMARY2_PROMPT,
    macros: RESUMMARY2_MACROS,
  },
  {
    key: 'jailbreak',
    label: '破限提示词',
    hint: '作为置顶 system 附加在摘要/总结请求里,降低副 API 拒答率。留空则用内置默认。',
    builtin: JAILBREAK_PROMPT,
    macros: [],
  },
  {
    key: 'timeTag',
    label: '固定提示词(时间标签)',
    hint: '注入主对话,要求 AI 每条正文前后输出时间标签,作为剧情时间锚点(摘要与新剧情据此对齐,不再错乱)。需开启下方「正文时间标签」开关。留空用内置默认。',
    builtin: TIME_TAG_PROMPT,
    macros: [],
  },
];

// 正在编辑的提示词;draft 是草稿,点「完成」才写回 apiSettings(取消则丢弃)。
const editingPrompt = ref<PromptMeta | null>(null);
const promptDraft = ref('');
const promptArea = ref<HTMLTextAreaElement | null>(null);

// 该任务是否已自定义(非空即视为已覆盖内置)
function isCustom(key: PromptKey): boolean {
  return apiSettings.prompts[key].trim().length > 0;
}

function openPrompt(meta: PromptMeta) {
  editingPrompt.value = meta;
  // 已自定义→载入用户内容;未自定义→预填内置模板,方便直接在其上改
  promptDraft.value = apiSettings.prompts[meta.key].trim() || meta.builtin;
}
function closePrompt() {
  editingPrompt.value = null;
  promptDraft.value = '';
}
function savePrompt() {
  const meta = editingPrompt.value;
  if (!meta) return;
  // 草稿与内置完全一致→存空串(回落内置),避免把模板冗余存进设置、也便于显示「默认」
  const v = promptDraft.value.trim();
  apiSettings.prompts[meta.key] = v === meta.builtin.trim() ? '' : promptDraft.value;
  closePrompt();
}
// 「恢复默认」:把草稿重置回内置模板(保存后即回落内置)
function resetPrompt() {
  if (editingPrompt.value) promptDraft.value = editingPrompt.value.builtin;
}

/* —— 向量记忆:三个模型角色,embedding 为基准,后两者留空复用它 —— */
type VectorRole = 'embedding' | 'rerank' | 'queryRewrite';
interface VectorRoleMeta {
  key: VectorRole;
  label: string;
}
const VECTOR_ROLES: VectorRoleMeta[] = [
  { key: 'embedding', label: 'Embedding(向量化,必填)' },
  { key: 'rerank', label: 'Rerank(重排)' },
  { key: 'queryRewrite', label: 'Query 重写' },
];

/* —— 向量端点:每角色直接填 地址/密钥/模型;模型可一键拉取(combobox)。 —— */
const vecShowKey = ref<Record<VectorRole, boolean>>({ embedding: false, rerank: false, queryRewrite: false });
// 三个端点卡片各自折叠,默认全收起,只露标题,需要时再展开。
const vecEpOpen = ref<Record<VectorRole, boolean>>({ embedding: false, rerank: false, queryRewrite: false });
const vecModels = ref<Record<VectorRole, string[]>>({ embedding: [], rerank: [], queryRewrite: [] });
const vecLoadingModels = ref<Record<VectorRole, boolean>>({ embedding: false, rerank: false, queryRewrite: false });
const vecModelMsg = ref<Record<VectorRole, string>>({ embedding: '', rerank: '', queryRewrite: '' });
// combobox:当前展开的角色(null=都收起)+ 过滤词
const vecModelMenuOpen = ref<VectorRole | null>(null);
const vecModelQuery = ref('');

async function pullVecModels(role: VectorRole) {
  // 解析回落后的地址/密钥:rerank/query 留空时自动用 Embedding 的去拉(模型仍写回本角色)
  const ep = resolveVectorModel(role);
  if (!ep.url.trim()) {
    vecModelMsg.value[role] = role === 'embedding' ? '请先填 Embedding 地址' : '请先填本角色或 Embedding 的地址';
    return;
  }
  vecLoadingModels.value[role] = true;
  vecModelMsg.value[role] = '';
  try {
    const list = await fetchModels({ url: ep.url, key: ep.key });
    vecModels.value[role] = list;
    if (list.length && !apiSettings.vector[role].model) apiSettings.vector[role].model = list[0];
    if (!list.length) vecModelMsg.value[role] = '未返回任何模型';
  } catch (e) {
    vecModelMsg.value[role] = e instanceof Error ? e.message : String(e);
  } finally {
    vecLoadingModels.value[role] = false;
  }
}
function filteredVecModels(role: VectorRole): string[] {
  const q = vecModelQuery.value.trim().toLowerCase();
  const list = vecModels.value[role] ?? [];
  const out = q ? list.filter(m => m.toLowerCase().includes(q)) : list;
  return out.slice(0, 200);
}
function openVecModelMenu(role: VectorRole) {
  vecModelQuery.value = '';
  vecModelMenuOpen.value = role;
}
function pickVecModel(role: VectorRole, m: string) {
  apiSettings.vector[role].model = m;
  vecModelMenuOpen.value = null;
  vecModelQuery.value = '';
}
function closeVecModelMenuSoon() {
  setTimeout(() => {
    vecModelMenuOpen.value = null;
    vecModelQuery.value = '';
  }, 150);
}

/* —— 向量后端类型:'backend' 柏宝库后端 / 'local' 本地降级;探测一次,展示当前在用哪个。 —— */
const vecBackend = ref<'backend' | 'local' | 'unknown'>('unknown');
async function refreshVecBackend(): Promise<void> {
  try {
    vecBackend.value = await vectorBackendKind();
  } catch {
    vecBackend.value = 'unknown';
  }
}
onMounted(refreshVecBackend);

/* —— 检测更新:版本区块 + 确认弹窗 —— */
const updateConfirmOpen = ref(false);
// 进设置页时静默重查一次(force:绕开「会话只查一次」,让用户每次进设置页都拿最新结论)
onMounted(() => void checkForUpdate(true));
function openUpdateConfirm() {
  if (updateState.available) updateConfirmOpen.value = true;
}
async function confirmUpdate() {
  updateConfirmOpen.value = false;
  const toastr = (globalThis as Record<string, any>).toastr;
  try {
    await performUpdate();
    // performUpdate 成功后会自动刷新页面;走到这里通常是已触发刷新倒计时
    toastr?.success?.('更新成功,正在刷新页面…', '柏宝书');
  } catch (e) {
    toastr?.error?.(`更新失败:${e instanceof Error ? e.message : String(e)}`, '柏宝书');
  }
}

/* —— 索引维护:手动重建当前聊天向量索引 —— */
const vecIndexing = ref(false);
const vecIndexMsg = ref('');
async function doRebuildIndex() {
  if (vecIndexing.value) return;
  vecIndexing.value = true;
  vecIndexMsg.value = '';
  resetVectorStoreProbe(); // 重测后端,确保索引落到当前真实可用的 store
  try {
    const n = await syncVectorIndex();
    vecIndexMsg.value = n > 0 ? `已索引 ${n} 条新摘要。` : '没有需要新增的索引(已是最新)。';
  } catch (e) {
    vecIndexMsg.value = `索引失败:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    vecIndexing.value = false;
    void refreshVecBackend();
  }
}

// 清空当前聊天向量索引:破坏性操作,点一次先要二次确认,再点才真清。
const vecClearing = ref(false);
const vecClearConfirm = ref(false);
async function doClearIndex() {
  if (vecClearing.value) return;
  if (!vecClearConfirm.value) {
    vecClearConfirm.value = true;
    return;
  }
  vecClearConfirm.value = false;
  vecClearing.value = true;
  vecIndexMsg.value = '';
  try {
    const n = await clearVectorIndex();
    vecIndexMsg.value = `已清空当前聊天向量索引(删除 ${n} 条)。可点「重建」从头索引。`;
  } catch (e) {
    vecIndexMsg.value = `清空失败:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    vecClearing.value = false;
    void refreshVecBackend();
  }
}

/* —— 带数据创建新对话 —— */
const carrying = ref(false);
const carryMsg = ref('');
const carryConfirmOpen = ref(false);
// 携带计划:展开面板时实时算(纯读 chat,不缓存,避免切聊天后过期)
const carryPlan = computed<CarryoverPlan>(() => computeCarryoverPlan());
async function runCarryover() {
  carryConfirmOpen.value = false;
  carrying.value = true;
  carryMsg.value = '';
  try {
    const ok = await createNewChatWithCarryover();
    carryMsg.value = ok ? '已创建新对话。' : '创建未完成(详见提示)。';
  } catch (e) {
    carryMsg.value = `创建失败:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    carrying.value = false;
  }
}

/* —— 从旧版 Horae 迁移 —— */
const migrating = ref(false);
const migrateMsg = ref('');
const migrateConfirmOpen = ref(false);
// 迁移计划:展开面板时实时算(纯读当前 chat 的 horae_meta,不缓存)
const migratePlan = computed<MigrationPlan>(() => computeMigrationPlan());
// 确认文案随「是否覆盖」变化
const migrateConfirmText = computed(() =>
  migratePlan.value.willOverwrite
    ? '当前聊天已有柏宝书数据,迁移会覆盖现有摘要并在各楼写入数据。继续吗?'
    : '将把当前聊天里的 Horae 旧数据迁移成柏宝书记忆。继续吗?',
);
async function runMigrate() {
  migrateConfirmOpen.value = false;
  migrating.value = true;
  migrateMsg.value = '';
  try {
    const ok = await runHoraeMigration();
    migrateMsg.value = ok ? '迁移完成。' : '迁移未完成(详见提示)。';
  } catch (e) {
    migrateMsg.value = `迁移失败:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    migrating.value = false;
  }
}

/* —— 排除角色:勾选的角色名(含重名卡)的聊天里,记忆系统所有功能都不生效。
   按「名字」排除,所以同名卡是一批一起排除。列表很长时易卡,故:① 仅在弹窗打开时取/去重角色名;
   ② 带搜索框过滤;③ 用 v-show + 子串匹配,渲染量随搜索收敛。 —— */
const excludeOpen = ref(false);
const excludeSearch = ref('');

// 弹窗打开时一次性算出去重后的角色名(按名排序),关闭后不再持有,避免常驻大列表。
const charNames = computed<string[]>(() => {
  if (!excludeOpen.value) return [];
  const chars = getContext()?.characters ?? [];
  const seen = new Set<string>();
  for (const c of chars) {
    const n = c?.name?.trim();
    if (n) seen.add(n);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh'));
});

// 过滤:空搜索显示全部;否则大小写不敏感子串匹配
const filteredCharNames = computed<string[]>(() => {
  const q = excludeSearch.value.trim().toLowerCase();
  if (!q) return charNames.value;
  return charNames.value.filter(n => n.toLowerCase().includes(q));
});

function openExclude() {
  excludeSearch.value = '';
  excludeOpen.value = true;
}
function closeExclude() {
  excludeOpen.value = false;
}
function isExcluded(name: string): boolean {
  return apiSettings.excludedChars.includes(name);
}
function toggleExcluded(name: string) {
  const list = apiSettings.excludedChars;
  const idx = list.indexOf(name);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(name);
}

/* —— 自定义清洗标签:用户填标签名(如 snow),清洗正文时把 <snow>…</snow> 整块删掉 —— */
const stripTagDraft = ref('');
function addStripTag() {
  const tag = sanitizeTagName(stripTagDraft.value);
  if (!tag) {
    stripTagDraft.value = '';
    return;
  }
  if (!apiSettings.customStripTags.includes(tag)) apiSettings.customStripTags.push(tag);
  stripTagDraft.value = '';
}
function removeStripTag(tag: string) {
  const idx = apiSettings.customStripTags.indexOf(tag);
  if (idx >= 0) apiSettings.customStripTags.splice(idx, 1);
}

// 点宏标签 → 插入到文本框光标处(无焦点则追加到末尾)
function insertMacro(token: string) {
  const el = promptArea.value;
  if (!el) {
    promptDraft.value += token;
    return;
  }
  const start = el.selectionStart ?? promptDraft.value.length;
  const end = el.selectionEnd ?? start;
  promptDraft.value = promptDraft.value.slice(0, start) + token + promptDraft.value.slice(end);
  // 等 v-model 回填后把光标移到插入内容之后
  void nextTick(() => {
    el.focus();
    const pos = start + token.length;
    el.setSelectionRange(pos, pos);
  });
}

/* —— 上次召回详情(调试面板):纯只读展示 recallDebug,reactive 自动刷新 —— */
function fmtRecallTime(at: number): string {
  if (!at) return '';
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// 来源 Q 标签:后端回传 -1(旧后端未支持)时显示占位符
function qLabel(queryIndex: number): string {
  return queryIndex >= 0 ? `Q${queryIndex + 1}` : '—';
}
const TIER_LABEL: Record<'full' | 'brief' | 'drop', string> = { full: '全文', brief: '摘要', drop: '丢弃' };
// 状态语气:决定横幅左侧圆点的配色(成功/警示/失败/进行中)
const recallStatusKind = computed<'ok' | 'warn' | 'fail' | 'pending'>(() => {
  const s = recallDebug.status;
  if (s.includes('失败')) return 'fail';
  if (s.includes('进行中')) return 'pending';
  if (s.includes('未召回') || s.includes('未注入')) return 'warn';
  return 'ok';
});
// 分数(0~1)→ 进度条宽度百分比;负分(如未知)按 0 处理
function scorePct(score: number): number {
  return Math.max(0, Math.min(1, score)) * 100;
}
</script>

<template>
  <section class="bbs-page">
    <!-- 标题行右端显示版本号;有更新时旁边出现「更新」按钮。 -->
    <div class="bbs-page-head">
      <h2 class="bbs-title bbs-title-sub">设置</h2>
      <div class="bbs-ver-row">
        <button
          class="bbs-ver"
          type="button"
          :disabled="updateState.checking"
          :title="updateState.checking ? '正在检查更新' : '点击检查更新'"
          @click="checkForUpdate(true)"
        >
          v{{ updateState.current || '—' }}
        </button>
        <button
          v-if="updateState.available"
          class="bbs-btn bbs-btn-primary bbs-btn-sm"
          type="button"
          :disabled="updateState.updating"
          :title="`更新到 v${updateState.latest}`"
          @click="openUpdateConfirm"
        >
          {{ updateState.updating ? '更新中…' : '更新' }}
        </button>
      </div>
    </div>
    <hr class="bbs-rule" />

    <!-- 总开关:整个插件的主控,关闭即停止注入/摘要/总结/隐藏(已有数据保留)。
         单独抬出在折叠区之上,作为这页最显眼的一处决策。 -->
    <div class="bbs-master" :class="{ 'is-off': !apiSettings.enabled }">
      <span class="bbs-master-spine" aria-hidden="true"></span>
      <div class="bbs-master-text">
        <span class="bbs-master-title">柏宝书 · 记忆引擎</span>
      </div>
      <button
        type="button"
        role="switch"
        class="bbs-toggle"
        :class="{ 'is-on': apiSettings.enabled }"
        :aria-checked="apiSettings.enabled"
        :title="apiSettings.enabled ? '点击停用' : '点击启用'"
        @click="apiSettings.enabled = !apiSettings.enabled"
      >
        <span class="bbs-toggle-knob"></span>
      </button>
    </div>

    <div class="bbs-sections">
      <!-- 基本设置 -->
      <Collapsible title="基本设置" :open="false">
        <div class="bbs-field">
          <div class="bbs-field-head">
            <span class="bbs-field-label">主题</span>
          </div>
          <div class="bbs-segmented bbs-segmented-wrap">
            <button
              v-for="t in THEMES"
              :key="t.value"
              type="button"
              class="bbs-seg"
              :class="{ 'is-on': ui.theme === t.value }"
              @click="ui.theme = t.value"
            >
              <Icon :name="t.icon" />
              {{ t.label }}
            </button>
          </div>
        </div>

        <div class="bbs-field">
          <div class="bbs-field-head">
            <span class="bbs-field-label">导航位置</span>
          </div>
          <div class="bbs-segmented">
            <button
              v-for="n in navOptions"
              :key="n.value"
              type="button"
              class="bbs-seg"
              :class="{ 'is-on': ui.navPosition === n.value }"
              @click="ui.navPosition = n.value"
            >
              {{ n.label }}
            </button>
          </div>
        </div>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">移动端点当前页导航关窗</span>
          <input v-model="ui.navTapClose" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">移动端再点一下当前所在页的导航按钮即可关闭整个窗口,省得去够右上角的 ×。怕误触可关。</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">在 ST 顶栏显示按钮</span>
          <input v-model="ui.showTopBar" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">在酒馆顶部导航栏(用户设定管理左侧)加一个快速打开柏宝书的按钮,免去每次点左下角魔杖。左下角魔杖入口照旧保留。</p>

        <label class="bbs-switch-row">
          <span class="bbs-field-label">在聊天框上方显示按钮</span>
          <input v-model="ui.showQuickReply" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">在输入框上方(与快速回复同位)加一个「柏宝书」按钮,跟随酒馆主题美化。</p>

        <!-- 屏幕悬浮球:配置项多,收进可收缩小分组 -->
        <Collapsible title="屏幕悬浮球" :open="false">
          <label class="bbs-switch-row">
            <span class="bbs-field-label">显示屏幕悬浮球</span>
            <input v-model="ui.showOrb" type="checkbox" class="bbs-checkbox" />
          </label>
          <p class="bbs-field-hint">在屏幕边缘挂一枚可拖动的悬浮球,点击即开柏宝书。拖到中间可常驻悬浮,拖近左右边缘则吸附贴边。</p>

          <!-- 形状:仅开启时可配 -->
          <div v-if="ui.showOrb" class="bbs-field">
            <div class="bbs-field-head">
              <span class="bbs-field-label">形状</span>
            </div>
            <div class="bbs-segmented">
              <button
                v-for="s in ORB_SHAPES"
                :key="s.value"
                type="button"
                class="bbs-seg"
                :class="{ 'is-on': ui.orbShape === s.value }"
                @click="ui.orbShape = s.value"
              >
                {{ s.label }}
              </button>
            </div>
          </div>

          <!-- 静止透明度:仅开启时可配 -->
          <div v-if="ui.showOrb" class="bbs-field">
            <div class="bbs-field-head">
              <span class="bbs-field-label">静止透明度</span>
              <span class="bbs-field-value">{{ ui.orbOpacity }}%</span>
            </div>
            <input v-model.number="ui.orbOpacity" type="range" min="20" max="100" step="1" class="bbs-range" />
            <p class="bbs-field-hint">悬浮球静止时的不透明度;鼠标悬停 / 拖动时一律全显。</p>
          </div>

          <!-- 大小:仅开启时可配 -->
          <div v-if="ui.showOrb" class="bbs-field">
            <div class="bbs-field-head">
              <span class="bbs-field-label">大小</span>
              <span class="bbs-field-value">{{ ui.orbSize }}px</span>
            </div>
            <input v-model.number="ui.orbSize" type="range" min="32" max="80" step="1" class="bbs-range" />
          </div>

          <!-- 图标:仅开启时可配 -->
          <div v-if="ui.showOrb" class="bbs-orb-config">
            <div class="bbs-orb-preview" :class="[`shape-${ui.orbShape}`, { 'has-image': !!ui.orbImage }]">
              <img v-if="ui.orbImage" :src="ui.orbImage" alt="悬浮球图标预览" />
              <Icon v-else name="bookmark" />
            </div>
            <div class="bbs-orb-config-actions">
              <button type="button" class="bbs-btn bbs-btn-sm bbs-btn-primary" :disabled="orbUploading" @click="pickOrbImage">
                {{ orbUploading ? '上传中…' : ui.orbImage ? '更换图标' : '上传图标' }}
              </button>
              <button v-if="ui.orbImage" type="button" class="bbs-btn bbs-btn-sm" @click="resetOrbImage">恢复默认</button>
            </div>
            <input ref="orbFileInput" type="file" accept="image/*" hidden @change="onOrbFileChange" />
          </div>
          <p v-if="ui.showOrb" class="bbs-field-hint">支持静态图与 GIF 动图(GIF 保留动画,≤2MB)。图标上传到酒馆服务器、跨设备同步;留空则用默认书签图标。</p>
        </Collapsible>
      </Collapsible>

      <!-- 副 API -->
      <Collapsible title="副 API" :open="false">
        <!-- 任务指派 -->
        <div class="bbs-field bbs-assign">
          <label class="bbs-assign-row">
            <span class="bbs-field-label">摘要使用</span>
            <select v-model="apiSettings.assignments.summary" class="bbs-input bbs-select">
              <option value="">跟随主 API</option>
              <option v-for="c in apiSettings.channels" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
          <label class="bbs-assign-row">
            <span class="bbs-field-label">总结使用</span>
            <select v-model="apiSettings.assignments.resummary" class="bbs-input bbs-select">
              <option value="">跟随主 API</option>
              <option v-for="c in apiSettings.channels" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
        </div>
        <p class="bbs-field-hint">不指派渠道时跟随主 API:直接借用你主界面当前正在用的 API(聊天补全/文本补全)执行摘要,无需额外配置。想用不同模型再在下方建副渠道指派。</p>

        <hr class="bbs-rule" />

        <!-- 渠道:顶部添加按钮 + 紧凑只读列表(点行进弹窗编辑),不再一长列表单平铺 -->
        <div class="bbs-channel-bar">
          <span class="bbs-field-label">渠道</span>
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="addChannel('api')">
            <Icon name="plus" /> 添加渠道
          </button>
        </div>

        <ul v-if="apiSettings.channels.length" class="bbs-channel-list">
          <li v-for="ch in apiSettings.channels" :key="ch.id" class="bbs-channel-item">
            <button class="bbs-channel-open" type="button" @click="openChannel(ch.id)">
              <span class="bbs-channel-item-name">{{ ch.name || '未命名渠道' }}</span>
              <span class="bbs-channel-item-model">{{ ch.model || '未设模型' }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">还没有渠道。点「添加渠道」配置摘要/总结要用的 API。</p>
      </Collapsible>

      <!-- 摘要设置 -->
      <Collapsible title="摘要设置" :open="false">
        <label class="bbs-switch-row">
          <span class="bbs-field-label">启用自动摘要</span>
          <input v-model="apiSettings.autoSummaryEnabled" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">开启后自动摘要并隐藏旧楼,同时启用正文时间标签(剧情时间锚点)与积压拦截(漏摘时拦截发送、提示补摘)。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">字数档位</span>
          <select v-model="apiSettings.verbosity" class="bbs-input bbs-select bbs-select-narrow">
            <option value="detailed">详细</option>
            <option value="concise">精简</option>
          </select>
        </label>
        <p class="bbs-field-hint">一键调节摘要/总结/二次总结的目标字数。详细=信息全(摘要150-300、总结300-500字)；精简=省token(摘要80-150、总结150-300字)。仅影响内置提示词,自定义模板不受影响。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">保留最近 AI 消息数</span>
          <input v-model.number="apiSettings.keepRecent" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">保留多少条 AI 消息发送全文,超出部分自动隐藏并发送摘要。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">每次总结 AI 消息数</span>
          <input v-model.number="apiSettings.leafBatchThreshold" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">每次总结多少条摘要,不计算 user 楼层,0 为关闭自动总结。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">二次总结</span>
          <input v-model.number="apiSettings.resummaryThreshold" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">总结达到多少条后再次进行总结,0 为关闭二次总结。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">失败重试次数</span>
          <input v-model.number="apiSettings.summaryMaxRetries" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">摘要/总结请求失败(报错或返回内容无法解析)时最多额外重试几次,0 为不重试。默认 1。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">批量补摘·每批字数</span>
          <input v-model.number="apiSettings.batchMaxChars" class="bbs-input bbs-num" type="number" min="500" step="500" />
        </label>
        <p class="bbs-field-hint">批量补摘时,每次请求最多打包多少字正文(清洗后)就切一批。越大越省 token/越快,但太大会让 AI 注意力分散、质量下降。默认 30000。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">批量补摘·每批楼数上限</span>
          <input v-model.number="apiSettings.batchMaxFloors" class="bbs-input bbs-num" type="number" min="1" />
        </label>
        <p class="bbs-field-hint">字数没到上限时,楼数到此也切批,作为兜底。默认 10。</p>
      </Collapsible>

      <!-- 排除角色 -->
      <Collapsible title="排除角色" :open="false">
        <p class="bbs-field-hint">勾选的角色名(含同名的重名卡)所在聊天里,柏宝书的所有功能都不生效——不摘要、不隐藏、不注入、不拦截。适合工具性、不需要记忆的角色。</p>
        <div class="bbs-channel-bar">
          <span class="bbs-field-label">
            已排除 {{ apiSettings.excludedChars.length }} 个
          </span>
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="openExclude">
            <Icon name="edit" /> 编辑名单
          </button>
        </div>
        <ul v-if="apiSettings.excludedChars.length" class="bbs-exclude-chips">
          <li v-for="name in apiSettings.excludedChars" :key="name" class="bbs-exclude-chip">
            <span class="bbs-exclude-chip-name">{{ name }}</span>
            <button class="bbs-exclude-chip-x" type="button" title="移出名单" @click="toggleExcluded(name)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">名单为空,所有角色都启用记忆系统。</p>
      </Collapsible>

      <!-- 自定义清洗标签 -->
      <Collapsible title="自定义清洗标签" :open="false">
        <p class="bbs-field-hint">
          正文里若混入其它插件/世界书写的格式块(如状态栏 <code>&lt;snow&gt;…&lt;/snow&gt;</code>),
          可在此填入标签名(只填 <code>snow</code>,不带尖括号),摘要、向量索引与召回时会把整块连内容一并删掉。
          调整后对**召回**即时生效(向量库存原文、召回再清洗),无需重建索引。
        </p>
        <div class="bbs-striptag-bar">
          <input
            v-model="stripTagDraft"
            class="bbs-input"
            type="text"
            placeholder="标签名,如 snow"
            @keydown.enter.prevent="addStripTag"
          />
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="addStripTag">
            <Icon name="plus" /> 添加
          </button>
        </div>
        <ul v-if="apiSettings.customStripTags.length" class="bbs-exclude-chips">
          <li v-for="tag in apiSettings.customStripTags" :key="tag" class="bbs-exclude-chip">
            <span class="bbs-exclude-chip-name">&lt;{{ tag }}&gt;</span>
            <button class="bbs-exclude-chip-x" type="button" title="移除" @click="removeStripTag(tag)">
              <Icon name="close" />
            </button>
          </li>
        </ul>
        <p v-else class="bbs-field-hint">暂无自定义标签。仅内置清洗(思维链、注释、物品旁注等)生效。</p>
      </Collapsible>

      <!-- 自定义提示词 -->
      <Collapsible title="自定义提示词" :open="false">
        <ul class="bbs-prompt-list">
          <li v-for="m in PROMPT_METAS" :key="m.key" class="bbs-prompt-item">
            <button class="bbs-prompt-open" type="button" @click="openPrompt(m)">
              <span class="bbs-prompt-name">{{ m.label }}</span>
              <span class="bbs-prompt-state" :class="{ 'is-custom': isCustom(m.key) }">
                {{ isCustom(m.key) ? '已自定义' : '默认' }}
              </span>
              <Icon name="edit" class="bbs-prompt-edit" />
            </button>
          </li>
        </ul>
      </Collapsible>

      <!-- 向量记忆 -->
      <Collapsible title="向量记忆" :open="false">
        <label class="bbs-switch-row bbs-vec-enable">
          <span class="bbs-field-label">启用向量记忆</span>
          <input v-model="apiSettings.vector.enabled" type="checkbox" class="bbs-checkbox" />
        </label>

        <hr class="bbs-rule bbs-vec-enable-rule" />

        <!-- 三个端点:Embedding 必填;Rerank/Query 地址留空 = 整体复用 Embedding。
             卡片自身可折叠(点标题栏),无额外外框;副标显当前模型,收起也看得出配没配。 -->
        <div
          v-for="role in VECTOR_ROLES"
          :key="role.key"
          class="bbs-vec-ep"
          :class="{ 'is-disabled': !apiSettings.vector.enabled, 'is-collapsed': !vecEpOpen[role.key] }"
        >
          <button
            type="button"
            class="bbs-vec-head bbs-vec-toggle"
            :aria-expanded="vecEpOpen[role.key]"
            @click="vecEpOpen[role.key] = !vecEpOpen[role.key]"
          >
            <span class="bbs-field-label">{{ role.label }}</span>
            <Icon name="chevron" class="bbs-vec-chevron" />
          </button>

          <div class="bbs-vec-ep-outer">
            <div class="bbs-vec-ep-inner">
          <div class="bbs-vec-ep-body">
          <p v-if="role.key !== 'embedding'" class="bbs-field-hint">地址 / 密钥留空即复用 Embedding;模型仍需各自填写。</p>

          <label class="bbs-modal-field">
            <span class="bbs-modal-label">API 地址</span>
            <input
              v-model="apiSettings.vector[role.key].url"
              class="bbs-input"
              :placeholder="role.key === 'embedding' ? '如 https://api.openai.com/v1' : '留空 = 复用 Embedding 的地址'"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>

          <label class="bbs-modal-field">
            <span class="bbs-modal-label">API 密钥</span>
            <div class="bbs-model-row">
              <input
                v-model="apiSettings.vector[role.key].key"
                class="bbs-input"
                :type="vecShowKey[role.key] ? 'text' : 'password'"
                :placeholder="role.key === 'embedding' ? 'API 密钥' : '留空 = 复用 Embedding 的密钥'"
                :disabled="!apiSettings.vector.enabled"
              />
              <button
                class="bbs-icon-mini"
                type="button"
                :title="vecShowKey[role.key] ? '隐藏密钥' : '显示密钥'"
                @click="vecShowKey[role.key] = !vecShowKey[role.key]"
              >
                <Icon :name="vecShowKey[role.key] ? 'eye-off' : 'eye'" />
              </button>
            </div>
          </label>

          <!-- 模型:三个角色各自独立(embedding/rerank/query 模型本就不同),都要单独选,从不复用。
               拉取走「该角色的地址/密钥」,留空则自动用 Embedding 的地址/密钥去拉。 -->
          <label class="bbs-modal-field">
            <span class="bbs-modal-label">模型</span>
            <div class="bbs-model-row">
              <div class="bbs-combo">
                <input
                  v-model="apiSettings.vector[role.key].model"
                  class="bbs-input"
                  :placeholder="(vecModels[role.key]?.length) ? '搜索或输入模型名…' : '模型名,或点右侧拉取'"
                  :disabled="!apiSettings.vector.enabled"
                  @focus="openVecModelMenu(role.key)"
                  @input="vecModelQuery = apiSettings.vector[role.key].model; vecModelMenuOpen = role.key"
                  @blur="closeVecModelMenuSoon"
                />
                <span
                  v-if="vecModels[role.key]?.length"
                  class="bbs-combo-caret"
                  :class="{ 'is-open': vecModelMenuOpen === role.key }"
                  aria-hidden="true"
                />
                <ul v-if="vecModelMenuOpen === role.key && vecModels[role.key]?.length" class="bbs-combo-menu">
                  <li v-if="!filteredVecModels(role.key).length" class="bbs-combo-empty">无匹配模型</li>
                  <li
                    v-for="m in filteredVecModels(role.key)"
                    :key="m"
                    class="bbs-combo-item"
                    :class="{ 'is-active': m === apiSettings.vector[role.key].model }"
                    @mousedown.prevent="pickVecModel(role.key, m)"
                  >
                    {{ m }}
                  </li>
                </ul>
              </div>
              <button
                class="bbs-icon-mini"
                type="button"
                :title="vecLoadingModels[role.key] ? '拉取中…' : '拉取模型'"
                :disabled="!apiSettings.vector.enabled || vecLoadingModels[role.key]"
                @click="pullVecModels(role.key)"
              >
                <Icon name="refresh" />
              </button>
            </div>
          </label>
          <p v-if="vecModelMsg[role.key]" class="bbs-field-hint">{{ vecModelMsg[role.key] }}</p>
          </div>
            </div>
          </div>
        </div>

        <hr class="bbs-rule" />

        <!-- 召回参数:机制说明 + 进阶旋钮整体折叠,默认收起,不淹没上方端点配置。 -->
        <Collapsible title="召回参数" :open="false">
          <div class="bbs-vec-recall" :class="{ 'is-disabled': !apiSettings.vector.enabled }">
            <p class="bbs-field-hint">
              先对全部向量索引算 embedding 相似度,取得分最高的若干条进入 rerank;rerank 打分后分两档:
              得分高的发原文全文,稍低但仍过 embedding 阈值的发摘要;两档合计不超过「最终召回条数」。
            </p>

            <p class="bbs-field-hint">
              生成前用小模型(上方「Query 重写」)把当前剧情重写成多条检索 query,多路召回更全面。
              <strong>查询重写为召回必经步骤,须配好「Query 重写」模型;未配或重写失败则本回合不召回。</strong>
              每回合多一次小模型请求(略增延迟)。
            </p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Rerank 候选数</span>
            <input
              v-model.number="apiSettings.vector.recall.rerankCandidates"
              class="bbs-input bbs-num"
              type="number"
              min="1"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">按 embedding 相似度取前 N 条进入 rerank 精排(越大越准但越慢)。</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Embedding 阈值</span>
            <input
              v-model.number="apiSettings.vector.recall.embeddingThreshold"
              class="bbs-input bbs-num"
              type="number"
              step="0.01"
              min="0"
              max="1"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">摘要档准入门槛:embedding 相似度低于此的内容连摘要都不召回(0~1)。</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">Rerank 阈值</span>
            <input
              v-model.number="apiSettings.vector.recall.rerankThreshold"
              class="bbs-input bbs-num"
              type="number"
              step="0.01"
              min="0"
              max="1"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">rerank 得分 ≥ 此值的发原文全文,低于此但过 embedding 阈值的退为发摘要(0~1)。</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">召回全文数</span>
            <input
              v-model.number="apiSettings.vector.recall.fullTextCount"
              class="bbs-input bbs-num"
              type="number"
              min="0"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">全文档最多取几条发原文(其余即便过 rerank 阈值也退为摘要)。</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">最终召回条数</span>
            <input
              v-model.number="apiSettings.vector.recall.finalRecallCount"
              class="bbs-input bbs-num"
              type="number"
              min="0"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">召回总条数上限(全文 + 摘要合计);全文不够用摘要补,补不满也无妨。</p>

          <label class="bbs-num-row">
            <span class="bbs-field-label">起召 AI 楼数</span>
            <input
              v-model.number="apiSettings.vector.recall.minAiFloors"
              class="bbs-input bbs-num"
              type="number"
              min="0"
              :disabled="!apiSettings.vector.enabled"
            />
          </label>
          <p class="bbs-field-hint">
            当前聊天 AI 消息数少于此值时不触发召回(0=不限制)。早期剧情旧记忆少,跳过可省额度/延迟。
            另:当所有消息都还在滑动窗口内全文发送时也会自动跳过(无窗口外旧楼可召);「带数据建新对话」的旧档不受此限,始终召回。
          </p>
          </div>
        </Collapsible>

        <hr class="bbs-rule" />

        <!-- 索引维护:把当前聊天的叶子摘要补建/对账进向量库 -->
        <div class="bbs-vec-recall" :class="{ 'is-disabled': !apiSettings.vector.enabled }">
          <div class="bbs-vec-head">
            <span class="bbs-field-label">索引维护</span>
            <span
              v-if="vecBackend !== 'unknown'"
              class="bbs-vec-backend"
              :class="vecBackend === 'backend' ? 'is-backend' : 'is-local'"
            >
              {{ vecBackend === 'backend' ? '柏宝库' : '前端' }}
            </span>
          </div>
          <p class="bbs-field-hint">
            正常情况下叶子摘要会随生成自动索引;若中途才开启向量记忆,可手动把当前聊天已有的摘要补建进向量库。
            清空只删当前聊天自己的索引,不动「带数据建新对话」继承来的旧档快照。
          </p>
          <p v-if="vecBackend === 'local'" class="bbs-field-hint">
            本地模式:索引存浏览器,仅当前聊天召回,不跨聊天 / 不跨设备。安装柏宝库后端后可恢复完整能力。
          </p>
          <div class="bbs-vec-index-actions">
            <button
              class="bbs-btn bbs-btn-sm"
              type="button"
              :disabled="!apiSettings.vector.enabled || vecIndexing || vecClearing"
              @click="doRebuildIndex"
            >
              {{ vecIndexing ? '索引中…' : '重建当前聊天向量索引' }}
            </button>
            <button
              class="bbs-btn bbs-btn-sm bbs-btn-danger"
              type="button"
              :disabled="!apiSettings.vector.enabled || vecIndexing || vecClearing"
              @click="doClearIndex"
              @blur="vecClearConfirm = false"
            >
              <Icon name="trash" />
              {{ vecClearing ? '清空中…' : vecClearConfirm ? '再点确认清空' : '清空当前聊天索引' }}
            </button>
          </div>
          <p v-if="vecIndexMsg" class="bbs-field-hint">{{ vecIndexMsg }}</p>
        </div>

        <hr class="bbs-rule" />

        <!-- 上次召回详情:把上一次召回各阶段的中间结果可视化,便于调参/排障(reactive 自动刷新) -->
        <Collapsible title="上次召回详情" :open="false">
          <p v-if="!recallDebug.at" class="bbs-field-hint">
            尚无召回记录。配好向量渠道后发一条消息触发召回,这里会显示重写 / 检索 / 重排 / 注入各阶段结果。
          </p>
          <div v-else class="bbs-dbg">
            <!-- 状态横幅:左侧圆点按语气配色,右侧时间 -->
            <div class="bbs-dbg-banner" :class="`is-${recallStatusKind}`">
              <span class="bbs-dbg-dot" aria-hidden="true"></span>
              <span class="bbs-dbg-status-text">{{ recallDebug.status }}</span>
              <span class="bbs-dbg-time">{{ fmtRecallTime(recallDebug.at) }}</span>
            </div>

            <!-- 四阶段各自可折叠,默认收起;标题带计数 -->
            <Collapsible :title="`1 · 查询重写 · ${recallDebug.queries.length} Q`" :open="false">
              <p v-if="recallDebug.intent" class="bbs-dbg-intent">
                <span class="bbs-dbg-tag">INTENT</span><span class="bbs-dbg-intent-text">{{ recallDebug.intent }}</span>
              </p>
              <ul v-if="recallDebug.queries.length" class="bbs-dbg-qlist">
                <li v-for="(q, i) in recallDebug.queries" :key="i" class="bbs-dbg-qitem">
                  <span class="bbs-dbg-qno">Q{{ i + 1 }}</span><span class="bbs-dbg-qtext">{{ q }}</span>
                </li>
              </ul>
              <p v-else class="bbs-dbg-empty">无</p>
            </Collapsible>

            <Collapsible :title="`2 · Embedding 检索 · ${recallDebug.embedding.length} 条`" :open="false">
              <ul v-if="recallDebug.embedding.length" class="bbs-dbg-cards">
                <li v-for="(h, i) in recallDebug.embedding" :key="i" class="bbs-dbg-card">
                  <div class="bbs-dbg-card-top">
                    <span class="bbs-dbg-src" :title="`来源 ${qLabel(h.queryIndex)}`">{{ qLabel(h.queryIndex) }}</span>
                    <span class="bbs-dbg-from" :class="{ 'is-bundle': h.source === '旧档' }">{{ h.source }}</span>
                    <span v-if="h.storyTime" class="bbs-dbg-when">【{{ h.storyTime }}】</span>
                    <span class="bbs-dbg-num">{{ h.similarity.toFixed(3) }}</span>
                  </div>
                  <div class="bbs-dbg-bar"><i :style="{ width: scorePct(h.similarity) + '%' }"></i></div>
                  <p class="bbs-dbg-prev">{{ h.preview }}</p>
                </li>
              </ul>
              <p v-else class="bbs-dbg-empty">无</p>
            </Collapsible>

            <Collapsible :title="`3 · Rerank 分档 · ${recallDebug.rerank.length} 条`" :open="false">
              <ul v-if="recallDebug.rerank.length" class="bbs-dbg-cards">
                <li v-for="(h, i) in recallDebug.rerank" :key="i" class="bbs-dbg-card" :class="{ 'is-dropped': h.tier === 'drop' }">
                  <div class="bbs-dbg-card-top">
                    <span class="bbs-dbg-tier" :class="`is-${h.tier}`">{{ TIER_LABEL[h.tier] }}</span>
                    <span class="bbs-dbg-from" :class="{ 'is-bundle': h.source === '旧档' }">{{ h.source }}</span>
                    <span v-if="h.storyTime" class="bbs-dbg-when">【{{ h.storyTime }}】</span>
                    <span class="bbs-dbg-num">{{ h.rerankScore.toFixed(3) }}</span>
                  </div>
                  <div class="bbs-dbg-bar" :class="`tier-${h.tier}`"><i :style="{ width: scorePct(h.rerankScore) + '%' }"></i></div>
                  <p class="bbs-dbg-prev">{{ h.preview }}</p>
                </li>
              </ul>
              <p v-else class="bbs-dbg-empty">无(rerank 未执行或无候选)</p>
            </Collapsible>

            <Collapsible title="4 · 最终注入" :open="false">
              <pre v-if="recallDebug.injectedText" class="bbs-dbg-pre">{{ recallDebug.injectedText }}</pre>
              <p v-else class="bbs-dbg-empty">本回合未注入。</p>
            </Collapsible>
          </div>
        </Collapsible>
      </Collapsible>

      <!-- 带数据创建新对话 -->
      <Collapsible title="带数据创建新对话" :open="false">
        <p class="bbs-field-hint">
          把当前聊天的「最近全文窗口 + 合并历史摘要 + 当前状态(物品/计划)」打包,创建一个新对话带过去。
          新对话从一片「种子叶子」重放还原状态,旧剧情作为摘要随行;若开了向量记忆,旧聊天会被快照,
          新对话可向量召回它的内容(逐次累加,分支也自动继承)。
        </p>
        <div v-if="carryPlan" class="bbs-field-hint">
          将携带:AI {{ carryPlan.aiCount }} 条 / 实际消息 {{ carryPlan.carryCount }} 条;旧剧情摘要 {{ carryPlan.recapLen > 0 ? '有' : '无' }}。
        </div>
        <button
          class="bbs-btn bbs-btn-sm bbs-btn-primary"
          type="button"
          :disabled="carrying || !carryPlan?.hasData"
          @click="carryConfirmOpen = true"
        >
          {{ carrying ? '创建中…' : '带数据创建新对话' }}
        </button>
        <p v-if="carryMsg" class="bbs-field-hint">{{ carryMsg }}</p>
      </Collapsible>

      <!-- 从旧版 Horae 迁移 -->
      <Collapsible title="从旧版 Horae 迁移" :open="false">
        <p class="bbs-field-hint">
          把当前聊天里旧版 Horae 的摘要、物品、计划迁移过来。需要迁移的聊天各点一次,不会动 Horae 原数据。
        </p>
        <div v-if="migratePlan" class="bbs-field-hint">
          <template v-if="migratePlan.hasData">
            检测到:可建摘要 {{ migratePlan.leafFloors }} 层 / 旧总结 {{ migratePlan.summaryCount }} 条 /
            物品 {{ migratePlan.itemCount }} / 计划悬念 {{ migratePlan.planCount }}。
            <span v-if="migratePlan.willOverwrite">⚠️ 当前聊天已有本插件数据,迁移将覆盖。</span>
          </template>
          <template v-else>未在当前聊天检测到 Horae 旧数据(请先进入含旧数据的聊天)。</template>
        </div>
        <button
          class="bbs-btn bbs-btn-sm bbs-btn-primary"
          type="button"
          :disabled="migrating || !migratePlan?.hasData"
          @click="migrateConfirmOpen = true"
        >
          {{ migrating ? '迁移中…' : '迁移当前聊天的 Horae 数据' }}
        </button>
        <p v-if="migrateMsg" class="bbs-field-hint">{{ migrateMsg }}</p>
      </Collapsible>
    </div>

    <!-- 带数据创建新对话 / Horae 迁移 的确认弹窗 -->
    <ConfirmDialog
      v-model:open="carryConfirmOpen"
      title="带数据创建新对话"
      confirm-text="创建并切入"
      @confirm="runCarryover"
    >
      将基于当前聊天创建一个带数据的新对话并切入。继续吗?
    </ConfirmDialog>
    <ConfirmDialog
      v-model:open="migrateConfirmOpen"
      title="从旧版 Horae 迁移"
      confirm-text="开始迁移"
      @confirm="runMigrate"
    >
      {{ migrateConfirmText }}
    </ConfirmDialog>

    <!-- ===== 渠道编辑弹窗 ===== -->
    <div v-if="editingChannel" class="bbs-modal-mask" @click.self="closeChannel">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑渠道">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑渠道</span>
          <button class="bbs-icon-mini" type="button" title="关闭" @click="closeChannel"><Icon name="close" /></button>
        </header>

        <label class="bbs-modal-field">
          <span class="bbs-modal-label">渠道名</span>
          <input v-model="editingChannel.name" class="bbs-input" placeholder="渠道名" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">API 地址</span>
          <input v-model="editingChannel.url" class="bbs-input" placeholder="如 https://api.openai.com/v1" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">API 密钥</span>
          <div class="bbs-model-row">
            <input
              v-model="editingChannel.key"
              class="bbs-input"
              :type="showKey ? 'text' : 'password'"
              placeholder="API 密钥"
            />
            <button
              class="bbs-icon-mini"
              type="button"
              :title="showKey ? '隐藏密钥' : '显示密钥'"
              :aria-pressed="showKey"
              @click="showKey = !showKey"
            >
              <Icon :name="showKey ? 'eye-off' : 'eye'" />
            </button>
          </div>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">模型</span>
          <div class="bbs-model-row">
            <!-- 可搜索 combobox:已拉取到模型列表时,聚焦弹出过滤菜单;没列表时就是普通输入框 -->
            <div class="bbs-combo">
              <input
                v-model="editingChannel.model"
                class="bbs-input"
                :placeholder="modelList.length ? '搜索或输入模型名…' : '模型名,如 gpt-4o-mini'"
                @focus="openModelMenu"
                @input="modelQuery = editingChannel.model; modelMenuOpen = true"
                @blur="closeModelMenuSoon"
              />
              <!-- 自绘下拉三角(纯装饰,pointer-events:none → 点击穿透到输入框照常聚焦展开);仅在有可选模型时显示 -->
              <span v-if="modelList.length" class="bbs-combo-caret" :class="{ 'is-open': modelMenuOpen }" aria-hidden="true" />
              <ul v-if="modelMenuOpen && modelList.length" class="bbs-combo-menu">
                <li v-if="!filteredModels.length" class="bbs-combo-empty">无匹配模型</li>
                <li
                  v-for="m in filteredModels"
                  :key="m"
                  class="bbs-combo-item"
                  :class="{ 'is-active': m === editingChannel.model }"
                  @mousedown.prevent="pickModel(m)"
                >
                  {{ m }}
                </li>
              </ul>
            </div>
            <button
              class="bbs-icon-mini"
              type="button"
              :title="loadingModels[editingChannel.id] ? '拉取中…' : '拉取模型'"
              :disabled="loadingModels[editingChannel.id]"
              @click="pullModels(editingChannel)"
            >
              <Icon name="refresh" />
            </button>
          </div>
        </label>
        <div class="bbs-channel-row">
          <label class="bbs-mini-field">
            <span>温度</span>
            <input v-model.number="editingChannel.temperature" class="bbs-input" type="number" step="0.1" min="0" max="2" />
          </label>
          <label class="bbs-mini-field">
            <span>最大 token</span>
            <input v-model.number="editingChannel.maxTokens" class="bbs-input" type="number" step="256" min="256" />
          </label>
        </div>
        <label class="bbs-switch-row">
          <span class="bbs-modal-label">流式传输</span>
          <input v-model="editingChannel.stream" type="checkbox" class="bbs-checkbox" />
        </label>
        <label class="bbs-switch-row">
          <span class="bbs-modal-label">发送预填充</span>
          <input v-model="editingChannel.prefill" type="checkbox" class="bbs-checkbox" />
        </label>
        <span class="bbs-field-hint">默认开。若副 API 报错信息里出现 prefill 字样,关掉它即可。</span>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">排除参数</span>
          <input
            v-model="excludeParamsText"
            class="bbs-input"
            type="text"
            placeholder="逗号分隔,如 temperature, max_tokens"
          />
          <span class="bbs-field-hint">这些参数会在发请求前从请求体里删除,用于规避不接受该参数的兼容端点报错。逗号分隔,留空则不排除。</span>
        </label>
        <p v-if="testing[editingChannel.id]" class="bbs-channel-test">{{ testing[editingChannel.id] }}</p>

        <footer class="bbs-modal-foot">
          <!-- 删除靠左、与右侧主操作拉开,破坏性动作不与「完成」相邻,降低误触。
               删除:始终显示文字;测试:PC 显「测试渠道」,移动端只显「测试」(短版,省版面) -->
          <button class="bbs-btn bbs-btn-danger" type="button" @click="askRemoveChannel">
            <Icon name="trash" /> 删除
          </button>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn" type="button" title="测试渠道" @click="doTest(editingChannel)">
            <Icon name="plug" /> <span class="bbs-btn-label-full">测试渠道</span><span class="bbs-btn-label-short">测试</span>
          </button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="confirmChannel">完成</button>
        </footer>
      </div>

      <!-- 删除渠道二次确认:叠在渠道弹窗之上 -->
      <ConfirmDialog
        v-model:open="confirmDeleteOpen"
        title="删除渠道"
        confirm-text="删除"
        confirm-icon="trash"
        tone="danger"
        top-layer
        @confirm="confirmRemoveChannel"
      >
        确定删除渠道「{{ editingChannel.name || '未命名渠道' }}」吗?此操作不可撤销,已指派该渠道的任务会被清空。
      </ConfirmDialog>
    </div>

    <!-- ===== 提示词编辑弹窗 ===== -->
    <div v-if="editingPrompt" class="bbs-modal-mask" @click.self="closePrompt">
      <div class="bbs-modal bbs-modal-wide" role="dialog" aria-modal="true" :aria-label="`编辑${editingPrompt.label}`">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑{{ editingPrompt.label }}</span>
          <button class="bbs-icon-mini" type="button" title="关闭" @click="closePrompt"><Icon name="close" /></button>
        </header>

        <p class="bbs-modal-label">{{ editingPrompt.hint }}</p>

        <!-- 可用宏:点一下插入到光标处 -->
        <div class="bbs-macro-bar">
          <span class="bbs-macro-tip">点击插入宏:</span>
          <button
            v-for="mac in editingPrompt.macros"
            :key="mac.token"
            class="bbs-macro"
            type="button"
            :title="mac.desc"
            @click="insertMacro(mac.token)"
          >
            {{ mac.token }}
          </button>
        </div>

        <textarea
          ref="promptArea"
          v-model="promptDraft"
          class="bbs-input bbs-prompt-area"
          spellcheck="false"
          rows="16"
        ></textarea>

        <footer class="bbs-modal-foot">
          <button class="bbs-btn bbs-btn-danger" type="button" @click="resetPrompt">
            <Icon name="refresh" /> 恢复默认
          </button>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn" type="button" @click="closePrompt">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="savePrompt">完成</button>
        </footer>
      </div>
    </div>

    <!-- ===== 排除角色弹窗:搜索 + 勾选列表 ===== -->
    <div v-if="excludeOpen" class="bbs-modal-mask" @click.self="closeExclude">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑排除名单">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">排除角色</span>
          <button class="bbs-icon-mini" type="button" title="关闭" @click="closeExclude"><Icon name="close" /></button>
        </header>

        <input
          v-model="excludeSearch"
          class="bbs-input"
          type="search"
          placeholder="搜索角色名…"
          spellcheck="false"
        />

        <div class="bbs-exclude-list">
          <label v-for="name in filteredCharNames" :key="name" class="bbs-exclude-row">
            <input
              type="checkbox"
              class="bbs-checkbox"
              :checked="isExcluded(name)"
              @change="toggleExcluded(name)"
            />
            <span class="bbs-exclude-row-name">{{ name }}</span>
          </label>
          <p v-if="!charNames.length" class="bbs-field-hint">未读取到角色列表。请先在 ST 里加载角色卡。</p>
          <p v-else-if="!filteredCharNames.length" class="bbs-field-hint">没有匹配「{{ excludeSearch }}」的角色。</p>
        </div>

        <footer class="bbs-modal-foot">
          <span class="bbs-exclude-count">共 {{ charNames.length }} 个角色 · 已排除 {{ apiSettings.excludedChars.length }}</span>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="closeExclude">完成</button>
        </footer>
      </div>
    </div>

    <!-- ===== 更新确认弹窗 ===== -->
    <ConfirmDialog
      v-model:open="updateConfirmOpen"
      title="发现新版本"
      confirm-text="更新并刷新"
      busy-text="更新中…"
      :busy="updateState.updating"
      @confirm="confirmUpdate"
    >
      当前版本 v{{ updateState.current || '—' }},最新版本 v{{ updateState.latest }}。<br />
      现在更新吗?更新完成后会自动刷新页面生效。
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.bbs-page {
  display: flex;
  flex-direction: column;
}
.bbs-sections {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* —— 标题行:左标题 + 右版本号(及更新按钮) —— */
.bbs-page-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.bbs-ver-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* 版本标签:实心强调底 + 白字(粉彩=粉底白字,各主题随 --bbs-accent 自适应) */
.bbs-ver {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
  cursor: pointer;
  font-family: var(--bbs-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  transition: opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-ver:hover {
  opacity: 0.88;
}
.bbs-ver:disabled {
  cursor: default;
}
.bbs-ver:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 2px;
}

.bbs-field {
  margin-bottom: 18px;
}
.bbs-field:last-child {
  margin-bottom: 0;
}
.bbs-field-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.bbs-field-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
}
/* 字段右上角的数值(如透明度百分比) */
.bbs-field-value {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--bbs-accent);
}

/* 滑块:用主题色,跨浏览器统一外观 */
.bbs-range {
  width: 100%;
  height: 4px;
  margin: 6px 0 12px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
}
.bbs-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  border: 2px solid var(--bbs-surface);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.25);
}
.bbs-range::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  border: 2px solid var(--bbs-surface);
}
.bbs-range:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 3px;
}
.bbs-field-hint {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
  line-height: 1.6;
}

.bbs-segmented {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  background: var(--bbs-surface-2);
  border-radius: var(--bbs-radius);
}
/* 主题选项可能较多/标签较长:允许换行,窄屏下不溢出 */
.bbs-segmented-wrap {
  display: flex;
  flex-wrap: wrap;
}
.bbs-seg {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 18px;
  background: transparent;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  color: var(--bbs-ink-soft);
  font-family: var(--bbs-font-sans);
  font-size: 13px;
  cursor: pointer;
  transition:
    background var(--bbs-dur) var(--bbs-ease),
    color var(--bbs-dur) var(--bbs-ease);
}
.bbs-seg:hover {
  color: var(--bbs-ink);
}
.bbs-seg.is-on {
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.08);
}

/* 任务指派 */
.bbs-assign {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbs-assign-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.bbs-select {
  max-width: 60%;
  font-size: 12px;
  /* 去掉原生右侧大留白的下拉箭头,换一枚紧贴文字的自绘小三角(右内边距随之收紧) */
  appearance: none;
  -webkit-appearance: none;
  padding-right: 26px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9.5 12 15.5 18 9.5'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 14px;
}
/* —— 模型可搜索 combobox —— */
.bbs-combo {
  position: relative;
  flex: 1;
  min-width: 0;
}
.bbs-combo .bbs-input {
  width: 100%;
  padding-right: 26px; /* 给右侧自绘三角让位,文字不压到箭头 */
}
/* 自绘下拉三角:与原生 <select> 同款 SVG,贴右侧居中;展开时翻转。装饰元素不拦点击 */
.bbs-combo-caret {
  position: absolute;
  top: 50%;
  right: 8px;
  width: 14px;
  height: 14px;
  transform: translateY(-50%);
  pointer-events: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9.5 12 15.5 18 9.5'/></svg>");
  background-repeat: no-repeat;
  background-position: center;
  background-size: 14px;
  transition: transform 0.15s ease;
}
.bbs-combo-caret.is-open {
  transform: translateY(-50%) rotate(180deg);
}
/* 过滤菜单:绝对定位贴在输入框下方,限高滚动,长列表不撑爆弹窗 */
.bbs-combo-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 6;
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 220px;
  overflow-y: auto;
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  box-shadow: var(--bbs-shadow);
}
.bbs-combo-item {
  padding: 7px 9px;
  border-radius: var(--bbs-radius-sm);
  font-size: 12.5px;
  color: var(--bbs-ink);
  cursor: pointer;
  word-break: break-all;
}
.bbs-combo-item:hover {
  background: var(--bbs-surface-2);
}
.bbs-combo-item.is-active {
  color: var(--bbs-accent);
  font-weight: 600;
}
.bbs-combo-empty {
  padding: 7px 9px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}

/* 小一号按钮:用于「添加渠道」等次级操作 */
.bbs-btn-sm {
  padding: 6px 11px;
  font-size: 12px;
}

/* 悬浮球图标配置:预览方块 + 操作按钮 */
.bbs-orb-config {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}
.bbs-orb-preview {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  font-size: 22px;
  overflow: hidden;
}
.bbs-orb-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* 预览随所选形状变化,让用户直观看到效果 */
.bbs-orb-preview.shape-bookmark {
  clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 78%, 0 100%);
  border-color: transparent;
}
.bbs-orb-preview.shape-circle {
  border-radius: 999px;
}
.bbs-orb-preview.shape-square {
  border-radius: 12px;
}
.bbs-orb-config-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* 测试按钮文字:默认(PC)显完整版,短版藏起;窄屏在媒体查询里互换 */
.bbs-btn-label-short {
  display: none;
}

/* 渠道:顶部操作条(标签 + 添加按钮) */
.bbs-channel-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

/* 渠道:紧凑只读列表,每渠道一行,点行进弹窗编辑 */
.bbs-channel-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbs-channel-item {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
/* 行主体:整块可点,左名字右模型 */
.bbs-channel-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
  font-family: var(--bbs-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbs-dur) var(--bbs-ease), background var(--bbs-dur) var(--bbs-ease);
}
.bbs-channel-open:hover {
  border-color: var(--bbs-accent);
  background: var(--bbs-surface);
}
/* 渠道名:完整显示,允许换行,占据剩余空间 */
.bbs-channel-item-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  word-break: break-word;
}
/* 模型名:次要信息,过长则截断,不挤占名字 */
.bbs-channel-item-model {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 弹窗底部:spacer 把删除键推到最左,与右侧操作分隔 */
.bbs-modal-foot-spacer {
  flex: 1 1 auto;
}
/* 危险操作按钮:描边低调,hover 才显红,避免误触 */
.bbs-btn-danger {
  color: var(--bbs-danger);
  border-color: var(--bbs-line-strong);
}
.bbs-btn-danger:hover {
  color: var(--bbs-danger);
  border-color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}

.bbs-model-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.bbs-model-row .bbs-input {
  flex: 1;
}
.bbs-icon-mini:disabled {
  opacity: 0.5;
  cursor: default;
}
.bbs-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbs-icon-mini:hover {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
}
.bbs-channel-row {
  display: flex;
  gap: 10px;
}
.bbs-mini-field {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}
.bbs-channel-test {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--bbs-ink-soft);
  word-break: break-all;
}

/* 摘要设置控件 */
.bbs-switch-row,
.bbs-num-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
}
/* 「启用向量记忆」是折叠区里独一行开关,不再额外加上 padding,贴合标题节奏 */
.bbs-vec-enable {
  padding-top: 0;
}
/* 紧跟开关行的分割线收掉上边距:开关行自带 8px 下 padding 已够,避免整块显得空旷 */
.bbs-vec-enable-rule {
  margin-top: 0;
}
.bbs-checkbox {
  width: 18px;
  height: 18px;
  accent-color: var(--bbs-accent);
  cursor: pointer;
}
.bbs-num {
  max-width: 110px;
  text-align: right;
}
/* 短选项下拉(如字数档位):贴合文字的窄宽,和右侧数字框对齐,不再撑满半行 */
.bbs-select-narrow {
  width: auto;
  min-width: 65px;
  max-width: 150px;
}

/* —— 总开关主控卡 —— */
/* 左缘一道金色书脊,呼应「书」的品牌;停用时整卡褪色、书脊转灰,状态一眼可辨 */
.bbs-master {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
  padding: 16px 18px 16px 16px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  box-shadow: var(--bbs-shadow);
  transition: opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-master-spine {
  flex: 0 0 auto;
  align-self: stretch;
  width: 4px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  transition: background var(--bbs-dur) var(--bbs-ease);
}
.bbs-master.is-off .bbs-master-spine {
  background: var(--bbs-line-strong);
}
.bbs-master.is-off .bbs-master-text {
  opacity: 0.7;
}
.bbs-master-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.bbs-master-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--bbs-ink);
}

/* —— 通用滑动开关(总开关用,后续别处也可复用) —— */
.bbs-toggle {
  flex: 0 0 auto;
  position: relative;
  width: 46px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-line-strong);
  cursor: pointer;
  transition: background var(--bbs-dur) var(--bbs-ease);
}
.bbs-toggle.is-on {
  background: var(--bbs-accent);
}
.bbs-toggle:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 2px;
}
.bbs-toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--bbs-surface);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.25);
  transition: transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-toggle.is-on .bbs-toggle-knob {
  transform: translateX(20px);
}

/* —— 向量记忆:每个模型角色一组卡片(渠道 + 模型名两列) —— */
/* 向量端点卡片(Embedding/Rerank/Query 各一块,扁平填地址/密钥/模型) */
.bbs-vec-ep {
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  transition: opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-vec-ep.is-disabled {
  opacity: 0.5;
}
/* 召回参数/索引维护整组在关闭向量记忆时一并置灰 */
.bbs-vec-recall.is-disabled {
  opacity: 0.5;
}
.bbs-vec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
/* 端点卡片折叠头:整条标题栏可点;收起时去掉下间距,卡片只剩一行标题。 */
.bbs-vec-toggle {
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--bbs-ink);
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.bbs-vec-toggle:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 4px;
  border-radius: var(--bbs-radius-sm);
}
/* 折叠头不自带下间距,改由 body 的 padding-top 统一供给,
   这样三块标题到首行内容的距离一致(不受有无提示行影响),收起时随 grid 一并归零。 */
.bbs-vec-toggle.bbs-vec-head {
  margin-bottom: 0;
}
.bbs-vec-ep-body {
  padding-top: 12px;
}
.bbs-vec-chevron {
  font-size: 18px;
  color: var(--bbs-ink-muted);
  transition: transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-vec-ep.is-collapsed .bbs-vec-chevron {
  transform: rotate(-90deg);
}
/* 展开动画:照搬 Collapsible 的 grid 0fr<->1fr,内容自适应高度,无需测量。 */
.bbs-vec-ep-outer {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--bbs-dur) var(--bbs-ease);
}
.bbs-vec-ep.is-collapsed .bbs-vec-ep-outer {
  grid-template-rows: 0fr;
}
/* 展开态放开 overflow,否则会裁掉里面模型 combobox 绝对定位的下拉菜单(拉取模型后「点不开」);
   折叠动画期间仍需 hidden 来平滑揭示——用离散过渡延迟到动画结束(0.28s)才切 visible,收起时立即变回 hidden。
   allow-discrete 不支持的旧浏览器降级为立即切换:展开瞬间内容略溢出(小瑕疵),但下拉可用,不再点不开。 */
.bbs-vec-ep-inner {
  min-height: 0;
  overflow: visible;
  transition: overflow 0s var(--bbs-dur);
  transition-behavior: allow-discrete;
}
.bbs-vec-ep.is-collapsed .bbs-vec-ep-inner {
  overflow: hidden;
  transition-delay: 0s;
}
/* 向量后端类型标签:与摘要列表的「总结」标签同款(实心填充、白字),后端=强调色,本地降级=警告色 */
.bbs-vec-backend {
  box-sizing: border-box;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  font-size: 11px;
  font-weight: 600;
  border-radius: var(--bbs-radius-sm);
  white-space: nowrap;
}
.bbs-vec-backend.is-backend {
  color: var(--bbs-accent-ink);
  background: var(--bbs-accent);
  border: 1px solid var(--bbs-accent);
}
.bbs-vec-backend.is-local {
  color: var(--bbs-accent-ink);
  background: var(--bbs-warning);
  border: 1px solid var(--bbs-warning);
}

/* —— 上次召回详情(调试面板):状态横幅 + 步骤分区 + 分数条卡片 —— */
.bbs-dbg {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 状态横幅:左色点 + 文案 + 时间 */
.bbs-dbg-banner {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  border-left: 3px solid var(--bbs-line-strong);
}
.bbs-dbg-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bbs-ink-muted);
}
.bbs-dbg-banner.is-ok {
  border-left-color: var(--bbs-accent);
}
.bbs-dbg-banner.is-ok .bbs-dbg-dot {
  background: var(--bbs-accent);
}
.bbs-dbg-banner.is-warn {
  border-left-color: var(--bbs-warning);
}
.bbs-dbg-banner.is-warn .bbs-dbg-dot {
  background: var(--bbs-warning);
}
.bbs-dbg-banner.is-fail {
  border-left-color: var(--bbs-danger);
}
.bbs-dbg-banner.is-fail .bbs-dbg-dot {
  background: var(--bbs-danger);
}
.bbs-dbg-banner.is-pending .bbs-dbg-dot {
  background: var(--bbs-ink-soft);
}
.bbs-dbg-status-text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-dbg-time {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
}

.bbs-dbg-empty {
  margin: 0;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}

/* 索引维护:重建/清空按钮并排,窄屏自动换行 */
.bbs-vec-index-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}

/* 重写:INTENT 高亮 + Q 列表 */
.bbs-dbg-intent {
  display: flex;
  gap: 7px;
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-accent-soft);
  font-size: 12px;
  line-height: 1.6;
}
.bbs-dbg-intent-text {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-dbg-tag {
  flex: 0 0 auto;
  align-self: flex-start;
  padding: 1px 6px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
  font-family: var(--bbs-font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.3px;
}
.bbs-dbg-qlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bbs-dbg-qitem {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--bbs-ink);
}
.bbs-dbg-qno {
  flex: 0 0 auto;
  min-width: 22px;
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--bbs-accent);
}
.bbs-dbg-qtext {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}

/* 命中卡片列表:固定高度内滑动,长列表不把折叠区撑得很长。 */
.bbs-dbg-cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.bbs-dbg-card {
  padding: 8px 10px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
}
.bbs-dbg-card.is-dropped {
  opacity: 0.55;
}
.bbs-dbg-card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
/* 来源 Q 徽标 */
.bbs-dbg-src {
  flex: 0 0 auto;
  min-width: 38px; /* 与楼层号标签等宽,单数 Q 也不至于太窄 */
  text-align: center;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 700;
}
/* 来源标记:本聊天楼层号(中性)/ 旧档(描边提示色) */
.bbs-dbg-from {
  flex: 0 0 auto;
  min-width: 38px; /* 楼层号个位数(#5)也不至于太窄,与 Q 标签视觉等宽 */
  text-align: center;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-pill);
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line-strong);
}
.bbs-dbg-from.is-bundle {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
  border-color: transparent;
}
.bbs-dbg-when {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--bbs-ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bbs-dbg-num {
  flex: 0 0 auto;
  margin-left: auto;
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--bbs-ink);
  font-variant-numeric: tabular-nums;
}
/* 分数条:细轨 + 填充;默认强调色,rerank 各档分色 */
.bbs-dbg-bar {
  height: 4px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-line);
  overflow: hidden;
}
.bbs-dbg-bar > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--bbs-accent);
  transition: width var(--bbs-dur) var(--bbs-ease);
}
.bbs-dbg-bar.tier-brief > i {
  background: var(--bbs-ink-soft);
}
.bbs-dbg-bar.tier-drop > i {
  background: var(--bbs-ink-muted);
}
.bbs-dbg-prev {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--bbs-ink-muted);
  word-break: break-word;
}
/* 分档徽标:全文(强调实底)/摘要(中性)/丢弃(描边褪色) */
.bbs-dbg-tier {
  flex: 0 0 auto;
  min-width: 32px;
  text-align: center;
  padding: 1px 8px;
  border-radius: var(--bbs-radius-pill);
  font-size: 11px;
  font-weight: 700;
}
.bbs-dbg-tier.is-full {
  color: var(--bbs-accent-ink);
  background: var(--bbs-accent);
}
.bbs-dbg-tier.is-brief {
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line-strong);
}
.bbs-dbg-tier.is-drop {
  color: var(--bbs-ink-muted);
  background: transparent;
  border: 1px solid var(--bbs-line);
}
/* 注入文本框:等宽、限高滚动 */
.bbs-dbg-pre {
  margin: 0;
  padding: 10px 12px;
  max-height: 320px;
  overflow: auto;
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--bbs-ink);
}

/* —— 自定义提示词列表 —— */
.bbs-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 整行可点进弹窗编辑;布局沿用渠道列表的观感(描边、hover 显强调色) */
.bbs-prompt-open {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
  font-family: var(--bbs-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbs-dur) var(--bbs-ease), background var(--bbs-dur) var(--bbs-ease);
}
.bbs-prompt-open:hover {
  border-color: var(--bbs-accent);
  background: var(--bbs-surface);
}
.bbs-prompt-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}
/* 状态药丸:默认 muted,已自定义转金强调 */
.bbs-prompt-state {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbs-radius-pill);
  color: var(--bbs-ink-muted);
  background: var(--bbs-surface);
  border: 1px solid var(--bbs-line);
}
.bbs-prompt-state.is-custom {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
  border-color: transparent;
}
.bbs-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbs-ink-muted);
}
.bbs-prompt-open:hover .bbs-prompt-edit {
  color: var(--bbs-accent);
}

/* —— 提示词弹窗:更宽 + 大文本框 —— */
.bbs-modal-wide {
  max-width: 680px;
}
/* 宏标签条:可横向裹行,每个宏点击插入 */
.bbs-macro-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.bbs-macro-tip {
  font-size: 12px;
  color: var(--bbs-ink-muted);
  margin-right: 2px;
}
.bbs-macro {
  padding: 3px 9px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-soft);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  cursor: pointer;
  transition: color var(--bbs-dur) var(--bbs-ease), border-color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-macro:hover {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-prompt-area {
  resize: vertical;
  min-height: 240px;
  line-height: 1.6;
  font-family: var(--bbs-font-mono);
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}

/* —— 自定义清洗标签:输入框 + 添加按钮一行 —— */
.bbs-striptag-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}
.bbs-striptag-bar .bbs-input {
  flex: 1;
  min-width: 0;
}
.bbs-striptag-bar .bbs-btn {
  flex: none;
}

/* —— 排除角色:已排除名字以药丸形式平铺,点 × 移出 —— */
.bbs-exclude-chips {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.bbs-exclude-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 11px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  font-size: 12px;
  font-weight: 600;
}
.bbs-exclude-chip-name {
  word-break: break-word;
}
.bbs-exclude-chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  opacity: 0.7;
}
.bbs-exclude-chip-x:hover {
  opacity: 1;
  background: oklch(0 0 0 / 0.08);
}

/* 弹窗内角色勾选列表:固定高度内滚动,长名单不撑爆弹窗 */
.bbs-exclude-list {
  max-height: 46vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0;
  padding-right: 2px;
}
.bbs-exclude-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  border-radius: var(--bbs-radius-sm);
  cursor: pointer;
}
.bbs-exclude-row:hover {
  background: var(--bbs-surface-2);
}
.bbs-exclude-row-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-exclude-count {
  font-size: 12px;
  color: var(--bbs-ink-muted);
}

/* ============ 移动端:折叠区内部正文整体收一号,与窄屏标题节奏统一 ============ */
@media (max-width: 640px) {
  .bbs-field-label,
  .bbs-channel-item-name {
    font-size: 13px;
  }
  .bbs-prompt-name {
    font-size: 12px;
  }
  .bbs-field-hint,
  .bbs-channel-item-model {
    font-size: 11px;
  }
  .bbs-seg {
    font-size: 12px;
  }
  /* 渠道弹窗底部:测试按钮窄屏只显短版「测试」,PC 显完整「测试渠道」 */
  .bbs-btn-label-full {
    display: none;
  }
  .bbs-btn-label-short {
    display: inline;
  }
}
</style>
