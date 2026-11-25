#!/usr/bin/env node
/**
 * 把「原文 / 剥离后 / 整块替换」三份并排导出，用来逐条核对语义有没有变。
 *
 * 挑选条件：块级判据判为退化 + 剥掉 20%–70% + 字符数 300–3000——
 * 既要真有东西剥，也要有真东西留下来，光剥空或只剥两行的样本说明不了问题。
 *
 * 注意：导出的是真实会话原文。**要贴到公开的地方之前先过一遍，把第三方名字、账号、
 * 内部 ID 换掉**——这份文件默认只给你自己看。
 *
 * 用法：node scripts/dump-pairs.mjs [--n 8] [--out 文件名.md] [sessions目录]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { measure, isDegraded, isPlaceholderLine, stripPlaceholderLines } from '../src/index.js';

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
const wantN = args.includes('--n') ? Number(args[args.indexOf('--n') + 1]) : 8;
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const rootArg = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a) && !a.endsWith('.md'));
const ROOT = rootArg
  ? path.resolve(rootArg)
  : path.join(process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh'), 'sessions');

const CFG = { maxRun: 25, looseRun: 15, looseUniq: 0.4, minLines: 10 };
const SQUASH = '（上一段思考陷入重复 N 行，已省略）';

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) files.push(full);
  }
})(ROOT);

const picked = [];
for (const file of files) {
  const session = path.basename(path.dirname(file)).replace(/^session-/, '').slice(0, 8);
  for (const source of reasoningBlocks(file)) {
    const chars = source.length;
    if (chars < 300 || chars > 3000) continue;
    const lines = source.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!isDegraded(measure(lines), CFG)) continue;
    const stripped = stripPlaceholderLines(source);
    const ratio = (chars - stripped.text.length) / chars;
    if (ratio < 0.2 || ratio > 0.7) continue;
    const placeholders = lines.filter((l) => isPlaceholderLine(l)).length;
    picked.push({ session, source, stripped: stripped.text, ratio, chars, lines: lines.length, placeholders });
  }
}

// 挑法：先按剥掉比例排序，再等距取 n 个，避免全是同一种形态
picked.sort((a, b) => a.ratio - b.ratio);
const step = Math.max(1, Math.floor(picked.length / wantN));
const samples = [];
for (let i = 0; i < picked.length && samples.length < wantN; i += step) samples.push(picked[i]);

const md = [];
md.push('# 剥离前后对照样本');
md.push('');
md.push('自动从本机 DSH 会话导出。挑选条件：块级判据判为退化、剥掉 20%–70%、原块 300–3000 字符。');
md.push('');
md.push('每组三份：**原文**、**逐行剥离**（本插件的做法）、**整块替换**（别人的做法）。');
md.push('判断标准只有一条：读完之后，能不能说出这段思考最后想做什么。');
md.push('');
samples.forEach((s, i) => {
  md.push('---');
  md.push('');
  md.push('## 样本 ' + (i + 1) + '　`' + s.session + '`');
  md.push('');
  md.push('| 项 | 值 |');
  md.push('|---|---|');
  md.push('| 原块 | ' + s.lines + ' 行 / ' + s.chars + ' 字符 |');
  md.push('| 占位行 | ' + s.placeholders + ' 行 |');
  md.push('| 逐行剥离后 | ' + s.stripped.length + ' 字符（剥掉 ' + (s.ratio * 100).toFixed(1) + '%） |');
  md.push('| 整块替换后 | ' + SQUASH.length + ' 字符（剥掉 ' + ((1 - SQUASH.length / s.chars) * 100).toFixed(1) + '%） |');
  md.push('');
  md.push('### 原文');
  md.push('');
  md.push('```');
  md.push(s.source);
  md.push('```');
  md.push('');
  md.push('### 逐行剥离后');
  md.push('');
  md.push('```');
  md.push(s.stripped);
  md.push('```');
  md.push('');
  md.push('### 整块替换后');
  md.push('');
  md.push('```');
  md.push(SQUASH);
  md.push('```');
  md.push('');
  md.push('### 判断');
  md.push('');
  md.push('<!-- 待填：剥离前后的「最终想做什么」是否一致？整块替换还看得出吗？ -->');
  md.push('');
});

const text = md.join('\n');
const outFile = outArg ? path.resolve(outArg) : null;
if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, text, 'utf8');
  console.log('已写出 ' + outFile + '（' + samples.length + ' 组，' + text.length + ' 字符）');
} else {
  console.log(text);
}
