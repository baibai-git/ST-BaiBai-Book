<script setup lang="ts">
/**
 * 可视化 JSON 结构编辑器(递归)。免手搓:点选类型、填值、增删字段。
 * 只编辑「结构与初始值」——用于变量初始模板,支持 对象/数组/文本/数值/真假 五类,够覆盖势力表这类结构。
 * 受控:modelValue 进,update:modelValue 出(每次改动 emit 一份新对象/数组,父级整体持有)。
 *
 * 设计:标量的「值」与它的「类型选择」同处一行(不再拆成独立递归子实例——那正是旧版误显真假开关的根因);
 * 只有对象/数组才向下递归成缩进子块。
 */
import Icon from '@/components/Icon.vue';
import type { JsonValue } from '@/memory/types';
import { computed } from 'vue';

const props = defineProps<{ modelValue: JsonValue }>();
const emit = defineEmits<{ 'update:modelValue': [JsonValue] }>();

type JType = 'object' | 'array' | 'string' | 'number' | 'boolean';
const TYPE_OPTS: { v: JType; label: string }[] = [
  { v: 'string', label: '文本' },
  { v: 'number', label: '数值' },
  { v: 'boolean', label: '真假' },
  { v: 'object', label: '对象' },
  { v: 'array', label: '数组' },
];

function typeOf(v: JsonValue): JType {
  if (Array.isArray(v)) return 'array';
  if (v !== null && typeof v === 'object') return 'object';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'string';
}
function isContainerVal(v: JsonValue): boolean {
  const t = typeOf(v);
  return t === 'object' || t === 'array';
}
function blankOf(t: JType): JsonValue {
  return t === 'object' ? {} : t === 'array' ? [] : t === 'number' ? 0 : t === 'boolean' ? false : '';
}

const rootType = computed<JType>(() => typeOf(props.modelValue));
const asObject = computed(() => (props.modelValue && typeof props.modelValue === 'object' && !Array.isArray(props.modelValue) ? (props.modelValue as Record<string, JsonValue>) : {}));
const objKeys = computed(() => Object.keys(asObject.value));
const asArray = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []));

/* —— 对象:增删改键 / 改子值 —— */
function setObjChild(key: string, v: JsonValue) {
  emit('update:modelValue', { ...asObject.value, [key]: v });
}
function changeObjType(key: string, ev: Event) {
  setObjChild(key, blankOf((ev.target as HTMLSelectElement).value as JType));
}
function renameKey(oldKey: string, ev: Event) {
  const newKey = (ev.target as HTMLInputElement).value.trim();
  if (!newKey || newKey === oldKey) return;
  const o: Record<string, JsonValue> = {}; // 保序重建,避免改名跳到末尾
  for (const k of objKeys.value) o[k === oldKey ? newKey : k] = asObject.value[k];
  emit('update:modelValue', o);
}
function addObjField() {
  const o = { ...asObject.value };
  let name = '新字段';
  let i = 2;
  while (name in o) name = `新字段${i++}`;
  o[name] = '';
  emit('update:modelValue', o);
}
function removeObjKey(key: string) {
  const o = { ...asObject.value };
  delete o[key];
  emit('update:modelValue', o);
}

/* —— 数组:增删改项 —— */
function setArrItem(idx: number, v: JsonValue) {
  const a = asArray.value.slice();
  a[idx] = v;
  emit('update:modelValue', a);
}
function changeArrType(idx: number, ev: Event) {
  setArrItem(idx, blankOf((ev.target as HTMLSelectElement).value as JType));
}
function addArrItem() { emit('update:modelValue', [...asArray.value, '']); }
function removeArrItem(idx: number) {
  const a = asArray.value.slice();
  a.splice(idx, 1);
  emit('update:modelValue', a);
}

/* —— 标量取值:输入事件 → 规整值 —— */
function strVal(ev: Event): JsonValue { return (ev.target as HTMLInputElement).value; }
function numVal(ev: Event): JsonValue {
  const n = Number((ev.target as HTMLInputElement).value);
  return Number.isFinite(n) ? n : 0;
}
</script>

<template>
  <!-- 对象:字段行列表 -->
  <div v-if="rootType === 'object'" class="bbs-jte">
    <div v-for="k in objKeys" :key="k" class="bbs-jte-field">
      <div class="bbs-jte-row">
        <input class="bbs-input bbs-jte-key" type="text" :value="k" placeholder="字段名" @change="renameKey(k, $event)" />
        <select class="bbs-input bbs-jte-type" :value="typeOf(asObject[k])" @change="changeObjType(k, $event)">
          <option v-for="t in TYPE_OPTS" :key="t.v" :value="t.v">{{ t.label }}</option>
        </select>
        <!-- 标量值就地编辑;容器则本行只留类型,值在下方缩进块 -->
        <input v-if="typeOf(asObject[k]) === 'string'" class="bbs-input bbs-jte-val" type="text" :value="asObject[k] as string" placeholder="值" @input="setObjChild(k, strVal($event))" />
        <input v-else-if="typeOf(asObject[k]) === 'number'" class="bbs-input bbs-jte-val" type="number" :value="asObject[k] as number" @input="setObjChild(k, numVal($event))" />
        <button v-else-if="typeOf(asObject[k]) === 'boolean'" class="bbs-jte-bool" :class="{ on: asObject[k] === true }" type="button" @click="setObjChild(k, asObject[k] !== true)">{{ asObject[k] === true ? '是' : '否' }}</button>
        <span v-else class="bbs-jte-containertag">{{ typeOf(asObject[k]) === 'array' ? '数组' : '对象' }}</span>
        <button class="bbs-jte-del" type="button" title="删除字段" @click="removeObjKey(k)"><Icon name="close" /></button>
      </div>
      <div v-if="isContainerVal(asObject[k])" class="bbs-jte-nest">
        <JsonTreeEditor :model-value="asObject[k]" @update:model-value="v => setObjChild(k, v)" />
      </div>
    </div>
    <button class="bbs-jte-add" type="button" @click="addObjField"><Icon name="plus" />加字段</button>
  </div>

  <!-- 数组:项列表 -->
  <div v-else-if="rootType === 'array'" class="bbs-jte">
    <div v-for="(item, idx) in asArray" :key="idx" class="bbs-jte-field">
      <div class="bbs-jte-row">
        <span class="bbs-jte-idx">#{{ idx }}</span>
        <select class="bbs-input bbs-jte-type" :value="typeOf(item)" @change="changeArrType(idx, $event)">
          <option v-for="t in TYPE_OPTS" :key="t.v" :value="t.v">{{ t.label }}</option>
        </select>
        <input v-if="typeOf(item) === 'string'" class="bbs-input bbs-jte-val" type="text" :value="item as string" placeholder="值" @input="setArrItem(idx, strVal($event))" />
        <input v-else-if="typeOf(item) === 'number'" class="bbs-input bbs-jte-val" type="number" :value="item as number" @input="setArrItem(idx, numVal($event))" />
        <button v-else-if="typeOf(item) === 'boolean'" class="bbs-jte-bool" :class="{ on: item === true }" type="button" @click="setArrItem(idx, item !== true)">{{ item === true ? '是' : '否' }}</button>
        <span v-else class="bbs-jte-containertag">{{ typeOf(item) === 'array' ? '数组' : '对象' }}</span>
        <button class="bbs-jte-del" type="button" title="删除项" @click="removeArrItem(idx)"><Icon name="close" /></button>
      </div>
      <div v-if="isContainerVal(item)" class="bbs-jte-nest">
        <JsonTreeEditor :model-value="item" @update:model-value="v => setArrItem(idx, v)" />
      </div>
    </div>
    <button class="bbs-jte-add" type="button" @click="addArrItem"><Icon name="plus" />加一项</button>
  </div>
</template>

<style scoped>
.bbs-jte {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbs-jte-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bbs-jte-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.bbs-jte-key {
  flex: 0 1 34%;
  min-width: 0;
  font-weight: 500;
}
.bbs-jte-idx {
  flex: 0 0 auto;
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  color: var(--bbs-ink-muted);
  min-width: 30px;
}
/* 类型选择:自绘小三角(与插件其它 select 同款 SVG),右内边距留够、不贴边 */
.bbs-jte-type {
  flex: 0 0 auto;
  width: 74px;
  padding: 6px 26px 6px 10px;
  font-size: 12px;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9.5 12 15.5 18 9.5'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 14px;
}
.bbs-jte-val {
  flex: 1 1 auto;
  min-width: 0;
}
.bbs-jte-bool {
  flex: 1 1 auto;
  align-self: stretch;
  padding: 7px 16px;
  border: 1px solid var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.bbs-jte-bool.on {
  background: var(--bbs-accent-soft);
  border-color: var(--bbs-accent);
  color: var(--bbs-accent);
}
/* 容器项(对象/数组):本行值位只标个类型,真正内容在下方缩进块 */
.bbs-jte-containertag {
  flex: 1 1 auto;
  font-size: 11px;
  color: var(--bbs-ink-muted);
  font-style: italic;
}
.bbs-jte-del {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  cursor: pointer;
  font-size: 13px;
}
.bbs-jte-del:hover {
  background: var(--bbs-danger-soft);
  color: var(--bbs-danger);
}
/* 嵌套子块:左缘细线 + 缩进,表达层级从属 */
.bbs-jte-nest {
  margin-left: 6px;
  padding-left: 12px;
  border-left: 1px solid var(--bbs-line);
}
.bbs-jte-add {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border: 1px dashed var(--bbs-line-strong);
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: 12px;
  cursor: pointer;
}
.bbs-jte-add:hover {
  border-color: var(--bbs-accent);
  color: var(--bbs-accent);
}
</style>
