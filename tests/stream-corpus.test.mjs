// 2026-11-26 第三轮外部评估的离线回归。
//
// 每个用例是一种「退化形态」或一种「正常对照」，一律按 7 / 11 / 64 / 256 / 1024 五种分片各跑一遍。
// 分片不同、结论必须一样——这本身就是验收项：上一版同一段英文在 11 字符分片被掐、256 字符分片整段放过。
//
// 语料全部是本地新写的形状复现，不引用任何公开报告原文；形态出处记在各自的 name 里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-corpus-'));
process.env.DSH_HOME = HOME;

const {
  apply, tailCycle, stripStructuralLines, stripPlaceholderLines, protectMask, englishMetrics, isEnglishDegenerate,
} = await import('../src/index.js');
const { writeSessionLevel } = await import('../src/state.js');

function makeCtx() {
  const handlers = new Map();
  const logs = [];
  const ctx = {
    handlers, logs,
    on(event, fn) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(fn); },
    effect(fn) { fn(); return () => {}; },
    systemPrompt: { section() { return { dispose() {} }; } },
    inject(names, fn) {
      if (!names.includes('webServer')) return;
      fn({ webServer: { register() { return { dispose() {} }; } }, effect: ctx.effect });
    },
    logger: { warn: (m) => logs.push(m), info: (m) => logs.push(m) },
  };
  return ctx;
}

/** 把一段文本按指定分片喂进流内中间件，返回掐没掐、以及上层最终收到的 finish。 */
async function runStream(text, chunkSize, config = {}, sid = 'corpus') {
  writeSessionLevel(path.join(HOME, 'thinking-guard.json'), sid, 3);
  const ctx = makeCtx();
  apply(ctx, { level: 3, traceEnabled: false, promptText: '', ...config });
  const handler = ctx.handlers.get('llm/stream')[0];
  const chars = Array.from(text);
  const chunks = [];
  for (let i = 0; i < chars.length; i += chunkSize) {
    chunks.push({ type: 'reasoning-delta', index: 0, text: chars.slice(i, i + chunkSize).join('') });
  }
  chunks.push({ type: 'finish', reason: { kind: 'stop' } });
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: sid, tools: [{ name: 'get_goal' }] }, next)) out.push(c);
  return {
    logs: ctx.logs,
    cut: out.some((c) => c.type === 'finish' && c.reason?.kind === 'tool-calls'),
    finishKinds: out.filter((c) => c.type === 'finish').map((c) => c.reason?.kind),
    syntheticTool: out.some((c) => c.type === 'tool-call-delta'),
    forwarded: out.filter((c) => c.type === 'reasoning-delta').length,
    total: chars.length,
  };
}

const PLAN = '我先检查这份设置说明，弄清楚为什么连续运行两次得到同样的结果。';
const WORDY = 'Observe the inputs and keep the steps separate. ';

// ---------- 形状 ----------

const CASES = [
  {
    name: '协议结束标签复读（一行 12 字，不算短行，也不进中文占位词表）',
    expectCut: true,
    text: 'I will now continue with the next step.\n' + '</assistant>\n'.repeat(120),
  },
  {
    name: '两个协议标签交替复读',
    expectCut: true,
    text: 'The formatting went wrong somewhere in the middle.\n' + '</parameter>\n</invoke>\n'.repeat(80),
  },
  {
    name: '无分隔符的符号串（整段只有一行，行首/密度判据全失效）',
    expectCut: true,
    text: '先核对输入。\n' + '！！：'.repeat(600),
  },
  {
    name: '同一条长中文陈述反复（一行三十多字，既不算短行也不算占位）',
    expectCut: true,
    text: (PLAN + '\n').repeat(80),
  },
  {
    name: '非拉丁短句循环（俄文，中文占位词表看不见）',
    expectCut: true,
    text: 'Сначала проверю.\nГотовлю следующий вызов.\nТеперь повторю проверку.\nЗапускаю новый шаг.\nХорошо.\n'.repeat(40),
  },
  {
    name: '长周期：一整段编号加引文原样循环（周期约 1.6K 字，比任何行级窗口都长）',
    expectCut: true,
    text: Array.from({ length: 40 }, (_, i) => `第${i}条资料解释样本${i + 13}的筛选条件。保留参考文献[^${i}]以便跟踪。`).join('').repeat(6),
  },
  {
    name: '正常对照：四反引号围栏里套三反引号，源码一个字节都不许动',
    expectCut: false,
    text: [
      '下面这段是 Markdown 源码，原样保留它的字节。',
      '````markdown',
      '```text',
      '好。',
      '做。',
      '（调用）',
      '```',
      '````',
      '接着拿转义后的输出跟期望的渲染比一遍。',
      '最后把结论写进交接文档，别只留在日志里。',
    ].join('\n'),
  },
  {
    name: '正常对照：同一句式逐条列举，后半句各不同（上一版在 11 字符分片误掐的就是它）',
    expectCut: false,
    text: [
      WORDY.trim(),
      ...Array.from({ length: 25 }, (_, i) => `For this verification pass, check step ${i + 1} of the render pipeline and record what changed.`),
      'The checks cover different conditions and are complete.',
    ].join('\n'),
  },
  {
    name: '正常对照：链接清单反复（结构性重复不是空转）',
    expectCut: false,
    text: 'README 的锚点是这样排的：\n' + '<a href="#-what-it-does">What it does</a> ·\n'.repeat(60),
  },
  {
    name: '正常对照：一大段没有周期的正常思考',
    expectCut: false,
    text: Array.from({ length: 160 }, (_, i) => `第 ${i} 步先看 ${['main.js', 'route.js', 'state.js'][i % 3]} 的第 ${i} 行，确认回调有没有绑到 runtime 上，再决定改不改。`).join('\n'),
  },
];

test('流内判据：每种形状在 5 种分片下结论一致', async () => {
  const chunkSizes = [7, 11, 64, 256, 1024];
  const failures = [];
  for (const item of CASES) {
    const verdicts = [];
    for (const size of chunkSizes) {
      const out = await runStream(item.text, size, {}, `case-${CASES.indexOf(item)}-${size}`);
      verdicts.push({ size, cut: out.cut, forwarded: out.forwarded, total: out.total });
    }
    const cuts = verdicts.map((v) => v.cut);
    if (new Set(cuts).size !== 1) {
      failures.push(`${item.name}：分片之间结论不一致 ${JSON.stringify(verdicts)}`);
      continue;
    }
    if (cuts[0] !== item.expectCut) {
      failures.push(`${item.name}：应${item.expectCut ? '触发' : '透传'}，实际${cuts[0] ? '触发' : '透传'}`);
      continue;
    }
    // 该透传的必须一个增量都不少
    if (!item.expectCut) {
      for (const v of verdicts) {
        if (v.forwarded !== Math.ceil(v.total / v.size)) {
          failures.push(`${item.name}：分片 ${v.size} 该整段透传，实际只放行 ${v.forwarded} 段`);
        }
      }
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});

test('tailCycle：认得出各种周期，也认得出现在没有周期这件事', () => {
  assert.equal(tailCycle('</assistant>\n'.repeat(40), {}).period, 13, '单个结束标签的周期是它自己那一行');
  assert.equal(tailCycle('！！：'.repeat(600), {}).period, 3, '符号串的周期是 3 个字符');
  assert.equal(tailCycle('好。\n做。\n'.repeat(8), {}).period, 6, '占位词轮转的周期是那两行');
  // 遍数下限：4 遍才算「原样重来」
  const unit = 'ABCDEFGHIJKLMNOPQRST';          // 20 个字，自身没有更小的周期
  assert.equal(tailCycle(unit.repeat(3), {}), null, '只有 3 遍不判');
  assert.equal(tailCycle(unit.repeat(4), {}).period, 20, '4 遍才判');
  // 长度下限：短分隔符不该被算成循环
  assert.equal(tailCycle('---\n'.repeat(6), {}), null, '6×4=24 字，不到 48 字下限');
  assert.equal(tailCycle('一句很长的正常推理内容在这里展开说明，然后继续往前推进。', {}), null, '没有周期就是没有');
  assert.equal(tailCycle('', {}), null);
});

// ---------- ① 跨推理块不累计 ----------

const lineBlock = (index, start) => [
  { type: 'block-start', index, blockType: 'reasoning' },
  ...Array.from({ length: 14 }, (_, k) => ({ type: 'reasoning-delta', index, text: `样本${String(start + k).padStart(2, '0')}项\n` })),
  { type: 'block-end', index, block: { type: 'reasoning', text: '' } },
];
const readTool = [
  { type: 'block-start', index: 1, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 1, id: 'read-ok', name: 'read', argumentsDelta: '{}' },
  { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'read-ok', name: 'read', arguments: '{}' } },
];

async function feedChunks(chunks, config = {}, sid = 'blocks') {
  writeSessionLevel(path.join(HOME, 'thinking-guard.json'), sid, 3);
  const ctx = makeCtx();
  apply(ctx, { level: 3, traceEnabled: false, promptText: '', streamKillMinChars: 0, ...config });
  const handler = ctx.handlers.get('llm/stream')[0];
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: sid, tools: [{ name: 'get_goal' }, { name: 'read' }] }, next)) out.push(c);
  return { out, logs: ctx.logs };
}

test('两个推理块各 14 行短句：不许跨块拼成 28 行（外部评估第 1 条）', async () => {
  const chunks = [...lineBlock(0, 0), ...readTool, ...lineBlock(2, 14), { type: 'finish', reason: { kind: 'stop' } }];
  const { out, logs } = await feedChunks(chunks);
  assert.equal(out.filter((c) => c.type === 'reasoning-delta').length, 28, '两段推理都要原样透传');
  assert.ok(!out.some((c) => c.type === 'tool-call-delta' && c.id !== 'read-ok'), '不许再插假工具');
  assert.ok(out.some((c) => c.type === 'block-end' && c.block?.id === 'read-ok'), '真实 read 的 block-end 要保留');
  assert.deepEqual(
    out.filter((c) => c.type === 'finish').map((c) => c.reason?.kind),
    ['stop'],
    '原始的 stop 必须原样到上层',
  );
  assert.ok(!logs.some((l) => l.includes('掐流')), '不该掐断');
});

test('真实工具已经转发出去之后，后面的复读也不再伪造工具', async () => {
  const loop = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', index: 2, text: '做。\n' }));
  const chunks = [...lineBlock(0, 0), ...readTool, { type: 'block-start', index: 2, blockType: 'reasoning' }, ...loop, { type: 'finish', reason: { kind: 'stop' } }];
  const { out } = await feedChunks(chunks);
  assert.ok(!out.some((c) => c.type === 'tool-call-delta' && c.id !== 'read-ok'), '已有真实工具就不该合成');
  assert.deepEqual(out.filter((c) => c.type === 'finish').map((c) => c.reason?.kind), ['stop'], '原始终止事件照常透传');
});

test('单个推理块一直复读：照样要掐（按块隔离不能把既有能力弄丢）', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', index: 0, text: '做。\n' })),
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const { out } = await feedChunks(chunks);
  assert.ok(out.some((c) => c.type === 'tool-call-delta'), '单块复读仍要合成续接');
});

// ---------- ② 慢续投递失败不许截断 ----------

function slowEnv(followup) {
  return { followup, calls: [] };
}

test('followup 同步抛错：不掐断，原 stop 照常到上层，也不记冷却', async () => {
  writeSessionLevel(path.join(HOME, 'thinking-guard.json'), 'followup-throw', 3);
  const ctx = makeCtx();
  apply(ctx, { level: 3, traceEnabled: false, promptText: '', streamKillMinChars: 0, streamKillFastContinue: false });
  const env = slowEnv(() => { throw new Error('fixture: inbox rejected'); });
  const agent = { session: { id: 'followup-throw', ownEvents: () => [] }, followup: (m) => { env.calls.push(m); return env.followup(); } };
  await ctx.handlers.get('agent/pre-step')[0]({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }));

  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = [...Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', index: 0, text: '好。\n做。\n' })), { type: 'finish', reason: { kind: 'stop' } }];
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: 'followup-throw', tools: [] }, next)) out.push(c);

  assert.equal(env.calls.length, 1, '整条流只尝试投递一次，不每个 chunk 重试');
  assert.deepEqual(out.filter((c) => c.type === 'finish').map((c) => c.reason?.kind), ['stop'], '原 stop 必须读到');
  assert.equal(out.filter((c) => c.type === 'reasoning-delta').length, 40, '原生成必须完整透传');
  assert.ok(!ctx.logs.some((l) => l.includes('掐流')), '投递没成就不能记成掐断');
});

test('followup 返回被拒的 Promise：同样按「没掐」处理', async () => {
  writeSessionLevel(path.join(HOME, 'thinking-guard.json'), 'followup-reject', 3);
  const ctx = makeCtx();
  apply(ctx, { level: 3, traceEnabled: false, promptText: '', streamKillMinChars: 0, streamKillFastContinue: false });
  let calls = 0;
  const agent = {
    session: { id: 'followup-reject', ownEvents: () => [] },
    followup() { calls += 1; return Promise.reject(new Error('fixture: delivery refused')); },
  };
  await ctx.handlers.get('agent/pre-step')[0]({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }));

  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = [...Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', index: 0, text: '好。\n做。\n' })), { type: 'finish', reason: { kind: 'stop' } }];
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: 'followup-reject', tools: [] }, next)) out.push(c);

  assert.equal(calls, 1, '只投一次');
  assert.deepEqual(out.filter((c) => c.type === 'finish').map((c) => c.reason?.kind), ['stop'], '原 stop 必须读到');
  assert.ok(!ctx.logs.some((l) => l.includes('掐流')));
});

test('followup 投递成功：只续一次，且这次真算掐断', async () => {
  writeSessionLevel(path.join(HOME, 'thinking-guard.json'), 'followup-ok', 3);
  const ctx = makeCtx();
  apply(ctx, { level: 3, traceEnabled: false, promptText: '', streamKillMinChars: 0, streamKillFastContinue: false });
  let calls = 0;
  const agent = { session: { id: 'followup-ok', ownEvents: () => [] }, followup() { calls += 1; } };
  await ctx.handlers.get('agent/pre-step')[0]({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }));

  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = Array.from({ length: 60 }, () => ({ type: 'reasoning-delta', index: 0, text: '好。\n做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  let forwarded = 0;
  for await (const c of handler({ sessionId: 'followup-ok', tools: [] }, next)) if (c.type === 'reasoning-delta') forwarded += 1;

  assert.equal(calls, 1, '投递成功也只续一次');
  assert.ok(forwarded < 60, '投递成功后该收手');
  assert.ok(ctx.logs.some((l) => l.includes('掐流')));
});

// ---------- ⑤ 围栏关闭条件按 CommonMark ----------

test('四反引号围栏不会被里面的三反引号关掉（外部评估第 5 条）', () => {
  const src = [
    '下面这段是 Markdown 源码，原样保留它的字节。',
    '````markdown',
    '```text',
    '好。',
    '做。',
    '（调用）',
    '```',
    '````',
    '接着拿转义后的输出跟期望的渲染比一遍。',
  ].join('\n');
  const mask = protectMask(src.split('\n'));
  assert.deepEqual(mask, [false, true, true, true, true, true, true, true, false], '围栏里 6 行都该受保护');
  const out = stripPlaceholderLines(src);
  assert.equal(out.dropped, 0, '围栏里的占位行一个都不许删');
  assert.equal(out.text, src, '剥完必须字节一致');
});

test('protectMask：关闭围栏必须同字符、不短于开栅栏、整行只剩它', () => {
  const lines = ['~~~', '好。', '```', '做。', '~~~', '正文。'];
  assert.deepEqual(protectMask(lines), [true, true, true, true, true, false], '``` 关不掉 ~~~ 开的围栏');
  const longer = ['````', '好。', '`````', '正文。'];
  assert.deepEqual(protectMask(longer), [true, true, true, false], '更长的反引号可以关闭');
  const trailing = ['```', '好。', '``` js', '正文。'];
  assert.deepEqual(protectMask(trailing), [true, true, true, true], '关闭行后面还跟着别的东西就不算关闭');
  const indented = ['    ```', '好。', '正文。'];
  assert.deepEqual(protectMask(indented), [true, false, false], '缩进 4 格的 ``` 自己算缩进代码，不开启围栏');
});

// ---------- ③ 句首 4 词降级成观察信号 ----------

test('句首同构但后半句各不同：不再判退化（只在 trace 里观察）', () => {
  const tails = [
    'check the image width from the input metadata',
    'read the source file and keep its line numbering',
    'compare the preview dimensions to the original canvas',
    'extract the color profile and record the encoding',
    'validate the table header against the expected schema',
    'run a local unit test for the crop boundaries',
    'record whether the exporter preserves the alpha channel',
    'compare the generated checksum with the saved manifest',
    'add a note explaining why the resize failed',
    'check the final summary against the recorded measurements',
    'preserve the documented response format after the change',
    'compare the native preview with the exported thumbnail',
    'observe which rows contain a missing value',
    'confirm the directory listing is stable after rendering',
    'verify that the fallback returns the original image',
    'record the orientation of each reference image',
    'read the updated report to check the exact units',
    'compare the original and the transformed test inputs',
    'validate the sample identifier against the manifest',
    'inspect the table footer before the final export',
    'run a baseline smoke test twice and record the durations',
    'include the final measurements in a short answer',
    'review the relative ordering of the chart labels',
    'make sure the result is understandable without the logs',
    'summarize the validated outcome with one example',
  ];
  const text = tails.map((t) => `For this verification pass, ${t}.`).join(' ');
  const metrics = englishMetrics(text);
  assert.ok(metrics.gramMax >= 10, `句首重复应当被观察到，实际 ${metrics.gramMax}`);
  assert.equal(isEnglishDegenerate(metrics, {}), false, '光句首像不许当掐断证据');
  // 反过来：同一句真反复，还是要判
  const loop = Array.from({ length: 16 }, () => 'Let me check the file again.').join(' ');
  assert.equal(isEnglishDegenerate(englishMetrics(loop), {}), true);
});

test('英文判据的采样按字符走，不按 delta 个数走', async () => {
  // 同一段文本、两种分片，结论必须一致（上一版 11 字符分片误掐、256 字符分片放过）
  const text = [
    'Observe the inputs and keep the steps separate.',
    ...Array.from({ length: 25 }, (_, i) => `For this verification pass, check step ${i + 1} of the render pipeline and record what changed.`),
    'The checks cover different conditions and are complete.',
  ].join('\n');
  for (const size of [11, 64, 256]) {
    const out = await runStream(text, size, {}, `english-sample-${size}`);
    assert.equal(out.cut, false, `分片 ${size} 不该掐断正常对照`);
  }
});
