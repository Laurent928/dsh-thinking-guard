#!/usr/bin/env node
/**
 * 体检一份会话日志：哪儿在空转、浪费了多少、插件抓不抓得住。
 *
 * 只读，不改任何文件。
 *
 *   node scripts/analyze.mjs                    # 扫 $DSH_HOME/sessions
 *   node scripts/analyze.mjs /path/to/sessions  # 指定目录
 *   node scripts/analyze.mjs --json             # 机读
 *   node scripts/analyze.mjs --top 20           # 只看最问题的 N 个会话
 *
 * 判据用的是 src/index.js 里真跑的那套，不另写一份——免得「体检结果」和「实际行为」不是一回事。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { isPlaceholderLine, DEFAULTS } from '../src/index.js';

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
const topIdx = args.indexOf('--top');
const TOP = topIdx >= 0 ? Number(args[topIdx + 1]) || 8 : 8;
const rootArg = args.find((a, i) => !a.startsWith('--') && !(topIdx >= 0 && i === topIdx + 1));
const ROOT = rootArg
  ? path.resolve(rootArg)
  : path.join(process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh'), 'sessions');

if (!fs.existsSync(ROOT)) {
  console.error('找不到会话目录：' + ROOT);
  console.error('用法：node scripts/analyze.mjs [sessions 目录] [--json] [--top N]');
  process.exit(1);
}

const cfg = DEFAULTS;
/** 和插件真跑一样的命中判定（占位密度那条，现在的主判据）。 */
function wouldCut(place, rate, lines) {
  return place >= cfg.streamKillDensityMinPlaceholders && rate >= cfg.streamKillDensityRatio && lines >= cfg.streamKillDensityMinLines;
}

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) files.push(full);
  }
})(ROOT);

const perSession = new Map();
const total = { blocks: 0, chars: 0, badBlocks: 0, badChars: 0, caughtBlocks: 0, caughtChars: 0, sessions: 0, badSessions: 0 };

for (const file of files) {
  let text = '';
  try {
    const buf = fs.readFileSync(file);
    text = Buffer.concat(frames(buf).map(([s, e]) => zlib.zstdDecompressSync(buf.subarray(s, e)))).toString('utf8');
  } catch { continue; }
  const sid = path.basename(path.dirname(file)).replace(/^session-/, '').slice(0, 8);
  const row = perSession.get(sid) ?? { sid, blocks: 0, chars: 0, badBlocks: 0, badChars: 0, caughtBlocks: 0, caughtChars: 0 };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'assistant/message') continue;
    const content = (ev.data?.message ?? ev.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== 'reasoning' || typeof b.text !== 'string' || !b.text) continue;
      const lines = b.text.split('\n').map((s) => s.trim()).filter(Boolean);
      if (lines.length < 10) continue;
      const place = lines.filter((s) => isPlaceholderLine(s)).length;
      const rate = place / lines.length;
      const bad = place >= 10 && rate >= 0.20;
      const caught = bad && wouldCut(place, rate, lines.length);
      total.blocks += 1; total.chars += b.text.length;
      row.blocks += 1; row.chars += b.text.length;
      if (bad) {
        total.badBlocks += 1; total.badChars += b.text.length;
        row.badBlocks += 1; row.badChars += b.text.length;
        if (caught) {
          total.caughtBlocks += 1; total.caughtChars += b.text.length;
          row.caughtBlocks += 1; row.caughtChars += b.text.length;
        }
      }
    }
  }
  perSession.set(sid, row);
}

const sessions = [...perSession.values()].filter((r) => r.blocks > 0).sort((a, b) => b.badChars - a.badChars);
total.sessions = sessions.length;
total.badSessions = sessions.filter((r) => r.badBlocks > 0).length;

const pct = (a, b) => (b === 0 ? '0' : (a / b * 100).toFixed(2)) + '%';
const fmt = (n) => n.toLocaleString('en-US');

if (asJson) {
  console.log(JSON.stringify({ root: ROOT, total, sessions: sessions.slice(0, TOP) }, null, 2));
} else {
  console.log(`语料目录   ${ROOT}`);
  console.log('');
  console.log('=== 规模 ===');
  console.log(`会话       ${fmt(total.sessions)}（其中出过空转的 ${fmt(total.badSessions)}）`);
  console.log(`思考块     ${fmt(total.blocks)}`);
  console.log(`思考字符   ${fmt(total.chars)}`);
  console.log('');
  console.log('=== 空转（占位≥10 行 且 ≥20% 的块）===');
  console.log(`块         ${fmt(total.badBlocks)}（${pct(total.badBlocks, total.blocks)}）`);
  console.log(`字符       ${fmt(total.badChars)}（占全部思考的 ${pct(total.badChars, total.chars)}）`);
  console.log('');
  console.log('=== 插件能抓住多少 ===');
  console.log(`按块       ${fmt(total.caughtBlocks)} / ${fmt(total.badBlocks)}（${pct(total.caughtBlocks, total.badBlocks)}）`);
  console.log(`按字符     ${fmt(total.caughtChars)} / ${fmt(total.badChars)}（${pct(total.caughtChars, total.badChars)}）`);
  console.log('');
  console.log(`=== 最值得看的 ${Math.min(TOP, sessions.length)} 个会话 ===`);
  console.log('会话      块数   字符      空转块  空转字符   能抓   空转占该会话');
  for (const r of sessions.slice(0, TOP)) {
    if (r.badBlocks === 0 && r !== sessions[0]) continue;
    console.log(`${r.sid}  ${String(r.blocks).padStart(5)}  ${fmt(r.chars).padStart(9)}  ${String(r.badBlocks).padStart(6)}  ${fmt(r.badChars).padStart(8)}  ${String(r.caughtBlocks).padStart(5)}   ${pct(r.badChars, r.chars)}`);
  }
  console.log('');
  console.log('注：这是离线体检，跑的是完整数据块；线上是边生成边判、半截缓冲，两边精度不能互推。');
}
