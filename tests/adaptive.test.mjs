// 自适应门控：把「渐变不误伤、突变抓得住」这件事钉死。
//
// 这两条不是拍脑袋定的——2026-11-26 在 177 个会话 / 2,421 轮真实语料上，
// 固定阈值每次都会误伤同一个占位率缓慢爬升的 game 会话，而基线×2 两种都能分开。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-adaptive-'));
process.env.DSH_HOME = HOME;

const { apply } = await import('../src/index.js');
const {
  median, adaptiveDecision, readAdaptive, writeAdaptive, noteStep, lockSession, ADAPTIVE_VERSION,
} = await import('../src/adaptive.js');
const { writeSessionLevel, writeSwitch } = await import('../src/state.js');

const CFG = { adaptiveMultiplier: 2, adaptiveFloor: 0.20, adaptiveMinLines: 30, adaptiveWarmupSteps: 3, adaptiveWindow: 8, adaptiveLockSteps: 5 };
const file = () => path.join(HOME, 'thinking-guard-adaptive.json');

// ---------- 纯函数 ----------

test('median：偶数取中间两个的均值，空数组是 0', () => {
  assert.equal(median([]), 0);
  assert.equal(median([0.3]), 0.3);
  assert.equal(median([0.1, 0.3]), 0.2);
  assert.equal(median([0.5, 0.1, 0.3]), 0.3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('adaptiveDecision：行数不够、冷启动、正常、突变、锁定', () => {
  const cfg = CFG;
  // 行数不够：13 行里 2 行占位是 15%，但跟 2886 行里 40% 不是一回事
  assert.equal(adaptiveDecision({ rate: 0.9, lines: 13, history: [0.1, 0.1, 0.1], lockUntil: 0, step: 3, cfg }).reason, 'too-short');

  // 冷启动：没有基线，退回绝对下限——爆发照掐，安静的不动
  assert.equal(adaptiveDecision({ rate: 1, lines: 100, history: [], lockUntil: 0, step: 0, cfg }).reason, 'cold-spike', '第一步就爆发要抓');
  assert.equal(adaptiveDecision({ rate: 0.05, lines: 100, history: [0.1, 0.1], lockUntil: 0, step: 2, cfg }).reason, 'cold', '样本不够但很安静就不动');

  // 正常：渐变到 31% 也不该开火（game 会话就是这种形状）
  const gradual = [0.136, 0.14, 0.172, 0.185, 0.195];
  const normal = adaptiveDecision({ rate: 0.314, lines: 443, history: gradual, lockUntil: 0, step: 5, cfg });
  assert.equal(normal.allow, false, `渐变不该开火，阈值 ${normal.threshold}`);
  assert.equal(normal.reason, 'normal');
  assert.equal(normal.baseline, 0.172, '基线取中位数 17.2%');

  // 突变：同一条会话里突然冲到 87% 就该开火
  const spike = adaptiveDecision({ rate: 0.873, lines: 110, history: [0.118, 0.118, 0.12, 0.118, 0.118], lockUntil: 0, step: 5, cfg });
  assert.equal(spike.allow, true, '突变必须开火');
  assert.equal(spike.reason, 'spike');

  // 基线接近 0：靠绝对下限兜底，免得新会话随便写两行就触发
  const lowBase = adaptiveDecision({ rate: 0.12, lines: 100, history: [0, 0, 0, 0], lockUntil: 0, step: 4, cfg });
  assert.equal(lowBase.allow, false, '12% 低于 20% 下限，不该开火');

  // 锁定期：刚开过火，按绝对下限放行，不等基线追上来
  assert.equal(adaptiveDecision({ rate: 0.25, lines: 100, history: [0.25, 0.25, 0.25, 0.25, 0.25], lockUntil: 9, step: 5, cfg }).reason, 'locked');
  assert.equal(adaptiveDecision({ rate: 0.05, lines: 100, history: [0.25, 0.25, 0.25, 0.25, 0.25], lockUntil: 9, step: 5, cfg }).reason, 'locked-idle');
});

// ---------- 状态文件 ----------

test('状态文件：原子写、能读回、坏文件当空状态', () => {
  const f = file();
  writeAdaptive(f, { version: ADAPTIVE_VERSION, sessions: { abc: { rates: [0.1, 0.2], steps: 2, lockUntil: 0 } }, order: ['abc'] });
  const back = readAdaptive(f);
  assert.deepEqual(back.sessions.abc.rates, [0.1, 0.2]);
  assert.equal(back.sessions.abc.steps, 2);

  fs.writeFileSync(f, '{ 这不是 json');
  assert.deepEqual(readAdaptive(f).sessions, {}, '坏文件不该抛，当空状态');

  fs.writeFileSync(f, JSON.stringify({ sessions: { x: { rates: [5, 'a', 0.3], steps: -1 } } }));
  const cleaned = readAdaptive(f);
  assert.deepEqual(cleaned.sessions.x.rates, [0.3], '超范围的数值被剔掉');
  assert.equal(cleaned.sessions.x.steps, 1, 'steps 非法时回落到 rates 长度');
});

test('noteStep：被掐断的那一步只推进步数，不进历史', () => {
  const f = file();
  const cfg = CFG;
  let row = noteStep(f, 'sess', { rate: 0.12, killed: false, cfg });
  assert.deepEqual(row.rates, [0.12], '正常的一步进历史');
  assert.equal(row.steps, 1);

  row = noteStep(f, 'sess', { rate: 0.95, killed: true, cfg });
  assert.deepEqual(row.rates, [0.12], '被掐断的一步不进历史——否则基线被拉高，下次就掐不动了');
  assert.equal(row.steps, 2, '但步数要推进');

  row = noteStep(f, 'sess', { rate: 0.5, killed: false, cfg });
  assert.deepEqual(row.rates, [0.12, 0.5]);
});

test('noteStep：历史长度被窗口截断', () => {
  const f = file();
  const cfg = { ...CFG, adaptiveWindow: 3 };
  for (const rate of [0.1, 0.2, 0.3, 0.4, 0.5]) noteStep(f, 'win', { rate, killed: false, cfg });
  assert.deepEqual(readAdaptive(f).sessions.win.rates, [0.3, 0.4, 0.5], '只留最近 3 步');
});

test('lockSession：锁到「当前步 + 锁定步数」', () => {
  const f = file();
  const cfg = { ...CFG, adaptiveLockSteps: 5 };
  noteStep(f, 'lock', { rate: 0.1, killed: false, cfg });
  noteStep(f, 'lock', { rate: 0.1, killed: false, cfg });
  const row = lockSession(f, 'lock', cfg);
  assert.equal(row.steps, 2);
  assert.equal(row.lockUntil, 7, '2 + 5');
});

// ---------- 端到端：渐变不掐、突变掐 ----------

const line = (i) => `第 ${i} 步先看 main.js 里的第 ${i} 行，确认回调有没有绑到 runtime 上，再决定改不改。`;
/**
 * 造一块：每 every 行匀着插一个「做。」。
 *
 * 匀着插是为了**不触发**判据：占位词不连续 → 连续短行 run 只有 1；
 * 每行的正文都带序号（唯一）→ 相邻对不会重复到 8 次。于是这块只贡献"占位率"，
 * 正好用来喂自适应基线，而不会自己把流掐掉。
 */
function evenBlock({ total = 120, every = 8, tail = 0 } = {}) {
  const out = [];
  for (let i = 0; i < total; i++) {
    out.push(line(i));
    if (every > 0 && (i + 1) % every === 0) out.push('做。');
  }
  for (let i = 0; i < tail; i++) out.push('做。');
  return out.join('\n') + '\n';
}
/** 占位率：匀着插出来的那块大概是多少。 */
function evenRate({ total = 120, every = 8, tail = 0 } = {}) {
  const body = total;
  const placeholders = (every > 0 ? Math.floor(total / every) : 0) + tail;
  return placeholders / (body + placeholders);
}

function makeCtx() {
  const handlers = new Map();
  const logs = [];
  const ctx = {
    handlers, logs,
    on(event, fn) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(fn); },
    effect(fn) { fn(); return () => {}; },
    systemPrompt: { section() { return { dispose() {} }; } },
    inject(names, fn) { if (names.includes('webServer')) fn({ webServer: { register() { return { dispose() {} }; } }, effect: ctx.effect }); },
    logger: { warn: (m) => logs.push(m), info: (m) => logs.push(m) },
  };
  return ctx;
}

/** 喂一步，返回掐没掐。 */
async function feedStep(ctx, sid, text) {
  const handler = ctx.handlers.get('llm/stream')[0];
  const chunks = Array.from(text).reduce((acc, ch, i) => {
    if (i % 64 === 0) acc.push({ type: 'reasoning-delta', index: 0, text: text.slice(i, i + 64) });
    return acc;
  }, []);
  chunks.push({ type: 'finish', reason: { kind: 'stop' } });
  const next = async function* () { for (const c of chunks) yield c; };
  const out = [];
  for await (const c of handler({ sessionId: sid, tools: [{ name: 'get_goal' }] }, next)) out.push(c);
  return out.some((c) => c.type === 'finish' && c.reason?.kind === 'tool-calls');
}

test('端到端：占位率缓慢爬升的会话不被掐（固定阈值会误伤的那种）', async () => {
  const sid = 'gradual-session';
  writeSessionLevel(path.join(HOME, 'thinking-guard.json'), sid, 3);
  const ctx = makeCtx();
  apply(ctx, { level: 3, adaptiveEnabled: true, streamKillMinChars: 0, streamKillRun: 15, ...CFG });

  // 占位率一路爬：11% → 14% → 17% → 20% → 25%（game 会话就长这样，基线同步往上走）
  const steps = [8, 6, 5, 4, 3];
  for (const every of steps) {
    const shape = { total: 120, every, tail: 0 };
    const cut = await feedStep(ctx, sid, evenBlock(shape));
    assert.equal(cut, false, `占位率约 ${(evenRate(shape) * 100).toFixed(0)}% 是渐变，不该掐（这一步实际掐了）`);
  }
  const hist = readAdaptive(file()).sessions[sid];
  assert.equal(hist.rates.length, steps.length, '每步都记进历史了');
  assert.ok(hist.rates.every((r, i) => i === 0 || r >= hist.rates[i - 1] - 0.02), '历史确实是往上爬的');
});

test('端到端：同一会话里突然爆发会被掐', async () => {
  const sid = 'spike-session';
  writeSessionLevel(path.join(HOME, 'thinking-guard.json'), sid, 3);
  const ctx = makeCtx();
  apply(ctx, { level: 3, adaptiveEnabled: true, streamKillMinChars: 0, streamKillRun: 15, ...CFG });

  // 先攒 4 步低占位率当基线
  for (const every of [8, 8, 7, 8]) {
    await feedStep(ctx, sid, evenBlock({ total: 120, every }));
  }
  const before = readAdaptive(file()).sessions[sid];
  assert.equal(before.rates.length, 4);

  // 第 5 步突然爆发：尾部 40 行连续占位词 → 判据命中，而且远超基线
  const cut = await feedStep(ctx, sid, evenBlock({ total: 20, every: 20, tail: 40 }));
  assert.equal(cut, true, '突变必须掐');

  const after = readAdaptive(file()).sessions[sid];
  assert.equal(after.rates.length, 4, '被掐断的那一步不进历史');
  assert.equal(after.steps, before.steps + 1, '但步数推进');
  assert.ok(after.lockUntil > after.steps, '掐完要上锁');
});

test('端到端：门控拦下时不伪造工具，原 stop 照常透传', async () => {
  const sid = 'gated-session';
  writeSessionLevel(path.join(HOME, 'thinking-guard.json'), sid, 3);
  const ctx = makeCtx();
  apply(ctx, { level: 3, adaptiveEnabled: true, streamKillMinChars: 0, streamKillRun: 15, ...CFG });

  // 基线：占位率 25% 起步（已经是高位），所以后面 30% 出头的一步不该算"突变"
  for (const every of [3, 3, 3]) await feedStep(ctx, sid, evenBlock({ total: 120, every }));

  // 这一步 30% 出头、且尾部连续触发判据；但基线也是高位 → 门控应该拦下
  const cut = await feedStep(ctx, sid, evenBlock({ total: 60, every: 3, tail: 20 }));
  assert.equal(cut, false, '没超过基线×2 就该放行原流');
});

test('关掉自适应就回到老行为：判据命中直接掐', async () => {
  const sid = 'off-session';
  writeSessionLevel(path.join(HOME, 'thinking-guard.json'), sid, 3);
  const ctx = makeCtx();
  apply(ctx, { level: 3, adaptiveEnabled: false, streamKillMinChars: 0, streamKillRun: 15 });
  const cut = await feedStep(ctx, sid, evenBlock({ total: 20, every: 20, tail: 20 }));
  assert.equal(cut, true, '关掉门控后，第一刀就该落');
  assert.equal(readAdaptive(file()).sessions[sid], undefined, '关掉时不写统计');
});

test('运行时开关：优先级高于配置默认值', async () => {
  const sid = 'switch-session';
  writeSessionLevel(path.join(HOME, 'thinking-guard.json'), sid, 3);
  writeSwitch('adaptive', false);
  const ctx = makeCtx();
  apply(ctx, { level: 3, adaptiveEnabled: true, streamKillMinChars: 0, streamKillRun: 15, ...CFG });
  const cut = await feedStep(ctx, sid, evenBlock({ total: 20, every: 20, tail: 20 }));
  assert.equal(cut, true, '运行时开关说关，就该按关走');
  writeSwitch('adaptive', true);
});

test('路由：GET 带 adaptive，POST 能切开关', async () => {
  const ctx = makeCtx();
  apply(ctx, { adaptiveEnabled: true });
  const route = ctx.handlers.size >= 0 ? null : null;
  // 路由是从 inject 里注册的，直接找注册过的那个
  const registered = [];
  const ctx2 = {
    handlers: new Map(),
    logs: [],
    on() {}, effect(fn) { fn(); return () => {}; },
    systemPrompt: { section() { return { dispose() {} }; } },
    inject(names, fn) {
      if (!names.includes('webServer')) return;
      fn({ webServer: { register(r) { registered.push(r); return { dispose() {} }; } }, effect: ctx2.effect });
    },
    logger: { warn() {}, info() {} },
  };
  apply(ctx2, { adaptiveEnabled: true });
  const r = registered[0];
  assert.ok(r, '应注册一个路由');

  const call = async (method, url, body) => {
    const req = {
      method, url,
      socket: { remoteAddress: '127.0.0.1' },
      on(event, cb) {
        if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
        if (event === 'end') cb();
      },
      destroy() {},
    };
    const res = {
      statusCode: 0, payload: null,
      writeHead(status) { this.statusCode = status; },
      setHeader() {},
      end(text) { this.payload = JSON.parse(text || '{}'); },
    };
    await r.handler(req, res);
    return res;
  };

  writeSwitch('adaptive', false);
  const got = await call('GET', '/thinking-guard/state');
  assert.equal(got.payload.adaptive, false, 'GET 要回当前开关');
  assert.equal(got.payload.adaptiveDetail.multiplier, 2, 'GET 带上参数');
  assert.equal(got.payload.adaptiveDetail.floor, 0.2);

  const ok = await call('POST', '/thinking-guard/state', { adaptive: true });
  assert.equal(ok.payload.ok, true);
  assert.equal(ok.payload.adaptive, true);
  const back = await call('GET', '/thinking-guard/state');
  assert.equal(back.payload.adaptive, true, 'POST 之后读回来是开');
  void route;
});
