// 体检脚本的冒烟测试：造一个最小会话，确认它能把「有病的块」认出来、并且不碰任何文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'scripts', 'analyze.mjs');

/** 造一个最小会话目录：一条 assistant/message，里面一个病块 + 一个干净块。 */
function makeCorpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-analyze-'));
  const sessionDir = path.join(root, 'ws', 'session-test1234');
  fs.mkdirSync(sessionDir, { recursive: true });
  // 病块要够长：流式检测有 150 字符下限（streamKillMinChars），
  // 40 行「做。」只有 120 字符——统计口径会判"会掐"，实跑不会。这正是两种口径的区别。
  const bad = Array.from({ length: 60 }, (_, i) => (i % 2 ? '好。' : '做。')).join('\n');
  const clean = Array.from({ length: 60 }, (_, i) => `第 ${i} 步先看 main.js 里的第 ${i} 行，确认回调绑到 runtime 上再决定。`).join('\n');
  const event = {
    type: 'assistant/message',
    seq: 1,
    time: Date.now(),
    data: {
      turn: 1, step: 1,
      message: {
        role: 'assistant', id: 'm1',
        content: [{ type: 'reasoning', text: bad }, { type: 'reasoning', text: clean }],
        source: { kind: 'model' },
      },
    },
  };
  const file = path.join(sessionDir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')));
  return root;
}

test('analyze：能扫出病块，并报告实测动作（不是统计估算）', () => {
  const root = makeCorpus();
  try {
    const out = execFileSync(process.execPath, [SCRIPT, root, '--json'], { encoding: 'utf8' });
    const report = JSON.parse(out);
    assert.equal(report.mode, 'replay', '默认必须走实跑，不是统计估算');
    assert.equal(report.total.sessions, 1, '应识别出 1 个会话');
    assert.equal(report.total.blocks, 2, '两个块都该被读进来');
    assert.equal(report.total.badBlocks, 1, '占位 30/60 的那个块应判为空转嫌疑');
    assert.equal(report.total.caughtBlocks, 1, '实跑应该掐得住它');
    assert.equal(report.sessions[0].badBlocks, 1);
    assert.ok(report.sessions[0].badChars > 0);
    assert.equal(report.coverage.unreadable, 0, '没有读不出来的文件');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyze --fast：退回统计口径时必须自报是估算', () => {
  const root = makeCorpus();
  try {
    const out = execFileSync(process.execPath, [SCRIPT, root, '--json', '--fast'], { encoding: 'utf8' });
    const report = JSON.parse(out);
    assert.equal(report.mode, 'estimate', '--fast 必须标成估算，不能让读数被误当成实测');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyze：只读——跑完之后语料一个字都没变', () => {
  const root = makeCorpus();
  try {
    const dir = path.join(root, 'ws', 'session-test1234');
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    const before = fs.readFileSync(file);
    const digest = (buf) => buf.length + ':' + buf.toString('base64').slice(0, 40);
    execFileSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
    const after = fs.readFileSync(file);
    assert.equal(digest(after), digest(before), '体检脚本不许改语料');
    assert.deepEqual(fs.readdirSync(dir), ['session.v4.jsonl.zstd'], '也不许留下新文件');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyze：没有会话目录时报错退出，不崩栈', () => {
  assert.throws(() => {
    execFileSync(process.execPath, [SCRIPT, path.join(os.tmpdir(), 'definitely-not-here-' + Date.now())], { encoding: 'utf8', stdio: 'pipe' });
  }, /Command failed|status 1/);
});
