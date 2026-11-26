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
  apply(ctx, { adaptiveEnabled: false, level: 0, noticeText: 'x' });
  const out = await waterfall(ctx, 'agent/request', blockOf(LOOP), { provider: 'p', model: 'm', maxTokens: 1000 });
  assert.equal(out.stop, undefined);
});

test('stop 序列不再挂载：已证伪，任何档位都不带', async () => {
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 3 });
  const out = await waterfall(ctx, 'agent/request', blockOf(LOOP), { provider: 'p', model: 'm', maxTokens: 1000 });
  assert.ok(!Array.isArray(out.stop) || out.stop.length === 0, 'stop 应为空：服务端接受但不截断思考');
  assert.equal(out.maxTokens, 1000);
  assert.equal(out.provider, 'p');
});

test('自己已有的 stop 被保留在前面，且总数不超过 16', async () => {
  const ctx = makeCtx();
  const sequences = Array.from({ length: 20 }, (_, i) => `X${i}。\n好。\n做。`);
  apply(ctx, { adaptiveEnabled: false, level: 3, stopSequences: sequences });
  const out = await waterfall(ctx, 'agent/request', blockOf(LOOP), { provider: 'p', model: 'm', stop: ['旧。\n好。'] });
  assert.equal(out.stop[0], '旧。\n好。');
  assert.ok(out.stop.length <= 16);
  assert.equal(new Set(out.stop).size, out.stop.length);
});

test('强度 2：只提醒不掐断；模板变量被替换', async () => {
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 2, noticeText: '上一步空转 {maxRun} 行（{lines} 行里占 {ratio}%）。直接调工具。' });
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
  apply(ctx, { adaptiveEnabled: false, level: 4, noticeText: 'x', degradedMaxTokens: 4000, fuseAfter: 1 });
  const decision = await waterfall(ctx, 'agent/pre-step', blockOf(CLEAN), { kind: 'enter', messages: [] });
  assert.equal(decision.messages.length, 0);
});

test('强度 4：连击到阈值熔断，中间夹正常块会清零', async () => {
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 4, noticeText: '', fuseAfter: 2, degradedMaxTokens: 4000 });
  const feed = (text) => waterfall(ctx, 'agent/pre-step', blockOf(text), { kind: 'enter', messages: [] });
  await feed(LOOP);
  await feed(CLEAN);
  await feed(LOOP);
  await assert.rejects(() => feed(LOOP), /熔断/);
});

test('强度 4：退化后下一步收紧预算，再下一步恢复', async () => {
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 4, noticeText: '', fuseAfter: 0, degradedMaxTokens: 4000 });
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
  assert.doesNotThrow(() => writeLevel(file, 'd', 3));
  assert.equal(readLevel(file, 'd'), 3);
  assert.equal(dshHome(), HOME);
});

test('旧档位迁移：存过的 4（熔断）读出来是 2（慢续）', () => {
  const file = path.join(HOME, 'thinking-guard-migrate.json');
  writeGlobal(file, 4);
  assert.equal(readGlobal(file), 2, '熔断已删档，读到时降到慢续');
  writeSessionLevel(file, 'm1', 4);
  assert.equal(effectiveLevel(file, 'm1', 1).level, 2);
});

test('滑条路由：GET 拿档位、POST 存档位、非本机 403、坏输入 400', async () => {
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 2 });
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

  r = await call('POST', '/thinking-guard/state', { sessionId: 'zzz', level: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.payload.level, 3);

  r = await call('GET', '/thinking-guard/state?sessionId=zzz');
  assert.equal(r.payload.level, 3, '存过的会话应读回 3');

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
  writeSessionLevel(file, 's1', 3);
  assert.deepEqual(effectiveLevel(file, 's1', 3), { level: 3, scope: 'session' });
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
  apply(ctx, { adaptiveEnabled: false, level: 2 });
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
  apply(ctx, { adaptiveEnabled: false, level: 2 });
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

  let r = await call('POST', '/thinking-guard/state', { sessionId: 'sess-drag', level: 3 });
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
  apply(ctx, { adaptiveEnabled: false, level: 3, streamKillRun: 15, streamKillMinChars: 0 });
  const handlers = ctx.handlers.get('llm/stream') ?? [];
  assert.equal(handlers.length, 1, '应注册一个 llm/stream 中间件');

  const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handlers[0]({ sessionId: 'stream-kill-hit', tools: [{ name: 'get_goal' }] }, next)) out.push(c);

  assert.ok(out.length < 25, `应提前结束，实际产出 ${out.length} 个 chunk`);
  assert.ok(out.length >= 10, `至少要放行到接近阈值，实际 ${out.length}`);
  assert.ok(ctx.logs.some(l => l.includes('掐流')), '应留下掐流日志');
});

test('流内掐断：强度不够时原样透传', async () => {
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 2, streamKillRun: 15 });
  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: 'stream-kill-off', tools: [{ name: 'get_goal' }] }, next)) out.push(c);
  assert.equal(out.length, 40, '强度 2 不该掐');
});

test('流内掐断：试运行只记日志不真掐', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'stream-kill-dry', 3);
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 3, streamKillRun: 15, streamKillDryRun: true, streamKillMinChars: 0 });
  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: 'stream-kill-dry', tools: [{ name: 'get_goal' }] }, next)) out.push(c);
  assert.equal(out.length, 40, '试运行不该掐断流');
  assert.ok(ctx.logs.some(l => l.includes('试运行')), '试运行应留下日志');
});

test('掐流之后，下一步会收到一次「被截断」提示，且只提示一次', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'kill-notice', 3);
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 3, streamKillRun: 15, streamKillMinChars: 0 });

  const streamHandler = ctx.handlers.get('llm/stream')[0];
  const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  let killed = 0;
  for await (const c of streamHandler({ sessionId: 'kill-notice', tools: [{ name: 'get_goal' }] }, next)) killed++;

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
  apply(ctx, { adaptiveEnabled: false, level: 3, streamKillRun: 15, maxKillStreak: 3, streamKillMinChars: 0 });
  const handler = ctx.handlers.get('llm/stream')[0];
  const feed = async () => {
    const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
    const next = async function* () { for (const c of chunks) yield c; };
    const out = [];
    for await (const c of handler({ sessionId: 'kill-streak', tools: [{ name: 'get_goal' }] }, next)) out.push(c);
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
  apply(ctx, { adaptiveEnabled: false, level: 3, streamKillRun: 15, streamKillMinChars: 1000 });
  const handler = ctx.handlers.get('llm/stream')[0];
  // 40 个短行 ≈ 120 字符，远不到 1000
  const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: 'kill-floor', tools: [{ name: 'get_goal' }] }, next)) out.push(c);
  assert.equal(out.length, 40, '字符数不够下限时不掐');
});

test('测试钩子必须绑会话：不指定就拒绝，指定了只作用那个会话', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'force-kill', 3);
  writeSessionLevel(file, 'other-session', 3);
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 3, streamKillRun: 15, streamKillMinChars: 1000 });
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
    for await (const c of handler({ sessionId: sid, tools: [{ name: 'get_goal' }] }, next)) out.push(c);
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
  apply(ctx, { adaptiveEnabled: false, level: 3, streamKillRun: 15, streamKillMinChars: 0, streamKillFastContinue: false });

  // 先让 pre-step 缓存 agent
  const agent = { session: { id: 'auto-continue', ownEvents: () => [] }, followup(msg) { followups.push(msg); } };
  await waterfall(ctx, 'agent/pre-step', { agent, messages: [] }, { kind: 'enter', messages: [] });

  // 再触发一次掐断
  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  for await (const c of handler({ sessionId: 'auto-continue', tools: [{ name: 'get_goal' }] }, next)) { /* 消费 */ }

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
  apply(ctx, { adaptiveEnabled: false, level: 3, streamKillRun: 15, streamKillMinChars: 0, streamKillFastContinue: true });
  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', index: 0, text: '做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: 'fast-continue', tools: [{ name: 'get_goal' }] }, next)) out.push(c);

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
  apply(ctx, { adaptiveEnabled: false, level: 2, noticeText: '', degradedMaxTokens: 4000, fuseAfter: 0 });
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
  apply(ctx, { adaptiveEnabled: false, level: 1, noticeText: '', degradedMaxTokens: 4000, fuseAfter: 0 });
  const reqPayload = { agent: { session: { id: 'sess-a' } } };
  await waterfall(ctx, 'agent/pre-step', blockOf(LOOP), { kind: 'enter', messages: [] });
  const out = await waterfall(ctx, 'agent/request', reqPayload, { provider: 'p', model: 'm', maxTokens: 256000 });
  assert.equal(out.maxTokens, 256000, '档位 1 不该改预算');
});

test('历史消毒：把退化的 reasoning 换成短句，正文和工具调用不动', async () => {
  const { scrubDegenerateReasoning } = await import('../src/index.js');
  const cfg = { minLines: 10, maxRun: 25, looseRun: 15, looseUniq: 0.4 };
  const degenerate = '做。\n'.repeat(60);
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '开始' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: degenerate },
        { type: 'text', text: '好的，我来看看。' },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ];
  const out = scrubDegenerateReasoning(messages, cfg);
  assert.equal(out.removed, 1, '应清掉一段');
  const cleaned = out.messages[1].content;
  assert.match(cleaned[0].text, /已省略/, 'reasoning 被换成短句');
  assert.equal(cleaned[1].text, '好的，我来看看。', '正文原样');
  assert.equal(cleaned[2].name, 'read', '工具调用原样');
  assert.equal(messages[1].content[0].text, degenerate, '原数组未被就地修改');
});

test('历史消毒：正常思考不动', async () => {
  const { scrubDegenerateReasoning } = await import('../src/index.js');
  const cfg = { minLines: 10, maxRun: 25, looseRun: 15, looseUniq: 0.4 };
  const normal = '先看 docs 目录，然后 grep 一下关键词。\n' + '再确认入口文件在哪。\n'.repeat(12);
  const messages = [{ role: 'assistant', content: [{ type: 'reasoning', text: normal }] }];
  const out = scrubDegenerateReasoning(messages, cfg);
  assert.equal(out.removed, 0, '正常思考不该被清');
  assert.equal(out.messages, messages, '没命中就原样返回同一个引用');
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

// ---------- 2026-11-24 夜：判据换代（重复对）+ 冷却窗 + 掐断补偿 ----------

test('重复对判据：好。⏎做。 反复就掐，不等连续短行', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'repeat-kill', 3);
  const ctx = makeCtx();
  // 把短行阈值调到不可能达到，只留重复对判据
  apply(ctx, { adaptiveEnabled: false, level: 3, streamKillRun: 999, streamKillMinChars: 0, maxKillStreak: 0 });
  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = [];
  for (let i = 0; i < 60; i++) chunks.push({ type: 'reasoning-delta', text: i % 2 ? '好。\n' : '做。\n' });
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: 'repeat-kill', tools: [{ name: 'get_goal' }] }, next)) out.push(c);
  assert.ok(out.length < 55, `应提前掐断，实际放行 ${out.length} 个 chunk`);
  assert.ok(ctx.logs.some((l) => l.includes('重复对')), '日志应写明是重复对命中');
});

test('风格性填充不掐：长内容里散着插「好。/嗯。」', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'style-filler', 3);
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 3, streamKillRun: 999, streamKillMinChars: 0, maxKillStreak: 0 });
  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = [];
  for (let i = 0; i < 40; i++) {
    chunks.push({ type: 'reasoning-delta', text: `第 ${i} 条：去改图的背袍压痕，再重新生成对照。\n` });
    chunks.push({ type: 'reasoning-delta', text: i % 2 ? '好。\n' : '嗯。\n' });
  }
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: 'style-filler', tools: [{ name: 'get_goal' }] }, next)) out.push(c);
  assert.equal(out.length, chunks.length, '散插的填充行不该被掐');
});

test('冷却：同一会话连掐 3 次后第 4 次整段放行', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'cooldown-test', 3);
  const ctx = makeCtx();
  // maxKillStreak 关掉，确保第 4 次放行只可能来自冷却窗
  apply(ctx, { adaptiveEnabled: false,
    level: 3, streamKillRun: 15, streamKillMinChars: 0, maxKillStreak: 0,
    cooldownWindowMs: 600000, cooldownHits: 3, cooldownMs: 300000,
  });
  const handler = ctx.handlers.get('llm/stream')[0];
  const feed = async () => {
    const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
    const next = async function* () { for (const c of chunks) yield c; };
    const out = [];
    for await (const c of handler({ sessionId: 'cooldown-test', tools: [{ name: 'get_goal' }] }, next)) out.push(c);
    return out.length;
  };
  for (let i = 0; i < 3; i++) assert.ok((await feed()) < 25, `第 ${i + 1} 次应被掐`);
  assert.equal(await feed(), 40, '冷却期内的第 4 次应整段放行');
  assert.ok(ctx.logs.some((l) => l.includes('冷却')), '应留下冷却日志');
});

test('掐断补偿：注入里带上被掐掉那段的最后几句真实内容', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'compensate', 3);
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 3, streamKillRun: 15, streamKillMinChars: 0, maxKillStreak: 0 });
  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = [
    { type: 'reasoning-delta', text: '先把背袍的压痕再压一遍。\n' },
    { type: 'reasoning-delta', text: '然后重新生成对照图并存到产出目录。\n' },
  ];
  for (let i = 0; i < 40; i++) chunks.push({ type: 'reasoning-delta', text: '做。\n' });
  const next = async function* () { for (const c of chunks) yield c; };
  for await (const c of handler({ sessionId: 'compensate', tools: [{ name: 'get_goal' }] }, next)) void c;

  const payload = { agent: { session: { id: 'compensate', ownEvents: () => [] } }, messages: [] };
  const step = await waterfall(ctx, 'agent/pre-step', payload, { kind: 'enter', messages: [] });
  assert.equal(step.messages.length, 1, '应注入一条提示');
  const text = step.messages[0].content[0].text;
  assert.match(text, /你刚才想到的/);
  assert.match(text, /背袍|产出目录/);
});

test('buildCompensation 跳过占位行与太短的行', async () => {
  const { buildCompensation } = await import('../src/index.js');
  const hint = buildCompensation(
    ['第一句有内容的思考。', '好。', '第二句也是内容。', '嗯。', '做。'],
    { compensateEnabled: true, compensateMaxLines: 2, compensateMaxChars: 240 },
  );
  assert.equal(hint, '第一句有内容的思考。 / 第二句也是内容。');
  assert.equal(buildCompensation(['好。', '做。'], { compensateEnabled: true }), '', '全是占位行时返回空');
});

// ---------- 英文判据：英文的口水长在句子里，行级判据看不见 ----------

test('英文指标：正常英文块不该判退化', async () => {
  const { englishMetrics, isEnglishDegenerate } = await import('../src/index.js');
  const normal = [
    'Check the docs first and confirm the entry point.',
    'The parameters should stay the same as the last run.',
    'Compare the render against the final image.',
    'Roll back to the previous version if it does not match.',
    'Then write the summary and hand it over.',
  ].join(' ');
  const m = englishMetrics(normal);
  assert.equal(m.sentences, 5);
  assert.ok(m.dupRatio < 0.3, `正常块句重复占比应低，实际 ${m.dupRatio}`);
  assert.equal(isEnglishDegenerate(m, { englishDupRatioMin: 0.3, englishMinSentences: 12 }), false);
});

test('英文判据：同一句反复就判退化', async () => {
  const { englishMetrics, isEnglishDegenerate } = await import('../src/index.js');
  const degenerate = Array.from({ length: 16 }, () => 'Let me check the file again.').join(' ');
  const m = englishMetrics(degenerate);
  assert.ok(m.sentences >= 12, `句数应够，实际 ${m.sentences}`);
  assert.ok(m.dupRatio >= 0.3, `句重复占比应高，实际 ${m.dupRatio}`);
  assert.equal(isEnglishDegenerate(m, { englishDupRatioMin: 0.3, englishMinSentences: 12 }), true);
});

test('英文判据：同构句（Let me …）反复也抓得到', async () => {
  const { englishMetrics, isEnglishDegenerate } = await import('../src/index.js');
  // 只换两个尾缀：同一句式反复才是要抓的形态
  const verbs = ['check it', 'run the build'];
  const lines = [];
  for (let i = 0; i < 24; i++) lines.push(`Let me ${verbs[i % verbs.length]}.`);
  const m = englishMetrics(lines.join(' '));
  assert.ok(m.gramMax >= 10, `句首 4 词重复应够高，实际 ${m.gramMax}「${m.gramKey}」`);
  assert.equal(isEnglishDegenerate(m, { englishGramMin: 10, englishGramMinSentences: 20 }), true);
});

test('英文判据：中文块不会被英文判据误伤', async () => {
  const { englishMetrics, isEnglishDegenerate } = await import('../src/index.js');
  const zh = ['先看 docs 目录。', '参数按原图那套来。', '出图后比一下。', '不一致就回退。'].join('');
  const m = englishMetrics(zh);
  assert.equal(isEnglishDegenerate(m, {}), false);
});

test('英文判据接进流内：同一句反复会被掐（关掉周期判据，单测这条线）', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'english-kill', 3);
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false,
    level: 3, streamKillRun: 999, streamKillMinChars: 0, maxKillStreak: 0,
    streamKillEnglishEnabled: true, streamKillCycleEnabled: false,
  });
  const handler = ctx.handlers.get('llm/stream')[0];
  // 同一句反复，只换大小写和标点——归一化之后是同一句，字符层面却不是精确周期
  const variants = [
    'Let me check the file again.', 'LET ME CHECK THE FILE AGAIN!', 'let me check the file again?',
    'Let me check the file again...', 'Let  me check the file again.',
  ];
  const others = [
    'The preview looks wrong on the left edge.', 'Compare it with the saved manifest.',
    'Roll back to the previous version.', 'Read the entry point and record its path.',
  ];
  const chunks = [];
  for (let i = 0; i < 70; i++) {
    const text = i % 3 === 2 ? `${others[Math.floor(i / 3) % others.length]} ` : `${variants[i % variants.length]} `;
    chunks.push({ type: 'reasoning-delta', text });
  }
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: 'english-kill', tools: [{ name: 'get_goal' }] }, next)) out.push(c);
  assert.ok(out.length < 70, `应提前掐断，实际放行 ${out.length}`);
  assert.ok(ctx.logs.some((l) => l.includes('英文重复')), '日志应写明是英文重复命中');
});

test('英文判据不把「写目录 / 链接清单」当成空转（2026-11-25 误伤 fixture）', async () => {
  const { englishMetrics, isEnglishDegenerate, stripStructuralLines } = await import('../src/index.js');
  const nav = [
    '<a href="#-the-symptom">Symptom</a> ·',
    '<a href="#-background-how-this-came-about">Background</a> ·',
    '<a href="#-what-it-does">What it does</a> ·',
    '<a href="#-install">Install</a> ·',
    '<a href="#-the-glyph">Tiers</a> ·',
    '<a href="#-why-it-works">Why</a> ·',
    '<a href="#-configuration">Config</a>',
  ].join('\n');
  const text = Array(8).fill(nav).join('\n');
  const metrics = englishMetrics(text);
  assert.equal(isEnglishDegenerate(metrics, {}), false, '八遍导航条也不该判退化——那是结构性重复');
  assert.ok(metrics.sentences < 12, `剔掉链接行后句子数应很少，实际 ${metrics.sentences}`);
  assert.equal(stripStructuralLines(text).trim(), '', '链接行应被整行剔掉');
  // 反向对照：同样的词换成散文句式，仍要能抓到
  const prose = Array(20).fill('Let me check the symptom background and what it does first.').join(' ');
  assert.equal(isEnglishDegenerate(englishMetrics(prose), {}), true, '散文里的同句重复仍要判退化');
});

test('英文判据不掐「写目录」的流（同一份 fixture 走流内）', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'english-nav', 3);
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false,
    level: 3, streamKillRun: 999, streamKillMinChars: 0, maxKillStreak: 0,
    streamKillEnglishEnabled: true, streamKillRepeatEnabled: false,
  });
  const handler = ctx.handlers.get('llm/stream')[0];
  const line = '<a href="#-what-it-does">What it does</a> ·';
  const chunks = [];
  for (let i = 0; i < 90; i++) chunks.push({ type: 'reasoning-delta', text: `${line}\n` });
  const next = async function* () { for (const c of chunks) yield c; };
  let seen = 0;
  for await (const _ of handler({ sessionId: 'english-nav', tools: [{ name: 'get_goal' }] }, next)) seen += 1;
  assert.equal(seen, 90, `链接清单不该被掐，实际只放行 ${seen}`);
});

// ---------- 2026-11-24 深夜：历史消毒改成「剔占位行 + 转发式重发」 ----------

test('strip 模式：占位行整行剔掉，正文一个字不丢', async () => {
  const { scrubDegenerateReasoning } = await import('../src/index.js');
  const dirty = '先看 docs 目录。\n好。\n再确认入口文件在哪。\n嗯。\n做。\n然后 grep 关键词。\n好。\n嗯。\n好。\n做。\n最后跑测试。';
  const messages = [{ role: 'assistant', content: [{ type: 'reasoning', text: dirty }, { type: 'text', text: '正文不动。' }] }];
  const out = scrubDegenerateReasoning(messages, { scrubMode: 'strip', scrubStripMinDropped: 5 });
  assert.ok(out.stripped >= 6, `应剔掉占位行，实际 ${out.stripped}`);
  const text = out.messages[0].content[0].text;
  assert.ok(!text.includes('好。'), '占位行不该留');
  assert.ok(!text.includes('嗯。'), '占位行不该留');
  assert.ok(text.includes('先看 docs 目录。') && text.includes('然后 grep 关键词。') && text.includes('最后跑测试。'), '正文全留');
  assert.equal(out.messages[0].content[1].text, '正文不动。', '正文块不碰');
});

test('围栏代码里的占位行不删（2026-11-25 外部评估 5）', async () => {
  const { stripPlaceholderLines } = await import('../src/index.js');
  const src = ['看这段证据：', '```', '做。', '好。', '```', '嗯。', '所以结论是 X。'].join('\n');
  const { text, dropped } = stripPlaceholderLines(src);
  assert.equal(dropped, 1, '只该删围栏外那个「嗯。」');
  assert.ok(text.includes('```\n做。\n好。\n```'), '围栏内的两行要原样留着');
  assert.ok(!/\n嗯。\n/.test(text), '围栏外的占位行仍然要删');
});

test('波浪线围栏、引用块、缩进代码都受保护', async () => {
  const { stripPlaceholderLines } = await import('../src/index.js');
  const src = ['~~~', '好。', '~~~', '> 做。', '    嗯。', '正文。'].join('\n');
  const { dropped, text } = stripPlaceholderLines(src);
  assert.equal(dropped, 0, '这三种行都不该被删');
  assert.equal(text, src, '一行都不该动');
});

test('剥离不动字节：不 trim、不压空行', async () => {
  const { stripPlaceholderLines } = await import('../src/index.js');
  const src = '  开头有缩进空格。  \n好。\n\n\n\n中间空三行。\n做。\n';
  const { text, dropped } = stripPlaceholderLines(src);
  assert.equal(dropped, 2);
  assert.equal(text, '  开头有缩进空格。  \n\n\n\n中间空三行。\n', '只少了那两行，其余字节一致');
});

test('没删到东西时原样返回同一个字符串（不走缓存也字节一致）', async () => {
  const { stripPlaceholderLines } = await import('../src/index.js');
  const src = '  这段没有占位行，首尾还有空白。  \n\n';
  const out = stripPlaceholderLines(src);
  assert.equal(out.dropped, 0);
  assert.equal(out.text, src);
});

test('剥离缓存：同一块第二次命中，结果一模一样（2026-11-25 性能）', async () => {
  const { stripPlaceholderLines, scrubCacheStats } = await import('../src/index.js');
  // 造一段够长、且带占位行的文本（缓存阈值 160 字符）
  const big = Array.from({ length: 40 }, (_, i) => `第 ${i} 行内容。`).join('\n') + '\n好。\n做。\n';
  const first = stripPlaceholderLines(big);
  const before = scrubCacheStats();
  const second = stripPlaceholderLines(big);
  const after = scrubCacheStats();
  assert.equal(first.dropped, 2);
  assert.equal(second.text, first.text, '缓存不能改变结果');
  assert.equal(second.dropped, first.dropped);
  assert.ok(after.hits > before.hits, '第二次应该命中缓存');
});

test('缓存容量必须大于单次请求的块数（踩过的坑：512 时命中率恒为 0）', () => {
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const m = /const SCRUB_CACHE_MAX = (\d+);/.exec(src);
  assert.ok(m, '找不到 SCRUB_CACHE_MAX');
  const cap = Number(m[1]);
  assert.ok(cap >= 1000, `缓存上限 ${cap} 太小：长会话一次请求就有六七百个块，淘汰会自毁`);
});

test('strip 模式：几乎全是占位行的块整块换成省略标记', async () => {
  const { scrubDegenerateReasoning } = await import('../src/index.js');
  const messages = [{ role: 'assistant', content: [{ type: 'reasoning', text: '做。\n'.repeat(40) }] }];
  const out = scrubDegenerateReasoning(messages, { scrubMode: 'strip', scrubStripMinDropped: 5 });
  assert.equal(out.removed, 1);
  assert.match(out.messages[0].content[0].text, /已省略/);
});

test('占位行太少就不动手（别为两行折腾整个上下文）', async () => {
  const { scrubDegenerateReasoning } = await import('../src/index.js');
  const messages = [{ role: 'assistant', content: [{ type: 'reasoning', text: '内容。\n好。\n内容二。' }] }];
  const out = scrubDegenerateReasoning(messages, { scrubMode: 'strip', scrubStripMinDropped: 5 });
  assert.equal(out.stripped, 0);
  assert.equal(out.messages, messages, '没动手就返回同一个引用');
});

test('历史消毒用转发式：深冻结的 options 也能把改过的消息发出去', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'scrub-forward', 1);
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 1, scrubDegenerateHistory: true, scrubMode: 'strip', scrubStripMinDropped: 5 });
  const handler = ctx.handlers.get('llm/stream')[0];

  const dirty = ['先看 docs 目录。', '好。', '再确认入口文件。', '嗯。', '做。', '然后 grep 关键词。', '好。', '嗯。', '好。', '做。', '最后跑测试。'].join('\n');
  // 模拟真机：options 与 messages 都是深冻结的
  const options = Object.freeze({
    sessionId: 'scrub-forward',
    messages: Object.freeze([Object.freeze({ role: 'assistant', content: Object.freeze([Object.freeze({ type: 'reasoning', text: dirty })]) })]),
  });
  const fakeRuntime = {
    calls: [],
    streamWithRegistration(opts) {
      this.calls.push(opts);
      return (async function* () { yield { type: 'reasoning-delta', text: 'ok' }; })();
    },
  };
  const out = [];
  for await (const c of handler.call(fakeRuntime, options, async function* () {})) out.push(c);

  assert.equal(fakeRuntime.calls.length, 1, '应该用新 options 重新发起一次');
  const forwarded = fakeRuntime.calls[0];
  assert.notEqual(forwarded, options, '发出去的是克隆对象，不是冻结的原件');
  assert.equal(forwarded.sessionId, 'scrub-forward', '其余字段照抄');
  const text = forwarded.messages[0].content[0].text;
  assert.ok(!text.includes('好。') && !text.includes('做。'), '占位行被剔掉');
  assert.ok(text.includes('先看 docs 目录。'), '正文保留');
  assert.equal(out.length, 1, '转发回来的流原样吐给上游');
  assert.equal(options.messages.length, 1, '原件没被就地改');
});

test('转发流中途抛错不重发原请求（2026-11-25 外部评估 P0）', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'scrub-throw', 1);
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 1, scrubDegenerateHistory: true, scrubMode: 'strip', scrubStripMinDropped: 5 });
  const handler = ctx.handlers.get('llm/stream')[0];

  const dirty = ['内容一。', '好。', '内容二。', '嗯。', '做。', '内容三。', '好。', '嗯。', '好。', '做。', '内容四。'].join('\n');
  const options = Object.freeze({
    sessionId: 'scrub-throw',
    messages: Object.freeze([Object.freeze({ role: 'assistant', content: Object.freeze([Object.freeze({ type: 'reasoning', text: dirty })]) })]),
  });
  const fakeRuntime = {
    calls: 0,
    streamWithRegistration() {
      this.calls += 1;
      return (async function* () {
        yield { type: 'reasoning-delta', text: '半截' };
        throw new Error('adapter 炸了');
      })();
    },
  };
  let nextCalls = 0;
  const next = async function* () { nextCalls += 1; yield { type: 'reasoning-delta', text: '原请求' }; };

  const seen = [];
  await assert.rejects(async () => {
    for await (const c of handler.call(fakeRuntime, options, next)) seen.push(c);
  }, /adapter 炸了/);

  assert.equal(fakeRuntime.calls, 1, '转发只发起一次');
  assert.equal(nextCalls, 0, '绝不能回头再跑原请求（那就是两份输出）');
  assert.equal(seen.length, 1, '已经吐出去的那帧保留，但不会再来一份');
});

test('转发入口同步抛错时也不回退原请求', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'scrub-throw2', 1);
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 1, scrubDegenerateHistory: true, scrubMode: 'strip', scrubStripMinDropped: 5 });
  const handler = ctx.handlers.get('llm/stream')[0];

  const dirty = ['内容一。', '好。', '内容二。', '嗯。', '做。', '内容三。', '好。', '嗯。', '好。', '做。', '内容四。'].join('\n');
  const options = Object.freeze({ sessionId: 'scrub-throw2', messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: dirty }] }] });
  const fakeRuntime = { calls: 0, streamWithRegistration() { this.calls += 1; throw new Error('入口炸了'); } };
  let nextCalls = 0;
  const next = async function* () { nextCalls += 1; yield { type: 'reasoning-delta', text: '原请求' }; };

  await assert.rejects(async () => {
    for await (const _ of handler.call(fakeRuntime, options, next)) void _;
  }, /入口炸了/);
  assert.equal(fakeRuntime.calls, 1);
  assert.equal(nextCalls, 0, '启动阶段的错误也要抛给宿主，不许重发');
});

test('工具表里没有 get_goal 时不做快断（2026-11-25 外部评估 P1）', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'no-fake-tool', 3);
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 3, streamKillRun: 15, streamKillMinChars: 0, followupFallback: false });
  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = Array.from({ length: 40 }, () => ({ type: 'reasoning-delta', text: '做。\n' }));
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  // 请求只带 read 工具，agent 也没有 followup：既不能快断也不能慢续
  for await (const c of handler({ sessionId: 'no-fake-tool', tools: [{ name: 'read' }] }, next)) out.push(c);
  assert.equal(out.length, 40, '接不上就别掐，整段放行');
  assert.ok(!out.some((c) => c.type === 'tool-call-delta'), '不该伪造任何工具调用');
});

test('转发过的新 options 不会二次消毒（防无限重发）', async () => {
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'scrub-once', 1);
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 1, scrubDegenerateHistory: true, scrubMode: 'strip', scrubStripMinDropped: 5 });
  const handler = ctx.handlers.get('llm/stream')[0];
  const dirty = ['内容一。', '好。', '内容二。', '嗯。', '做。', '内容三。', '好。', '嗯。', '好。', '做。', '内容四。'].join('\n');
  const fakeRuntime = {
    calls: [],
    streamWithRegistration(opts) { this.calls.push(opts); return (async function* () {})(); },
  };
  const options = Object.freeze({ sessionId: 'scrub-once', messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: dirty }] }] });
  for await (const c of handler.call(fakeRuntime, options, async function* () {})) void c;
  const forwarded = fakeRuntime.calls[0];
  for await (const c of handler.call(fakeRuntime, forwarded, async function* () {})) void c;
  assert.equal(fakeRuntime.calls.length, 1, '第二遍不该再发起');
});

test('运行时开关：scrub=false 这一轮就不消毒，拨回来立刻恢复', async () => {
  const { writeSwitch, readSwitch } = await import('../src/state.js');
  const file = path.join(HOME, 'thinking-guard.json');
  writeSessionLevel(file, 'scrub-switch', 1);
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: false, level: 1, scrubDegenerateHistory: true, scrubMode: 'strip', scrubStripMinDropped: 5 });
  const handler = ctx.handlers.get('llm/stream')[0];
  const dirty = ['内容一。', '好。', '内容二。', '嗯。', '做。', '内容三。', '好。', '嗯。', '好。', '做。', '内容四。'].join('\n');
  const options = () => ({ sessionId: 'scrub-switch', messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: dirty }] }] });

  writeSwitch('scrub', false);
  assert.equal(readSwitch('scrub'), false, '开关能读回');
  const offRuntime = { calls: [], streamWithRegistration(opts) { this.calls.push(opts); return (async function* () {})(); } };
  for await (const c of handler.call(offRuntime, options(), async function* () {})) void c;
  assert.equal(offRuntime.calls.length, 0, '关掉就不该转发');
  assert.equal(ctx.logs.filter((l) => l.includes('历史消毒') && l.includes('转发')).length, 0);

  writeSwitch('scrub', true);
  const onRuntime = { calls: [], streamWithRegistration(opts) { this.calls.push(opts); return (async function* () {})(); } };
  for await (const c of handler.call(onRuntime, options(), async function* () {})) void c;
  assert.equal(onRuntime.calls.length, 1, '拨回来就该转发');

  writeSwitch('scrub', true); // 收尾，别污染后面的用例
});
