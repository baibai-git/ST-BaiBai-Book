<script setup lang="ts">
import { apiSettings } from '@/api/settings';
import Icon from '@/components/Icon.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ModalMask from '@/components/ModalMask.vue';
import SummaryOnlyNotice from '@/components/SummaryOnlyNotice.vue';
import { classifyNpcPresence, editNpc, removeNpc, setNpcFollow, setNpcImportant, setProtagonist, upsertNpc } from '@/memory/apply';
import { derivedMeta, memory } from '@/memory/store';
import type { MemNpc } from '@/memory/types';
import { getContext } from '@/st/context';
import { computed, nextTick, ref } from 'vue';

// NPC 是从叶子摘要重放出的派生数据,手动操作写入「最新一条有效叶子」;无有效叶子时无处挂载。
const hasLeaf = computed(() => derivedMeta.hasLeaf);
const protagonistName = computed(() => {
  void derivedMeta.rev;
  return getContext()?.name1?.trim() || '主角';
});
const protagonistHasData = computed(() => Object.values(memory.protagonist).some(value => !!value?.trim()));
const protagonistHasDetails = computed(() => [
  memory.protagonist.identity,
  memory.protagonist.appearance,
  memory.protagonist.outfit,
  memory.protagonist.condition,
].some(value => !!value?.trim()));

interface ProtagonistDraft {
  gender: string;
  identity: string;
  appearance: string;
  outfit: string;
  condition: string;
}
const protagonistEditing = ref<ProtagonistDraft | null>(null);

function openProtagonistEdit() {
  if (!hasLeaf.value) return;
  protagonistEditing.value = {
    gender: memory.protagonist.gender ?? '',
    identity: memory.protagonist.identity ?? '',
    appearance: memory.protagonist.appearance ?? '',
    outfit: memory.protagonist.outfit ?? '',
    condition: memory.protagonist.condition ?? '',
  };
}
function cancelProtagonistEdit() {
  protagonistEditing.value = null;
}
function saveProtagonistEdit() {
  const draft = protagonistEditing.value;
  if (!draft) return;
  if (setProtagonist({ ...draft })) protagonistEditing.value = null;
}

// 触屏判定:跳过弹窗自动聚焦(移动端自动聚焦会弹输入法挡界面),与场景/摘要页一致。
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

// 在场分档:与注入端(inject.ts)共用同一权威 classifyNpcPresence —— 读 location + locationPath,
// 杜绝两套逻辑漂移,确保「界面显示的 = AI 收到的」。四档:
//   主要角色(置顶,不论在场)/ 在场(全量)/ 同区域(名+身份+性格)/ 不在场(名+身份)。
const sortByCreated = (a: MemNpc, b: MemNpc) => a.createdAt - b.createdAt;

// 单趟分桶:每个非主要角色只判一次在场,避免三个 computed 各判一遍。
const buckets = computed(() => {
  const present: MemNpc[] = [];
  const nearby: MemNpc[] = [];
  const absent: MemNpc[] = [];
  const here = memory.state.location || '';
  const locPath = memory.state.locationPath;
  for (const n of memory.npcs) {
    if (n.important) continue; // 主要角色单列,不进在场判定
    const p = classifyNpcPresence(n, memory.scenes, here, locPath);
    (p === 'present' ? present : p === 'nearby' ? nearby : absent).push(n);
  }
  present.sort(sortByCreated);
  nearby.sort(sortByCreated);
  absent.sort(sortByCreated);
  return { present, nearby, absent };
});
const mains = computed(() => memory.npcs.filter(n => n.important).sort(sortByCreated));
const present = computed(() => buckets.value.present);
const nearby = computed(() => buckets.value.nearby);
const absent = computed(() => buckets.value.absent);

/* —— 随行一键开关:随行→取消(留在当前地点);非随行→标记随行 —— */
function toggleFollow(npc: MemNpc) {
  if (npc.follow === true) {
    // 取消随行:留在当前所在地(无则留空,成为无位置的游离 NPC)
    setNpcFollow(npc.name, false, memory.state.location || '');
  } else {
    setNpcFollow(npc.name, true);
  }
}

/* —— 主要角色一键升/降 —— */
function toggleImportant(npc: MemNpc) {
  setNpcImportant(npc.name, !npc.important);
}

function askRemove(npc: MemNpc) {
  removing.value = npc;
}

/* —— 新增弹窗 —— */
const composerOpen = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);
interface NpcDraft {
  name: string;
  gender: string;
  title: string;
  personality: string;
  desc: string;
  outfit: string;
  condition: string;
  important: boolean;
  follow: boolean;
  location: string;
}
function emptyDraft(): NpcDraft {
  return { name: '', gender: '', title: '', personality: '', desc: '', outfit: '', condition: '', important: false, follow: false, location: memory.state.location || '' };
}
const draft = ref<NpcDraft>(emptyDraft());

function openComposer() {
  if (!hasLeaf.value) return;
  draft.value = emptyDraft();
  composerOpen.value = true;
  if (!isTouch) void nextTick(() => nameInput.value?.focus());
}
function closeComposer() {
  composerOpen.value = false;
}
function addNpc() {
  const d = draft.value;
  if (!d.name.trim()) return;
  const ok = upsertNpc({
    name: d.name,
    gender: d.gender,
    title: d.title,
    personality: d.personality,
    desc: d.desc,
    outfit: d.outfit,
    condition: d.condition,
    important: d.important,
    follow: d.follow,
    location: d.follow ? '' : d.location,
  });
  if (!ok) return;
  composerOpen.value = false;
}

/* —— 编辑弹窗 —— */
interface NpcEditing extends NpcDraft {
  oldName: string;
}
const editing = ref<NpcEditing | null>(null);

function openEdit(npc: MemNpc) {
  editing.value = {
    oldName: npc.name,
    name: npc.name,
    gender: npc.gender ?? '',
    title: npc.title ?? '',
    personality: npc.personality ?? '',
    desc: npc.desc ?? '',
    outfit: npc.outfit ?? '',
    condition: npc.condition ?? '',
    important: npc.important === true,
    follow: npc.follow === true,
    location: npc.location ?? '',
  };
}
function cancelEdit() {
  editing.value = null;
}
function saveEdit() {
  const e = editing.value;
  if (!e || !e.name.trim()) return;
  editNpc(e.oldName, {
    name: e.name,
    gender: e.gender,
    title: e.title,
    personality: e.personality,
    desc: e.desc,
    outfit: e.outfit,
    condition: e.condition,
    important: e.important,
    follow: e.follow,
    location: e.follow ? '' : e.location,
  });
  editing.value = null;
}

/* —— 删除确认 —— */
const removing = ref<MemNpc | null>(null);
function confirmRemove() {
  if (removing.value) removeNpc(removing.value.name);
  removing.value = null;
}
</script>

<template>
  <section class="bbs-page">
    <div class="bbs-section-head">
      <h2 class="bbs-title bbs-title-sub">角色</h2>
      <button
        class="bbs-add-mini"
        type="button"
        :disabled="!hasLeaf"
        :title="hasLeaf ? '手动添加角色' : '需先有摘要才能手动添加'"
        @click="openComposer"
      >
        <Icon name="plus" />
      </button>
    </div>
    <SummaryOnlyNotice subject="主角档案、NPC 名册与角色状态" />

    <hr class="bbs-rule" />

    <div class="bbs-protagonist-section">
      <div class="bbs-npc-grouphead">
        <span class="bbs-npc-grouptag is-protagonist"><Icon name="characters" />主角</span>
        <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
          {{ apiSettings.summaryOnlyMode ? '仅供柏宝书记录，不发送给主对话 AI' : '始终完整发送,与 NPC 名册分开记录' }}
        </span>
      </div>
      <article class="bbs-npc bbs-protagonist">
        <div class="bbs-npc-body">
          <div class="bbs-npc-head">
            <span class="bbs-npc-name">{{ protagonistName }}</span>
            <span v-if="memory.protagonist.gender" class="bbs-npc-gender">{{ memory.protagonist.gender }}</span>
            <span class="bbs-npc-acts">
              <button
                class="bbs-item-act"
                type="button"
                :disabled="!hasLeaf"
                :title="hasLeaf ? '编辑主角当前档案' : '需先有摘要才能编辑'"
                @click="openProtagonistEdit"
              >
                <Icon name="edit" />
              </button>
            </span>
          </div>
          <dl v-if="protagonistHasDetails" class="bbs-npc-fields">
            <div v-if="memory.protagonist.identity" class="bbs-npc-field f-title"><dt>身份</dt><dd>{{ memory.protagonist.identity }}</dd></div>
            <div v-if="memory.protagonist.appearance" class="bbs-npc-field f-desc"><dt>外貌</dt><dd>{{ memory.protagonist.appearance }}</dd></div>
            <div v-if="memory.protagonist.outfit" class="bbs-npc-field f-outfit"><dt>着装</dt><dd>{{ memory.protagonist.outfit }}</dd></div>
            <div v-if="memory.protagonist.condition" class="bbs-npc-field f-cond"><dt>状态</dt><dd>{{ memory.protagonist.condition }}</dd></div>
          </dl>
          <p v-else-if="!protagonistHasData" class="bbs-npc-mainhint">尚无主角状态记录。后续摘要会从剧情中的明确事实逐步补充。</p>
        </div>
      </article>
    </div>

    <div v-if="memory.npcs.length" class="bbs-npc-groups">
      <!-- 主要角色:核心主演,永远全量发送。这里突出「即时状态面板」(着装/状态/所在),弱化身份档案 -->
      <div v-if="mains.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-main"><Icon name="star" />主要角色</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? '仍会重点维护状态，但不发送给主对话 AI' : '始终随剧情发送,重点维护当前状态' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in mains" :key="n.id" class="bbs-npc is-present is-main">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name">{{ n.name }}</span>
                <span v-if="n.gender" class="bbs-npc-gender">{{ n.gender }}</span>
                <span v-if="n.title" class="bbs-npc-flag">{{ n.title }}</span>
                <span class="bbs-npc-acts">
                  <button class="bbs-item-act bbs-npc-star active" type="button" title="主要角色 · 点击取消" @click="toggleImportant(n)"><Icon name="star" /></button>
                  <button class="bbs-item-act" type="button" title="编辑" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl v-if="n.outfit || n.condition || n.follow || n.location" class="bbs-npc-fields">
                <div v-if="n.outfit" class="bbs-npc-field f-outfit"><dt>着装</dt><dd>{{ n.outfit }}</dd></div>
                <div v-if="n.condition" class="bbs-npc-field f-cond"><dt>状态</dt><dd>{{ n.condition }}</dd></div>
                <div v-if="n.follow || n.location" class="bbs-npc-field f-loc">
                  <dt>所在</dt><dd>{{ n.follow ? '随主角同行' : n.location }}</dd>
                </div>
              </dl>
              <p v-else class="bbs-npc-mainhint">尚无状态记录 —— 编辑可补充当前着装 / 状态 / 所在。</p>
            </div>
          </article>
        </div>
      </div>

      <!-- 在场:随行 / 所在当前场景。全量信息发给 AI,这里也全量展示 -->
      <div v-if="present.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-present">在场</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? '仍按在场状态完整记录，但不发送给主对话 AI' : '完整信息随剧情发送' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in present" :key="n.id" class="bbs-npc is-present" :class="{ 'is-follow': n.follow }">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name">{{ n.name }}</span>
                <span v-if="n.gender" class="bbs-npc-gender">{{ n.gender }}</span>
                <span v-if="n.follow" class="bbs-npc-flag is-follow"><Icon name="pin" />随行</span>
                <span v-else-if="n.location" class="bbs-npc-flag"><Icon name="scenes" />{{ n.location }}</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-star"
                    type="button"
                    :title="apiSettings.summaryOnlyMode ? '标记为主要角色(仅调整柏宝书内的角色分组)' : '标记为主要角色(始终全量发送、追踪状态)'"
                    @click="toggleImportant(n)"
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    :class="{ active: n.follow }"
                    type="button"
                    :title="n.follow ? '随行中 · 点击取消(留在当前地点)' : '标记为随行同伴'"
                    @click="toggleFollow(n)"
                  >
                    <Icon name="pin" />
                  </button>
                  <button class="bbs-item-act" type="button" title="编辑" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl v-if="n.title || n.personality || n.desc || n.outfit || n.condition" class="bbs-npc-fields">
                <div v-if="n.title" class="bbs-npc-field f-title"><dt>身份</dt><dd>{{ n.title }}</dd></div>
                <div v-if="n.outfit" class="bbs-npc-field f-outfit"><dt>着装</dt><dd>{{ n.outfit }}</dd></div>
                <div v-if="n.condition" class="bbs-npc-field f-cond"><dt>状态</dt><dd>{{ n.condition }}</dd></div>
                <div v-if="n.personality" class="bbs-npc-field f-trait"><dt>性格</dt><dd>{{ n.personality }}</dd></div>
                <div v-if="n.desc" class="bbs-npc-field f-desc"><dt>外貌</dt><dd>{{ n.desc }}</dd></div>
              </dl>
            </div>
          </article>
        </div>
      </div>

      <!-- 同区域:在附近但未必照面。发名+身份+性格给 AI,这里也只展示这三样 -->
      <div v-if="nearby.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-nearby">同区域</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? '仍按同区域分档记录，但不发送给主对话 AI' : '在附近,发送名字、身份与性格' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in nearby" :key="n.id" class="bbs-npc is-nearby">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name">{{ n.name }}</span>
                <span v-if="n.gender" class="bbs-npc-gender">{{ n.gender }}</span>
                <span v-if="n.location" class="bbs-npc-flag"><Icon name="scenes" />{{ n.location }}</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-star"
                    type="button"
                    :title="apiSettings.summaryOnlyMode ? '标记为主要角色(仅调整柏宝书内的角色分组)' : '标记为主要角色(始终全量发送、追踪状态)'"
                    @click="toggleImportant(n)"
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    type="button"
                    title="标记为随行同伴(将随主角在场)"
                    @click="toggleFollow(n)"
                  >
                    <Icon name="pin" />
                  </button>
                  <button class="bbs-item-act" type="button" title="编辑" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl v-if="n.title || n.personality" class="bbs-npc-fields">
                <div v-if="n.title" class="bbs-npc-field f-title"><dt>身份</dt><dd>{{ n.title }}</dd></div>
                <div v-if="n.personality" class="bbs-npc-field f-trait"><dt>性格</dt><dd>{{ n.personality }}</dd></div>
              </dl>
            </div>
          </article>
        </div>
      </div>

      <!-- 不在场:只发名+身份给 AI,这里也压暗、收起细节 -->
      <div v-if="absent.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag">不在场</span>
          <span class="bbs-npc-grouphint" :class="{ 'is-local-only': apiSettings.summaryOnlyMode }">
            {{ apiSettings.summaryOnlyMode ? '仍保留名册分档，但不发送给主对话 AI' : '仅发送名字与身份,省 token' }}
          </span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in absent" :key="n.id" class="bbs-npc is-absent">
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name">{{ n.name }}</span>
                <span v-if="n.gender" class="bbs-npc-gender">{{ n.gender }}</span>
                <span v-if="n.location" class="bbs-npc-flag"><Icon name="scenes" />{{ n.location }}</span>
                <span v-else class="bbs-npc-flag is-nowhere">所在不明</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-star"
                    type="button"
                    :title="apiSettings.summaryOnlyMode ? '标记为主要角色(仅调整柏宝书内的角色分组)' : '标记为主要角色(始终全量发送、追踪状态)'"
                    @click="toggleImportant(n)"
                  >
                    <Icon name="star" />
                  </button>
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    type="button"
                    title="标记为随行同伴(将随主角在场)"
                    @click="toggleFollow(n)"
                  >
                    <Icon name="pin" />
                  </button>
                  <button class="bbs-item-act" type="button" title="编辑" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <dl v-if="n.title" class="bbs-npc-fields">
                <div class="bbs-npc-field f-title"><dt>身份</dt><dd>{{ n.title }}</dd></div>
              </dl>
            </div>
          </article>
        </div>
      </div>
    </div>

    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="npcs" /></span>
      <p>还没有登场的 NPC。摘要时会记下与主角有交集的人物,也可点右上角「+」手动添加。</p>
    </div>

    <ModalMask :open="!!protagonistEditing" @close="cancelProtagonistEdit">
      <div v-if="protagonistEditing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑主角档案">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑主角档案</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="cancelProtagonistEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">性别</span>
          <input v-model="protagonistEditing.gender" class="bbs-input" type="text" placeholder="如:男、女" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前身份 / 职业 / 种族 / 公开地位</span>
          <textarea v-model="protagonistEditing.identity" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">稳定外貌 / 身体特征</span>
          <textarea v-model="protagonistEditing.appearance" class="bbs-input bbs-modal-textarea" rows="2" placeholder="如:黑色短发、左眉有疤"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前着装</span>
          <textarea v-model="protagonistEditing.outfit" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前身体状态 / 健康</span>
          <textarea v-model="protagonistEditing.condition" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="无异常时留空"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelProtagonistEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="saveProtagonistEdit">保存</button>
        </footer>
      </div>
    </ModalMask>

    <!-- 添加弹窗:position:fixed 内联(不用 Teleport,见 base.css 说明) -->
    <ModalMask :open="composerOpen" @close="closeComposer">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="添加角色">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">添加角色</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="closeComposer"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">名字</span>
          <input ref="nameInput" v-model="draft.name" class="bbs-input" type="text" placeholder="角色名" @keydown.enter="addNpc" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">性别</span>
          <input v-model="draft.gender" class="bbs-input" type="text" placeholder="如:男、女" @keydown.enter="addNpc" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">身份(职业 / 与主角的关系)</span>
          <textarea v-model="draft.title" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:归雁客栈掌柜、青梅竹马"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">性格</span>
          <textarea v-model="draft.personality" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:沉默寡言、护短"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">外貌描述(固定特征:发色 / 身材 / 疤痕,勿写穿着)</span>
          <textarea v-model="draft.desc" class="bbs-input bbs-modal-textarea" rows="2" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前着装(会随剧情变化)</span>
          <textarea v-model="draft.outfit" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:红斗篷、佩长剑"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前状态(受伤 / 疲惫等,无则留空)</span>
          <textarea v-model="draft.condition" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="draft.important" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">
            {{ apiSettings.summaryOnlyMode ? '主要角色(核心主演,仅在柏宝书内重点追踪状态)' : '主要角色(核心主演,始终全量发送、重点追踪状态)' }}
          </span>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="draft.follow" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">随行同伴(跟随主角移动,永远在场)</span>
        </label>
        <label v-if="!draft.follow" class="bbs-modal-field">
          <span class="bbs-modal-label">所在地点</span>
          <textarea v-model="draft.location" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:归雁客栈、王宫"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="closeComposer">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!draft.name.trim()" @click="addNpc">添加</button>
        </footer>
      </div>
    </ModalMask>

    <!-- 编辑弹窗 -->
    <ModalMask :open="!!editing" @close="cancelEdit">
      <div v-if="editing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑角色">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑角色</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="cancelEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">名字</span>
          <input v-model="editing.name" class="bbs-input" type="text" placeholder="角色名" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">性别</span>
          <input v-model="editing.gender" class="bbs-input" type="text" placeholder="如:男、女" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">身份(职业 / 与主角的关系)</span>
          <textarea v-model="editing.title" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:归雁客栈掌柜、青梅竹马"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">性格</span>
          <textarea v-model="editing.personality" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:沉默寡言、护短"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">外貌描述(固定特征:发色 / 身材 / 疤痕,勿写穿着)</span>
          <textarea v-model="editing.desc" class="bbs-input bbs-modal-textarea" rows="2" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前着装(会随剧情变化)</span>
          <textarea v-model="editing.outfit" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:红斗篷、佩长剑"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">当前状态(受伤 / 疲惫等,无则留空)</span>
          <textarea v-model="editing.condition" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="editing.important" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">
            {{ apiSettings.summaryOnlyMode ? '主要角色(核心主演,仅在柏宝书内重点追踪状态)' : '主要角色(核心主演,始终全量发送、重点追踪状态)' }}
          </span>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="editing.follow" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">随行同伴(跟随主角移动,永远在场)</span>
        </label>
        <label v-if="!editing.follow" class="bbs-modal-field">
          <span class="bbs-modal-label">所在地点</span>
          <textarea v-model="editing.location" v-autosize class="bbs-input bbs-modal-textarea bbs-modal-autogrow" rows="1" placeholder="如:归雁客栈、王宫"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editing.name.trim()" @click="saveEdit">保存</button>
        </footer>
      </div>
    </ModalMask>

    <ConfirmDialog
      :open="!!removing"
      title="删除角色"
      tone="danger"
      confirm-text="删除"
      confirm-icon="trash"
      @update:open="v => { if (!v) removing = null; }"
      @confirm="confirmRemove"
      @cancel="removing = null"
    >
      删除「{{ removing?.name }}」。此操作写入最新摘要,删除楼层可回退。
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.bbs-npc-groups {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.bbs-protagonist-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 18px;
}
.bbs-npc-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 分组头:在场/不在场是这页的信息骨架(= AI 实际收到的分档),用细标签 + 一句说明点明取舍 */
.bbs-npc-grouphead {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.bbs-npc-grouptag {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  padding: 2px 9px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-npc-grouptag.is-present {
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
/* 同区域:描边空心 pill —— 介于「在场(实心强调)」与「不在场(实心灰底)」之间 */
.bbs-npc-grouptag.is-nearby {
  background: transparent;
  border: 1px solid var(--bbs-line-strong);
  padding: 1px 8px; /* 补偿 1px 边框,保持与实心标签等高 */
}
/* 主要角色分组标签:同强调底色 + 星标,与置顶组的「核心」地位呼应 */
.bbs-npc-grouptag.is-main {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
.bbs-npc-grouptag.is-protagonist {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--bbs-warning-soft);
  color: var(--bbs-warning);
}
.bbs-npc-grouphint {
  font-size: 11.5px;
  color: var(--bbs-ink-muted);
}
.bbs-npc-grouphint.is-local-only {
  color: var(--bbs-warning);
  font-weight: 600;
}

.bbs-npc-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* —— 角色卡:与物品/场景同款的安静卡片。在场/随行只用「左侧一道色条」表态,
      不再用大圆球——保持列表整体的克制,把强调留给那道竖条。 —— */
.bbs-npc {
  position: relative;
  display: flex;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  overflow: hidden; /* 让左色条贴着圆角边缘 */
}
/* 在场:左缘一道青瓷色条 */
.bbs-npc.is-present::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--bbs-accent);
  opacity: 0.5;
}
.bbs-protagonist::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--bbs-warning);
  opacity: 0.65;
}
/* 同区域:左色条更细更淡 —— 在「在场(3px@0.5)」与「不在场(无条)」之间的一档 */
.bbs-npc.is-nearby::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--bbs-accent);
  opacity: 0.28;
}
/* 随行:色条加粗加实,作同伴的最高标识 */
.bbs-npc.is-follow::before {
  width: 3px;
  opacity: 1;
}
/* 主要角色:整条左色条加粗实色,卡片更醒目,呼应「核心主演」地位 */
.bbs-npc.is-main::before {
  width: 4px;
  opacity: 1;
}
.bbs-npc.is-main {
  border-color: var(--bbs-line-strong);
}
/* 不在场:整行压暗 + 虚线框,与「只发名+身份」的弱化呼应 */
.bbs-npc.is-absent {
  background: transparent;
  border-style: dashed;
}
.bbs-npc.is-absent .bbs-npc-name {
  color: var(--bbs-ink-soft);
}

.bbs-npc-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* 头行:名字 + 一枚状态标(随行/所在地)+ 操作区。名字占自然宽,状态标吃剩余宽并截断,
   操作区固定不被挤。身份不在这行——长身份单独成段,不再挤乱头行。 */
.bbs-npc-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bbs-npc-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
  flex: 0 0 auto;
  white-space: nowrap;
}
/* 性别小标签:紧凑灰色括注,跟在名字后面 */
.bbs-npc-gender {
  font-size: 11px;
  color: var(--bbs-ink-muted);
  flex: 0 0 auto;
  white-space: nowrap;
}
.bbs-npc-acts {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}
.bbs-npc-flag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  font-size: 11px;
  color: var(--bbs-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bbs-npc-flag.is-follow {
  color: var(--bbs-accent);
  flex-shrink: 0;
}
.bbs-npc-flag.is-nowhere {
  font-style: italic;
  opacity: 0.7;
}

/* —— 字段表:身份/性格/外貌统一成「彩色类别标签 + 内容」的对齐行。
      标签同宽左对齐成一条竖列,用语义色区分类别,内容统一字号——治「三行同灰、层次乱」。 —— */
.bbs-npc-fields {
  margin: 2px 0 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.bbs-npc-field {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.bbs-npc-field dt {
  flex: 0 0 auto;
  width: 30px;
  text-align: center;
  padding: 1px 0;
  border-radius: var(--bbs-radius-sm);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: 0.04em;
  /* 默认中性,具体类别在下方各自染色 */
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-npc-field dd {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}
/* 身份:强调金标签——这是最关键的一类身份信息 */
.bbs-npc-field.f-title dt {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
.bbs-npc-field.f-title dd {
  color: var(--bbs-ink);
}
/* 着装:暖色标签——即时层核心,与「会变的当前状态」呼应,内容也加重 */
.bbs-npc-field.f-outfit dt {
  background: var(--bbs-warning-soft);
  color: var(--bbs-warning);
}
.bbs-npc-field.f-outfit dd {
  color: var(--bbs-ink);
}
/* 状态/健康:警示色标签——受伤/异常一眼可辨 */
.bbs-npc-field.f-cond dt {
  background: var(--bbs-danger-soft);
  color: var(--bbs-danger);
}
/* 性格:中性偏暖(沿用默认中性,与档案层弱化一致) */
.bbs-npc-field.f-trait dt {
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
/* 外貌 / 所在:中性标签(沿用默认),作次要细节 */

/* 主要角色无状态时的占位提示:引导补录当前状态,避免空卡 */
.bbs-npc-mainhint {
  margin: 4px 0 0;
  font-size: 12px;
  font-style: italic;
  color: var(--bbs-ink-muted);
}

/* PC(支持 hover)上操作按钮默认隐藏,悬停整卡才浮现;触屏常驻(与物品页一致) */
@media (hover: hover) {
  .bbs-npc-acts {
    opacity: 0;
    transition: opacity var(--bbs-dur) var(--bbs-ease);
  }
  .bbs-npc:hover .bbs-npc-acts,
  .bbs-npc-acts:focus-within {
    opacity: 1;
  }
}

/* 行内操作按钮:复刻 items 页(scoped 不继承,重声明同款) */
.bbs-item-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  cursor: pointer;
  font-size: 14px;
}
.bbs-item-act:hover {
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
}
.bbs-item-del:hover {
  color: var(--bbs-danger);
}
/* 随行开关:激活态点亮强调色,把「这是同伴」表达在按钮本身 */
.bbs-npc-pin.active {
  color: var(--bbs-accent);
}
.bbs-npc-pin.active:hover {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
/* 主要角色星标:激活态点亮(实心感由强调色填充表达) */
.bbs-npc-star.active {
  color: var(--bbs-accent);
}
.bbs-npc-star.active:hover {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
/* 主要角色卡的操作区常驻(置顶组无需 hover 才显,星标本身就是状态指示) */
.bbs-npc.is-main .bbs-npc-acts {
  opacity: 1;
}
.bbs-protagonist .bbs-npc-acts {
  opacity: 1;
}

.bbs-modal-textarea {
  resize: vertical;
  min-height: 60px;
  font-family: inherit;
}
/* 自适应高度:默认贴合一行,内容多才长高(v-autosize 量 scrollHeight 写回);
   min-height 归零、resize 交给指令,封顶后滚动。 */
.bbs-modal-autogrow {
  resize: none;
  min-height: 0;
  max-height: 140px;
  overflow-y: auto;
}
.bbs-modal-check {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.bbs-modal-check input {
  flex-shrink: 0;
}
.bbs-empty {
  flex: 1;
}
</style>
