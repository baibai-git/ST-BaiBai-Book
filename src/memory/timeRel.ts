/**
 * 故事内时间的「相对时间」推断 —— 移植自旧插件 Horae 的 timeUtils,只保留中文、去掉多语言层。
 *
 * 用途:历史摘要注入与摘要页展示时,在绝对时间前加一个相对前缀(如「昨天」「3天前」),
 * 让主模型与用户都能直观感知「这段剧情距离现在多久」。
 *
 * 设计底线(沿用 Horae):时间是 AI 写的自由文本。
 *  - 数字日历(1988/9/29、1988年9月29日、9/29、带历法前缀的 X年M月D日)→ 精确算天数差。
 *  - 架空日历(霜月3日 这类非数字月名、含 XX/?? 的占位)→ 仅同月可算,跨架空月放弃。
 *  - 纯时辰无日期、彻底解析不出 → 返回空串,调用方降级为「不加前缀」。
 * 一句话:宁可不标,绝不标错。
 */

/** 中文周几(0=周日) */
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

/** 解析出的故事日期:standard 可精确换算,fantasy 仅同月可比 */
interface StoryDate {
  type: 'standard' | 'fantasy';
  year?: number;
  month?: number;
  day?: number | null;
  /** 架空月标识(如「霜月」),fantasy 跨月比对用 */
  monthId?: string;
  /** 历法前缀(如「庆历」),仅展示用,不参与换算 */
  calendarPrefix?: string;
  raw?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** 把全角/中文句点等日期分隔符规范成 /,便于后续正则统一处理 */
function normalizeNumericDateSeparators(dateStr: string): string {
  if (!dateStr) return dateStr;
  return dateStr
    .replace(/^(\d{4,})[.．。﹒](\d{1,2})[.．。﹒](\d{1,2})(?=$|\s)/, '$1/$2/$3')
    .replace(/^(\d{1,2})[.．。﹒](\d{1,2})(?=$|\s)/, '$1/$2');
}

/** 看起来是结构化数字日期(用于排除「霜月3日」误判为架空) */
function looksLikeStructuredNumericDate(dateStr: string): boolean {
  if (!dateStr) return false;
  return (
    /^(?:\d{4,}[/.\-．。﹒]\d{1,2}[/.\-．。﹒]\d{1,2}|\d{1,2}[/.\-．。﹒]\d{1,2})(?=$|\s)/.test(dateStr) ||
    /^\d+\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?(?=$|\s)/.test(dateStr) ||
    /^\d{1,2}\s*月\s*\d{1,2}\s*日?(?=$|\s)/.test(dateStr)
  );
}

/** 从架空日期串里抽「日数」(阿拉伯优先,无则取首个数字) */
function extractDayNumber(dateStr: string): number | null {
  if (!dateStr) return null;
  const m = dateStr.match(/(\d+)\s*[日号]/) || dateStr.match(/第\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  const any = dateStr.match(/(\d+)/);
  if (any) return parseInt(any[1], 10);
  return null;
}

/** 从架空日期串里抽「月标识」(如「霜月」) */
function extractMonthIdentifier(dateStr: string): string | null {
  if (!dateStr) return null;
  const m = dateStr.match(/([^\s\d]+月)/);
  if (m) return m[1];
  const num = dateStr.match(/(?:\d{4}[/\-])?(\d{1,2})[/\-]\d{1,2}/);
  if (num) return num[1] + '月';
  return null;
}

/** 解析故事内日期字符串;解析不出返回 null */
export function parseStoryDate(dateStr: string): StoryDate | null {
  if (!dateStr) return null;
  let s = dateStr.trim();
  // 去掉 AI 写的周几标注「(三)」
  s = s.replace(/\s*\([日一二三四五六]\)\s*/g, ' ').trim();
  s = normalizeNumericDateSeparators(s);

  // 含 XX/?? 占位 → 架空
  if (/[xX]{2}|[?？]{2}/.test(s)) {
    return { type: 'fantasy', raw: dateStr.trim() };
  }

  // 标准:YYYY/M/D
  const full = s.match(/^(\d{4,})[/\-](\d{1,2})[/\-](\d{1,2})/);
  if (full) {
    const year = parseInt(full[1], 10);
    const month = parseInt(full[2], 10);
    const day = parseInt(full[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { year, month, day, type: 'standard' };
  }

  // 标准:M/D
  const short = s.match(/^(\d{1,2})[/\-](\d{1,2})(?:\s|$)/);
  if (short) {
    const month = parseInt(short[1], 10);
    const day = parseInt(short[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { month, day, type: 'standard' };
  }

  // 标准:X年M月D日(带可选历法前缀,如「庆历四年九月廿九」无法走这条,只接受数字)
  const yearCn = s.match(/(\d+)年\s*(\d{1,2})月(\d{1,2})日?/);
  if (yearCn) {
    const year = parseInt(yearCn[1], 10);
    const month = parseInt(yearCn[2], 10);
    const day = parseInt(yearCn[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const prefixEnd = s.indexOf(yearCn[0]);
      const calendarPrefix = s.substring(0, prefixEnd).trim() || undefined;
      return { year, month, day, type: 'standard', calendarPrefix };
    }
  }

  // 标准:M月D日
  const cn = s.match(/(\d{1,2})月(\d{1,2})日?/);
  if (cn) {
    const month = parseInt(cn[1], 10);
    const day = parseInt(cn[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { month, day, type: 'standard' };
  }

  // 架空日历
  if (looksLikeStructuredNumericDate(s)) return null;
  const monthId = extractMonthIdentifier(s);
  const dayNum = extractDayNumber(s);
  if (monthId || dayNum !== null) {
    return { monthId: monthId ?? undefined, day: dayNum, type: 'fantasy', raw: dateStr.trim() };
  }

  return null;
}

/**
 * 计算 from→to 的天数差(to - from,正=to 更晚)。
 * 解析不出或跨架空月无法判定 → 返回 null。
 */
export function calculateRelativeDays(fromDate: string, toDate: string): number | null {
  if (!fromDate || !toDate) return null;

  // 先剥掉尾部时刻(15:00 / 下午 / 酉时…),只比日期
  const stripTime = (x: string): string =>
    normalizeNumericDateSeparators(
      x
        .trim()
        .replace(/\s+\d{1,2}[:：]\d{2}.*$/, '')
        .replace(/\s+(凌晨|早上|上午|中午|下午|傍晚|晚上|深夜|子时|丑时|寅时|卯时|辰时|巳时|午时|未时|申时|酉时|戌时|亥时).*$/i, '')
        .trim(),
    );
  if (stripTime(fromDate) === stripTime(toDate)) return 0;

  const from = parseStoryDate(fromDate);
  const to = parseStoryDate(toDate);
  if (!from || !to) return null;

  // 标准日历:精确算(用 setFullYear 避开 Date 对小年份的偏移)
  if (from.type === 'standard' && to.type === 'standard') {
    const defaultYear = 2024;
    const fromYear = from.year || to.year || defaultYear;
    const toYear = to.year || from.year || defaultYear;
    const fromObj = new Date(0);
    fromObj.setFullYear(fromYear, (from.month ?? 1) - 1, from.day ?? 1);
    const toObj = new Date(0);
    toObj.setFullYear(toYear, (to.month ?? 1) - 1, to.day ?? 1);
    return Math.round((toObj.getTime() - fromObj.getTime()) / DAY_MS);
  }

  // 架空日历:仅同月可算,跨架空月名易误判 → 放弃
  if (from.type === 'fantasy' || to.type === 'fantasy') {
    const fromMonth = from.monthId ?? from.month;
    const toMonth = to.monthId ?? to.month;
    if (from.day != null && to.day != null) {
      if (fromMonth && toMonth && fromMonth !== toMonth) return null;
      return to.day - from.day;
    }
    return null;
  }

  return null;
}

/** 标准日历的两端转成 Date(供周/月/年语义判定);任一非标准则返回 null */
function toDatePair(fromDate: string, toDate: string): { from: Date; to: Date } | null {
  const from = parseStoryDate(fromDate);
  const to = parseStoryDate(toDate);
  if (from?.type !== 'standard' || to?.type !== 'standard') return null;
  const defaultYear = new Date().getFullYear();
  const fromYear = from.year || to.year || defaultYear;
  const toYear = to.year || from.year || defaultYear;
  const f = new Date(0);
  f.setFullYear(fromYear, (from.month ?? 1) - 1, from.day ?? 1);
  const t = new Date(0);
  t.setFullYear(toYear, (to.month ?? 1) - 1, to.day ?? 1);
  return { from: f, to: t };
}

/** 以「周一」为周起点算周差 */
function weekDiffByMonday(from: Date, to: Date): number {
  const weekStart = (d: Date): number => {
    const wd = d.getDay();
    const offset = wd === 0 ? -6 : 1 - wd;
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + offset);
  };
  return Math.round((weekStart(to) - weekStart(from)) / WEEK_MS);
}

/** 自然月差 */
function monthDiff(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

/**
 * 把「事件时间 event」相对「现在 now」格式化成相对前缀文本。
 * 解析不出 / 无法判定 → 返回空串(调用方据此不加前缀)。
 */
export function relativeTimeLabel(eventTime?: string, nowTime?: string): string {
  const ev = eventTime?.trim();
  const now = nowTime?.trim();
  if (!ev || !now) return '';

  // days = now - event,正=事件在过去
  const days = calculateRelativeDays(ev, now);
  if (days === null || days === undefined) return '';

  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  if (days === 3) return '大前天';
  if (days === -1) return '明天';
  if (days === -2) return '后天';
  if (days === -3) return '大后天';

  const pair = toDatePair(ev, now);

  if (days > 0) {
    // 过去方向
    if (days < 4) return `${days}天前`;
    if (days >= 4 && days <= 13 && pair) {
      const wd = weekDiffByMonday(pair.from, pair.to);
      if (wd === 1) return `上周${WEEKDAY_NAMES[pair.from.getDay()]}`;
      if (wd === 2) return `上上周${WEEKDAY_NAMES[pair.from.getDay()]}`;
    }
    if (days >= 7 && days < 60 && pair && monthDiff(pair.from, pair.to) === 1) {
      return `上个月${pair.from.getDate()}号`;
    }
    if (days >= 300 && pair) {
      const yearDiff = pair.to.getFullYear() - pair.from.getFullYear();
      if (yearDiff === 1) return `去年${pair.from.getMonth() + 1}月${pair.from.getDate()}日`;
      if (yearDiff === 2) return `前年${pair.from.getMonth() + 1}月${pair.from.getDate()}日`;
    }
    if (days < 30) return `${days}天前`;
    if (days < 365) {
      const md = pair ? monthDiff(pair.from, pair.to) : 0;
      const months = md > 0 ? md : Math.floor(days / 30);
      return `${months}个月前`;
    }
    const years = Math.floor(days / 365);
    const remainMonths = Math.round((days % 365) / 30);
    if (remainMonths > 0 && years < 5) return `${years}年${remainMonths}个月前`;
    return `${years}年前`;
  }

  // 未来方向
  const abs = Math.abs(days);
  if (abs < 4) return `${abs}天后`;
  if (abs >= 4 && abs <= 13 && pair) {
    const wd = weekDiffByMonday(pair.from, pair.to);
    if (wd === -1) return `下周${WEEKDAY_NAMES[pair.from.getDay()]}`;
    if (wd === -2) return `下下周${WEEKDAY_NAMES[pair.from.getDay()]}`;
  }
  if (abs >= 7 && abs < 60 && pair && monthDiff(pair.from, pair.to) === -1) {
    return `下个月${pair.from.getDate()}号`;
  }
  if (abs < 30) return `${abs}天后`;
  if (abs < 365) {
    const md = pair ? monthDiff(pair.from, pair.to) : 0;
    const months = md < 0 ? Math.abs(md) : Math.floor(abs / 30);
    return `${months}个月后`;
  }
  const years = Math.floor(abs / 365);
  const remainMonths = Math.round((abs % 365) / 30);
  if (remainMonths > 0 && years < 5) return `${years}年${remainMonths}个月后`;
  return `${years}年后`;
}
