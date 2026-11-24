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

test('渲染路径：未连接时给出可访问的滑条结构', () => {
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
  const element = render({ sessionId: 'sess-1' });
  assert.equal(typeof element.type, 'function');
  const node = element.type(element.props);
  assert.equal(node.type, 'button');
  assert.equal(node.props.role, 'slider');
  assert.equal(node.props['aria-valuemin'], 0);
  assert.equal(node.props['aria-valuemax'], 4);
  assert.match(node.props['aria-label'], /未连接/);
  assert.equal(node.children.length, 2);
  assert.equal(node.children[0].type, 'svg');
  assert.equal(node.children[1].type, 'span');
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

test('色阶：五档颜色互不相同，两端分别偏冷与偏暖', () => {
  const block = source.match(/var LEVELS = \[([\s\S]*?)\n\];/);
  assert.ok(block, '源码里找不到 LEVELS 定义');
  const colors = [...block[1].matchAll(/color: '(#[0-9a-fA-F]{6})'/g)].map(m => m[1]);
  assert.equal(colors.length, 5, '应有 5 个档位颜色');
  assert.equal(new Set(colors.map(c => c.toLowerCase())).size, 5, '五档颜色不能重复');

  const rgb = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const [r0, g0, b0] = rgb(colors[0]);
  const spread = Math.max(r0, g0, b0) - Math.min(r0, g0, b0);
  assert.ok(spread < 45, `0 档应为低饱和灰，实际 ${colors[0]} 差值 ${spread}`);

  const [, , bCold] = rgb(colors[1]);
  const [rCold] = rgb(colors[1]);
  assert.ok(bCold > rCold, `1 档应偏冷（蓝分量>红分量），实际 ${colors[1]}`);

  const last = colors.length - 1;
  const [rHot, , bHot] = rgb(colors[last]);
  assert.ok(rHot > bHot, `最后一档应偏暖（红分量>蓝分量），实际 ${colors[last]}`);
});

test('提示文案写得比标签详细：每档都有说明句', () => {
  const block = source.match(/var LEVELS = \[([\s\S]*?)\n\];/);
  const segments = block[1].split(/desc: /).slice(1);
  assert.equal(segments.length, 5, '每档都要有一句 desc');
  for (const seg of segments) {
    const text = seg.split('\n  },')[0].replace(/['+\n\s,]/g, '');
    assert.ok(text.length >= 20, `说明太短：${text}`);
  }
});

test('外部改动要能实时反映：有轮询、聚焦刷新，且拖拽时不被覆盖', () => {
  assert.match(source, /var SYNC_MS = \d+;/);
  assert.ok(source.includes('setInterval(sync, SYNC_MS)'), '缺轮询');
  assert.ok(source.includes("addEventListener('focus', sync)"), '缺聚焦刷新');
  assert.ok(source.includes("addEventListener('visibilitychange'"), '缺可见性起停');
  assert.ok(source.includes('if (!alive || dragRef.current) return'), '拖拽时应跳过远端同步');
  const ms = Number(source.match(/var SYNC_MS = (\d+);/)[1]);
  assert.ok(ms >= 300 && ms <= 5000, `轮询间隔 ${ms}ms 不合理`);
});

test('行为：宿主值被外部改掉后，聚焦能立刻把新值同步进来', async () => {
  let hostLevel = 2;
  const setCalls = [];
  const cleanups = [];
  const listeners = {};
  const fakeWindow = {
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener(type, fn) { if (listeners[type] === fn) delete listeners[type]; },
  };
  const fakeFetch = () => Promise.resolve({
    json: () => Promise.resolve({ ok: true, level: hostLevel, max: 4 }),
  });
  // 只关心同步逻辑，提供一个能记录 setLevel 入参的最小 React
  const React = {
    createElement: (type, props, children) => ({ type, props: props ?? {}, children }),
    useState(init) { return [init, (next) => { setCalls.push(typeof next === 'function' ? next(init) : next); }]; },
    useEffect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
    useRef(value) { return { current: value }; },
    useCallback(fn) { return fn; },
  };

  try {
    const { exports } = loadViaModuleLoader(React, { window: fakeWindow, fetch: fakeFetch });
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
    const element = render({ sessionId: 'sess-sync' });
    element.type(element.props);

    await new Promise((r) => setTimeout(r, 0));
    assert.ok(setCalls.includes(2), `挂载时应读到初始值 2，实际 ${JSON.stringify(setCalls)}`);

    hostLevel = 4;
    assert.equal(typeof listeners.focus, 'function', '应注册了 focus 刷新');
    listeners.focus();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(setCalls.includes(4), `外部改成 4 后应同步进来，实际 ${JSON.stringify(setCalls)}`);
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
});

test('全局作用域：上拉阈值、长按、双击三条入口都在', () => {
  assert.match(source, /var ARM_DISTANCE = \d+;/);
  assert.match(source, /var HOLD_MS = \d+;/);
  assert.ok(source.includes('onDoubleClick: onDoubleClick'), '缺双击入口');
  assert.ok(source.includes("scope: 'global'"), '缺全局写入');
  assert.ok(source.includes('setArmed'), '缺锁定状态');
  assert.ok(source.includes('仅本对话（已设）'), '标签里应区分本对话已设');
  assert.ok(source.includes('全局默认（继承）'), '标签里应区分继承值');
});

test('行为：双击轨道提交 scope=global', async () => {
  const posts = [];
  const fakeFetch = (url, init) => {
    if (init && init.method === 'POST') {
      posts.push(JSON.parse(init.body));
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, level: 0, scope: 'global', max: 4 }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, level: 2, scope: 'session', max: 4 }) });
  };
  const { exports } = loadViaModuleLoader(makeReact(), { fetch: fakeFetch });
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
  const element = render({ sessionId: 'sess-x' });
  const node = element.type(element.props);
  node.props.onDoubleClick({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(posts.length, 1, '应发出一次 POST');
  assert.equal(posts[0].scope, 'global');
  assert.equal(posts[0].sessionId, undefined, '全局请求不该带 sessionId');
});

test('锁定档位要泛光：两层高斯模糊 + 两份不同周期的呼吸', () => {
  assert.ok(source.includes('feGaussianBlur'), '缺 SVG 高斯模糊');
  assert.ok(source.includes('rg-glow-soft') && source.includes('rg-glow-wide'), '缺两层光晕定义');
  assert.ok(source.includes('ensureKeyframes'), '缺 keyframes 注入');
  const durations = [...source.matchAll(/'rg-breathe-[ab] ' \+ \(fast \? '([\d.]+)s' : '([\d.]+)s'\)/g)];
  assert.equal(durations.length, 2, '应有两层光晕各挂一个动画');
  assert.notEqual(durations[0][2], durations[1][2], '两层的周期不能相同，否则会像机械闪烁');
  assert.notEqual(durations[0][1], durations[1][1], '快档的节奏也应彼此错开');
});

test('泛光只属于「本对话被手动设过」；继承来的值要安静', () => {
  const m = source.match(/var liveGlow = ([^;]+);/);
  assert.ok(m, '找不到 liveGlow 判定');
  assert.ok(m[1].includes('armed'), '拖拽中要亮');
  assert.ok(m[1].includes("scope === 'session'"), '本对话已设要亮');
  assert.ok(!m[1].includes("scope === 'global'"), '全局继承值不该一直亮');
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

test('光灭走外层透明度过渡，不能靠换 key 播一次性淡出', () => {
  assert.ok(source.includes("key: 'glow'"), '光晕要有稳定的 key');
  assert.ok(!source.includes("'-on' : '-off'"), '不许再用换 key 的方式切换亮灭');
  assert.ok(!source.includes('rg-fadeout'), '不许再用一次性淡出关键帧');
  // 亮要快、灭要慢（具体毫秒可调，不锁死数值）
  const g = source.match(/opacity: liveGlow \? '1' : '0',\s*\n\s*transition: liveGlow \? 'opacity (\d+)ms ease-out' : 'opacity (\d+)ms ease-out'/);
  assert.ok(g, '外层 group 应做 opacity 过渡');
  assert.ok(Number(g[2]) > Number(g[1]), '灭的过渡必须比亮的慢');
  assert.ok(source.includes("transition: 'fill 180ms ease-out'"), '换色也要过渡');
  // 呼吸动画必须在节点里常驻，不能因为显隐被重建（周期值可调，不锁死具体秒数）
  assert.match(source, /animation: 'rg-breathe-a ' \+ \(fast \? '[0-9.]+s' : '[0-9.]+s'\) \+ ' ease-in-out infinite'/);
  // 两层呼吸必须错开相位，否则会周期性一起亮/一起暗，看着像闪
  assert.match(source, /animationDelay: '-[0-9.]+s'/);
});

test('描边只在拖动期间出现，平时不留框', () => {
  assert.ok(source.includes("key: 'drag-outline'"), '缺拖动描边');
  assert.match(source, /if \(expanded\) \{[^}]*drag-outline/s, '描边应由 expanded 控制');
  assert.ok(!source.includes("key: 'scope'"), '已设状态不该常驻描边');
});

test('收起时只画当前那一格，不画邻格', () => {
  assert.match(source, /var firstSeg = expanded \? 0 : shown;/);
  assert.match(source, /var lastSeg = expanded \? MAX_LEVEL : shown;/);
  assert.match(source, /for \(var i = firstSeg; i <= lastSeg; i\+\+\)/);
});

test('渲染：svg 里带 defs（滤镜定义），且锁定格的光只在 armed 或 global 时出现', () => {
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
  const element = render({ sessionId: 'sess-glow' });
  const node = element.type(element.props);
  const svg = node.children[0];
  assert.equal(svg.type, 'svg');
  assert.ok(svg.children.some(c => c && c.type === 'defs'), '缺 defs');
  // 默认（未知 / session 作用域）不该有光晕
  assert.ok(!svg.children.some(c => c && String(c.props?.key ?? '').startsWith('glow-')),
    '非锁定态不该出现光晕');
});

test('轨道平时收起，按下或键盘聚焦才展开', () => {
  assert.ok(source.includes('expandedState'), '缺展开状态');
  assert.ok(source.includes('setExpanded(true)'), '按下/聚焦应展开');
  assert.ok(source.includes('onFocus: function () { setExpanded(true); }'), '聚焦应展开');
  assert.ok(source.includes('setExpanded(false)'), '松手/失焦应收起');
  assert.match(source, /var viewW = expanded \? TRACK_W : SEG_W \+ 8;/, '收起时视口应只覆盖当前一格');
  assert.ok(source.includes('viewBox: viewX'), '尺寸要靠 viewBox 裁剪而不是改结构');
});

test('路由名写对、没有串到别的插件', () => {
  assert.match(source, /\/thinking-guard\/state/);
  assert.doesNotMatch(source, /unlimited-mode/);
});
