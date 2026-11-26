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

test('analyze：只含 </assistant> 复读的块——实跑会掐，但它不在占位嫌疑圈里，两个数都要报', () => {
  // 来自 2026-11-26 外部复核：纯周期循环能被流式检测抓到，但占位行是 0，落在「空转嫌疑」圈外。
  // 旧报表只在嫌疑块里累计打断数，于是这种块显示 0 次。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cycle-'));
  try {
    const sessionDir = path.join(root, 'ws', 'session-cycle1234');
    fs.mkdirSync(sessionDir, { recursive: true });
    const cycle = Array.from({ length: 30 }, () => '</assistant>').join('\n');
    const event = {
      type: 'assistant/message', seq: 1, time: Date.now(),
      data: { turn: 1, step: 1, message: { role: 'assistant', id: 'm1', content: [{ type: 'reasoning', text: cycle }], source: { kind: 'model' } } },
    };
    fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')));
    const report = JSON.parse(execFileSync(process.execPath, [SCRIPT, root, '--json'], { encoding: 'utf8' }));
    assert.equal(report.total.badBlocks, 0, '它的占位行是 0，不该进嫌疑圈');
    assert.ok(report.total.allCutBlocks >= 1, '但实跑确实应该掐它——「全部触发」必须记到');
    assert.ok(report.total.cleanCutBlocks >= 1, '并且要单独报出「嫌疑圈外被掐」的数量');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyze：坏文件与坏记录都要计数，不能静默吞掉', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bad-'));
  try {
    const dir = path.join(root, 'ws', 'session-bad12345');
    fs.mkdirSync(dir, { recursive: true });
    // ① 根本不是 zstd 的文件（一帧都切不出来）
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.from('这不是 zstd 文件', 'utf8'));
    // ② 合法但内容为 null 的记录——旧版会在 ev.type 上抛 TypeError 整次退出
    const dir2 = path.join(root, 'ws', 'session-null1234');
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from('null\n{"type":"其它"}\n', 'utf8')));
    const report = JSON.parse(execFileSync(process.execPath, [SCRIPT, root, '--json'], { encoding: 'utf8' }));
    assert.equal(report.coverage.unreadable, 1, '切不出帧的文件要算读失败');
    assert.ok(report.coverage.unreadableSample, '并且要给一个样本，方便用户自己看是哪个文件');
    assert.equal(report.coverage.skippedRecords, 1, 'null 这种「能 parse 但不是对象」的记录要计入跳过数（其它 type 是正常记录，不该算）');
    assert.equal(report.total.blocks, 0, '两个文件里都没有可用的推理块');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyze：榜单要把「实际触发过打断的会话」排在前面，哪怕它占位字符是 0', () => {
  // 外部复核场景：9 个正常会话 + 1 个纯周期循环会话。
  // 只按嫌疑字符排序的话，循环那个会话 badChars=0，会被挤出榜单，
  // 于是「总表说触发 1 次，榜单前 8 名却全是正常会话」。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rank-'));
  try {
    const write = (sid, text) => {
      const dir = path.join(root, 'ws', `session-${sid}`);
      fs.mkdirSync(dir, { recursive: true });
      const ev = {
        type: 'assistant/message', seq: 1, time: Date.now(),
        data: { turn: 1, step: 1, message: { role: 'assistant', id: 'm1', content: [{ type: 'reasoning', text }], source: { kind: 'model' } } },
      };
      fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(JSON.stringify(ev) + '\n', 'utf8')));
    };
    // 每行内容都不一样：用一段长文本滑窗取片段。
    // 别用「第 N 步看第 N 行」那种模板——它会被相邻对/周期判据抓到，那就不叫正常会话了。
    const src = Array.from({ length: 900 }, (_, n) => String.fromCharCode(0x4e00 + (n * 173) % 8000)).join('');
    const line = (k) => src.slice((k * 37) % 600, (k * 37) % 600 + 34);
    for (let i = 0; i < 9; i++) {
      write(`n${i}`, Array.from({ length: 40 }, (_, k) => line(k + i * 40)).join('\n'));
    }
    write('zzz-cycle', Array.from({ length: 30 }, () => '</assistant>').join('\n'));

    const report = JSON.parse(execFileSync(process.execPath, [SCRIPT, root, '--json', '--top', '8'], { encoding: 'utf8' }));
    assert.ok(report.total.allCutBlocks >= 1, '总表要记到那次触发');
    // 注意：会话 id 在报表里会截断到 8 个字符，zzz-cycle → zzz-cycl
    assert.ok(report.sessions[0].sid.startsWith('zzz'), `榜单第一名必须是有实际触发的那个会话，实际是 ${report.sessions[0].sid}`);
    assert.ok(report.sessions[0].allCut >= 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
