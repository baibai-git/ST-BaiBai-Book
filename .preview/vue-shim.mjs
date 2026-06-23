// 测试用 vue 垫片:只实现被测代码路径用到的 API
export const reactive = x => x;
export const ref = v => ({ value: v });
export const computed = f => ({ get value() { return f(); } });
export const watch = () => {};
export const watchEffect = () => {};
