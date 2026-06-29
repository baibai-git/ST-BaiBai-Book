import type { Component } from 'vue';
import Items from './items/index.vue';
import Npcs from './npcs/index.vue';
import Scenes from './scenes/index.vue';
import Settings from './settings/index.vue';
import Summary from './summary/index.vue';

export interface PageDef {
  /** 唯一 id,存进 ui.activePage / localStorage;同时作为 Icon 的 name */
  id: string;
  /** 导航栏全称 */
  label: string;
  component: Component;
}

/**
 * 分页注册表 —— 新增一页:建一个 pages/<id>/index.vue,再往这里加一行,
 * 并在 Icon.vue 的 PATHS 里加一条同 id 的图标。顺序即导航顺序,设置放最末。
 *
 * 计划/悬念已并入摘要页(上方),不再单独成页。
 */
export const PAGES: PageDef[] = [
  { id: 'summary', label: '摘要', component: Summary },
  { id: 'items', label: '物品', component: Items },
  { id: 'scenes', label: '场景', component: Scenes },
  { id: 'npcs', label: '角色', component: Npcs },
  { id: 'settings', label: '设置', component: Settings },
];

export function getPage(id: string): PageDef {
  return PAGES.find(p => p.id === id) ?? PAGES[0];
}
