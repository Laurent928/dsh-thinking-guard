#!/usr/bin/env node
/**
 * 量一量「逐行剥离」比「整块替换」多留下多少东西。
 *
 * 用法：
 *   node scripts/measure-scrub.mjs                      # 扫 $DSH_HOME/sessions（或 ~/.dsh/sessions）
 *   node scripts/measure-scrub.mjs /path/to/sessions    # 指定目录
 *   node scripts/measure-scrub.mjs --json               # 机读
 *
 * 只用插件自己的 stripPlaceholderLines() / measure() / isDegraded()，不另写一份判据——
 * 免得「量出来的不是真跑的那套」。全程只读，不改任何会话文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { stripPlaceholderLines, measure, isDegraded, isPlaceholderLine } from '../src/index.js';

const ZSTD_MAGIC = 0xfd2fb528, SKIPPABLE_LO = 0x184d2a50, SKIPPABLE_HI = 0x184d2a5f;

/**
 * 按 zstd 帧格式切分。会话日志是「一个事件一个 frame」的多帧文件，
 * zstdDecompressSync 只解第一个 frame，所以必须自己切。
 * @param {Buffer} buf - 整个文件。
 * @returns {Array<[number, number]>} 每帧的 [起, 止)。
 */
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

/** 找到一个会话文件里所有 reasoning 块。 */
function reasoningBlocks(file) {
  let text = '';
  try {
    const buf = fs.readFileSync(file);
    text = Buffer.concat(frames(buf).map(([s, e]) => zlib.zstdDecompressSync(buf.subarray(s, e)))).toString('utf8');
  } catch { return []; }
  const blocks = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant/message') continue;
    const content = (event.data?.message ?? event.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text) blocks.push(block.text);
    }
  }
  return blocks;
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const rootArg = args.find((a) => !a.startsWith('--'));
const ROOT = rootArg
  ? path.resolve(rootArg)
  : path.join(process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh'), 'sessions');

if (!fs.existsSync(ROOT)) {
  console.error('找不到会话目录：' + ROOT);
  console.error('用法：node scripts/measure-scrub.mjs [sessions 目录]');
  process.exit(1);
}

/** 判据默认值与 DEFAULTS 保持一致。 */
const CFG = { maxRun: 25, looseRun: 15, looseUniq: 0.4, minLines: 10 };
/** 整块替换（squash）时用来顶替的标记长度，取自源码里那句「（上一段思考陷入重复 N 行，已省略）」。 */
const SQUASH_MARK = '（上一段思考陷入重复 0 行，已省略）';

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) files.push(full);
  }
})(ROOT);

const perSession = new Map();
const T = {
  files: files.length, blocks: 0, lines: 0, chars: 0, placeholderLines: 0, placeholderChars: 0,
  keep: { none: 0, strip: 0 },
  degraded: { blocks: 0, lines: 0, chars: 0, placeholderLines: 0, keepStrip: 0, keepSquash: 0, emptied: 0 },
  ratios: [],
};

for (const file of files) {
  const workspace = path.relative(ROOT, file).split(/[\\/]/)[0] || '?';
  const session = path.basename(path.dirname(file)).replace(/^session-/, '').slice(0, 8);
  for (const source of reasoningBlocks(file)) {
    const lines = source.split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const placeholders = lines.filter((line) => isPlaceholderLine(line));
    const stripped = stripPlaceholderLines(source);
    const degraded = isDegraded(measure(lines), CFG);

    T.blocks += 1;
    T.lines += lines.length;
    T.chars += source.length;
    T.placeholderLines += placeholders.length;
    T.placeholderChars += placeholders.reduce((a, s) => a + s.length, 0);
    T.keep.none += source.length;
    T.keep.strip += stripped.text.length;
    T.ratios.push((source.length - stripped.text.length) / source.length);

    if (degraded) {
      T.degraded.blocks += 1;
      T.degraded.lines += lines.length;
      T.degraded.chars += source.length;
      T.degraded.placeholderLines += placeholders.length;
      T.degraded.keepStrip += stripped.text.length;
      T.degraded.keepSquash += SQUASH_MARK.length;
      if (stripped.text.length === 0) T.degraded.emptied += 1;
    }

    const key = session;
    const row = perSession.get(key) ?? { workspace, blocks: 0, lines: 0, chars: 0, placeholderLines: 0, drop: 0 };
    row.blocks += 1;
    row.lines += lines.length;
    row.chars += source.length;
    row.placeholderLines += placeholders.length;
    row.drop += source.length - stripped.text.length;
    perSession.set(key, row);
  }
}

const pct = (part, whole) => (whole ? (part / whole) * 100 : 0);
const fmt = (n) => n.toLocaleString('en-US');
const p = (n) => n.toFixed(2) + '%';
const sortedRatios = T.ratios.slice().sort((a, b) => a - b);
const quantile = (q) => (sortedRatios.length ? sortedRatios[Math.min(sortedRatios.length - 1, Math.floor(q * sortedRatios.length))] : 0);

if (asJson) {
  console.log(JSON.stringify({
    root: ROOT, files: T.files, blocks: T.blocks, lines: T.lines, chars: T.chars,
    placeholderLines: T.placeholderLines, placeholderChars: T.placeholderChars,
    placeholderLineShare: pct(T.placeholderLines, T.lines),
    keepNone: T.keep.none, keepStrip: T.keep.strip,
    stripShare: pct(T.keep.strip, T.chars),
    degraded: T.degraded,
    ratioP50: quantile(0.5), ratioP90: quantile(0.9), ratioP99: quantile(0.99), ratioMax: quantile(1),
    sessions: [...perSession].map(([id, v]) => ({ id, ...v })),
  }, null, 2));
  process.exit(0);
}

console.log('语料目录   ' + ROOT);
console.log('');
console.log('=== 语料规模 ===');
console.log('会话文件   ' + fmt(T.files));
console.log('思考块     ' + fmt(T.blocks));
console.log('思考行     ' + fmt(T.lines));
console.log('思考字符   ' + fmt(T.chars));
console.log('');
console.log('=== 占位行（严格口径：整行只有「做。/好。/嗯。」这类无宾语词）===');
console.log('占位行     ' + fmt(T.placeholderLines) + '  → ' + p(pct(T.placeholderLines, T.lines)) + ' 的行');
console.log('占位字符   ' + fmt(T.placeholderChars) + '  → ' + p(pct(T.placeholderChars, T.chars)) + ' 的字符');
console.log('');
console.log('=== 全部块的字符留存（同一个范围，才比得出来）===');
console.log('不动       保留 ' + fmt(T.keep.none) + ' 字符（' + p(pct(T.keep.none, T.chars)) + '）');
console.log('逐行剥离   保留 ' + fmt(T.keep.strip) + ' 字符（' + p(pct(T.keep.strip, T.chars)) + '），丢 ' + fmt(T.chars - T.keep.strip));
console.log('');
console.log('=== 单块剥除字符占比 ===');
console.log('p50 ' + p(quantile(0.5) * 100) + '   p90 ' + p(quantile(0.9) * 100) + '   p99 ' + p(quantile(0.99) * 100) + '   max ' + p(quantile(1) * 100));
console.log('');
console.log('=== 只算块级判据判为退化的那些块 ===');
const D = T.degraded;
console.log('块数       ' + fmt(D.blocks) + ' / ' + fmt(T.blocks) + '（' + p(pct(D.blocks, T.blocks)) + '）');
console.log('行 / 字符  ' + fmt(D.lines) + ' / ' + fmt(D.chars));
console.log('占位行     ' + p(pct(D.placeholderLines, D.lines)) + ' 的行');
console.log('逐行剥离   保留 ' + fmt(D.keepStrip) + ' 字符（' + p(pct(D.keepStrip, D.chars)) + '）');
console.log('整块替换   保留 ' + fmt(D.keepSquash) + ' 字符（' + p(pct(D.keepSquash, D.chars)) + '）');
console.log('剥空的块   ' + fmt(D.emptied) + ' / ' + fmt(D.blocks) + '（一行真话都不剩，才整块换成标记）');
console.log('');
console.log('=== 剥得最多的 8 个会话 ===');
const rows = [...perSession].sort((a, b) => b[1].drop - a[1].drop).slice(0, 8);
console.log('会话        块      行      字符      占位行    剥掉');
for (const [id, v] of rows) {
  console.log(
    id.padEnd(10) +
    String(fmt(v.blocks)).padStart(6) +
    String(fmt(v.lines)).padStart(8) +
    String(fmt(v.chars)).padStart(10) +
    String(p(pct(v.placeholderLines, v.lines))).padStart(9) +
    String(p(pct(v.drop, v.chars))).padStart(9),
  );
}
console.log('');
console.log('注：语料是本机 DSH 会话日志，不是公开数据集——换个语料，数字会不一样。');
