/**
 * 从 LLM 文本输出里健壮地提取 JSON 对象。
 * 应对:```json 围栏、思维链前后缀、智能引号、尾随逗号。
 */
export function extractJsonObject<T = unknown>(raw: string): T | null {
  if (!raw || typeof raw !== 'string') return null;

  let s = raw.trim();

  // 去掉 <think>…</think> / <thinking>…</thinking> 思维链(大小写不敏感)
  s = s.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '').trim();

  // assistant prefill 场景下,返回可能只包含续写的思维链正文 + </thinking> + JSON,
  // 没有开头 <thinking>。此时丢弃最后一个闭合标签及其之前的全部文本。
  const danglingThinkClose = s.match(/<\/think(?:ing)?>/gi);
  if (danglingThinkClose) {
    const lastClose = Math.max(
      s.toLowerCase().lastIndexOf('</think>'),
      s.toLowerCase().lastIndexOf('</thinking>'),
    );
    if (lastClose >= 0) {
      const close = s.slice(lastClose).match(/^<\/think(?:ing)?>/i)?.[0] ?? '';
      s = s.slice(lastClose + close.length).trim();
    }
  }

  // 去掉 ```json ... ``` / ``` ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // 截取第一个 { 到最后一个 } 之间(去掉前后说明文字)
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  let body = s.slice(first, last + 1);

  // 直接尝试
  const direct = tryParse<T>(body);
  if (direct !== null) return direct;

  // 容错清洗:智能引号 -> 直引号,去尾随逗号
  const cleaned = body
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
  const cleanedParsed = tryParse<T>(cleaned);
  if (cleanedParsed !== null) return cleanedParsed;

  // 仍失败:多半是正文里有未转义的英文双引号(如英文对白 He said "hi")。补转义后再试。
  // 原串与清洗串各补一次(清洗把智能引号变直引号后可能新增野引号,故也要补)。
  const repaired = tryParse<T>(escapeStrayQuotes(body));
  if (repaired !== null) return repaired;
  return tryParse<T>(escapeStrayQuotes(cleaned));
}

/**
 * 补转义:把「字符串值内部未转义的双引号」补成 \"。仅在直接/清洗解析都失败后作兜底。
 * 逐字符扫描并跟踪是否在字符串内:字符串内遇到 " 时,向后看第一个非空白字符——只有它是
 * 结构符(: , } ] 或结尾)时才当作结束引号,否则判为正文里的野引号并补成 \"。
 * 对本就合法的 JSON 是恒等变换(合法 JSON 的字符串内不存在未转义的 "),故绝不会把能解析的弄坏;
 * 遇到真正歧义(野引号紧贴 ASCII 逗号)时会解析失败落到重试,不会静默截断成错数据。
 */
function escapeStrayQuotes(s: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      continue;
    }
    if (c === '\\') {
      // 保留转义对(\" \\ \n 等)整体原样搬过去,不误判其中的引号
      out += c;
      if (i + 1 < s.length) { out += s[i + 1]; i++; }
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      const next = j < s.length ? s[j] : '';
      if (next === '' || next === ':' || next === ',' || next === '}' || next === ']') {
        out += c;        // 结束引号
        inString = false;
      } else {
        out += '\\"';    // 正文野引号 -> 补转义
      }
      continue;
    }
    out += c;
  }
  return out;
}

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
