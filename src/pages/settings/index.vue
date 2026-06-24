<script setup lang="ts">
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { fetchModels, testChannel } from '@/api/client';
import { apiSettings, newChannel, type ApiChannel } from '@/api/settings';
import { ui, THEMES, type NavPosition } from '@/state/ui';
import { ref } from 'vue';

const navOptions: { value: NavPosition; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'top', label: '顶部' },
  { value: 'bottom', label: '底部' },
];

function addChannel() {
  apiSettings.channels.push(newChannel());
}
function removeChannel(id: string) {
  const idx = apiSettings.channels.findIndex(c => c.id === id);
  if (idx >= 0) apiSettings.channels.splice(idx, 1);
  // 清理指派
  if (apiSettings.assignments.summary === id) apiSettings.assignments.summary = '';
  if (apiSettings.assignments.resummary === id) apiSettings.assignments.resummary = '';
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
</script>

<template>
  <section class="bbs-page">
    <h2 class="bbs-title">设置</h2>
    <hr class="bbs-rule" />

    <div class="bbs-sections">
      <!-- 基本设置 -->
      <Collapsible title="基本设置" :open="true">
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
        <p class="bbs-field-hint">配置独立于主对话的 API,用于摘要与总结。请求经 SillyTavern 服务端转发,无需担心跨域。</p>

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

        <!-- 渠道列表 -->
        <div v-for="ch in apiSettings.channels" :key="ch.id" class="bbs-channel">
          <div class="bbs-channel-head">
            <input v-model="ch.name" class="bbs-input bbs-channel-name" placeholder="渠道名" />
            <button class="bbs-icon-mini" type="button" title="测试连通" @click="doTest(ch)">
              <Icon name="plug" />
            </button>
            <button class="bbs-icon-mini" type="button" title="删除" @click="removeChannel(ch.id)">
              <Icon name="close" />
            </button>
          </div>
          <input v-model="ch.url" class="bbs-input" placeholder="API 地址,如 https://api.openai.com/v1" />
          <input v-model="ch.key" class="bbs-input" type="password" placeholder="API 密钥" />
          <!-- 模型:可拉取下拉,也可手填 -->
          <div class="bbs-model-row">
            <select v-if="models[ch.id]?.length" v-model="ch.model" class="bbs-input">
              <option v-for="m in models[ch.id]" :key="m" :value="m">{{ m }}</option>
            </select>
            <input v-else v-model="ch.model" class="bbs-input" placeholder="模型名,如 gpt-4o-mini" />
            <button
              class="bbs-icon-mini"
              type="button"
              :title="loadingModels[ch.id] ? '拉取中…' : '拉取模型'"
              :disabled="loadingModels[ch.id]"
              @click="pullModels(ch)"
            >
              <Icon name="refresh" />
            </button>
          </div>
          <div class="bbs-channel-row">
            <label class="bbs-mini-field">
              <span>温度</span>
              <input v-model.number="ch.temperature" class="bbs-input" type="number" step="0.1" min="0" max="2" />
            </label>
            <label class="bbs-mini-field">
              <span>最大 token</span>
              <input v-model.number="ch.maxTokens" class="bbs-input" type="number" step="256" min="256" />
            </label>
          </div>
          <p v-if="testing[ch.id]" class="bbs-channel-test">{{ testing[ch.id] }}</p>
        </div>

        <button class="bbs-btn" type="button" @click="addChannel">
          <Icon name="plug" /> 添加渠道
        </button>
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

      <!-- 向量记忆(待填充) -->
      <Collapsible title="向量记忆" :open="false">
        <p class="bbs-field-hint">即将开放。</p>
      </Collapsible>
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
}

/* 渠道卡片 */
.bbs-channel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  margin-bottom: 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface-2);
}
.bbs-channel-head {
  display: flex;
  gap: 8px;
  align-items: center;
}
.bbs-channel-name {
  flex: 1;
  font-weight: 600;
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
</style>
