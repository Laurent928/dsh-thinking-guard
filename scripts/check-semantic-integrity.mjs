#!/usr/bin/env node
/**
 * 证明「剥掉的都是没带信息的独立行」，而不是「剥掉了半个句子」。
 *
 * 三个前提，缺一个「语义完整」就站不住：
 *   ① 被剥的行本身不含信息（纯占位词，没有宾语、没有工具名、没有指代）
 *   ② 被剥的行独立成行（前一行已经收尾、后一行自己起头，没有悬挂）
 *   ③ 剥完不做别的改动（不重排、不拼接、不改标点）
 * 这个脚本把 ①② 在全库上量一遍；③ 由 stripPlaceholderLines() 的实现保证（只 remove 行 + 压空行）。
 *
 * 用法：node scripts/check-semantic-integrity.mjs [sessions目录] [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { isPlaceholderLine, stripPlaceholderLines } from '../src/index.js';

const ZSTD_MAGIC = 0xfd2fb528, SKIPPABLE_LO = 0x184d2a50, SKIPPABLE_HI = 0x184d2a5f;

function frames(buf) {
  const out = []; let p = 0;
  while (p < buf.length) {
    const start = p; if (buf.length - p < 5) break;
    const magic = buf.readUInt32LE(p);
    if (magic >= SKIPPABLE_LO && magic <= SKIPPABLE_HI) {
      const size = buf.readUInt32LE(p + 4); p += 8 + size; out.push([start, p]); continue;
    }
    if (magic !== ZSTD_MAGIC) break;
    const d = buf.readUInt8(p + 4);
    const fcs = d >> 6, single = (d >> 5) & 1, cks = (d >> 2) & 1, dict = d & 3;
    p += 5;
    if (!single) p += 1;
    p += [0, 1, 2, 4][dict];
    p += fcs === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcs];
    for (;;) {
      if (buf.length - p < 3) { p = buf.length; break; }
      const h = buf.readUIntLE(p, 3), last = h & 1, type = (h >> 1) & 3, size = h >> 3;
      p += 3;
      if (type === 0) p += size;
      else if (type === 1) p += 1;
      else if (type === 2) p += size;
      else { p = buf.length; break; }
      if (last) break;
    }
    if (cks) p += 4;
    out.push([start, p]);
  }
  return out;
}

function reasoningBlocks(file) {
  let text = '';
  try {
    const buf = fs.readFileSync(file);
    text = Buffer.concat(frames(buf).map(([s, e]) => zlib.zstdDecompressSync(buf.subarray(s, e)))).toString('utf8');
  } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant/message') continue;
    const content = (event.data?.message ?? event.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text) out.push(block.text);
    }
  }
  return out;
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const rootArg = args.find((a) => !a.startsWith('--'));
const ROOT = rootArg
  ? path.resolve(rootArg)
  : path.join(process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh'), 'sessions');
if (!fs.existsSync(ROOT)) { console.error('找不到会话目录：' + ROOT); process.exit(1); }

/** 续接开头：后一行以它起头，说明它在前一行句子里。 */
const CONTINUER = /^[，、。；：）」』）\])】》，,;:.）]/;

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) files.push(full);
  }
})(ROOT);

const T = {
  blocks: 0, blocksTouched: 0,
  dropped: 0, droppedNotPlaceholder: 0,
  leadHanging: 0,       // 前一行以未闭合标点结尾（句子被切开）
  trailContinuation: 0, // 后一行以续接符起头
  hasReference: 0,      // 含「这个/它/该/上面」这类指代
  sentencesBefore: 0, sentencesAfter: 0,
  atHead: 0, atTail: 0, inMiddle: 0,
  keptChars: 0, totalChars: 0,
  subsequenceOk: 0, subsequenceBad: 0,   // 剥完的行是不是原文行的子序列（只删不改）
  rewrittenChars: 0,                     // 剥完出现原文里没有的行 → 改写，理想为 0
};
const contents = new Map();

/**
 * 剥完的行序列是不是原文行序列的子序列。
 * 子序列＝只能删、不能加、不能改顺序。这是「只做删除」的严格定义。
 * @param {string[]} before - 原文非空行（trim 过）。
 * @param {string[]} after - 剥完非空行（trim 过）。
 * @returns {boolean}
 */
function isSubsequence(before, after) {
  let i = 0;
  for (const line of after) {
    let found = false;
    while (i < before.length) {
      if (before[i] === line) { i += 1; found = true; break; }
      i += 1;
    }
    if (!found) return false;
  }
  return true;
}

for (const file of files) {
  for (const source of reasoningBlocks(file)) {
    T.blocks += 1;
    T.totalChars += source.length;
    const lines = source.split('\n');
    const kept = [];
    let touched = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) { kept.push(lines[i]); continue; }
      if (!isPlaceholderLine(line)) { kept.push(lines[i]); continue; }
      touched = true;
      T.dropped += 1;
      contents.set(line, (contents.get(line) ?? 0) + 1);
      if (/[，、：；]|（|\(/.test(line.replace(/^[（(]|[。）)]$/g, ''))) T.droppedNotPlaceholder += 1;
      if (/这|那|它|该|上面|上面|刚才|前面/.test(line)) T.hasReference += 1;

      // 前一行（跳过空行）
      let prev = null;
      for (let j = i - 1; j >= 0; j--) { if (lines[j].trim()) { prev = lines[j].trim(); break; } }
      // 后一行（跳过空行）
      let next = null;
      for (let j = i + 1; j < lines.length; j++) { if (lines[j].trim()) { next = lines[j].trim(); break; } }
      if (prev && /[，、：；,;:（(「《【]$/.test(prev)) T.leadHanging += 1;
      if (next && CONTINUER.test(next)) T.trailContinuation += 1;
      if (!prev) T.atHead += 1;
      else if (!next) T.atTail += 1;
      else T.inMiddle += 1;
    }
    if (touched) {
      T.blocksTouched += 1;
      const before = lines.map((l) => l.trim()).filter(Boolean);
      const after = stripPlaceholderLines(source).text.split('\n').map((l) => l.trim()).filter(Boolean);
      if (isSubsequence(before, after)) T.subsequenceOk += 1;
      else T.subsequenceBad += 1;
      const beforeSet = new Set(before);
      for (const line of after) if (!beforeSet.has(line)) T.rewrittenChars += line.length;
    }
    const after = kept.join('\n');
    T.keptChars += stripPlaceholderLines(source).text.length;
    T.sentencesBefore += (source.match(/[。！？!?]/g) || []).length;
    T.sentencesAfter += (after.match(/[。！？!?]/g) || []).length;
  }
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(4) + '%' : '0%');
const fmt = (n) => n.toLocaleString('en-US');

if (asJson) {
  console.log(JSON.stringify({ root: ROOT, ...T, topContents: [...contents].sort((a, b) => b[1] - a[1]).slice(0, 30) }, null, 2));
  process.exit(0);
}

console.log('语料       ' + ROOT);
console.log('思考块     ' + fmt(T.blocks) + '（其中 ' + fmt(T.blocksTouched) + ' 块被动过）');
console.log('');
console.log('=== ① 被剥的行本身有没有信息 ===');
console.log('被剥行数   ' + fmt(T.dropped));
console.log('非纯占位   ' + fmt(T.droppedNotPlaceholder) + '（含逗号/冒号/括号的行数，理想为 0）');
console.log('含指代     ' + fmt(T.hasReference) + '（「这个/它/该/刚才」这类，理想为 0）');
console.log('出现最多的占位行：');
for (const [line, count] of [...contents].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log('  ' + JSON.stringify(line).padEnd(16) + ' × ' + fmt(count));
}
console.log('不同写法共 ' + fmt(contents.size) + ' 种');
console.log('');
console.log('=== ② 被剥行是不是独立成行（剥掉会不会把句子切开）===');
console.log('前一行未闭合 ' + fmt(T.leadHanging) + '（' + pct(T.leadHanging, T.dropped) + '）');
console.log('后一行续接   ' + fmt(T.trailContinuation) + '（' + pct(T.trailContinuation, T.dropped) + '）');
console.log('位置分布     开头 ' + fmt(T.atHead) + ' / 中间 ' + fmt(T.inMiddle) + ' / 结尾 ' + fmt(T.atTail));
console.log('（未闭合＝前一行以「，、：；（」收尾。占位行插在这类位置时，删掉它是修通顺，不是切开句子）');
console.log('');
console.log('=== ③ 剥完是不是「只删不改」===');
console.log('子序列验证   ' + fmt(T.subsequenceOk) + ' / ' + fmt(T.blocksTouched) + ' 块通过（' + pct(T.subsequenceOk, T.blocksTouched) + '）');
console.log('凭空出现的行 ' + fmt(T.rewrittenChars) + ' 字符（理想为 0：没有新内容、没有改写、没有重排）');
console.log('');
console.log('=== ③ 剥完只少了句号，句子结构没变 ===');
console.log('句数 剥前 ' + fmt(T.sentencesBefore) + ' → 剥后 ' + fmt(T.sentencesAfter) + '，差 ' + fmt(T.sentencesBefore - T.sentencesAfter) + ' 句');
console.log('（差值应当等于被剥行数：剥掉的一行一个句号，不多不少）');
console.log('');
console.log('字符 剥前 ' + fmt(T.totalChars) + ' → 剥后 ' + fmt(T.keptChars) + '（保留 ' + pct(T.keptChars, T.totalChars) + '）');
