<script setup lang="ts">
/**
 * 自定义变量页(MVU 式:一个 JSON 状态树 + 路径命令)。三块:
 *  ① 当前状态:AI 在剧情里用命令建/改出来的 JSON(派生,只读展示;可手动编辑整份 → 写回最新叶子)。
 *  ② 初始模板与说明:三层(全局/角色/聊天)各一份初始结构 + 给 AI 的说明,合并作为重放起点。
 *  ③ 导入/导出:分享变量结构(模板+说明,不含值)。
 * 值永远每聊天独立(从各聊天叶子的 varOps 重放);改模板不需摘要,改「当前值」需要有摘要(写最新叶子)。
 */
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import JsonTreeEditor from '@/components/JsonTreeEditor.vue';
import { currentCharKey } from '@/api/settings';
import { mergeTemplates, setVarsRoot } from '@/memory/apply';
import { refreshInjection } from '@/memory/inject';
import { derivedMeta, memory, replaceVarsTemplate } from '@/memory/store';
import type { JsonValue, VarTier } from '@/memory/types';
import { toast } from '@/st/toast';
import { computed, ref, watch } from 'vue';

const hasLeaf = computed(() => derivedMeta.hasLeaf);
// rev 每次重算派生(含切聊天/切角色)自增,借它让「是否有角色」「当前状态」随之刷新
const charAvailable = computed(() => { void derivedMeta.rev; return currentCharKey() !== null; });

const TIER_META: Record<VarTier, { label: string; hint: string }> = {
  global: { label: '全局', hint: '所有角色所有聊天共享初始模板' },
  char: { label: '角色', hint: '当前角色的所有聊天共享初始模板' },
  chat: { label: '聊天', hint: '仅当前聊天' },
};
const TIER_ORDER: VarTier[] = ['global', 'char', 'chat'];

/** 解析成 JSON 对象(根须是对象);失败返回 null。 */
function parseObj(text: string): Record<string, JsonValue> | null {
  try {
    const o = JSON.parse(text || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/* ============ 当前状态 ============ */
const stateJson = computed(() => {
  void derivedMeta.rev;
  try {
    return JSON.stringify(memory.vars, null, 2);
  } catch {
    return '{}';
  }
});
const hasState = computed(() => Object.keys(memory.vars).length > 0);

const editStateOpen = ref(false);
const stateEdit = ref('');
const stateEditErr = ref('');
function openEditState() {
  if (!hasLeaf.value) return;
  stateEdit.value = stateJson.value;
  stateEditErr.value = '';
  editStateOpen.value = true;
}
function saveState() {
  const json = parseObj(stateEdit.value);
  if (!json) { stateEditErr.value = 'JSON 无效或根不是对象 {…}'; return; }
  if (!setVarsRoot(json)) { stateEditErr.value = '保存失败:需要先有摘要才能写入'; return; }
  refreshInjection();
  editStateOpen.value = false;
}

/* ============ 初始模板与说明(三层) ============ */
const editorTier = ref<VarTier>('chat');
const editorMode = ref<'tree' | 'source'>('tree'); // 结构编辑器(默认)/ 源码
const editorTree = ref<Record<string, JsonValue>>({}); // 树形模式的工作副本
const editorJson = ref(''); // 源码模式文本
const editorMeaning = ref(''); // 含义:各字段是什么(主/副API都拿)
const editorRule = ref('');    // 变化规则:何时怎么改/可否新建(仅副API)
const jsonError = ref('');

function loadTier(t: VarTier) {
  const tpl = memory.varTemplates[t];
  editorTree.value = JSON.parse(JSON.stringify(tpl.json ?? {}));
  editorJson.value = Object.keys(tpl.json).length ? JSON.stringify(tpl.json, null, 2) : '{\n\n}';
  editorMeaning.value = tpl.meaning;
  editorRule.value = tpl.rule;
  jsonError.value = '';
}
function switchTier(t: VarTier) {
  if (t === 'char' && !charAvailable.value) return;
  editorTier.value = t;
  loadTier(t);
}
loadTier('chat'); // 初始载入聊天层

// 树形编辑改动 → 同步一份到源码文本(切到源码时不落后)
watch(editorTree, v => { editorJson.value = JSON.stringify(v, null, 2); }, { deep: true });

// 切模式:进树形时用源码文本重解析(接住用户在源码里的编辑);进源码时用树重渲染
function switchMode(m: 'tree' | 'source') {
  if (m === editorMode.value) return;
  if (m === 'tree') {
    const obj = parseObj(editorJson.value);
    if (!obj) { jsonError.value = '源码 JSON 无效,修正后才能切到结构视图'; return; }
    editorTree.value = obj;
    jsonError.value = '';
  } else {
    editorJson.value = JSON.stringify(editorTree.value, null, 2);
  }
  editorMode.value = m;
}

/** 取当前编辑中的 json(按模式来源);无效返回 null。 */
function currentEditorJson(): Record<string, JsonValue> | null {
  return editorMode.value === 'tree' ? editorTree.value : parseObj(editorJson.value);
}

function saveTemplate() {
  const t = editorTier.value;
  if (t === 'char' && !charAvailable.value) return;
  const json = currentEditorJson();
  if (!json) { jsonError.value = 'JSON 无效或根不是对象 {…}'; return; }
  jsonError.value = '';
  replaceVarsTemplate(t, { json, meaning: editorMeaning.value, rule: editorRule.value });
  refreshInjection();
  toast(`已保存${TIER_META[t].label}模板`, 'success');
}

/* ============ 导入 / 导出(模板+说明,不含值) ============ */
const exportOpen = ref(false);
const importOpen = ref(false);
const importText = ref('');
const importTier = ref<VarTier>('chat');

const exportText = computed(() => {
  const json = mergeTemplates(memory.varTemplates);
  const meaning = TIER_ORDER.map(t => memory.varTemplates[t].meaning.trim()).filter(Boolean).join('\n\n');
  const rule = TIER_ORDER.map(t => memory.varTemplates[t].rule.trim()).filter(Boolean).join('\n\n');
  return JSON.stringify({ app: 'ST-BaiBai-Book', kind: 'vars', version: 3, json, meaning, rule }, null, 2);
});
const hasAnyTemplate = computed(() => {
  void derivedMeta.rev;
  return TIER_ORDER.some(t => Object.keys(memory.varTemplates[t].json).length || memory.varTemplates[t].meaning.trim() || memory.varTemplates[t].rule.trim());
});

function openExport() {
  if (!hasAnyTemplate.value) return;
  exportOpen.value = true;
}
function openImport() {
  importText.value = '';
  importTier.value = 'chat';
  importOpen.value = true;
}
async function copyExport() {
  try {
    await navigator.clipboard.writeText(exportText.value);
    toast('已复制到剪贴板', 'success');
  } catch {
    toast('复制失败,请在框里手动选择复制', 'error');
  }
}
function downloadExport() {
  const blob = new Blob([exportText.value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'baibai-vars.json';
  a.click();
  URL.revokeObjectURL(url);
}
function onImportFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { importText.value = String(reader.result ?? ''); };
  reader.readAsText(f);
}
function applyImport() {
  let parsed: unknown;
  try { parsed = JSON.parse(importText.value); } catch { toast('JSON 解析失败,请检查', 'error'); return; }
  // 接受 {json,meaning,rule} 包裹(兼容旧 guide → 并入 rule),或裸对象(当作 json)
  let json: Record<string, JsonValue> = {};
  let meaning = '';
  let rule = '';
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    if (o.json && typeof o.json === 'object' && !Array.isArray(o.json)) {
      json = o.json as Record<string, JsonValue>;
      meaning = typeof o.meaning === 'string' ? o.meaning : '';
      rule = typeof o.rule === 'string' ? o.rule : '';
      if (!meaning && !rule && typeof o.guide === 'string') rule = o.guide; // 兼容旧单一说明
    } else if (!o.kind) {
      json = o as Record<string, JsonValue>; // 裸对象
    }
  }
  if (!Object.keys(json).length && !meaning.trim() && !rule.trim()) { toast('没解析到可导入的结构', 'error'); return; }
  let tier = importTier.value;
  if (tier === 'char' && !charAvailable.value) tier = 'chat';
  const cur = memory.varTemplates[tier];
  const mergedJson = { ...cur.json, ...json }; // 顶层浅合并(同名整体覆盖)
  const mergedMeaning = [cur.meaning.trim(), meaning.trim()].filter(Boolean).join('\n\n');
  const mergedRule = [cur.rule.trim(), rule.trim()].filter(Boolean).join('\n\n');
  replaceVarsTemplate(tier, { json: mergedJson, meaning: mergedMeaning, rule: mergedRule });
  refreshInjection();
  if (editorTier.value === tier) loadTier(tier); // 正在编辑该层则刷新编辑器
  importOpen.value = false;
  toast(`已导入到${TIER_META[tier].label}模板`, 'success');
}
</script>

<template>
  <section class="bbs-page">
    <div class="bbs-section-head">
      <h2 class="bbs-title bbs-title-sub">变量</h2>
      <div class="bbs-var-tools">
        <button class="bbs-add-mini" type="button" :disabled="!hasAnyTemplate" title="导出模板(分享)" @click="openExport">
          <Icon name="upload" />
        </button>
        <button class="bbs-add-mini" type="button" title="导入模板" @click="openImport">
          <Icon name="download" />
        </button>
      </div>
    </div>

    <hr class="bbs-rule" />

    <!-- 当前状态 -->
    <div class="bbs-var-blockhead">
      <span class="bbs-var-sub">当前状态</span>
      <button class="bbs-mini-btn" type="button" :disabled="!hasLeaf" title="手动编辑整份 JSON" @click="openEditState">
        <Icon name="edit" />编辑
      </button>
    </div>
    <pre v-if="hasState" class="bbs-json-view">{{ stateJson }}</pre>
    <p v-else class="bbs-var-emptyline">还没有变量状态。到下面定义初始模板,或让 AI 在剧情里自行创建(如新势力、新条目)。</p>
    <p v-if="hasState && !hasLeaf" class="bbs-modal-hint">改「当前值」需先有摘要;现在显示的是初始状态。</p>

    <!-- 初始模板与说明 -->
    <div class="bbs-var-blockhead bbs-var-tmplhead">
      <span class="bbs-var-sub">初始模板与说明</span>
    </div>
    <p class="bbs-modal-hint bbs-var-tmpltip">
      初始结构 + 给 AI 的说明。三层合并(聊天 &gt; 角色 &gt; 全局)作为重放起点,AI 在剧情里用命令增删改。改初始值会影响整条聊天的当前值。
    </p>

    <div class="bbs-typegrid bbs-var-tierpick">
      <button
        v-for="t in TIER_ORDER"
        :key="t"
        class="bbs-typebtn"
        :class="{ on: editorTier === t }"
        type="button"
        :disabled="t === 'char' && !charAvailable"
        @click="switchTier(t)"
      >
        {{ TIER_META[t].label }}
      </button>
    </div>
    <span class="bbs-modal-hint">
      {{ editorTier === 'char' && !charAvailable ? '当前无单一角色(群聊/未进入),暂不能编辑角色层' : TIER_META[editorTier].hint }}
    </span>

    <div class="bbs-modal-field">
      <div class="bbs-jte-fieldhead">
        <span class="bbs-modal-label">初始结构(可留空让 AI 从零建)</span>
        <div class="bbs-mode-toggle">
          <button class="bbs-mode-btn" :class="{ on: editorMode === 'tree' }" type="button" @click="switchMode('tree')">结构</button>
          <button class="bbs-mode-btn" :class="{ on: editorMode === 'source' }" type="button" @click="switchMode('source')">源码</button>
        </div>
      </div>
      <div v-if="editorMode === 'tree'" class="bbs-jte-wrap">
        <JsonTreeEditor v-model="editorTree" />
        <p v-if="!Object.keys(editorTree).length" class="bbs-jte-empty">空结构。点「加字段」搭出想追踪的结构,或留空让 AI 在剧情里自建。</p>
      </div>
      <textarea v-else v-model="editorJson" class="bbs-input bbs-json-edit" spellcheck="false" rows="7"></textarea>
      <span v-if="jsonError" class="bbs-json-err">{{ jsonError }}</span>
    </div>
    <label class="bbs-modal-field">
      <span class="bbs-modal-label">含义(各字段是什么;正文 AI 与摘要 AI 都会看到,用于理解当前值)</span>
      <textarea
        v-model="editorMeaning"
        class="bbs-input bbs-modal-textarea"
        rows="3"
        placeholder="如:势力 是一组势力对象,键=势力名,每个含 立场(中立/敌对/结盟)、声望(0-100)、领袖、据点。"
      ></textarea>
    </label>
    <label class="bbs-modal-field">
      <span class="bbs-modal-label">变化规则(何时怎么改、可否新建;只发摘要 AI,不进正文,避免正文复述变量)</span>
      <textarea
        v-model="editorRule"
        class="bbs-input bbs-modal-textarea"
        rows="3"
        placeholder="如:遇到新势力用 assign 在 势力 下新建;声望随事件用 add 调整。不确定就别动。"
      ></textarea>
    </label>
    <div class="bbs-modal-foot bbs-var-savefoot">
      <button
        class="bbs-btn bbs-btn-primary"
        type="button"
        :disabled="editorTier === 'char' && !charAvailable"
        @click="saveTemplate"
      >
        <Icon name="check" />保存{{ TIER_META[editorTier].label }}模板
      </button>
    </div>

    <!-- 编辑当前值 -->
    <ModalMask :open="editStateOpen" @close="editStateOpen = false">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑当前变量值">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑当前值</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="editStateOpen = false"><Icon name="close" /></button>
        </header>
        <p class="bbs-modal-hint">直接改整份 JSON,保存即写进最新摘要楼层(删该楼可回退)。</p>
        <textarea v-model="stateEdit" class="bbs-input bbs-json-edit bbs-io-area" spellcheck="false"></textarea>
        <span v-if="stateEditErr" class="bbs-json-err">{{ stateEditErr }}</span>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="editStateOpen = false">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="saveState">保存</button>
        </footer>
      </div>
    </ModalMask>

    <!-- 导出 -->
    <ModalMask :open="exportOpen" @close="exportOpen = false">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="导出变量模板">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">导出变量模板</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="exportOpen = false"><Icon name="close" /></button>
        </header>
        <p class="bbs-modal-hint">三层合并后的初始结构 + 说明(不含具体值)。复制发给别人即可分享。</p>
        <textarea class="bbs-input bbs-json-edit bbs-io-area" readonly :value="exportText"></textarea>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="downloadExport"><Icon name="download" />下载文件</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="copyExport"><Icon name="check" />复制</button>
        </footer>
      </div>
    </ModalMask>

    <!-- 导入 -->
    <ModalMask :open="importOpen" @close="importOpen = false">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="导入变量模板">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">导入变量模板</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="importOpen = false"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">粘贴模板 JSON</span>
          <textarea v-model="importText" class="bbs-input bbs-json-edit bbs-io-area" spellcheck="false" placeholder="把分享来的变量模板 JSON 粘到这里,或用下面的文件选择"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">或从文件导入</span>
          <input class="bbs-input" type="file" accept="application/json,.json" @change="onImportFile" />
        </label>
        <div class="bbs-modal-field">
          <span class="bbs-modal-label">导入到哪层</span>
          <div class="bbs-typegrid">
            <button
              v-for="t in TIER_ORDER"
              :key="t"
              class="bbs-typebtn"
              :class="{ on: importTier === t }"
              type="button"
              :disabled="t === 'char' && !charAvailable"
              @click="importTier = t"
            >
              {{ TIER_META[t].label }}
            </button>
          </div>
          <span class="bbs-modal-hint">合并进该层模板(顶层同名字段会被覆盖);说明会追加。</span>
        </div>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="importOpen = false">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!importText.trim()" @click="applyImport">导入</button>
        </footer>
      </div>
    </ModalMask>
  </section>
</template>

<style scoped>
/* 不设 height:100% —— 本页是自然文档流,靠 .bbs-body 滚动。
   钉死高度会让 flex 列把「当前状态」pre(自带 overflow)挤到几乎没高度,什么都看不到。 */
.bbs-page {
  display: flex;
  flex-direction: column;
}
.bbs-var-tools {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

/* 小节标题行 */
.bbs-var-blockhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.bbs-var-tmplhead {
  margin-top: 22px;
}
.bbs-var-sub {
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-ink);
  letter-spacing: 0.02em;
}
.bbs-mini-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-ink-soft);
  font-size: 12px;
  cursor: pointer;
}
.bbs-mini-btn:hover:not(:disabled) {
  border-color: var(--bbs-accent);
  color: var(--bbs-accent);
}
.bbs-mini-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 当前状态 JSON 视图 */
.bbs-json-view {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-soft);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  min-height: 160px;
  max-height: 60vh;
  overflow-y: auto;
}
.bbs-var-emptyline {
  margin: 0;
  padding: 14px;
  border: 1px dashed var(--bbs-line-strong);
  border-radius: var(--bbs-radius);
  color: var(--bbs-ink-muted);
  font-size: 12.5px;
  line-height: 1.6;
}
.bbs-var-tmpltip {
  margin-top: -2px;
  margin-bottom: 10px;
}

.bbs-var-tierpick {
  margin-bottom: 6px;
}
.bbs-typegrid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bbs-typebtn {
  flex: 1 1 auto;
  padding: 7px 10px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-ink-soft);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--bbs-dur) var(--bbs-ease), border-color var(--bbs-dur) var(--bbs-ease), color var(--bbs-dur) var(--bbs-ease);
}
.bbs-typebtn:hover:not(:disabled) {
  border-color: var(--bbs-accent);
  color: var(--bbs-accent);
}
.bbs-typebtn.on {
  background: var(--bbs-accent);
  border-color: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
.bbs-typebtn:disabled {
  opacity: 0.5;
  cursor: default;
}

.bbs-json-edit {
  resize: vertical;
  min-height: 120px;
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre;
}
/* 结构 / 源码 模式切换 */
.bbs-jte-fieldhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.bbs-mode-toggle {
  display: inline-flex;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  overflow: hidden;
}
.bbs-mode-btn {
  padding: 4px 12px;
  border: 0;
  background: var(--bbs-surface);
  color: var(--bbs-ink-muted);
  font-size: 12px;
  cursor: pointer;
}
.bbs-mode-btn.on {
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
.bbs-jte-wrap {
  padding: 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
}
.bbs-jte-empty {
  margin: 0;
  font-size: 12px;
  color: var(--bbs-ink-muted);
  line-height: 1.6;
}
.bbs-json-err {
  font-size: 11.5px;
  color: var(--bbs-danger);
}
.bbs-modal-textarea {
  resize: vertical;
  min-height: 56px;
  font-family: inherit;
}
.bbs-modal-hint {
  font-size: 11.5px;
  color: var(--bbs-ink-muted);
  line-height: 1.55;
}
.bbs-var-savefoot {
  margin-top: 12px;
}
.bbs-io-area {
  min-height: 200px;
}
</style>
