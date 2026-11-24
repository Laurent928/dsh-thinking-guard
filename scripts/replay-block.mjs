#!/usr/bin/env node
/**
 * 拿一个思考块，跑一遍插件的判据，看它会不会被掐、会被剥掉多少。
 *
 * 用途：改判据之前先在这里试，不用装插件、不用真跑模型。
 *
 *   node scripts/replay-block.mjs block.txt
 *   node scripts/replay-block.mjs block.txt --json
 *
 * block.txt 就是一整段 reasoning 原文（可以从会话 jsonl 里抠出来，直接粘）。
 */
import fs from 'node:fs';
import {
  isPlaceholderLine, stripPlaceholderLines, trailingShortRun, measure, isDegraded,
} from '../src/index.js';

/** 和插件 DEFAULTS 里那几项保持一致的默认值。 */
const DEFAULTS = {
  streamKillRun: 15,
  streamKillMinChars: 150,
  streamKillRepeatMin: 8,
  streamKillRepeatRatioMin: 0.15,
  streamKillRepeatMinLines: 20,
  maxRun: 25,
  looseRun: 15,
  looseUniq: 0.4,
  minLines: 10,
  scrubStripMinDropped: 5,
};

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/replay-block.mjs <thinking.txt> [--json]');
  process.exit(1);
}
const asJson = process.argv.includes('--json');
const text = fs.readFileSync(file, 'utf8');

/** 按插件的流式逻辑逐段喂进去，返回它会在第几行掐。 */
function replayStreaming(src, cfg) {
  let tail = '';
  let chars = 0;
  let pending = '';
  const recentLines = [];
  let placeLines = 0;
  let pairMax = 0;
  let pairKey = '';
  const pairCounts = new Map();

  for (const piece of src.split(/(?<=\n)/)) {
    chars += piece.length;
    tail = (tail + piece).slice(-400);
    pending += piece;
    let nl = pending.indexOf('\n');
    while (nl >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line) {
        if (recentLines.length > 0) {
          const prev = recentLines[recentLines.length - 1];
          const pk = `${prev}|${line}`;
          const seen = (pairCounts.get(pk) ?? 0) + 1;
          pairCounts.set(pk, seen);
          if (seen > pairMax) {
            pairMax = seen;
            pairKey = `${prev} ⏎ ${line}`;
          }
        }
        recentLines.push(line);
        if (isPlaceholderLine(line)) placeLines += 1;
      }
      nl = pending.indexOf('\n');
    }

    const run = trailingShortRun(tail);
    const placeRatio = recentLines.length > 0 ? placeLines / recentLines.length : 0;
    const repeatHit = recentLines.length >= cfg.streamKillRepeatMinLines
      && pairMax >= cfg.streamKillRepeatMin
      && placeRatio >= cfg.streamKillRepeatRatioMin
      && chars >= cfg.streamKillMinChars;
    const shortHit = run >= cfg.streamKillRun && chars >= cfg.streamKillMinChars;
    if (repeatHit || shortHit) {
      return {
        hit: true,
        why: repeatHit
          ? `重复对 ${pairMax} 次「${pairKey}」，占位 ${Math.round(placeRatio * 100)}%`
          : `尾部连续短行 ${run} 行`,
        atLine: recentLines.length,
        chars,
      };
    }
  }
  return { hit: false, lines: recentLines.length, maxPair: pairMax, chars };
}

const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
const place = lines.filter(isPlaceholderLine).length;
const stripped = stripPlaceholderLines(text);
const metrics = measure(lines);
const blockDegraded = isDegraded(metrics, DEFAULTS);
const stream = replayStreaming(text, DEFAULTS);

const report = {
  block: {
    lines: lines.length,
    chars: text.length,
    placeholderLines: place,
    placeholderLineRatio: +(place / Math.max(1, lines.length)).toFixed(3),
    longestTrailingShortRun: trailingShortRun(text),
  },
  strip: {
    droppedLines: stripped.dropped,
    keptChars: stripped.text.length,
    keptRatio: +(stripped.text.length / Math.max(1, text.length)).toFixed(3),
  },
  blockCriterion: {
    degraded: blockDegraded,
    markRun: metrics.markRun,
    ratio: +metrics.ratio.toFixed(3),
    uniqueLineRatio: +metrics.uniq.toFixed(3),
  },
  streamingCriterion: stream,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  console.log(`块：${report.block.lines} 行 / ${report.block.chars} 字`);
  console.log(`占位行：${report.block.placeholderLines} 行（${pct(report.block.placeholderLineRatio)}）`);
  console.log(`剥离：剔掉 ${report.strip.droppedLines} 行 → 保留 ${pct(report.strip.keptRatio)} 的字符`);
  console.log(`块级判据：${blockDegraded ? '判为退化' : '正常'}（markRun=${metrics.markRun}, 唯一行率=${metrics.uniq.toFixed(2)}）`);
  console.log(stream.hit
    ? `流内判据：会掐 —— 第 ${stream.atLine} 行、${stream.chars} 字，理由：${stream.why}`
    : `流内判据：不掐（最大相邻对 ${stream.maxPair ?? 0} 次）`);
}
