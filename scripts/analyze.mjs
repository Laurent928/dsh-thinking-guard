#!/usr/bin/env node
/**
 * 体检一份会话日志：哪儿在空转、浪费了多少、插件抓不抓得住。
 *
 * 只读，不改任何文件。
 *
 *   node scripts/analyze.mjs                    # 扫 $DSH_HOME/sessions
 *   node scripts/analyze.mjs /path/to/sessions  # 指定目录
 *   node scripts/analyze.mjs --json             # 机读
 *   node scripts/analyze.mjs --fast             # 只用统计口径（快，不是实跑）
 *
 * ## 口径（2026-11-26 改过一次，改的原因是 GPT 的评估指出它错）
 *
 * 旧版只对完整推理块做占位密度统计，然后报「插件能抓住多少」——那是**承诺**，不是实测。
 * 实测发现两头都会错：
 *   - **高估**：围栏里的「好。/做。」流式检测会放行（有围栏状态机），旧版照样算成"会掐"；
 *   - **低估**：重复的 `</assistant>` 流式检测命中（精确周期判据），旧版根本不看。
 *
 * 现在默认**把每个块按 64 字符切片，真喂进 apply() 出来的 llm/stream 处理器**，
 * 记它到底掐不掐、在第几字符掐。这才是"体检结果 = 实际行为"。
 * 慢一些（万把块要几十秒），要快就 `--fast` 退回统计口径——但那时输出标题会写明是估算。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const z = zlib;

const ZSTD_MAGIC = 0xfd2fb528, SKIPPABLE_LO = 0x184d2a50, SKIPPABLE_HI = 0x184d2a5f;

/** 按 zstd 帧切分（会话日志是一个事件一个 frame 的多帧文件）。 */
function frames(buf) {
  const out = []; let p = 0;
  while (p < buf.length) {
    const start = p; if (buf.length - p < 5) break;
    const magic = buf.readUInt32LE(p);
    if (magic >= SKIPPABLE_LO && magic <= SKIPPABLE_HI) {
      const size = buf.readUInt32LE(p + 4); p += 8 + size; out.push([start, p]); continue;
    }
    if (magic !== ZSTD_MAGIC) break;
    const descriptor = buf.readUInt8(p + 4);
    const fcsFlag = descriptor >> 6, singleSegment = (descriptor >> 5) & 1;
    const checksum = (descriptor >> 2) & 1, dictFlag = descriptor & 3;
    p += 5;
    if (!singleSegment) p += 1;
    p += [0, 1, 2, 4][dictFlag];
    p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
    for (;;) {
      if (buf.length - p < 3) { p = buf.length; break; }
      const header = buf.readUIntLE(p, 3), last = header & 1, type = (header >> 1) & 3, size = header >> 3;
      p += 3;
      if (type === 0) p += size;
      else if (type === 1) p += 1;
      else if (type === 2) p += size;
      else { p = buf.length; break; }
      if (last) break;
    }
    if (checksum) p += 4;
    out.push([start, p]);
  }
  return out;
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const fast = args.includes('--fast');
const topIdx = args.indexOf('--top');
const TOP = topIdx >= 0 ? Number(args[topIdx + 1]) || 8 : 8;
const rootArg = args.find((a, i) => !a.startsWith('--') && !(topIdx >= 0 && i === topIdx + 1));
const ROOT = rootArg
  ? path.resolve(rootArg)
  : path.join(process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh'), 'sessions');

if (!fs.existsSync(ROOT)) {
  console.error('找不到会话目录：' + ROOT);
  console.error('用法：node scripts/analyze.mjs [sessions 目录] [--json] [--fast] [--top N]');
  process.exit(1);
}

// ---------- 读语料 ----------
const files = [];
let unreadable = 0;
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) files.push(full);
  }
})(ROOT);

const blocks = [];        // { sid, text }
let skippedEvents = 0;    // 读到了但不认识的记录类型计数（只报数，不解析）
for (const file of files) {
  let text = '';
  try {
    const buf = fs.readFileSync(file);
    text = Buffer.concat(frames(buf).map(([s, e]) => z.decompressSync ? z.decompressSync : z.zstdDecompressSync(buf.subarray(s, e)))).toString('utf8');
  } catch {
    unreadable += 1;
    continue;
  }
  const sid = path.basename(path.dirname(file)).replace(/^session-/, '').slice(0, 8);
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { skippedEvents += 1; continue; }
    if (ev.type !== 'assistant/message') continue;
    const content = (ev.data?.message ?? ev.message)?.content;
    if (!Array.isArray(content)) { skippedEvents += 1; continue; }
    for (const b of content) {
      if (b?.type !== 'reasoning' || typeof b.text !== 'string' || !b.text) continue;
      blocks.push({ sid, text: b.text });
    }
  }
}

// ---------- 实跑：把块真喂进插件 ----------
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-analyze-'));
process.env.DSH_HOME = HOME;
const { apply, isPlaceholderLine, DEFAULTS } = await import('../src/index.js');
const state = await import('../src/state.js');
state.writeSessionLevel(path.join(HOME, 'thinking-guard.json'), 'probe-level', 3);

function makeCtx() {
  const ctx = { handlers: new Map() };
  ctx.on = function (e, f) { this.handlers.set(e, f); };
  ctx.effect = function (fn) { fn(); return () => {}; };
  ctx.systemPrompt = { section() { return { dispose() {} }; } };
  ctx.inject = function (n, f) { if (n.includes('webServer')) f({ webServer: { register() { return { dispose() {} }; } }, effect: () => {} }); };
  ctx.logger = { warn() {}, info() {} };
  return ctx;
}

const results = [];   // { sid, text, cut, consumed }
if (!fast) {
  const ctx = makeCtx();
  apply(ctx, { level: 3, traceEnabled: false });
  const handler = ctx.handlers.get('llm/stream');
  let seq = 0;
  for (const blk of blocks) {
    const sid = `probe-${(seq += 1)}`;
    state.writeSessionLevel(path.join(HOME, 'thinking-guard.json'), sid, 3);
    const chunks = [];
    for (let i = 0; i < blk.text.length; i += 64) chunks.push({ type: 'reasoning-delta', index: 0, text: blk.text.slice(i, i + 64) });
    chunks.push({ type: 'finish', reason: { kind: 'stop' } });
    const next = async function* () { for (const c of chunks) yield c; };
    let cut = false, consumed = 0;
    for await (const c of handler({ sessionId: sid, tools: [{ name: 'get_goal' }] }, next)) {
      if (c.type === 'reasoning-delta') consumed += c.text.length;
      if (c.type === 'finish' && c.reason?.kind === 'tool-calls') cut = true;
    }
    results.push({ sid: blk.sid, text: blk.text, cut, consumed });
  }
} else {
  const cfg = DEFAULTS;
  for (const blk of blocks) {
    const lines = blk.text.split('\n').map((s) => s.trim()).filter(Boolean);
    const place = lines.length >= 10 ? lines.filter((s) => isPlaceholderLine(s)).length : 0;
    const rate = lines.length ? place / lines.length : 0;
    const cut = lines.length >= cfg.streamKillDensityMinLines
      && place >= cfg.streamKillDensityMinPlaceholders
      && rate >= cfg.streamKillDensityRatio;
    results.push({ sid: blk.sid, text: blk.text, cut, consumed: cut ? 0 : blk.text.length });
  }
}

fs.rmSync(HOME, { recursive: true, force: true });

// ---------- 统计 ----------
/** 「病块」的独立定义：占位行 ≥10 且 ≥20%。它只用来圈定"该看的样本"，不参与"抓不抓得住"的判断。 */
function isBad(text) {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  if (lines.length < 10) return false;
  const place = lines.filter((s) => isPlaceholderLine(s)).length;
  return place >= 10 && place / lines.length >= 0.20;
}

const perSession = new Map();
const total = { blocks: 0, chars: 0, badBlocks: 0, badChars: 0, caughtBlocks: 0, caughtChars: 0 };
for (const r of results) {
  const bad = isBad(r.text);
  const row = perSession.get(r.sid) ?? { sid: r.sid, blocks: 0, chars: 0, badBlocks: 0, badChars: 0, caughtBlocks: 0, caughtChars: 0 };
  total.blocks += 1; total.chars += r.text.length;
  row.blocks += 1; row.chars += r.text.length;
  if (bad) {
    total.badBlocks += 1; total.badChars += r.text.length;
    row.badBlocks += 1; row.badChars += r.text.length;
    if (r.cut) {
      total.caughtBlocks += 1; total.caughtChars += r.text.length;
      row.caughtBlocks += 1; row.caughtChars += r.text.length;
    }
  }
  perSession.set(r.sid, row);
}

const sessions = [...perSession.values()].filter((r) => r.blocks > 0).sort((a, b) => b.badChars - a.badChars);
total.sessions = sessions.length;
total.badSessions = sessions.filter((r) => r.badBlocks > 0).length;
const pct = (a, b) => (b === 0 ? '0' : (a / b * 100).toFixed(2)) + '%';
const fmt = (n) => n.toLocaleString('en-US');

if (asJson) {
  console.log(JSON.stringify({
    root: ROOT, mode: fast ? 'estimate' : 'replay',
    coverage: { sessionFiles: files.length, unreadable, blocks: results.length, skippedRecords: skippedEvents },
    total, sessions: sessions.slice(0, TOP),
  }, null, 2));
} else {
  console.log(`语料目录   ${ROOT}`);
  console.log(`口径       ${fast ? '估算（纯占位密度统计，不跑流式检测器）' : '实跑（每块按 64 字符切片喂进插件，看真掐不掐）'}`);
  console.log(`覆盖       ${files.length} 个会话文件，读到 ${fmt(results.length)} 个推理块${unreadable ? `，${unreadable} 个文件读取失败` : ''}${skippedEvents ? `，${skippedEvents} 条记录无法解析` : ''}`);
  console.log('');
  console.log('=== 规模 ===');
  console.log(`思考块     ${fmt(total.blocks)}`);
  console.log(`思考字符   ${fmt(total.chars)}`);
  console.log('');
  console.log('=== 空转嫌疑（占位 ≥10 行 且 占比 ≥20%，只用来圈样本）===');
  console.log(`块         ${fmt(total.badBlocks)}（${pct(total.badBlocks, total.blocks)}）`);
  console.log(`字符       ${fmt(total.badChars)}（占全部思考的 ${pct(total.badChars, total.chars)}）`);
  console.log('');
  console.log(`=== ${fast ? '预计' : '实测'}动作（快断档：会掐吗）===`);
  console.log(`按块       ${fmt(total.caughtBlocks)} / ${fmt(total.badBlocks)}（${pct(total.caughtBlocks, total.badBlocks)}）`);
  console.log(`按字符     ${fmt(total.caughtChars)} / ${fmt(total.badChars)}（${pct(total.caughtChars, total.badChars)}）`);
  console.log('');
  console.log(`=== 最值得看的 ${Math.min(TOP, sessions.length)} 个会话 ===`);
  console.log('会话      块数   字符      嫌疑块  嫌疑字符  实掐   占该会话');
  for (const r of sessions.slice(0, TOP)) {
    console.log(`${r.sid}  ${String(r.blocks).padStart(5)}  ${fmt(r.chars).padStart(9)}  ${String(r.badBlocks).padStart(6)}  ${fmt(r.badChars).padStart(8)}  ${String(r.caughtBlocks).padStart(4)}   ${pct(r.badChars, r.chars)}`);
  }
  console.log('');
  console.log('注 1：整理档不打断生成，只剥离占位行；上面是快断档的行为。');
  console.log('注 2：离线回放跑的是完整数据块；线上是边生成边判、半截缓冲，两边精度不能互推。');
}
