// 浏览器半的装载测试：不开浏览器，但按 DSH 的 __ModuleLoader__ 协议真装载一遍。
//
// 教训来自 2026-11-23：第一版 lib/client.js 只有裸的 factory body，没有
// __ModuleLoader__ 外壳、且用全局 React 而不是 require('react')，结果宿主半
// 正常、滑条却完全不出现。所以这里把「外壳形态」本身也当成被测对象。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = 'dsh-thinking-guard';
const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

function makeReact() {
  return {
    createElement(type, props, children) {
      return { type, props: props ?? {}, children };
    },
    useState(initial) { return [initial, () => {}]; },
    useEffect() {},
    useRef(value) { return { current: value }; },
    useCallback(fn) { return fn; },
  };
}

/** 按 ModuleLoader 协议装载，返回 exports 与记录下来的 id。 */
function loadViaModuleLoader(React = makeReact(), options = {}) {
  let recorded = null;
  const win = options.window ?? {};
  win.__ModuleLoader__ = { load(spec) { recorded = spec; } };
  // 与浏览器里同形：外层只提供 window / fetch
  const run = new Function('window', 'fetch', source);
  run(win, options.fetch ?? (() => Promise.reject(new Error('no network in test'))));
  assert.ok(recorded, '没有调用 window.__ModuleLoader__.load');
  const require = (name) => {
    if (name === 'react') return React;
    throw new Error('未预期的 require: ' + name);
  };
  const exports = recorded.factory(require);
  return { id: recorded.id, exports };
}

test('外壳：必须是 __ModuleLoader__ 包装、id 是包名、React 走 require', () => {
  assert.match(source.trimStart(), /^window\.__ModuleLoader__\.load\(\{ id: /);
  assert.ok(source.includes('id: "dsh-thinking-guard"'), 'id 应为包名');
  assert.ok(source.includes('var React = require("react");'), 'React 必须由 require 注入');
  assert.ok(source.trimEnd().endsWith('return module.exports; } });'), '尾部必须 return module.exports');
  assert.doesNotMatch(source, /__ModuleLoader__\.load\([^)]*\)\s*;\s*\n?\s*var module/, '不应重复包裹');
});

test('装载后 id 正确，导出形状正确', () => {
  const { id, exports } = loadViaModuleLoader();
  assert.equal(id, PKG);
  assert.equal(exports.name, 'thinking-guard');
  assert.deepEqual(exports.inject, ['slots']);
  assert.equal(typeof exports.apply, 'function');
});

test('apply 注册进 conversation.input.right，id 与 order 稳定', () => {
  const { exports } = loadViaModuleLoader();
  const registrations = [];
  const injected = [];
  exports.apply({
    inject(services, fn) {
      injected.push(services);
      fn({
        slots: {
          inject(name, cb) { injected.push(['slots.inject', name]); cb(); },
          register(meta, render) { registrations.push({ meta, render }); return { dispose() {} }; },
        },
      });
    },
  });
  assert.deepEqual(injected[0], ['slots']);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].meta.name, 'conversation.input.right');
  assert.equal(registrations[0].meta.id, 'thinking-guard');
  assert.equal(typeof registrations[0].meta.order, 'number');
});

test('没有 sessionId 时也能渲染，不抛错', () => {
  const { exports } = loadViaModuleLoader();
  let render = null;
  exports.apply({
    inject(services, fn) {
      fn({
        slots: {
          inject(name, cb) { cb(); },
          register(meta, r) { render = r; return { dispose() {} }; },
        },
      });
    },
  });
  assert.doesNotThrow(() => { const el = render({}); el.type(el.props); });
});

test('宿主回报 default 不能被当成「已设」', () => {
  assert.ok(source.includes('function scopeOf('), '缺作用域归一函数');
  const fn = source.match(/function scopeOf\(payload\) \{([\s\S]*?)\n\}/);
  assert.ok(fn, '找不到 scopeOf 实现');
  assert.ok(fn[1].includes("'session'"), '要认 session');
  assert.ok(fn[1].includes("'global'"), '要认 global');
  assert.ok(fn[1].includes("return 'default'"), '其余必须是 default，不能默认成 session');
  // 两处回报都要走 scopeOf，不能再有「不是 global 就当 session」的写法
  assert.ok(!source.includes("payload.scope === 'global' ? 'global' : 'session'"), '残留旧的三元判断');
});

test('路由名写对、没有串到别的插件', () => {
  assert.match(source, /\/thinking-guard\/state/);
  assert.doesNotMatch(source, /unlimited-mode/);
});

/* ---------- 以下是字形（GuardGlyph）这一版的用例 ---------- */

function renderGuard(props = { sessionId: 'sess-1' }) {
  const { exports } = loadViaModuleLoader();
  let render = null;
  exports.apply({
    inject(services, fn) {
      fn({
        slots: {
          inject(name, cb) { cb(); },
          register(meta, r) { render = r; return { dispose() {} }; },
        },
      });
    },
  });
  const element = render(props);
  return element.type(element.props);
}

test('渲染：一颗字形按钮，带可读的档位名', () => {
  const node = renderGuard();
  assert.equal(node.type, 'div');
  const button = node.children.find((c) => c && c.type === 'button');
  assert.ok(button, '应有一个 button');
  assert.match(button.props['aria-label'], /整理|Clean|关|Off/);
  const svg = button.children;
  assert.equal(svg.type, 'svg');
  assert.equal(svg.props.viewBox, '0 0 24 24');
  // 默认档是「整理」：绿色实心圆
  assert.equal(svg.children.type, 'circle');
  assert.equal(svg.children.props.fill, '#5d9c83');
});

test('四档颜色互不相同，且都是柔化过的低饱和色', () => {
  const block = source.slice(source.indexOf('var LEVELS = ['), source.indexOf('var MAX_LEVEL'));
  const colors = [...block.matchAll(/color: '(#[0-9a-f]{6})'/g)].map((m) => m[1]);
  assert.equal(new Set(colors).size, 4, '应恰有四个不同的档位色');
  assert.deepEqual(colors, ['#9aa3ad', '#5d9c83', '#c19a4b', '#b76a63']);
});

test('每档都有中英两句说明，长过档位名', () => {
  const zh = [...source.matchAll(/desc: '([^']+)'/g)].map((m) => m[1]);
  const en = [...source.matchAll(/descEn: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(zh.length, 4);
  assert.equal(en.length, 4);
  for (const d of zh) assert.ok(d.length >= 12, '中文说明太短：' + d);
  for (const d of en) assert.ok(d.length >= 20, '英文说明太短：' + d);
});

test('两个通道分开写：颜色管整理、形状管档位', () => {
  assert.match(source, /shape: 'circle'[\s\S]*?shape: 'circle'[\s\S]*?shape: 'triangle'[\s\S]*?shape: 'square'/, '形状顺序应是 圆→圆→三角→方');
  assert.match(source, /点一下：开关颜色|点一下/);
});

test('轮询宿主状态，不靠刷新页面', () => {
  assert.match(source, /var SYNC_MS = \d+/);
  assert.match(source, /setInterval\(pull, SYNC_MS\)/);
  assert.match(source, /readHostLevel\(sessionId\)/);
});

test('上拉设全局的入口还在（阈值 LIFT_PX）', () => {
  assert.match(source, /var LIFT_PX = 10/);
  assert.match(source, /d\.dy <= -LIFT_PX/);
  assert.match(source, /scope: global \? 'global' : 'session'/);
});

test('键盘可操作：方向键换档、空格开关', () => {
  assert.match(source, /e\.key === 'ArrowRight'/);
  assert.match(source, /e\.key === 'ArrowLeft'/);
  assert.match(source, /e\.key === ' ' \|\| e\.key === 'Enter'/);
});

test('悬停说明跟随系统语言', () => {
  assert.match(source, /navigator\.language/);
  assert.match(source, /求个 star/);
  assert.match(source, /a star would mean a lot/);
});

test('会打断的那两档，每次进去都要确认一次', () => {
  assert.match(source, /if \(next >= 2\) \{ setAsk/);
  assert.match(source, /我知道了/);
  assert.doesNotMatch(source, /localStorage/, '不许把「不再提示」记进 localStorage');
});

test('求 star 那一行带可点链接', () => {
  assert.match(source, /https:\/\/github\.com\/Laurent928\/dsh-thinking-guard/);
  assert.match(source, /target: '_blank'/);
});
