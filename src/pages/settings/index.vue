<script setup lang="ts">
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { fetchModels, testChannel } from '@/api/client';
import { apiSettings, newChannel, type ApiChannel } from '@/api/settings';
import {
  RESUMMARY_MACROS,
  RESUMMARY_PROMPT,
  SUMMARY_MACROS,
  SUMMARY_PROMPT,
  type PromptMacro,
} from '@/memory/prompts';
import { ui, THEMES, type NavPosition } from '@/state/ui';
import { computed, nextTick, ref } from 'vue';

const navOptions: { value: NavPosition; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'top', label: '顶部' },
  { value: 'bottom', label: '底部' },
];

/* —— 渠道:列表只读展示,编辑/新建都在弹窗里进行,避免一长列表单平铺误触 —— */
const editingId = ref<string | null>(null);
const editingChannel = computed(() => apiSettings.channels.find(c => c.id === editingId.value) ?? null);
// 密钥默认隐藏;每次打开/关闭弹窗都复位,避免密钥意外保持明文
const showKey = ref(false);

function addChannel() {
  const ch = newChannel();
  apiSettings.channels.push(ch);
  showKey.value = false;
  editingId.value = ch.id; // 新建即进入编辑弹窗
}
function openChannel(id: string) {
  showKey.value = false;
  editingId.value = id;
}
function closeChannel() {
  showKey.value = false;
  editingId.value = null;
}
function removeChannel(id: string) {
  const idx = apiSettings.channels.findIndex(c => c.id === id);
  if (idx >= 0) apiSettings.channels.splice(idx, 1);
  // 清理指派
  if (apiSettings.assignments.summary === id) apiSettings.assignments.summary = '';
  if (apiSettings.assignments.resummary === id) apiSettings.assignments.resummary = '';
  if (editingId.value === id) editingId.value = null;
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

/* —— 自定义提示词:列表(摘要/总结/破限),点开在弹窗里编辑大文本 —— */
type PromptKey = 'summary' | 'resummary' | 'jailbreak';
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
    hint: '把多条楼层摘要压缩成一条更上层的总结。',
    builtin: RESUMMARY_PROMPT,
    macros: RESUMMARY_MACROS,
  },
  {
    key: 'jailbreak',
    label: '破限提示词',
    hint: '附加在摘要/总结请求里的破限内容。留空则不附加。',
    builtin: '',
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
</script>

<template>
  <section class="bbs-page">
    <h2 class="bbs-title bbs-title-sub">设置</h2>
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
      </Collapsible>

      <!-- 副 API -->
      <Collapsible title="副 API" :open="false">
        <!-- 任务指派 -->
        <div class="bbs-field bbs-assign">
          <label class="bbs-assign-row">
            <span class="bbs-field-label">摘要使用</span>
            <select v-model="apiSettings.assignments.summary" class="bbs-input bbs-select">
              <option value="">— 未指派 —</option>
              <option v-for="c in apiSettings.channels" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
          <label class="bbs-assign-row">
            <span class="bbs-field-label">总结使用</span>
            <select v-model="apiSettings.assignments.resummary" class="bbs-input bbs-select">
              <option value="">— 未指派 —</option>
              <option v-for="c in apiSettings.channels" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
        </div>

        <hr class="bbs-rule" />

        <!-- 渠道:顶部添加按钮 + 紧凑只读列表(点行进弹窗编辑),不再一长列表单平铺 -->
        <div class="bbs-channel-bar">
          <span class="bbs-field-label">渠道</span>
          <button class="bbs-btn bbs-btn-primary bbs-btn-sm" type="button" @click="addChannel">
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
        <label class="bbs-switch-row">
          <span class="bbs-field-label">自动隐藏已摘要消息</span>
          <input v-model="apiSettings.autoHide" type="checkbox" class="bbs-checkbox" />
        </label>
        <p class="bbs-field-hint">关闭后仅生成摘要、不隐藏原文(原文与摘要会重复占用上下文)。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">保留最近 AI 消息数</span>
          <input v-model.number="apiSettings.keepRecent" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">滑动窗口:最近 N 条 AI 消息发送全文;更早的自动生成摘要并从主对话隐藏,摘要会以系统提示注入回上下文,主模型仍可感知。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">摘要压成总结阈值(0=关闭)</span>
          <input v-model.number="apiSettings.leafBatchThreshold" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">楼层摘要积累到这么多条时,把它们压成一条上层「总结」(底层摘要保留,可随时删总结展开)。</p>
        <label class="bbs-num-row">
          <span class="bbs-field-label">总结再压缩阈值(0=关闭)</span>
          <input v-model.number="apiSettings.resummaryThreshold" class="bbs-input bbs-num" type="number" min="0" />
        </label>
        <p class="bbs-field-hint">总结(及更高层)积累到这么多条时,继续向上压成更高一层总结,逐级递归。</p>
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

      <!-- 向量记忆(待填充) -->
      <Collapsible title="向量记忆" :open="false">
        <p class="bbs-field-hint">即将开放。</p>
      </Collapsible>
    </div>

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
            <select v-if="models[editingChannel.id]?.length" v-model="editingChannel.model" class="bbs-input">
              <option v-for="m in models[editingChannel.id]" :key="m" :value="m">{{ m }}</option>
            </select>
            <input v-else v-model="editingChannel.model" class="bbs-input" placeholder="模型名,如 gpt-4o-mini" />
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
        <p v-if="testing[editingChannel.id]" class="bbs-channel-test">{{ testing[editingChannel.id] }}</p>

        <footer class="bbs-modal-foot">
          <!-- 删除靠左、与右侧主操作拉开,破坏性动作不与「完成」相邻,降低误触 -->
          <button class="bbs-btn bbs-btn-danger" type="button" @click="removeChannel(editingChannel.id)">
            <Icon name="trash" /> 删除
          </button>
          <span class="bbs-modal-foot-spacer"></span>
          <button class="bbs-btn" type="button" @click="doTest(editingChannel)">
            <Icon name="plug" /> 测试连通
          </button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="closeChannel">完成</button>
        </footer>
      </div>
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

.bbs-field {
  margin-bottom: 18px;
}
.bbs-field:last-child {
  margin-bottom: 0;
}
.bbs-field-head {
  margin-bottom: 10px;
}
.bbs-field-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
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

/* 小一号按钮:用于「添加渠道」等次级操作 */
.bbs-btn-sm {
  padding: 6px 11px;
  font-size: 12px;
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
  font-size: 14px;
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

/* ============ 移动端:折叠区内部正文整体收一号,与窄屏标题节奏统一 ============ */
@media (max-width: 640px) {
  .bbs-field-label,
  .bbs-channel-item-name,
  .bbs-prompt-name {
    font-size: 13px;
  }
  .bbs-field-hint,
  .bbs-channel-item-model {
    font-size: 11px;
  }
  .bbs-seg {
    font-size: 12px;
  }
}
</style>
