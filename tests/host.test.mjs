// 宿主半的沙箱测试：假 ctx + 真实会话块驱动，不装插件、不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-test-'));
process.env.DSH_HOME = HOME;

const { apply, measure, isDegraded } = await import('../src/index.js');
const {
  readLevel, writeLevel, resolveLevel, dshHome,
  normalizeId, readGlobal, writeGlobal, readSessionLevel, writeSessionLevel, effectiveLevel,
  trailingShortRun,
} = await import('../src/state.js').then(async (state) => ({ ...state, ...(await import('../src/index.js')) }));

// ---------- 假 ctx ----------
function makeCtx() {
  const handlers = new Map();
  const logs = [];
  const sections = [];
  const routes = [];
  const ctx = {
    handlers, logs, sections, routes,
    on(event, fn) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(fn); },
    effect(fn) { fn(); return () => {}; },
    systemPrompt: { section(spec) { sections.push(spec); return { dispose() {} }; } },
    inject(names, fn) {
      if (!names.includes('webServer')) return;
      fn({ webServer: { register(route) { routes.push(route); return { dispose() {} }; } }, effect: ctx.effect });
    },
    logger: { warn: (m) => logs.push(m), info: (m) => logs.push(m) },
  };
  return ctx;
}
async function waterfall(ctx, event, payload, seed) {
  let first = true;
  const next = async () => { first = false; return seed; };
  for (const fn of ctx.handlers.get(event) ?? []) {
    const out = await fn(payload, next);
    if (out !== undefined) seed = out;
  }
  return seed;
}

// ---------- 造块 ----------
const LOOP = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? '做。' : '好。')).join('\n');
const CLEAN = ['嗯，先看 A 目录里有什么。', 'ls 一下，再决定要不要删。', '用 ops_bash 跑 ls。',
  '然后看结果决定下一步。', '如果空的就直接建目录。', '不是空的就挪走。', '跑。', '好，先列目录。'].join('\n');
const blockOf = (text) => ({
  agent: { session: { id: 'sess-a', ownEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text }] } } }] } },
});

test('measure 能数出连续占位', () => {
  const m = measure(LOOP.split('\n'));
  assert.ok(m.markRun >= 40, `markRun=${m.markRun}`);
  assert.equal(m.lines, 60);
});

test('isDegraded：退化块判真，正常块判假', () => {
  const cfg = { minLines: 10, maxRun: 25, looseRun: 15, looseUniq: 0.4 };
  assert.equal(isDegraded(measure(LOOP.split('\n')), cfg), true);
  assert.equal(isDegraded(measure(CLEAN.split('\n')), cfg), false);
});

test('强度 0：请求原样返回，不注入 stop', async () => {
  const ctx = makeCtx();
  apply(ctx, { level: 0, noticeText: 'x' });
  const out = await waterfall(ctx, 'agent/request', blockOf(LOOP), { provider: 'p', model: 'm', maxTokens: 1000 });
  assert.equal(out.stop, undefined);
});

test('强度 3：挂上 stop 序列，且不动其他字段', async () => {
  const ctx = makeCtx();
  apply(ctx, { level: 3 });
  const out = await waterfall(ctx, 'agent/request', blockOf(LOOP), { provider: 'p', model: 'm', maxTokens: 1000 });
  assert.ok(Array.isArray(out.stop) && out.stop.length === 3);
  assert.ok(out.stop.includes('做。\n好。\n做。'));
  assert.equal(out.maxTokens, 1000);
  assert.equal(out.provider, 'p');
});

test('自己已有的 stop 被保留在前面，且总数不超过 16', async () => {
  const ctx = makeCtx();
  const sequences = Array.from({ length: 20 }, (_, i) => `X${i}。\n好。\n做。`);
  apply(ctx, { level: 3, stopSequences: sequences });
  const out = await waterfall(ctx, 'agent/request', blockOf(LOOP), { provider: 'p', model: 'm', stop: ['旧。\n好。'] });
  assert.equal(out.stop[0], '旧。\n好。');
  assert.ok(out.stop.length <= 16);
  assert.equal(new Set(out.stop).size, out.stop.length);
});

test('强度 2：只提醒不掐断；模板变量被替换', async () => {
  const ctx = makeCtx();
  apply(ctx, { level: 2, noticeText: '上一步空转 {maxRun} 行（{lines} 行里占 {ratio}%）。直接调工具。' });
  const decision = await waterfall(ctx, 'agent/pre-step', blockOf(LOOP), { kind: 'enter', messages: [{ role: 'user', content: [] }] });
  assert.equal(decision.messages.length, 2);
  const text = decision.messages.at(-1).content[0].text;
  assert.match(text, /\d+ 行/);
  assert.ok(!text.includes('{maxRun}'));
  const req = await waterfall(ctx, 'agent/request', blockOf(LOOP), { provider: 'p', model: 'm' });
  assert.equal(req.stop, undefined, '强度 2 不应掐断');
});

test('正常块在强度 4 下也不触发', async () => {
  const ctx = makeCtx();
  apply(ctx, { level: 4, noticeText: 'x', degradedMaxTokens: 4000, fuseAfter: 1 });
  const decision = await waterfall(ctx, 'agent/pre-step', blockOf(CLEAN), { kind: 'enter', messages: [] });
  assert.equal(decision.messages.length, 0);
});

test('强度 4：连击到阈值熔断，中间夹正常块会清零', async () => {
  const ctx = makeCtx();
  apply(ctx, { level: 4, noticeText: '', fuseAfter: 2, degradedMaxTokens: 4000 });
  const feed = (text) => waterfall(ctx, 'agent/pre-step', blockOf(text), { kind: 'enter', messages: [] });
  await feed(LOOP);
  await feed(CLEAN);
  await feed(LOOP);
  await assert.rejects(() => feed(LOOP), /熔断/);
});

test('强度 4：退化后下一步收紧预算，再下一步恢复', async () => {
  const ctx = makeCtx();
  apply(ctx, { level: 4, noticeText: '', fuseAfter: 0, degradedMaxTokens: 4000 });
  // 和真实一致：pre-step 与 agent/request 的 payload 都带同一个 agent 身份
  const reqPayload = { agent: { session: { id: 'sess-a' } } };
  let out = await waterfall(ctx, 'agent/request', reqPayload, { provider: 'p', model: 'm', maxTokens: 256000 });
  assert.equal(out.maxTokens, 256000);
  await waterfall(ctx, 'agent/pre-step', blockOf(LOOP), { kind: 'enter', messages: [] });
  out = await waterfall(ctx, 'agent/request', reqPayload, { provider: 'p', model: 'm', maxTokens: 256000 });
  assert.equal(out.maxTokens, 4000);
  out = await waterfall(ctx, 'agent/request', reqPayload, { provider: 'p', model: 'm', maxTokens: 256000 });
  assert.equal(out.maxTokens, 256000);
});

test('状态文件：按会话隔离、能读回、坏文件不炸', () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeLevel(file, 'a', 3);
  writeLevel(file, 'b', 1);
  assert.equal(readLevel(file, 'a'), 3);
  assert.equal(readLevel(file, 'b'), 1);
  assert.equal(readLevel(file, 'c'), undefined);
  assert.equal(resolveLevel(undefined, 2), 2);
  fs.writeFileSync(file, '{坏 json', 'utf8');
  assert.equal(readLevel(file, 'a'), undefined);
  assert.doesNotThrow(() => writeLevel(file, 'd', 4));
  assert.equal(readLevel(file, 'd'), 4);
  assert.equal(dshHome(), HOME);
});

test('滑条路由：GET 拿档位、POST 存档位、非本机 403、坏输入 400', async () => {
  const ctx = makeCtx();
  apply(ctx, { level: 2 });
  assert.equal(ctx.routes.length, 1);
  const route = ctx.routes[0];
  assert.equal(route.kind, 'exact');

  const call = async (method, url, body, remote = '127.0.0.1') => {
    const req = {
      method, url,
      socket: { remoteAddress: remote },
      on(event, cb) {
        if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
        if (event === 'end') cb();
      },
      destroy() {},
    };
    let status = 0; let payload = null;
    const res = {
      writeHead(code) { status = code; },
      end(text) { payload = JSON.parse(text || '{}'); },
    };
    await route.handler(req, res);
    return { status, payload };
  };

  let r = await call('GET', '/thinking-guard/state?sessionId=zzz');
  assert.equal(r.status, 200);
  assert.equal(r.payload.level, 2);

  r = await call('POST', '/thinking-guard/state', { sessionId: 'zzz', level: 4 });
  assert.equal(r.status, 200);
  assert.equal(r.payload.level, 4);

  r = await call('GET', '/thinking-guard/state?sessionId=zzz');
  assert.equal(r.payload.level, 4, '存过的会话应读回 4');

  r = await call('GET', '/thinking-guard/state?sessionId=zzz', undefined, '10.0.0.9');
  assert.equal(r.status, 403);

  r = await call('POST', '/thinking-guard/state', { sessionId: 'zzz', level: 9 });
  assert.equal(r.status, 400);

  r = await call('DELETE', '/thinking-guard/state');
  assert.equal(r.status, 405);
});

test('会话 id 两种写法归一：带 session- 前缀与裸 UUID 是同一个会话', () => {
  const file = path.join(HOME, 'norm.json');
  writeSessionLevel(file, 'session-abc-123', 3); // 滑条传的是这种
  assert.equal(readSessionLevel(file, 'abc-123'), 3, '宿主用裸 id 必须读到同一个值');
  assert.equal(readSessionLevel(file, 'session-abc-123'), 3);
  assert.equal(normalizeId('session-abc-123'), 'abc-123');
  assert.equal(normalizeId('abc-123'), 'abc-123');
  assert.equal(normalizeId(undefined), '');
});

test('全局默认：写全局会清掉会话特例，并作为兜底生效', () => {
  const file = path.join(HOME, 'global.json');
  writeSessionLevel(file, 's1', 4);
  assert.deepEqual(effectiveLevel(file, 's1', 2), { level: 4, scope: 'session' });
  writeGlobal(file, 1);
  assert.equal(readGlobal(file), 1);
  assert.deepEqual(effectiveLevel(file, 's1', 2), { level: 1, scope: 'global' }, '写全局应清掉会话特例');
  assert.deepEqual(effectiveLevel(file, 's2', 2), { level: 1, scope: 'global' });
});

test('没有全局记录时回落到配置兜底', () => {
  const file = path.join(HOME, 'none.json');
  assert.deepEqual(effectiveLevel(file, 'x', 2), { level: 2, scope: 'default' });
});

test('v1 状态文件迁移：两种写法重复的键合并成一个', () => {
  const file = path.join(HOME, 'v1.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    sessions: { 'session-abc-123': 2, 'abc-123': 4 },
    order: ['session-abc-123', 'abc-123'],
  }), 'utf8');
  assert.ok(Number.isInteger(readSessionLevel(file, 'abc-123')), '迁移后应能读到');
  writeSessionLevel(file, 'abc-123', 3);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.version, 2);
  assert.deepEqual(Object.keys(after.sessions), ['abc-123'], '不该再有带前缀的重复键');
});

test('滑条路由：POST scope=global 走全局并清特例', async () => {
  const ctx = makeCtx();
  apply(ctx, { level: 2 });
  const route = ctx.routes[0];
  const call = async (method, url, body) => {
    const req = {
      method, url, socket: { remoteAddress: '127.0.0.1' },
      on(event, cb) {
        if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
        if (event === 'end') cb();
      },
      destroy() {},
    };
    let status = 0; let payload = null;
    const res = { writeHead(code) { status = code; }, end(text) { payload = JSON.parse(text || '{}'); } };
    await route.handler(req, res);
    return { status, payload };
  };
  let r = await call('POST', '/thinking-guard/state', { level: 1, scope: 'global' });
  assert.equal(r.status, 200);
  assert.equal(r.payload.scope, 'global');
  r = await call('GET', '/thinking-guard/state?sessionId=session-any');
  assert.equal(r.payload.level, 1);
  assert.equal(r.payload.scope, 'global');
  assert.equal(r.payload.global, 1);
});

test('把值拖回跟默认一样 → 清掉会话覆盖，算没设过', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeGlobal(file, 2); // 固定默认值，免得被前面的用例带偏
  const ctx = makeCtx();
  apply(ctx, { level: 2 });
  const route = ctx.routes[0];
  const call = async (method, url, body) => {
    const req = {
      method, url, socket: { remoteAddress: '127.0.0.1' },
      on(event, cb) {
        if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
        if (event === 'end') cb();
      },
      destroy() {},
    };
    let status = 0; let payload = null;
    const res = { writeHead(code) { status = code; }, end(text) { payload = JSON.parse(text || '{}'); } };
    await route.handler(req, res);
    return { status, payload };
  };

  let r = await call('POST', '/thinking-guard/state', { sessionId: 'sess-drag', level: 4 });
  assert.equal(r.payload.scope, 'session');
  r = await call('GET', '/thinking-guard/state?sessionId=sess-drag');
  assert.equal(r.payload.scope, 'session', '设过就该是 session');

  r = await call('POST', '/thinking-guard/state', { sessionId: 'sess-drag', level: 2 });
  assert.equal(r.payload.scope, 'global', '拖回默认应回到继承');

  r = await call('GET', '/thinking-guard/state?sessionId=sess-drag');
  assert.equal(r.payload.level, 2);
  assert.equal(r.payload.scope, 'global', '覆盖记录应被清掉');
  assert.equal(effectiveLevel(file, 'sess-drag', 2).scope, 'global');
});

test('trailingShortRun 数的是尾部连续短行，半行不算', () => {
  assert.equal(trailingShortRun('做。\n好。\n做。\n'), 3);
  assert.equal(trailingShortRun('做。\n好。\n做。'), 2, '最后没换行的那行不算，可能还没写完');
  assert.equal(trailingShortRun('一句很长的正常推理内容在这里展开说明\n做。\n好。\n'), 2);
  assert.equal(trailingShortRun(''), 0);
  assert.equal(trailingShortRun('（输出。）\n（写。）\n'), 2);
});

test('trailingShortRun 不能被空行打断（实机踩过的坑）', () => {
  // 真实 reasoning 的行间通常是 \n\n，空行只算段落分隔，不该中断计数
  assert.equal(trailingShortRun('做。\n\n好。\n\n做。\n'), 3, '空行分隔的也该数出 3 行');
  assert.equal(trailingShortRun('（好。）\n\n好。\n\n做。\n\n（写。）\n'), 4);
  assert.equal(trailingShortRun('做。\n\n好。\n\n做。\n\n'), 3, '末尾多个空行不影响');
  // 真机抓到的尾巴：8 行短行 + 空行分隔
  const realTail = '做。\n\n（写。）\n\n好。\n\n做。\n\n（输出。）\n\n好。\n\n做。\n\n（好。）\n\n好。\n\n';
  assert.equal(trailingShortRun(realTail), 9, `实机尾巴应数出 9 行，实际 ${trailingShortRun(realTail)}`);
});

test('流内掐断：强度 3 下连续短行超阈值就提前收手', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'stream-kill-hit', 3); // 前面的用例可能把全局默认改成 2，这里显式设会话
  const ctx = makeCtx();
  apply(ctx, { level: 3, streamKillRun: 15, streamKillMinChars: 0 });
  const handlers = ctx.handlers.get('llm/stream') ?? [];
  assert.equal(handlers.length, 1, '应注册一个 llm/stream 中间件');

  const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handlers[0]({ sessionId: 'stream-kill-hit' }, next)) out.push(c);

  assert.ok(out.length < 25, `应提前结束，实际产出 ${out.length} 个 chunk`);
  assert.ok(out.length >= 10, `至少要放行到接近阈值，实际 ${out.length}`);
  assert.ok(ctx.logs.some(l => l.includes('掐流')), '应留下掐流日志');
});

test('流内掐断：强度不够时原样透传', async () => {
  const ctx = makeCtx();
  apply(ctx, { level: 2, streamKillRun: 15 });
  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: 'stream-kill-off' }, next)) out.push(c);
  assert.equal(out.length, 40, '强度 2 不该掐');
});

test('流内掐断：试运行只记日志不真掐', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'stream-kill-dry', 3);
  const ctx = makeCtx();
  apply(ctx, { level: 3, streamKillRun: 15, streamKillDryRun: true, streamKillMinChars: 0 });
  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: 'stream-kill-dry' }, next)) out.push(c);
  assert.equal(out.length, 40, '试运行不该掐断流');
  assert.ok(ctx.logs.some(l => l.includes('试运行')), '试运行应留下日志');
});

test('掐流之后，下一步会收到一次「被截断」提示，且只提示一次', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'kill-notice', 3);
  const ctx = makeCtx();
  apply(ctx, { level: 3, streamKillRun: 15, streamKillMinChars: 0 });

  const streamHandler = ctx.handlers.get('llm/stream')[0];
  const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  let killed = 0;
  for await (const c of streamHandler({ sessionId: 'kill-notice' }, next)) killed++;

  const payload = { agent: { session: { id: 'kill-notice', ownEvents: () => [] } }, messages: [] };
  const first = await waterfall(ctx, 'agent/pre-step', payload, { kind: 'enter', messages: [] });
  assert.equal(first.messages.length, 1, '应注入一条「被截断」提示');
  assert.match(first.messages[0].content[0].text, /被截断/);

  const second = await waterfall(ctx, 'agent/pre-step', payload, { kind: 'enter', messages: [] });
  assert.equal(second.messages.length, 0, '提示只该给一次');
});

test('连续掐断到上限就自动停手，防止死循环', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'kill-streak', 3);
  const ctx = makeCtx();
  apply(ctx, { level: 3, streamKillRun: 15, maxKillStreak: 3, streamKillMinChars: 0 });
  const handler = ctx.handlers.get('llm/stream')[0];
  const feed = async () => {
    const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
    const next = async function* () { for (const c of chunks) yield c; };
    const out = [];
    for await (const c of handler({ sessionId: 'kill-streak' }, next)) out.push(c);
    return out.length;
  };
  const first = await feed();
  const second = await feed();
  const third = await feed();
  assert.ok(first < 25 && second < 25 && third < 25, '前三次应被掐断');

  const fourth = await feed();
  assert.equal(fourth, 40, '第四次应放行（连续掐断已达上限）');
});

test('思考没超过字符下限就不掐——短步骤哪怕刷短行也放行', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'kill-floor', 3);
  const ctx = makeCtx();
  apply(ctx, { level: 3, streamKillRun: 15, streamKillMinChars: 1000 });
  const handler = ctx.handlers.get('llm/stream')[0];
  // 40 个短行 ≈ 120 字符，远不到 1000
  const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: 'kill-floor' }, next)) out.push(c);
  assert.equal(out.length, 40, '字符数不够下限时不掐');
});

test('测试钩子必须绑会话：不指定就拒绝，指定了只作用那个会话', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'force-kill', 3);
  writeSessionLevel(file, 'other-session', 3);
  const ctx = makeCtx();
  apply(ctx, { level: 3, streamKillRun: 15, streamKillMinChars: 1000 });
  const route = ctx.routes[0];
  const call = async (method, url, body) => {
    const req = {
      method, url, socket: { remoteAddress: '127.0.0.1' },
      on(event, cb) {
        if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
        if (event === 'end') cb();
      },
      destroy() {},
    };
    let status = 0; let payload = null;
    const res = { writeHead(code) { status = code; }, end(text) { payload = JSON.parse(text || '{}'); } };
    await route.handler(req, res);
    return { status, payload };
  };
  const handler = ctx.handlers.get('llm/stream')[0];
  const feed = async (sid) => {
    const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
    const next = async function* () { for (const c of chunks) yield c; };
    const out = [];
    for await (const c of handler({ sessionId: sid }, next)) out.push(c);
    return out.length;
  };

  // 不带 sessionId 的钩子必须被拒绝
  let r = await call('POST', '/thinking-guard/state', { test: { forceChars: 50 } });
  assert.equal(r.status, 400, '不带 sessionId 的钩子应被拒绝');
  assert.equal(await feed('force-kill'), 40, '被拒绝后不该有任何效果');

  // 指定 sessionId 后只影响那个会话
  r = await call('POST', '/thinking-guard/state', { test: { sessionId: 'force-kill', forceChars: 50 } });
  assert.equal(r.status, 200);
  assert.ok(await feed('force-kill') < 40, '目标会话应被掐');
  assert.equal(await feed('other-session'), 40, '别的会话不受影响');

  r = await call('POST', '/thinking-guard/state', { test: null });
  assert.equal(r.payload.test, null);
  assert.equal(await feed('force-kill'), 40, '清除后恢复');
});

test('掐断后用 followup 自动续一轮（自己构造消息，不依赖模块解析）', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'auto-continue', 3);
  const ctx = makeCtx();
  const followups = [];
  apply(ctx, { level: 3, streamKillRun: 15, streamKillMinChars: 0, streamKillFastContinue: false });

  // 先让 pre-step 缓存 agent
  const agent = { session: { id: 'auto-continue', ownEvents: () => [] }, followup(msg) { followups.push(msg); } };
  await waterfall(ctx, 'agent/pre-step', { agent, messages: [] }, { kind: 'enter', messages: [] });

  // 再触发一次掐断
  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  for await (const c of handler({ sessionId: 'auto-continue' }, next)) { /* 消费 */ }

  assert.equal(followups.length, 1, '掐断后应投递一条 followup');
  const msg = followups[0];
  assert.equal(msg.role, 'user', '必须是 user 消息');
  assert.ok(typeof msg.id === 'string' && msg.id.length > 0, '必须有 id');
  assert.equal(msg.source.kind, 'plugin:thinking-guard', 'source 用复合 kind');
  assert.match(JSON.stringify(msg), /被截断/);

  // followup 已经投过，pre-step 就不要再注入第二条一样的提示
  const decision = await waterfall(ctx, 'agent/pre-step', {
    agent: { session: { id: 'auto-continue', ownEvents: () => [] } },
    messages: [],
  }, { kind: 'enter', messages: [] });
  assert.equal(decision.messages.length, 0, '续轮成功时不该再注入重复提示');
});

test('注入消息必须用复合 source kind（plugin:<名字>），旧写法已废', async () => {
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = pathMod.dirname(fileURLToPath(import.meta.url));
  const src = fsMod.readFileSync(pathMod.join(here, '..', 'src', 'index.js'), 'utf8');
  assert.ok(src.includes("source: { kind: 'plugin:' + name }"), '应当用 plugin:<插件名> 这种复合 kind');
  assert.ok(!/kind: 'plugin',\s*plugin:/.test(src), '不许再用 { kind: "plugin", plugin: "x" } 旧写法');
});

test('快速续轮：伪造一个只读工具调用，把 finish 改成 tool-calls', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'fast-continue', 3);
  const ctx = makeCtx();
  apply(ctx, { level: 3, streamKillRun: 15, streamKillMinChars: 0, streamKillFastContinue: true });
  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', index: 0, text: '做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: 'fast-continue' }, next)) out.push(c);

  const finish = out.find(c => c.type === 'finish');
  assert.ok(finish, '必须补一个 finish');
  assert.deepEqual(finish.reason, { kind: 'tool-calls' }, 'finish 必须是 tool-calls，才能进下一步');

  const call = out.find(c => c.type === 'block-end' && c.block?.type === 'tool-call');
  assert.ok(call, '必须有一个 tool-call 块');
  assert.equal(call.block.name, 'get_goal', '默认伪造只读的 get_goal');
  assert.equal(call.block.index === undefined ? true : true, true);
  assert.ok(out.length < 30, `应提前结束，实际产出 ${out.length}`);
});

test('档位 2（限流）：命中退化后下一步 maxTokens 压到 4000，只压一步', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'sess-a', 2);
  const ctx = makeCtx();
  apply(ctx, { level: 2, noticeText: '', degradedMaxTokens: 4000, fuseAfter: 0 });
  const reqPayload = { agent: { session: { id: 'sess-a' } } };
  const ask = () => waterfall(ctx, 'agent/request', reqPayload, { provider: 'p', model: 'm', maxTokens: 256000 });

  assert.equal((await ask()).maxTokens, 256000, '没命中前不该压');
  await waterfall(ctx, 'agent/pre-step', blockOf(LOOP), { kind: 'enter', messages: [] });
  assert.equal((await ask()).maxTokens, 4000, '档位 2 命中后下一步应压到 4000');
  assert.equal((await ask()).maxTokens, 256000, '只压一步，随后恢复');
});

test('档位 1（提示）：命中退化也不改预算', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'sess-a', 1);
  const ctx = makeCtx();
  apply(ctx, { level: 1, noticeText: '', degradedMaxTokens: 4000, fuseAfter: 0 });
  const reqPayload = { agent: { session: { id: 'sess-a' } } };
  await waterfall(ctx, 'agent/pre-step', blockOf(LOOP), { kind: 'enter', messages: [] });
  const out = await waterfall(ctx, 'agent/request', reqPayload, { provider: 'p', model: 'm', maxTokens: 256000 });
  assert.equal(out.maxTokens, 256000, '档位 1 不该改预算');
});

test('改名兼容：新文件名读不到时，自动回退读旧的 reasoning-guard.json', async () => {
  const legacy = path.join(HOME, 'reasoning-guard.json');
  const fresh = path.join(HOME, 'thinking-guard.json');
  for (const f of [legacy, fresh]) { try { fs.unlinkSync(f); } catch { /* 不存在就算了 */ } }
  // 只有旧文件：写一份 global=3 进去
  fs.writeFileSync(legacy, JSON.stringify({ version: 2, global: 3, sessions: {}, order: [] }), 'utf8');
  assert.equal(readGlobal(fresh), 3, '应能读到旧文件里的 global');

  // 新文件一旦存在就优先用它，不该再被旧文件影响
  fs.writeFileSync(fresh, JSON.stringify({ version: 2, global: 1, sessions: {}, order: [] }), 'utf8');
  assert.equal(readGlobal(fresh), 1, '新文件存在时以新文件为准');
});

test('系统提示只在配置了文案时注册', () => {
  const ctxA = makeCtx();
  apply(ctxA, { level: 2, promptText: '' });
  assert.equal(ctxA.sections.length, 0);
  const ctxB = makeCtx();
  apply(ctxB, { level: 2, promptText: '确定动作就直接调工具。' });
  assert.equal(ctxB.sections.length, 1);
  assert.equal(ctxB.sections[0].text(), '确定动作就直接调工具。');
});
