/**
 * dsh-thinking-guard — 宿主半。
 *
 * 治的是：模型在 reasoning 通道里退化成「好。/做。」这类无宾语占位词，
 * 一边刷几百行一边迟迟不发出工具调用。工具调用本身是对的，烧的是时间。
 *
 * 三件可独立开关的事，由「强度」一个数控制（0–4，滑条就是它）：
 *   0 关（注意：系统提示段本身是无条件注册的，档位 0 也照样注入）
 *   1 提示：系统提示给「可照抄的句式」+ 历史消毒，不碰请求参数
 *   2 慢断：流内掐断，掐断后用 followup 起新轮（等 7–21 秒，历史干净）
 *   3 快断：掐断 + 伪造只读调用推进（<1 秒，历史多一条假记录）
 *   4 熔断：连续第 3 次命中就中止本轮
 *
 * 风格上刻意不预设「性格」：所有会被读到的文字都是配置字符串，
 * 留空就等于安静模式。
 */

import { isLoopback, readJson, sendJson } from './route.js';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dshHome, clearSessionLevel, effectiveLevel, effectiveTier, normalizeId, readGlobal, readSwitch, readGlobalTier, writeGlobal, writeGlobalTier, writeSessionLevel, writeSessionTier } from './state.js';

/** Cordis 插件名。 */
export const name = 'thinking-guard';

/** 依赖的服务：系统提示词注册表。 */
export const inject = ['systemPrompt'];

/** 浏览器半读写这个路由。 */
export const ROUTE_STATE = '/thinking-guard/state';

/** 系统提示段名，带 external 前缀避免被预设撞名。 */
const SECTION_NAME = 'external:thinking-guard';

/** 排在 unlimited-mode（10250）之后。 */
const SECTION_ORDER = 10251;

/** 强度上限。 */
export const MAX_LEVEL = 3;

/**
 * 默认配置。profile 的 patch 可以覆盖任意一项。
 * level 默认 1（整理）：只做无损剥离，一次都不打断。
 * 2026-11-25 起默认从 2（慢断）降回 1——默认档不该把生成砍掉，见 CHANGELOG 2.0.0。
 */
const DEFAULTS = {
  level: 1,
  /** 默认 stop 序列：中文占位词的三连。用户可自行替换。 */
  stopSequences: ['做。\n好。\n做。', '好。\n做。\n好。', '做。\n好。\n做。\n好。'],
  /** 判据：连续占位行数达到多少就判退化。 */
  maxRun: 25,
  /** 次级判据：连续占位 >= looseRun 且唯一行率 <= looseUniq 也判。 */
  looseRun: 15,
  looseUniq: 0.4,
  /** 少于这么多行不看。 */
  minLines: 10,
  /** 提醒文案，空字符串 = 不注入。占位变量：{maxRun} {lines} {ratio} */
  noticeText: '',
  /**
   * 系统提示：**空转的正面对策，零延迟、不伪造、可开源**。
   *
   * 成因已查清——模型停在「做。」「好。」这种没有宾语的抽象动词上，就会一直生成
   * 下一条抽象动词；只有写出带具体宾语的工具动作（「（输出 image_crop。）」）才结束思考。
   * 所以这里要求它「写清楚哪个工具、什么参数」，而不是抽象催促「别空转」——后者与病同形，实测无效。
   * 空字符串 = 不注册这一段。
   */
  promptText: '思考里禁止写「做。」「好。」「写。」这三个词——它们没有宾语，停在上面就会一直写下一条空话。\n要动手时，思考的最后一行直接写成：调用 <工具名>，参数 <要传的值>。写完就停，立刻调用。',
  /** 退化后下一步的 maxTokens 上限；**默认 0 = 不收紧**（阿丞否过压预算伤质量，2026-11-23 撤掉）。 */
  degradedMaxTokens: 0,
  /** 强度 >=4 时，连续命中几次熔断本轮；0 = 不熔断。 */
  fuseAfter: 3,
  /** 强度 >=3 时是否挂 stop 序列。 */
  stopEnabled: true,
  /** 流内掐断：尾部连续这么多行短行就结束本次生成（0 = 关）。 */
  streamKillRun: 15,
  /**
   * 流内掐断的字符数下限：思考没超过这么多字符就不掐。
   *
   * 2026-11-24 从 600 降到 150：真实事故块（19:11 那块）run 到 15 行时累计只有 235 字符，
   * 600 的门槛把它整个放过去了（等字数够时连续短行已被长行打断，判定条件再也不会同时成立）。
   */
  streamKillMinChars: 150,
  /**
   * 占位密度判据：整段思考里「占位行」占比够高就掐，不看连续性。
   *
   * **2026-11-24 夜起默认关**：它按「行的个数」算占比，而一行的「做。」只有 2 个字——
   * 真机上 26% 的行只占 3% 的字。game 会话 21 分钟被砍 11 次正常思考；
   * 全库看密度单独多抓 199 块、真正的死循环 0 块。主力换成下面的 streamKillRepeat*。
   */
  streamKillDensityEnabled: false,
  /** 至少要有这么多行才看密度（行数太少时占比没有意义）。 */
  streamKillDensityMinLines: 30,
  /** 占位行占比达到这个值就判（0.25 = 25%）。 */
  streamKillDensityRatio: 0.25,
  /**
   * 相邻对重复判据（2026-11-24 夜起的主力）：同一对相邻行重复够多次、且占位行占比够高，就掐。
   *
   * 为什么换成它：真死循环的形状是「好。→做。」这种同一对行反复（全库 49 块，重复 8–259 次），
   * 而风格性的填充行只是散着插，重复对涨不上去。全库试算（16739 块）：
   * 重复对≥8 且占位行≥15% → 命中 172 块、49 块真死循环全中、game 会话 279 块零误伤
   * （旧密度判据误伤 23 块、全库多抓 199 块而真死循环 0）。
   */
  streamKillRepeatEnabled: true,
  /** 同一对相邻行至少重复这么多次才开始看（8 次约等于 16 行）。 */
  streamKillRepeatMin: 8,
  /** 同时要求占位行占比达到这个值，避免把贴代码/贴表格的重复也算进来。 */
  streamKillRepeatRatioMin: 0.15,
  /** 少于这么多行不看重复对（行数太少时重复次数没有统计意义）。 */
  streamKillRepeatMinLines: 20,
  /**
   * 英文判据：英文的口水长在**句子里**（Let me… / Wait…），不单独成行，行级判据对它无效。
   * 改用句级：同一句（归一化后）重复占比够高就判。
   * 阈值是在 4504 个真实英文思考块上定的：句重复占比 99 分位 0.10、最大 0.267；取 0.30。
   * **召回未验证**：我们的语料里没有英文空转样本。
   */
  streamKillEnglishEnabled: true,
  /** 同一句（归一化后）最多占多少句就算退化。 */
  englishDupRatioMin: 0.30,
  /** 至少这么多句才看句重复。 */
  englishMinSentences: 12,
  /**
   * 句首 4 词的重复次数。2026-11-26 起**只做观察信号**（进 trace，不参与掐断）。
   * 原因见 isEnglishDegenerate：它分不开「同一组句子反复」和「同一句式逐条列举」。
   */
  englishGramMin: 10,
  /** 句首 4 词的观察下限（句数）。 */
  englishGramMinSentences: 20,
  /** 句首 4 词占全部句子的比例，同样只做观察。 */
  englishGramRatioMin: 0.10,
  /**
   * 英文句级判据的采样间隔（按已收字符数，不按 delta 个数）。
   * 按 delta 个数走的话，同一段文本换个分片就是另一种结论——11 字符分片会误掐，
   * 256 字符分片又整段放过（2026-11-26 外部评估第 3 条）。
   */
  englishStep: 600,
  /**
   * 精确周期判据：同一段内容一字不差地重复够多遍就掐。
   *
   * 补的是行级判据和英文判据之间的那一大片：协议结束标签、无分隔符的符号串、
   * 整句中文、俄文短句、几千字的编号引文段。它们跟语言、断行、标点都没关系，
   * 唯一的共同点就是「同一段字节原样重来」。实现见 tailCycle。
   */
  streamKillCycleEnabled: true,
  /** 同一段内容要原样重复这么多遍才算。 */
  cycleMinRepeats: 4,
  /** 周期区至少这么长才算，挡住 `---`、`====` 这类短分隔符被算成循环。 */
  cycleMinChars: 48,
  /** 单次看的尾部窗口（字符）。周期 2.3K 的样本要 4 遍，窗口必须明显大于 4×周期。 */
  cycleWindow: 12288,
  /** 隔多少字符查一次周期（按字符走，分片大小不影响结论）。 */
  cycleStep: 512,
  /** 周期上限；再长就不当循环看了。 */
  cycleMaxPeriod: 4096,
  /**
   * 冷却：同一会话在 cooldownWindowMs 内被掐到 cooldownHits 次，就歇 cooldownMs 再掐。
   *
   * 为什么不用 maxKillStreak：那个「连续计数」被 `if (!killed) killStreak.delete(key)` 清零，
   * 实测 11 次掐断里 10 次 streak=1，刹车一次都没触发过。时间窗才刹得住。
   */
  cooldownWindowMs: 600000,
  cooldownHits: 3,
  cooldownMs: 300000,
  /** 掐断补偿：把被掐掉那段思考里最后几句真实内容带进注入提示。 */
  compensateEnabled: true,
  compensateMaxLines: 3,
  compensateMaxChars: 240,
  /** 流内掐断总开关。 */
  streamKillEnabled: true,
  /** 试运行：只记「本该掐」的日志，不真掐。用来验证判据。 */
  streamKillDryRun: false,
  /** 诊断探针：把流内中间件的关键节点写进 $DSH_HOME/thinking-guard-trace.log。 */
  traceEnabled: true,
  /**
   * 历史消毒：发请求前把已经退化的 reasoning 从 messages 里换成一句短的。
   *
   * 退化的思考会被逐轮回传进后续每轮输入（DSH 官方 Discussion #7270 实测），
   * 模型模仿自己 → 自我强化。掐断只管这一轮，摘掉才算治本。
   * 只动 assistant 的 reasoning 块，正文与工具调用一概不碰。
   */
  scrubDegenerateHistory: true,
  /** 历史消毒的做法：strip = 把「好。/嗯。」这类占位行整行剔掉、正文留着（默认）；squash = 整块换成一句省略标记。 */
  scrubMode: 'strip',
  /** strip 模式下，一块里至少要剔掉这么多行才动手。 */
  scrubStripMinDropped: 5,
  /**
   * 改过的 messages 怎么送出去：redispatch = 克隆一个新 options 重新发起请求（能绕开深冻结）；
   * inplace = 原地改 options.messages（options 冻结时会抛错，只留作对照）。
   */
  scrubStrategy: 'redispatch',
  /** 被掐断后，下一步给模型的一句提示（空字符串 = 不提示）。 */
  afterKillText: '你上一步的思考因为{reason}被截断了，那条思路没走完。别重新推一遍，直接做你上一步已经决定的事。',
  /** 连续掐断太多次就先停手，免得陷入「掐→重想→再掐」的死循环（0 = 不限）。 */
  maxKillStreak: 3,
  /**
   * 快速续轮：掐断时**伪造一个工具调用**，把 finish 变成 tool-calls，让这一轮直接进下一步。
   *
   * 为什么需要它：用 followup 续轮实测要等 7–21 秒（turn 收尾 + 唤醒调度），
   * 而一次空转平均只值 15 秒左右，净收益接近零甚至为负。
   * 伪造工具调用把延迟压到 1 秒内，代价是会话历史里会多一条工具调用记录。
   */
  streamKillFastContinue: true,
  /** 伪造的工具名：必须真实存在、只读、幂等，这样即使被执行也无副作用。 */
  fakeToolName: 'get_goal',
  /** 快速续轮没做成时，退回 followup 续轮。 */
  followupFallback: true,
};

/**
 * 把历史里已经退化的 reasoning 块换成一句短的。
 *
 * 依据（DSH 官方 Discussion #7270）：退化的思考会被 serialize.ts **逐轮回传**进后续每一轮输入，
 * 模型倾向于模仿自己刚才的模式 → 自我强化。所以只在「这一轮」里掐断是治标的，
 * 把那段垃圾从下一轮的输入里摘掉才是治本。
 *
 * 只动 assistant 的 reasoning 块，正文和工具调用一概不碰；判定沿用同一套退化判据。
 * @param messages - 即将发给 provider 的消息数组（GenerateOptions.messages）。
 * @param cfg - 判据配置。
 * @returns 改后的新数组与被清掉的块数。
 */
/** 历史消毒里「转发」用的记号：打过标就不重复消毒，避免无限重发。 */
const SCRUB_MARK = Symbol.for('dsh.thinking-guard.scrubbed');

/** 一行是不是纯占位（「做。」「好。」「嗯。」这类没有宾语的过渡行）。 */
export function isPlaceholderLine(line) {
  const text = String(line).trim();
  if (!text) return false;
  return MARK_LINE.test(text) || (text.length <= 4 && /^嗯[，,。]?$/.test(text));
}

/** 英文句子的归一化：小写、去标点、压空格。 */
function normalizeEnglish(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 量一段英文思考的「句级重复」。
 *
 * 英文退化不长成一行一个词，而是同一句反复出现、或同一句式反复开头（Let me…）。
 * @param text - 思考原文。
 * @returns 句数、最高重复句的占比、句首 4 词的最高重复次数与那个短语。
 */
/**
 * 英文句级判据只看「散文」：先剔掉那些**天生就重复**的结构性文本。
 *
 * 2026-11-25 18:08 的误伤现场：模型在思考里写 README 的导航条，
 * 十几行 `<a href="#-…">…</a>` 归一化之后彼此相同，被判成「同一句占 32%」——
 * 那不是空转，是写目录。所以代码块、链接、纯标签行、短列表项一律不算句子。
 * @param text - 思考原文。
 * @returns 只剩散文句的文本（结构性行被换成空行，句子切分不变）。
 */
export function stripStructuralLines(text) {
  const lines = String(text ?? '').split('\n');
  const mask = protectMask(lines);            // 围栏、引用块、缩进代码都在这里挡掉
  const kept = [];
  /** 已经出现过、还没闭合的开标签，用来分辨「真 HTML」和「协议自造的伪标签」。 */
  const opened = new Map();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { kept.push(''); continue; }
    if (mask[i]) continue;                                                     // 代码 / 引用 / 缩进
    if (/href=|src=|https?:\/\//i.test(line)) continue;                         // 链接 / 图片
    const tag = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)[^>]*>$/.exec(line);
    if (tag) {
      const element = tag[1].toLowerCase();
      if (!line.startsWith('</')) {                                            // 开标签 / 自闭合：结构性
        opened.set(element, (opened.get(element) ?? 0) + 1);
        continue;
      }
      if ((opened.get(element) ?? 0) > 0) {                                    // 有对应开标签：正常闭合的 HTML
        opened.set(element, opened.get(element) - 1);
        continue;
      }
      // 孤儿闭合标签：前面根本没有同名开标签。`</assistant>` 这种不是 HTML，是协议自造的记号，
      // 退化成复读时它才是证据，所以按字面量留着（2026-11-26 外部评估第 4 条）。
      kept.push(raw); continue;
    }
    if (/^[-*+]\s/.test(line) && line.length < 40) continue;                    // 短列表项
    if (/^\d+[.)]\s/.test(line) && line.length < 40) continue;                  // 短编号项
    if ((line.match(/[<>]/g) || []).length >= 2 && line.length < 80) continue;  // 标签密集的短行
    kept.push(raw);
  }
  return kept.join('\n');
}

export function englishMetrics(text) {
  const prose = stripStructuralLines(text);
  const sentences = String(prose).split(/[.!?\n]+/).map((s) => s.trim()).filter((s) => s.length >= 8);
  if (sentences.length === 0) return { sentences: 0, dupRatio: 0, gramMax: 0, gramKey: '' };
  const seen = new Map();
  for (const s of sentences) {
    const n = normalizeEnglish(s);
    if (n.length >= 6) seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  let maxSame = 0;
  for (const v of seen.values()) if (v > maxSame) maxSame = v;
  const grams = new Map();
  for (const s of sentences) {
    const words = normalizeEnglish(s).split(' ');
    if (words.length < 4) continue;
    const key = words.slice(0, 4).join(' ');
    grams.set(key, (grams.get(key) ?? 0) + 1);
  }
  let gramMax = 0, gramKey = '';
  for (const [k, v] of grams) if (v > gramMax) { gramMax = v; gramKey = k; }
  return { sentences: sentences.length, dupRatio: (maxSame - 1) / sentences.length, gramMax, gramKey };
}

/** 英文块判不判退化。 */
export function isEnglishDegenerate(metrics, cfg) {
  if (!metrics || metrics.sentences === 0) return false;
  // 句首 4 词重复（gramMax）2026-11-26 起**只做观察信号，不再当掐断证据**。
  // 原因：9716 那种「同一组句子反复」和「25 句都以 For this verification pass, 开头、
  // 后半句各不同」的正常列举，在句首频率上长得一模一样（都是 1.0），分不开；
  // 上一版拿它当判据，结果正常对照在 11 字符分片下被误掐。
  // 现在自动掐断只认两样：同一句反复，以及流内那条「精确周期」。
  return metrics.sentences >= (cfg.englishMinSentences ?? 12)
    && metrics.dupRatio >= (cfg.englishDupRatioMin ?? 0.30);
}

/**
 * 把一段思考里的占位行整行剔掉，正文一字不动。
 *
 * 为什么剔而不是整块删：占位行是模型模仿自己的源头，正文是它真想过的东西。
 * 整块删会连带把有用的推理一起扔掉，模型下一轮只能从头再想一遍。
 * @param text - 原始 reasoning 文本。
 * @returns 剔完的文本与被剔掉的行数。
 */
/**
 * 标出「不许动」的行：围栏代码块内、引用块、缩进代码。
 *
 * 2026-11-25 外部评估指出：思考里粘贴的代码示例中的「好。」「做。」会被当占位行删掉。
 * 实测这类行只占 0.127%，但删用户代码是原则问题，所以先扫一遍保护位。
 *
 * 围栏的开关按 CommonMark §4.5 走：关闭围栏必须同种字符、长度不短于开栅栏、整行只剩它。
 * 早先只比首字符，于是 ```` 开着的围栏被一行 ``` 关掉，后面在围栏里的内容全被当成正文。
 * @param {string[]} lines - 原文按换行切出来的行。
 * @returns {boolean[]} 每行是否受保护。
 */
export function protectMask(lines) {
  const mask = new Array(lines.length).fill(false);
  /** 当前围栏：{ char: '`' | '~', length }。 */
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    // 缩进 4 格以上的 ``` 是缩进代码，不是围栏；所以这里只认 0–3 个空格开头
    const run = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/.exec(raw);
    if (fence !== null) {
      mask[i] = true;
      if (run) {
        // 关闭条件（CommonMark 0.31.2 §4.5）：同种字符、长度不短于开栅栏、后面不再跟别的东西。
        // 早先只比首字符，于是 ```` 开着的围栏被一行 ``` 关掉，
        // 后面本来在围栏里的正常内容全被当成正文（2026-11-26 外部评估第 5 条）。
        if (run[1][0] === fence.char && run[1].length >= fence.length && run[2].trim() === '') fence = null;
      }
      continue;
    }
    if (run) {
      mask[i] = true;
      fence = { char: run[1][0], length: run[1].length };
      continue;
    }
    if (/^(?: {4}|\t)/.test(raw)) { mask[i] = true; continue; }              // 缩进代码
    if (trimmed.startsWith('>')) { mask[i] = true; continue; }               // 引用块
  }
  return mask;
}

/** 剥离结果缓存：同一块历史在后续每轮请求里都要再算一次，内容没变就该直接命中。 */
const scrubCache = new Map();
/**
 * 缓存条数上限。
 * 踩过的坑：一开始设 512，而一个长会话一次请求就要处理 677 个块——
 * 容量比批量还小，淘汰等于自毁，命中率恒为 0。上限必须明显大于单次请求的块数。
 */
const SCRUB_CACHE_MAX = 2048;
const SCRUB_CACHE_MIN_CHARS = 160;
let scrubCacheHits = 0;
let scrubCacheMisses = 0;

/** 仅供测试与诊断：缓存规模与命中计数。 */
export function scrubCacheStats() {
  const total = scrubCacheHits + scrubCacheMisses;
  return {
    size: scrubCache.size,
    hits: scrubCacheHits,
    misses: scrubCacheMisses,
    hitRate: total === 0 ? 0 : scrubCacheHits / total,
  };
}

/**
 * 把一段思考里的占位行整行剔掉，正文一字不动。
 *
 * 三条硬约束：
 *   ① 只删整行，不 trim、不压空行——没删到东西时原样返回同一个字符串；
 *   ② 围栏代码、引用块、缩进代码里的行不碰（protectMask）；
 *   ③ 同一块内容算过一次就记住（历史每轮都会重传，命中率很高）。
 * 为什么剔而不是整块删：占位行是模型模仿自己的源头，正文是它真想过的东西。
 * 整块删会连带把有用的推理一起扔掉，模型下一轮只能从头再想一遍。
 * @param text - 原始 reasoning 文本。
 * @returns 剔完的文本与被剔掉的行数。
 */
export function stripPlaceholderLines(text) {
  const source = String(text ?? '');
  if (!source) return { text: source, dropped: 0 };

  const cacheable = source.length >= SCRUB_CACHE_MIN_CHARS;
  if (cacheable) {
    const hit = scrubCache.get(source);
    if (hit) { scrubCacheHits += 1; return hit; }
  }

  const lines = source.split('\n');
  const mask = protectMask(lines);
  const kept = [];
  let dropped = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!mask[i]) {
      const trimmed = raw.trim();
      if (trimmed && isPlaceholderLine(trimmed)) { dropped += 1; continue; }
    }
    kept.push(raw);                       // 原样保留，一个字节都不改
  }

  const result = dropped === 0 ? { text: source, dropped: 0 } : { text: kept.join('\n'), dropped };

  if (cacheable) {
    scrubCacheMisses += 1;
    if (scrubCache.size >= SCRUB_CACHE_MAX) {
      let removed = 0;
      for (const key of scrubCache.keys()) {
        scrubCache.delete(key);
        if (++removed > SCRUB_CACHE_MAX / 2) break;
      }
    }
    scrubCache.set(source, result);
  }
  return result;
}

/**
 * 历史消毒：把已经退化的 reasoning 从这一轮的输入里改掉。
 *
 * 依据（DSH 官方 Discussion #7270）：退化的思考会被 serialize.ts 逐轮回传进后续每一轮输入，
 * 模型倾向于模仿自己刚才的模式 → 自我强化。掐断只管这一轮，改历史才是治本。
 *
 * 两种模式：strip（默认）只剔占位行、保留正文；squash 整块换成一句省略标记。
 * 只动 assistant 的 reasoning 块，正文与工具调用一概不碰。
 * @param messages - 即将发给 provider 的消息数组（GenerateOptions.messages）。
 * @param cfg - 判据配置。
 * @returns 改后的新数组、被省略的块数、被剔掉的行数。
 */
export function scrubDegenerateReasoning(messages, cfg) {
  if (!Array.isArray(messages)) return { messages, removed: 0, stripped: 0 };
  const mode = cfg?.scrubMode ?? 'strip';
  const minDropped = Math.max(1, cfg?.scrubStripMinDropped ?? 5);
  let removed = 0;
  let stripped = 0;
  const next = messages.map((message) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return message;
    let touched = false;
    const content = message.content.map((block) => {
      if (block?.type !== 'reasoning' || typeof block.text !== 'string') return block;
      if (mode === 'strip') {
        const { text, dropped } = stripPlaceholderLines(block.text);
        if (dropped < minDropped) return block;
        touched = true;
        stripped += dropped;
        if (text.trim().length > 0) return { ...block, text };
        removed += 1;
        return { ...block, text: '（上一段思考陷入重复 ' + dropped + ' 行占位，已省略）' };
      }
      const metrics = measure(block.text.split('\n'));
      if (!isDegraded(metrics, cfg)) return block;
      touched = true;
      removed += 1;
      return { ...block, text: '（上一段思考陷入重复 ' + metrics.markRun + ' 行，已省略）' };
    });
    return touched ? { ...message, content } : message;
  });
  return { messages: removed + stripped > 0 ? next : messages, removed, stripped };
}

/** 无宾语的执行意图词，整行只有它自己。 */
const MARK_LINE = /^[（(]?(做|好|写|输出|调用|执行|看|停|嗯|走|来|继续)[。，、)]*[。）)]?$/;

/**
 * 流内判据用的宽松口径：任何 1–6 字的整行都算「短行」。
 *
 * 比事后判据宽，是因为流里要抢时间——等到严格口径凑够 25 行，已经烧掉几百 token 了。
 * 实测正常块里连续短行最长只有几行，15 连是安全的。
 */
const SHORT_LINE = /^[（(]?[^（()）\n]{1,6}[。，、]?[。）)]?$/;

/**
 * 掐断补偿：从被截断的思考里挑最后几句「有内容」的行，拼成一句可注入的话。
 *
 * 掐断本身不是问题，问题是模型下一轮看不到自己刚才想到哪，只能从头再推一遍——
 * 而重推的过程又会长出新的填充行。把最后几句真实内容还给它，能省掉这一轮。
 * @param lines - 已经切好的整行数组。
 * @param cfg - 判据配置。
 * @returns 拼好的短句；没有可用行时返回空字符串。
 */
export function buildCompensation(lines, cfg) {
  if (!cfg?.compensateEnabled || !Array.isArray(lines)) return "";
  const maxLines = Math.max(1, cfg.compensateMaxLines ?? 3);
  const maxChars = Math.max(20, cfg.compensateMaxChars ?? 240);
  const picked = [];
  for (let i = lines.length - 1; i >= 0 && picked.length < maxLines; i--) {
    const line = lines[i];
    if (!line || line.length <= 4 || line.length > 80) continue;
    if (MARK_LINE.test(line)) continue;
    picked.unshift(line);
  }
  if (picked.length === 0) return "";
  let text = picked.join(" / ");
  if (text.length > maxChars) text = text.slice(0, maxChars) + "…";
  return text;
}

/** 只保留尾部这么多字符做实时判断，避免每次全量扫描。 */
const TAIL_CHARS = 400;

/** 英文句级判据的缓冲长度（字符）。 */
const ENGLISH_BUF = 8000;

/** 英文句级判据至少要看这么多字符才采样。 */
const ENGLISH_MIN_BUF = 600;

/** 攒着的完整行最多留这么多条（掐断补偿只用最后 3 条，再多就是白占内存）。 */
const RECENT_LINES_MAX = 600;

/** 相邻对计数表超过这么多条就清一次（长块里对子是平方级增长的）。 */
const PAIR_COUNTS_MAX = 4096;

/**
 * 数一段文本尾部「连续短行」有多少行。
 *
 * 最后一段可能还没写完（没有换行收尾），不算进去，否则会误判半行。
 * @param text - 累积的 reasoning 尾部文本。
 * @returns 连续短行数。
 */
export function trailingShortRun(text) {
  const source = String(text);
  const raw = source.split('\n');
  // 不是以换行收尾时，最后一行可能还在写，不参与计数
  const end = source.endsWith('\n') ? raw.length : raw.length - 1;
  let run = 0;
  for (let i = end - 1; i >= 0; i--) {
    const line = raw[i].trim();
    // 空行是段落分隔（真实 reasoning 的行间通常是 \n\n）：
    // 既不算作一行，也不打断连续性——早先在这里 break，导致永远数不到 2 行
    if (line === '') continue;
    if (SHORT_LINE.test(line)) run++;
    else break;
  }
  return run;
}

/**
 * 把一段 reasoning 拆成非空行。
 * @param text - reasoning 原文。
 * @returns 去掉空行与首尾空白的行数组。
 */
function linesOf(text) {
  return String(text ?? '').split('\n').map(s => s.trim()).filter(Boolean);
}

/**
 * 在尾部窗口里找「精确周期」——同一段内容一字不差地重复够多遍。
 *
 * 为什么加这一条（2026-11-26 外部评估第 3、4 条）：公开报告里整整一类退化全都漏掉了，
 * 而它们共同点只有一个——**同一段字节在尾巴上原样重来**：
 *
 * | 形态 | 为什么旧判据看不见 | 周期 |
 * | --- | --- | --- |
 * | `</assistant>` 这类协议结束标签复读 | 一行 12 个字符，不算「1–6 字短行」 | 13 |
 * | `！！：` 这种没有分隔符的符号串 | 整段只有一行，行首/密度都失效 | 3 |
 * | 同一条长中文陈述反复 | 一行 30 多字，且行与行相同但不算占位行 | 36 |
 * | 俄文短句循环 | 俄文不进中文占位词表 | 95 |
 * | 两千多字的编号引文段整段循环 | 周期比任何行级窗口都长 | 2294 |
 *
 * 逐字比对而不是上哈希：错的周期第一个字符就不符，实际成本约等于 O(周期上限)，
 * 只有在真的周期性文本上才会往深处扫。
 *
 * @param {string} text - 已经过结构过滤的尾部窗口（调用方负责，见 stripStructuralLines）。
 * @param {object} [opts] - 阈值。
 * @returns {null | {period: number, repeats: number, chars: number}} 命中时返回周期、重复遍数与周期区长度。
 */
export function tailCycle(text, opts = {}) {
  const minRepeats = Math.max(2, Math.floor(opts.cycleMinRepeats ?? 4));
  const minChars = Math.max(1, Math.floor(opts.cycleMinChars ?? 48));
  const maxPeriod = Math.max(1, Math.floor(opts.cycleMaxPeriod ?? 4096));
  /** 比对次数的上限，防止极端文本让一次判定变慢。 */
  const budget = Math.max(1000, Math.floor(opts.cycleBudget ?? 400000));
  const source = String(text ?? '');
  const n = source.length;
  if (n < minChars) return null;
  let work = 0;
  const pMax = Math.min(maxPeriod, Math.floor(n / minRepeats));
  for (let period = 1; period <= pMax; period++) {
    const need = Math.max(minRepeats * period, minChars);
    if (need > n) break;
    const start = n - need;
    let ok = true;
    // 从尾巴往前比：错的周期几乎第一下就不符，所以平均只花一两次比对
    for (let i = n - 1; i - period >= start; i--) {
      work += 1;
      if (source.charCodeAt(i) !== source.charCodeAt(i - period)) { ok = false; break; }
    }
    if (!ok) { if (work > budget) return null; continue; }
    return { period, repeats: Math.floor(need / period), chars: need };
  }
  return null;
}

/**
 * 量一块 reasoning 的退化形态。
 * @param lines - 非空行数组。
 * @returns 连续占位最长值、占位占比、唯一行率、行数。
 */
export function measure(lines) {
  let run = 0;
  let longest = 0;
  let marks = 0;
  for (const line of lines) {
    if (MARK_LINE.test(line)) { run++; marks++; if (run > longest) longest = run; } else run = 0;
  }
  const uniq = lines.length === 0 ? 1 : new Set(lines).size / lines.length;
  return { lines: lines.length, markRun: longest, ratio: lines.length ? marks / lines.length : 0, uniq };
}

/**
 * 判断一块是否退化。
 * @param metrics - {@link measure} 的返回值。
 * @param cfg - 生效配置。
 * @returns 是否判为退化。
 */
export function isDegraded(metrics, cfg) {
  if (metrics.lines < cfg.minLines) return false;
  if (metrics.markRun >= cfg.maxRun) return true;
  return metrics.markRun >= cfg.looseRun && metrics.uniq <= cfg.looseUniq;
}

/**
 * 从一条 assistant 消息里取 reasoning 文本。
 * @param message - 消息对象。
 * @returns 拼接后的 reasoning；没有就返回空串。
 */
function reasoningOf(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'reasoning').map(block => block.text ?? '').join('\n');
}

/**
 * 读会话里最近一条 assistant 消息的 reasoning。
 * @param payload - pre-step 的 payload。
 * @param session - agent 的 session（可能没有）。
 * @returns reasoning 原文。
 */
function latestReasoning(payload, session) {
  const claimed = Array.isArray(payload?.messages) ? payload.messages : [];
  for (let i = claimed.length - 1; i >= 0; i--) {
    if (claimed[i]?.role !== 'assistant') continue;
    const text = reasoningOf(claimed[i]);
    if (text) return text;
  }
  let events = [];
  try { events = session?.ownEvents?.() ?? []; } catch { events = []; }
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type !== 'assistant/message') continue;
    return reasoningOf(events[i]?.data?.message ?? events[i]?.message);
  }
  return '';
}

/**
 * 装配宿主半。
 * @param ctx - Cordis 上下文。
 * @param config - profile 传来的配置。
 * @returns 暴露给测试的句柄。
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const file = `${dshHome()}/thinking-guard.json`;
  const hits = new Map();
  const budgetLeft = new Map();
  /** 被掐断过的会话：sid -> { run, chars }，下一步给一次提示后清掉。 */
  const killedSessions = new Map();
  /** 连续被掐次数：sid -> n。用来在死循环出现前自己踩刹车。 */
  const killStreak = new Map();
  /** 冷却截止时间：sid -> epoch ms。 */
  const cooldowns = new Map();
  /** 每次掐断的时间戳：sid -> number[]，用来数时间窗里的次数。 */
  const killTimes = new Map();
  /**
   * 记一次掐断，窗口内够次数就进冷却。
   *
   * 为什么不用 maxKillStreak：那个「连续计数」被 `if (!killed) killStreak.delete(key)` 清零，
   * 实测 11 次掐断里 10 次 streak=1，刹车一次没触发过。时间窗才刹得住。
   */
  const recordKill = (key) => {
    const now = Date.now();
    const windowMs = Math.max(0, cfg.cooldownWindowMs ?? 0);
    const list = (killTimes.get(key) ?? []).filter((t) => now - t <= windowMs);
    list.push(now);
    killTimes.set(key, list);
    if (cfg.cooldownHits > 0 && list.length >= cfg.cooldownHits) {
      const coolMs = Math.max(0, cfg.cooldownMs ?? 0);
      cooldowns.set(key, now + coolMs);
      killTimes.delete(key);
      log(`冷却：本会话 ${Math.round(windowMs / 1000)}s 内掐了 ${list.length} 次，接下来 ${Math.round(coolMs / 1000)}s 只放行不掐`);
      trace(`冷却开始 ${Math.round(coolMs / 1000)}s`);
    }
  };
  /**
   * 各会话的 agent 引用。掐断后要靠它主动续一轮——没有工具调用的 stop 会让这一轮
   * 直接结束，用户必须再开口；用 agent.followup 投一条消息就能自动接上。
   */
  const sessionAgents = new Map();
  /**
   * 自己构造一条注入用的 user 消息。
   *
   * dsh-llm 的 createUserMessage 就是 `{ ...input, role:'user', id: randomUUID() }` 再深冻结，
   * 手法完全一样。**不 import 它**是有原因的：插件装在 local-plugins 下，那里没有
   * node_modules，`await import('@deepseek-ai/dsh-llm')` 解析不到，followup 就会哑掉
   * （2026-11-23 实机踩过：日志打「没有可用的 agent 或消息工厂」）。
   * @param input - { content, source }。
   * @returns 可投递给 agent.followup 的消息对象。
   */
  const buildUserMessage = (input) => ({ ...input, role: 'user', id: randomUUID() });
  /**
   * 运行时测试钩子（不落盘，重启即失效）：通过 /thinking-guard/state 的 POST 打开，
   * 用来**主动制造一次掐断**——不然这条路径永远等不到真实触发就无法验证。
   * 形状：{ killRun?, minChars?, forceChars? }
   */
  let testOverride = null;

  const log = (msg) => { try { ctx.logger?.warn?.(`thinking-guard: ${msg}`); } catch { /* logger 可能缺席 */ } };

  /**
   * 诊断探针：桌面版看不到 logger 输出，所以另写一份到文件，方便确认中间件到底有没有被调用。
   * 只在流内掐断相关的几个节点写，量很小。
   */
  const traceFile = `${dshHome()}/thinking-guard-trace.log`;
  /** trace 一直开着会一直长，超过这个大小就轮转一次（覆盖旧的 .1）。 */
  const TRACE_MAX_BYTES = 2 * 1024 * 1024;
  let traceWrites = 0;
  const trace = (msg) => {
    if (!cfg.traceEnabled) return;
    try {
      if (traceWrites++ % 100 === 0) {
        try { if (fs.statSync(traceFile).size > TRACE_MAX_BYTES) fs.renameSync(traceFile, traceFile + '.1'); } catch { /* 文件还不存在 */ }
      }
      fs.appendFileSync(traceFile, `${new Date().toISOString()} ${msg}\n`);
    } catch { /* 写不进去就算了 */ }
  };

  /**
   * 当前会话生效的强度：会话覆盖 > 全局默认 > 配置兜底。
   * 会话 id 的两种写法在 state 层归一化，这里不用管。
   */
  const levelFor = (sid) => effectiveLevel(file, sid, cfg.level).level;
  /** 颜色这一维：有没有在整理历史。 */
  const cleanFor = (sid) => levelFor(sid) >= 1;
  /** 形状这一维：打断得多狠（颜色关掉时也要能记住 1..3）。 */
  const tierFor = (sid) => {
    const lv = levelFor(sid);
    // 形状有自己的记录就用它（0/3 = 不整理但快断），没有记录时才跟着颜色走
    return effectiveTier(file, sid, Math.max(1, lv));
  };

  if (typeof cfg.promptText === 'string' && cfg.promptText.length > 0) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      // 系统提示段是全局拼的，拿不到当前会话 id：只能按「全局档」决定要不要注入。
      // 全局拨到 0（关）就不再发这段；单独关掉某个会话仍会带上它——README 已写明这点。
      text: () => (readGlobal(file) === 0 ? '' : cfg.promptText),
      interpolate: false,
    }), 'thinking-guard: section');
  }

  ctx.on('agent/request', async (request, next) => {
    const proposed = await next();
    if (!proposed) return proposed;
    const sid = request?.agent?.session?.id ?? 'global';
    const level = levelFor(sid);
    const out = { ...proposed };

    // stop 序列已证伪：服务端接受、但不截断思考。门槛抬到 99 = 永不挂载
    if (level >= 99 && cfg.stopEnabled && Array.isArray(cfg.stopSequences) && cfg.stopSequences.length > 0) {
      const merged = [...(proposed.stop ?? [])];
      for (const seq of cfg.stopSequences) if (seq && !merged.includes(seq)) merged.push(seq);
      out.stop = merged.slice(0, 16);
    }

    const left = budgetLeft.get(sid) ?? 0;
    if (left > 0 && cfg.degradedMaxTokens > 0) {
      if (out.maxTokens === undefined || out.maxTokens > cfg.degradedMaxTokens) out.maxTokens = cfg.degradedMaxTokens;
      budgetLeft.set(sid, left - 1);
      log(`预算收紧 maxTokens=${cfg.degradedMaxTokens}（剩 ${left - 1} 步）`);
    }
    return out;
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision?.kind !== 'enter') return decision;

    const session = payload?.agent?.session;
    const sid = session?.id ?? 'global';
    const level = levelFor(sid);
    const tier = tierFor(sid);
    if (level < 1 && tier < 2) return decision;   // 既不整理、也不打断：什么都不做

    // 记下 agent，掐断后要用它主动续一轮
    if (payload?.agent && typeof payload.agent.followup === 'function') {
      sessionAgents.set(normalizeId(sid) || String(sid), payload.agent);
    }

    // 上一步是被掐断的：先告诉它这件事，否则它可能从头再推一遍（甚至再卡一次）
    const killedInfo = killedSessions.get(normalizeId(sid) || sid);
    if (killedInfo) {
      killedSessions.delete(normalizeId(sid) || sid);
      const notice = String(cfg.afterKillText ?? '')
        .replace(/\{run\}/g, String(killedInfo.run))
        .replace(/\{chars\}/g, String(killedInfo.chars))
        .replace(/\{reason\}/g, killedInfo.reason ?? '重复写空话');
      trace(`注入掐断提示 sid=${String(sid).slice(0, 16)} run=${killedInfo.run}`);
      const finalNotice = killedInfo.hint
        ? notice + " 你刚才想到的：" + killedInfo.hint + " 别再重推，直接动手。"
        : notice;
      if (finalNotice.length > 0) {
        return {
          ...decision,
          messages: [...(decision.messages ?? []), {
            role: 'user',
            content: [{ type: 'text', text: finalNotice }],
            source: { kind: 'plugin:' + name },
          }],
        };
      }
    }

    const metrics = measure(linesOf(latestReasoning(payload, session)));
    if (!isDegraded(metrics, cfg)) { hits.delete(sid); return decision; }

    const streak = (hits.get(sid) ?? 0) + 1;
    hits.set(sid, streak);
    log(`命中 ${streak} markRun=${metrics.markRun} lines=${metrics.lines} uniq=${metrics.uniq.toFixed(2)} level=${level}`);

    // 档位 2 起：命中后退化，下一步收紧 maxTokens（3 档递进里的第二档）
    if (tier >= 2 && cfg.degradedMaxTokens > 0) budgetLeft.set(sid, 1);

    if (level >= 4 && cfg.fuseAfter > 0 && streak >= cfg.fuseAfter) {
      hits.delete(sid);
      throw new Error(`[thinking-guard] 空转熔断（连续 ${streak} 次，markRun=${metrics.markRun}）`);
    }

    if (cfg.noticeText.length > 0) {
      const text = cfg.noticeText
        .replace(/\{maxRun\}/g, String(metrics.markRun))
        .replace(/\{lines\}/g, String(metrics.lines))
        .replace(/\{ratio\}/g, String(Math.round(metrics.ratio * 100)));
      return {
        ...decision,
        messages: [...(decision.messages ?? []), {
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'plugin:' + name },
        }],
      };
    }
    return decision;
  });

  // ④ 流内掐断：边生成边数短行，确认在空转就收手。
  //    提前结束生成器会被上层当成一次正常 stop（assembler 的 finish 默认 {kind:'stop'}，
  //    loop-agent 的 for await 正常退出不抛错），所以不报错、不重试，
  //    代价只是这一步没有工具调用、进入下一步。
  if (cfg.streamKillRun > 0) {
    ctx.on('llm/stream', async function* (options, next) {
      const sid0 = options?.sessionId ?? '(none)';
      const lv0 = levelFor(sid0);
      trace(`stream 进入 purpose=${options?.purpose ?? '-'} sid=${String(sid0).slice(0, 16)} level=${lv0}`);

      // ⓪ 治本一步：把历史里已经退化的 reasoning 从这一轮的输入里改掉。
      //    退化的思考会被逐轮回传，模型模仿自己 → 自我强化；不摘就会一直喂它垃圾。
      //    options 是深冻结的，原地改会抛错（以前就是这么静默失效的）；
      //    改成克隆一个新的 options 再从 this.streamWithRegistration 发起——
      //    cordis 的 waterfall 会把回调绑到 LlmRuntime 上，所以这里的 this 就是它。
      const scrubOn = readSwitch('scrub') ?? cfg.scrubDegenerateHistory;
      // ⓪ 分两步：先纯计算（失败就退回原请求），再转发（一旦发起就不再回退）。
      //    2026-11-25 外部评估：原来 yield* 包在 try 里，转发流中途抛错会被 catch 吞掉，
      //    然后落回 next() 又跑一遍——上层收到两段输出，原异常丢失。
      if (scrubOn && cleanFor(sid0) && options && typeof options === 'object' && !options[SCRUB_MARK]) {
        let forwardedOptions = null;
        let scrubStats = null;
        try {
          const before = options.messages;
          const scrubbed = scrubDegenerateReasoning(before, cfg);
          const changed = (scrubbed.removed > 0 || scrubbed.stripped > 0) && scrubbed.messages !== before;
          if (!changed) {
            trace('历史消毒：这一轮没有要清的退化块');
          } else if (cfg.scrubStrategy === 'redispatch' && this && typeof this.streamWithRegistration === 'function') {
            forwardedOptions = { ...options, messages: scrubbed.messages };
            Object.defineProperty(forwardedOptions, SCRUB_MARK, { value: true });
            scrubStats = scrubbed;
          } else {
            trace('历史消毒：没有可用的转发入口，本轮不改历史（原地写深冻结对象会抛，已弃用）');
          }
        } catch (error) {
          trace('历史消毒准备失败，本轮走原请求 ' + String(error));
          forwardedOptions = null;
        }

        if (forwardedOptions) {
          // 从这里开始不许回退：请求可能已经发出去，重发会让上层收到两份流。
          let stream;
          try {
            stream = this.streamWithRegistration(forwardedOptions);
            if (stream && typeof stream.then === 'function') stream = await stream;
          } catch (error) {
            trace('历史消毒转发启动失败，错误原样交给宿主 ' + String(error));
            throw error;
          }
          if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
            throw new TypeError('thinking-guard: 转发拿到的不是异步可迭代的流');
          }
          trace('历史消毒（转发）：剔掉 ' + scrubStats.stripped + ' 行占位、省略 ' + scrubStats.removed + ' 段');
          log('从上下文里剔掉 ' + scrubStats.stripped + ' 行占位、省略 ' + scrubStats.removed + ' 段退化思考');
          yield* stream;
          return;
        }
      }

      if (!cfg.streamKillEnabled) { trace('未启用，透传'); yield* next(); return; }
      const sid = options?.sessionId ?? 'global';
      const killLevel = tierFor(sid);
      if (killLevel < 2) { trace('档位不足 2，透传'); yield* next(); return; }
      // 档 2 = 慢速掐断（followup 续轮，等十几秒但历史干净）；档 3+ = 快速（伪造只读调用，<1s）
      const useFastContinue = killLevel >= 3 && cfg.streamKillFastContinue;

      // 测试钩子必须点名会话；没点名就谁都不作用（安全默认）。
      // 2026-11-23 教训：钩子全局生效时把我自己这个会话的思考也掐了。
      const key = normalizeId(sid) || String(sid);
      const testFor = testOverride && normalizeId(testOverride.sessionId ?? '') === key ? testOverride : null;
      const runThreshold = Number.isInteger(testFor?.killRun) ? testFor.killRun : cfg.streamKillRun;
      const minChars = Number.isInteger(testFor?.minChars) ? testFor.minChars : cfg.streamKillMinChars;
      const forceChars = Number.isInteger(testFor?.forceChars) ? testFor.forceChars : 0;
      if (testFor) trace(`测试钩子生效（仅本会话） ${JSON.stringify(testFor)}`);

      // 连续掐断太多次就先停手，免得陷入「掐→重想→再掐」的死循环
      const streakBefore = killStreak.get(key) ?? 0;
      if (cfg.maxKillStreak > 0 && streakBefore >= cfg.maxKillStreak) {
        trace(`连续掐断 ${streakBefore} 次已达上限，本次透传`);
        killStreak.delete(key);
        yield* next();
        return;
      }

      /**
       * 一个推理块的判定状态。
       *
       * 为什么要按块分开（2026-11-26 外部评估第 1 条）：早先这些计数器是整个流的，
       * 于是「14 行短句 + 一次真实 read + 14 行短句」被拼成 28 行连着的短行，
       * 在真实工具已经转发出去之后又插一个假工具、还把原始 stop 吞掉。
       * 现在块结束、切块各归各算；工具块或正文一出现，这条流就不再合成续接。
       */
      const freshBlock = () => ({
        chars: 0, deltas: 0, tail: '', maxRun: 0,
        pendingLine: '', recentLines: [], lineTotal: 0, placeTotal: 0,
        pairCounts: new Map(), pairMax: 0, pairKey: '',
        englishBuf: '', englishAt: -1e9, englishStreak: 0, englishHit: false, englishWhy: '',
        cycleBuf: '', cycleAt: -1e9,
      });
      const blockState = new Map();
      let activeBlock = 'none';
      let st = freshBlock();
      blockState.set(activeBlock, st);

      const isPlaceholder = (line) => MARK_LINE.test(line) || (line.length <= 4 && /^嗯[，,。]?$/.test(line));
      /** 读一张工具表里有没有伪工具名；返回 null 表示这张表看不出结论。 */
      const readToolList = (list) => {
        if (Array.isArray(list)) {
          return list.some((t) => (typeof t === 'string' ? t : (t?.name ?? t?.function?.name)) === cfg.fakeToolName);
        }
        if (list && typeof list === 'object') {
          return Object.prototype.hasOwnProperty.call(list, cfg.fakeToolName);
        }
        return null;
      };
      /** 这一块是不是「真有产出」：正文或真实工具。 */
      const isProgressChunk = (chunk) => {
        switch (chunk?.type) {
          case 'text-delta':
          case 'tool-call-delta':
            return true;
          case 'block-start':
            return chunk.blockType === 'text' || chunk.blockType === 'tool-call';
          case 'block-end':
            return chunk.block?.type === 'text' || chunk.block?.type === 'tool-call';
          default:
            return false;
        }
      };

      let maxIndex = -1;
      /** 本流是否已经有真实工具或正文进度。 */
      let hasProgress = false;
      let killed = false;
      /** 判定过「掐不了 / 不该掐」以后，本流不再逐块重跑。 */
      let killDisabled = false;
      /** followup 投递失败过：本流不再重试，免得每个 chunk 都投一次。 */
      let followupBroken = false;
      let totalDeltas = 0;
      const cycleWindow = Math.max(2048, Math.min(1 << 20, Math.floor(cfg.cycleWindow ?? 12288)));
      const englishStep = Math.max(100, Math.floor(cfg.englishStep ?? 600));

      // 冷却：本会话短时间内掐太多次就先收手，别把正常会话砍成筛子
      const cooling = (cooldowns.get(key) ?? 0) > Date.now();
      if (cooling) trace("冷却中，本次只放行不掐 sid=" + String(sid).slice(0, 16));

      /**
       * 记一次掐断。**投递确认之后才调**——投递失败却先把冷却和连击记上，
       * 等于「这一轮没断，但下一轮不许断」（2026-11-26 外部评估第 2 条）。
       * @param {string} why - 带数字的原因，进日志。
       */
      const commitKill = (why) => {
        killed = true;
        log(`掐流：${why}，在 ${st.chars} 字符处收手`);
        trace(`掐流命中 ${why} chars=${st.chars} streak=${streakBefore + 1}`);
        killStreak.set(key, streakBefore + 1);
        recordKill(key);
      };

      /**
       * 吃一个推理增量：更新这个块的统计、判定、必要时掐断。
       * @param {string} text - 增量文本。
       * @returns {Promise<null | {kind: 'fast'|'slow', run: number, hint: string, whyText: string}>}
       */
      const observeReasoning = async (text) => {
        st.chars += text.length;
        st.deltas += 1;
        totalDeltas += 1;
        st.tail = (st.tail + text).slice(-TAIL_CHARS);
        st.englishBuf = (st.englishBuf + text).slice(-ENGLISH_BUF);
        st.cycleBuf = (st.cycleBuf + text).slice(-cycleWindow);

        // —— 按换行切出完整行（密度 / 相邻对 / 掐断补偿都要用） ——
        st.pendingLine += text;
        for (let nl = st.pendingLine.indexOf('\n'); nl >= 0; nl = st.pendingLine.indexOf('\n')) {
          const line = st.pendingLine.slice(0, nl).trim();
          st.pendingLine = st.pendingLine.slice(nl + 1);
          if (!line) continue;
          const prev = st.recentLines[st.recentLines.length - 1];
          if (prev !== undefined) {
            const pk = prev + '|' + line;
            const seen = (st.pairCounts.get(pk) ?? 0) + 1;
            st.pairCounts.set(pk, seen);
            if (seen > st.pairMax) { st.pairMax = seen; st.pairKey = prev + ' / ' + line; }
          }
          st.recentLines.push(line);
          if (st.recentLines.length > RECENT_LINES_MAX) st.recentLines.shift();
          if (st.pairCounts.size > PAIR_COUNTS_MAX) st.pairCounts.clear();
          st.lineTotal += 1;
          if (isPlaceholder(line)) st.placeTotal += 1;
        }

        const run = trailingShortRun(st.tail);
        if (run > st.maxRun) {
          st.maxRun = run;
          if (run === 8) trace(`连续短行到 8 行（累计 ${st.chars} 字符），继续观察`);
        }

        const forced = forceChars > 0 && st.chars >= forceChars;
        if (!forced && (killDisabled || hasProgress || cooling)) return null;

        const placeRatio = st.lineTotal > 0 ? st.placeTotal / st.lineTotal : 0;
        const repeatHit =
          cfg.streamKillRepeatEnabled &&
          st.lineTotal >= cfg.streamKillRepeatMinLines &&
          st.pairMax >= cfg.streamKillRepeatMin &&
          placeRatio >= cfg.streamKillRepeatRatioMin &&
          st.chars >= minChars;
        const densityHit =
          cfg.streamKillDensityEnabled &&
          st.lineTotal >= cfg.streamKillDensityMinLines &&
          placeRatio >= cfg.streamKillDensityRatio &&
          st.chars >= minChars;
        const shortHit = run >= runThreshold && st.chars >= minChars;

        // 英文句级：按**已收字符数**采样。按 delta 个数走的话，同一段文本换个分片就是另一个结论
        // （2026-11-26 外部评估第 3 条：11 字符分片误掐正常对照，256 字符分片整段放过）。
        if (cfg.streamKillEnglishEnabled && !st.englishHit
          && st.englishBuf.length > ENGLISH_MIN_BUF
          && st.chars - st.englishAt >= englishStep) {
          st.englishAt = st.chars;
          const metrics = englishMetrics(st.englishBuf);
          if (isEnglishDegenerate(metrics, cfg)) {
            st.englishStreak += 1;
            st.englishWhy = `英文重复 同一句占 ${Math.round(metrics.dupRatio * 100)}%（句首 4 词 ${metrics.gramMax} 次「${metrics.gramKey}」只作观察）`;
            // 只超阈一次不算：半截缓冲的分母还在长，占比会虚高（2026-11-25 那次误伤就是单次采样）
            if (st.englishStreak >= 2) st.englishHit = true;
          } else {
            st.englishStreak = 0;
          }
        }

        // 精确周期：跟语言、断行、标点都无关的那条判据。
        // 和别的判据一样服从字符下限——短步骤里就算真有重复也不掐（用户设的 streamKillMinChars）。
        let cycle = null;
        if (cfg.streamKillCycleEnabled && st.chars >= minChars && st.chars - st.cycleAt >= cfg.cycleStep) {
          st.cycleAt = st.chars;
          cycle = tailCycle(stripStructuralLines(st.cycleBuf), cfg);
        }

        const englishHit = st.englishHit;
        if (!forced && !cycle && !englishHit && !repeatHit && !densityHit && !shortHit) return null;

        const why = forced
          ? '强制'
          : cycle
            ? `精确周期 ${cycle.period} 字 × ${cycle.repeats} 遍`
            : englishHit
              ? st.englishWhy
              : repeatHit
                ? '重复对 ' + st.pairMax + ' 次「' + st.pairKey + '」占位 ' + Math.round(placeRatio * 100) + '%'
                : densityHit
                  ? `密度 ${st.placeTotal}/${st.lineTotal}`
                  : `连续 ${run} 行`;
        /** 给模型看的人话原因；日志里的 why 带数字，不适合直接嵌进提示。 */
        const whyText = forced
          ? '测试强制触发'
          : cycle
            ? '同一段内容在反复重写'
            : englishHit
              ? '英文句子里反复写同一句'
              : repeatHit
                ? '同一对行来回写'
                : densityHit
                  ? '占位行太密'
                  : `连着写了 ${run} 行短句`;

        // 掐之前先确认「掐完能不能接上」：快断看当前请求的工具表，慢续要有 followup。
        // 两样都确认不了就不掐——白掐一轮还没人接，比不掐更糟（2026-11-25 外部评估）。
        let fakeToolState = readToolList(options?.tools);
        if (fakeToolState === null) {
          const probe = sessionAgents.get(key);
          for (const list of [probe?.tools, probe?.toolNames, probe?.session?.tools, probe?.session?.toolNames]) {
            const state = readToolList(list);
            if (state !== null) { fakeToolState = state; break; }
          }
        }
        const canFast = useFastContinue && fakeToolState === true;
        const agentRef = sessionAgents.get(key);
        const canFollow = Boolean(
          !followupBroken
          && cfg.followupFallback
          && typeof cfg.afterKillText === 'string' && cfg.afterKillText.length > 0
          && agentRef && typeof agentRef.followup === 'function',
        );

        if (cfg.streamKillDryRun) {
          log(`[试运行] 该掐了：${why}，已生成 ${st.chars} 字符`);
          trace(`试运行命中 ${why} chars=${st.chars}，快断=${canFast} 慢续=${canFollow}`);
          killDisabled = true;                       // 一个流记一次就够，别每块刷屏
          return null;
        }
        if (!canFast && !canFollow) {
          killDisabled = true;
          trace(`掐了也没人接（${cfg.fakeToolName} ${fakeToolState === false ? '不在工具表' : '未确认'}，followup 不可用），放行本次生成；原因 ${why}`);
          return null;
        }

        const hint = buildCompensation(st.recentLines, cfg);
        if (canFast) {
          commitKill(why);
          if (hint) trace("掐断补偿：" + hint.length + " 字（原文不入日志）");
          return { kind: 'fast', run, hint, whyText };
        }

        // 慢速续轮：**投递成功才算掐断**。同步抛错、或者返回的 Promise 被拒，
        // 都按「这次没掐」处理——原流继续透传，原来的 stop 也照常到上层。
        const followText = String(cfg.afterKillText).replace(/\{reason\}/g, whyText);
        try {
          const maybe = agentRef.followup(buildUserMessage({
            content: [{ type: 'text', text: followText }],
            source: { kind: 'plugin:' + name },
          }));
          // 宿主要是有可等待的投递确认，就按它的契约等；没有就当作已投
          if (maybe && typeof maybe.then === 'function') await maybe;
        } catch (error) {
          followupBroken = true;
          killDisabled = true;
          trace(`followup 投递失败，本次不掐断、原流继续：${String(error)}`);
          log(`慢速续轮没投出去，这一次不掐断（原生成继续）：${error?.message ?? String(error)}`);
          return null;
        }
        commitKill(why);
        if (hint) trace("掐断补偿：" + hint.length + " 字（原文不入日志）");
        trace('已用 followup 续一轮');
        return { kind: 'slow', run, hint, whyText };
      };
      for await (const chunk of next()) {
        const idx = typeof chunk?.index === 'number' ? chunk.index : null;
        if (idx !== null && idx > maxIndex) maxIndex = idx;

        // —— 推理块隔离：换块就换一套状态，块结束就把这套状态扔掉 ——
        if (idx !== null) {
          if (chunk?.type === 'block-start' && chunk.blockType === 'reasoning') {
            activeBlock = idx;
            st = freshBlock();
            blockState.set(idx, st);
          } else if (idx !== activeBlock) {
            activeBlock = idx;
            st = blockState.get(idx) ?? freshBlock();
            blockState.set(idx, st);
          }
        }
        if (chunk?.type === 'block-end' && chunk.block?.type === 'reasoning') {
          const done = idx ?? activeBlock;
          blockState.delete(done);
          if (done === activeBlock) { st = freshBlock(); blockState.set(activeBlock, st); }
        }

        // —— 真实进度：之后一律不做合成续接，原始终止事件照常透传 ——
        if (!hasProgress && isProgressChunk(chunk)) {
          hasProgress = true;
          trace('本流已有真实工具/正文进度，之后不再判定（原始终止事件照常透传）');
        }

        const action = chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string'
          ? await observeReasoning(chunk.text)
          : null;

        if (action?.kind === 'fast') {
          // 快速续轮：伪造一个只读工具调用，把 finish 改成 tool-calls。
          // 这一轮于是不会结束，直接进下一步（延迟 <1s），下一步的 pre-step 再注入提示。
          const fakeIndex = maxIndex + 1;
          const fakeId = `call_${randomUUID()}`;
          const fakeName = cfg.fakeToolName;
          const fakeArgs = '{}';
          trace(`伪造工具调用 ${fakeName}（index=${fakeIndex}）让本轮直接进下一步`);
          yield { type: 'block-start', index: fakeIndex, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: fakeIndex, id: fakeId, name: fakeName, argumentsDelta: fakeArgs };
          yield { type: 'block-end', index: fakeIndex, block: { type: 'tool-call', id: fakeId, name: fakeName, arguments: fakeArgs } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          // 让下一步的 pre-step 注入「你被截断了」（伪造路径没有投递消息，只能靠它）
          killedSessions.set(key, { run: action.run, chars: st.chars, hint: action.hint, reason: action.whyText });
          return;
        }
        if (action?.kind === 'slow') break;
        yield chunk;
      }
      if (!killed) killStreak.delete(key);
      trace(`stream 结束 killed=${killed} deltas=${totalDeltas} chars=${st.chars} maxRun=${st.maxRun}`);
      if (killed) log('本次生成已提前结束（上层按正常 stop 处理）');
    });
  }

  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer;
    if (!server || typeof server.register !== 'function') {
      log('webServer 没有 register()，滑条接不上');
      return;
    }
    webCtx.effect(() => server.register({
      kind: 'exact',
      path: ROUTE_STATE,
      async handler(req, res) {
        if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method === 'GET') {
          const sid = new URL(req.url, 'http://127.0.0.1').searchParams.get('sessionId') ?? '';
          const effective = effectiveLevel(file, sid, cfg.level);
          return sendJson(res, 200, {
            ok: true,
            level: effective.level,
            tier: effectiveTier(file, sid, Math.max(1, effective.level)),
            scope: effective.scope,
            global: readGlobal(file) ?? null,
            max: MAX_LEVEL,
            fallback: cfg.level,
            test: testOverride,
          });
        }
        if (req.method === 'POST') {
          const body = await readJson(req);
          // 测试钩子：{ test: { sessionId, killRun, minChars, forceChars } }，传 null 清除。
          // **必须带 sessionId**——全局生效的破坏性开关会连自己一起打。
          // 只存内存、不落盘，重启即失效。
          if (body && Object.prototype.hasOwnProperty.call(body, 'test')) {
            if (body.test === null) {
              testOverride = null;
              log('测试钩子已清除');
              return sendJson(res, 200, { ok: true, test: null });
            }
            if (typeof body.test?.sessionId !== 'string' || body.test.sessionId.length === 0) {
              return sendJson(res, 400, { ok: false, error: 'test 钩子必须带 sessionId，禁止全局生效' });
            }
            testOverride = body.test;
            log(`测试钩子 → 仅对会话 ${normalizeId(body.test.sessionId)} 生效：${JSON.stringify(testOverride)}`);
            return sendJson(res, 200, { ok: true, test: testOverride });
          }
          const level = Number(body?.level);
          if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL) {
            return sendJson(res, 400, { ok: false, error: 'level 必须是 0..' + MAX_LEVEL + ' 的整数' });
          }
          // 形状档位：不传就跟着 level 走（level 0 归一到 1——灰圆＝两项都关）
          const rawTier = body?.tier === undefined ? Math.max(1, level) : Number(body.tier);
          if (!Number.isInteger(rawTier) || rawTier < 1 || rawTier > 3) {
            return sendJson(res, 400, { ok: false, error: 'tier 必须是 1..3 的整数' });
          }
          const tier = rawTier;
          if (body?.scope === 'global') {
            writeGlobal(file, level);
            writeGlobalTier(file, tier);
            log(`档位 → 全局默认 ${level} / 形状 ${tier}（已清掉所有会话特例）`);
            return sendJson(res, 200, { ok: true, level, tier, scope: 'global', global: level, max: MAX_LEVEL });
          }
          const sid = normalizeId(typeof body?.sessionId === 'string' ? body.sessionId : '');
          if (!sid) return sendJson(res, 400, { ok: false, error: 'scope=session 时必须给 sessionId' });
          // 拖回跟默认一样的值＝没改过：直接删掉覆盖，别留一条「看起来设过」的记录。
          const inherited = Number.isInteger(readGlobal(file)) ? readGlobal(file) : cfg.level;
          if (level === inherited) {
            clearSessionLevel(file, sid);
            writeSessionTier(file, sid, tier);
            log(`档位 → 会话 ${sid.slice(0, 8)} 回到默认颜色 ${level}，形状 ${tier}`);
            return sendJson(res, 200, {
              ok: true,
              level,
              tier,
              scope: Number.isInteger(readGlobal(file)) ? 'global' : 'default',
              max: MAX_LEVEL,
            });
          }
          writeSessionLevel(file, sid, level);
          writeSessionTier(file, sid, tier);
          log(`档位 → 会话 ${sid.slice(0, 8)} 颜色 ${level} / 形状 ${tier}`);
          return sendJson(res, 200, { ok: true, level, tier, scope: 'session', max: MAX_LEVEL });
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      },
    }), 'thinking-guard: state route');
  });

  return { measure, isDegraded, DEFAULTS, MAX_LEVEL };
}
