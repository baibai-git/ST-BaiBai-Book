import type { STBaiBaiBookApi } from '@/public/types';

declare global {
  // ST 在全局挂载了这些依赖,这里只声明插件实际使用到的最小类型。
  const $: any;
  const _: any;
  const toastr: any;
  const __BBS_VERSION__: string;
  var STBaiBaiBook: STBaiBaiBookApi | undefined;
}

export {};
