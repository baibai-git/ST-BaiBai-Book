// ST 在全局挂载了 jQuery,这里给个最小声明,避免 tsc 报错。
// 后续若需要更完整的类型,可引入 @types/jquery。
declare const $: any;
declare const _: any;
declare const toastr: any;
declare const __BBS_VERSION__: string;
