/**
 * dsh-thinking-guard — 宿主半。
 *
 * 治的是：模型在 reasoning 通道里退化成「好。/做。」这类无宾语占位词，
 * 一边刷几百行一边迟迟不发出工具调用。工具调用本身是对的，烧的是时间。
 *
 * 三件可独立开关的事，由「强度」一个数控制（0–4，滑条就是它）：
 *   0 关
 *   1 只记账：写日志，不碰请求
 *   2 提醒：下一步注入一句（文案由使用者写）
 *   3 掐断：给请求挂 stop 序列，模型写出循环串即刻停生成
 *   4 掐断 + 预算收紧 + 熔断
 *
 * 风格上刻意不预设「性格」：所有会被读到的文字都是配置字符串，
 * 留空就等于安静模式。
 */

import { isLoopback, readJson, sendJson } from './route.js';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dshHome, clearSessionLevel, effectiveLevel, normalizeId, readGlobal, writeGlobal, writeSessionLevel } from './state.js';

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
export const MAX_LEVEL = 4;

/**
 * 默认配置。profile 的 patch 可以覆盖任意一项。
 * 默认 2（只提醒）——掐断会改请求参数，属于会改变手感的选择，不默认开。
 */
const DEFAULTS = {
  level: 2,
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
   * 防的是「正常步骤恰好尾部有十几行短行」——正常步骤的思考通常只有几百字符，
   * 退化才会上千。也顺带保证不会为了省几百字符去中断一个本来很短的步骤。
   */
  streamKillMinChars: 1000,
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
  /** 被掐断后，下一步给模型的一句提示（空字符串 = 不提示）。 */
  afterKillText: '你上一步在思考里重复写「做。/好。」被截断了，那条思路没走完。别重新推一遍，直接做你上一步已经决定的事。',
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
export function scrubDegenerateReasoning(messages, cfg) {
  if (!Array.isArray(messages)) return { messages, removed: 0 };
  let removed = 0;
  const next = messages.map((message) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return message;
    let touched = false;
    const content = message.content.map((block) => {
      if (block?.type !== 'reasoning' || typeof block.text !== 'string') return block;
      const metrics = measure(block.text.split('\n'));
      if (!isDegraded(metrics, cfg)) return block;
      touched = true;
      removed += 1;
      return { ...block, text: `（上一段思考陷入重复 ${metrics.markRun} 行，已省略）` };
    });
    return touched ? { ...message, content } : message;
  });
  return { messages: removed > 0 ? next : messages, removed };
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

/** 只保留尾部这么多字符做实时判断，避免每次全量扫描。 */
const TAIL_CHARS = 400;

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
  const trace = (msg) => {
    if (!cfg.traceEnabled) return;
    try { fs.appendFileSync(traceFile, `${new Date().toISOString()} ${msg}\n`); } catch { /* 写不进去就算了 */ }
  };

  /**
   * 当前会话生效的强度：会话覆盖 > 全局默认 > 配置兜底。
   * 会话 id 的两种写法在 state 层归一化，这里不用管。
   */
  const levelFor = (sid) => effectiveLevel(file, sid, cfg.level).level;

  if (typeof cfg.promptText === 'string' && cfg.promptText.length > 0) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: () => cfg.promptText,
      interpolate: false,
    }), 'thinking-guard: section');
  }

  ctx.on('agent/request', async (request, next) => {
    const proposed = await next();
    if (!proposed) return proposed;
    const sid = request?.agent?.session?.id ?? 'global';
    const level = levelFor(sid);
    const out = { ...proposed };

    if (level >= 3 && cfg.stopEnabled && Array.isArray(cfg.stopSequences) && cfg.stopSequences.length > 0) {
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
    if (level < 1) return decision;

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
        .replace(/\{chars\}/g, String(killedInfo.chars));
      trace(`注入掐断提示 sid=${String(sid).slice(0, 16)} run=${killedInfo.run}`);
      if (notice.length > 0) {
        return {
          ...decision,
          messages: [...(decision.messages ?? []), {
            role: 'user',
            content: [{ type: 'text', text: notice }],
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
    if (level >= 2 && cfg.degradedMaxTokens > 0) budgetLeft.set(sid, 1);

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

      // ⓪ 治本一步：把历史上已经退化的 reasoning 从这一轮的输入里摘掉。
      //    退化的思考会被逐轮回传，模型模仿自己 → 自我强化；不摘就会一直喂它垃圾。
      //    options 是 next() 闭包里捕获的同一个对象，改它等于改即将发出的请求。
      if (cfg.scrubDegenerateHistory && lv0 >= 1 && options && typeof options === 'object') {
        try {
          const before = options.messages;
          const scrubbed = scrubDegenerateReasoning(before, cfg);
          if (scrubbed.removed > 0 && scrubbed.messages !== before) {
            options.messages = scrubbed.messages;
            trace(`清掉 ${scrubbed.removed} 段退化思考（历史消毒）`);
            log(`从上下文里摘掉 ${scrubbed.removed} 段退化思考`);
          }
        } catch (error) {
          trace(`历史消毒失败 ${String(error)}`);
        }
      }

      if (!cfg.streamKillEnabled) { trace('未启用，透传'); yield* next(); return; }
      const sid = options?.sessionId ?? 'global';
      const killLevel = levelFor(sid);
      if (killLevel < 2) { trace('强度不足 2，透传'); yield* next(); return; }
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

      let tail = '';
      let chars = 0;
      let deltaCount = 0;
      let maxRun = 0;
      let maxIndex = -1;
      let killed = false;
      for await (const chunk of next()) {
        if (typeof chunk?.index === 'number' && chunk.index > maxIndex) maxIndex = chunk.index;
        if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          chars += chunk.text.length;
          deltaCount++;
          tail = (tail + chunk.text).slice(-TAIL_CHARS);
          const run = trailingShortRun(tail);
          if (run > maxRun) {
            maxRun = run;
            if (run === 8) trace(`连续短行到 8 行（累计 ${chars} 字符），继续观察`);
          }
          const forceHit = forceChars > 0 && chars >= forceChars;
          if (forceHit || (run >= runThreshold && chars >= minChars)) {
            if (cfg.streamKillDryRun) {
              log(`[试运行] 该掐了：连续短行 ${run} 行，已生成 ${chars} 字符`);
              trace(`试运行命中 run=${run} chars=${chars}`);
              tail = '';
            } else {
              killed = true;
              log(`掐流：连续短行 ${run} 行，在 ${chars} 字符处收手${forceHit ? '（测试钩子强制）' : ''}`);
              trace(`掐流命中 run=${run} chars=${chars} streak=${streakBefore + 1}${forceHit ? ' force=true' : ''}`);
              killStreak.set(key, streakBefore + 1);

              // 快速续轮：伪造一个只读工具调用，把 finish 改成 tool-calls。
              // 这一轮于是不会结束，直接进下一步（延迟 <1s），下一步的 pre-step 再注入提示。
              if (useFastContinue) {
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
                killedSessions.set(key, { run, chars });
                return;
              }

              // 慢速续轮（兜底）：用 followup 投一条消息，等 turn 收尾后自己起新的一轮。
              let continued = false;
              if (cfg.followupFallback && cfg.afterKillText.length > 0) {
                const agentRef = sessionAgents.get(key);
                if (agentRef && typeof agentRef.followup === 'function') {
                  try {
                    agentRef.followup(buildUserMessage({
                      content: [{ type: 'text', text: cfg.afterKillText }],
                      source: { kind: 'plugin:' + name },
                    }));
                    continued = true;
                    trace('已用 followup 续一轮');
                  } catch (error) {
                    trace(`followup 失败 ${String(error)}`);
                  }
                } else {
                  trace('没有缓存的 agent，掐断后不会自动续（该会话还没走过 pre-step）');
                }
              }
              if (!continued) killedSessions.set(key, { run, chars });
              break;
            }
          }
        }
        yield chunk;
      }
      if (!killed) killStreak.delete(key);
      trace(`stream 结束 killed=${killed} deltas=${deltaCount} chars=${chars} maxRun=${maxRun}`);
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
          if (body?.scope === 'global') {
            writeGlobal(file, level);
            log(`滑条 → 全局默认 ${level}（已清掉所有会话特例）`);
            return sendJson(res, 200, { ok: true, level, scope: 'global', global: level, max: MAX_LEVEL });
          }
          const sid = normalizeId(typeof body?.sessionId === 'string' ? body.sessionId : '');
          if (!sid) return sendJson(res, 400, { ok: false, error: 'scope=session 时必须给 sessionId' });
          // 拖回跟默认一样的值＝没改过：直接删掉覆盖，别留一条「看起来设过」的记录。
          const inherited = Number.isInteger(readGlobal(file)) ? readGlobal(file) : cfg.level;
          if (level === inherited) {
            clearSessionLevel(file, sid);
            log(`滑条 → 会话 ${sid.slice(0, 8)} 回到默认 ${level}（已清掉覆盖）`);
            return sendJson(res, 200, {
              ok: true,
              level,
              scope: Number.isInteger(readGlobal(file)) ? 'global' : 'default',
              max: MAX_LEVEL,
            });
          }
          writeSessionLevel(file, sid, level);
          log(`滑条 → 会话 ${sid.slice(0, 8)} 强度 ${level}`);
          return sendJson(res, 200, { ok: true, level, scope: 'session', max: MAX_LEVEL });
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      },
    }), 'thinking-guard: state route');
  });

  return { measure, isDegraded, DEFAULTS, MAX_LEVEL };
}
