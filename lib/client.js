window.__ModuleLoader__.load({ id: "dsh-thinking-guard", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var React = require("react");
/**
 * dsh-thinking-guard — 浏览器半。
 *
 * 注册进 `conversation.input.right`（list 槽），渲染成一个 5 段小滑条：
 * 左右拖动或点击某一段切换强度，0 是关、4 是最凶。
 *
 * 两种作用域：
 *   - 会话：只改当前会话（默认拖动）
 *   - 全局：设为所有对话的默认，并清掉已有会话特例
 *   进入全局的方式：拖动时把手往上抬过阈值（会亮出一圈琥珀色描边 + 文字变「全局」），
 *   或者双击轨道，或者长按 ↑。
 *
 * 状态按会话 + 全局两层存，读写走宿主半的 `/thinking-guard/state` 回环路由；
 * 每 1.2 秒对一次账，因为值可能被宿主以外的力量改掉（curl、别的窗口、脚本）。
 *
 * 为什么不用原生 `<input type=range>`：它在这个工具条里有默认 padding 和
 * 原生轨道样式，跨平台不一致，而且拖动时会把指针事件吞掉。
 */

/** 宿主半提供的回环路由。 */
var ROUTE_STATE = '/thinking-guard/state';

/**
 * 档位定义；下标就是级别。
 *
 * color 按「冷 → 暖」排色阶，用来表示干预力度的递增：
 * 灰（不管）→ 蓝（只记录）→ 青（动嘴）→ 琥珀（动手掐）→ 红（最凶）。
 * desc 是给鼠标悬停看的完整解释，一行一句，说清「会做什么」和「代价」。
 */
var LEVELS = [
  {
    short: '关', en: 'Off', shape: 'circle', color: '#9aa3ad',
    desc: '不整理历史，也不打断：只看不动',
    descEn: 'Nothing at all: no cleaning, no interruption',
  },
  {
    short: '整理', en: 'Clean', shape: 'circle', color: '#5d9c83',
    desc: '整理历史：把「好。/嗯。」整行剔掉，正文不动，永不打断',
    descEn: 'Cleans history: drops the filler lines, keeps every real sentence, never interrupts',
  },
  {
    short: '慢续', en: 'Slow', shape: 'triangle', color: '#c19a4b',
    desc: '整理 + 真卡住时打断，用慢续（等 7–21 秒，历史干净）',
    descEn: 'Cleans + cuts a real loop, then resumes slowly (7–21 s)',
  },
  {
    short: '快断', en: 'Fast', shape: 'square', color: '#b76a63',
    desc: '整理 + 真卡住时打断，伪造只读调用秒接（历史里多一条假记录）',
    descEn: 'Cleans + cuts a real loop, then resumes instantly (a fake tool call lands in history)',
  },
];

var MAX_LEVEL = LEVELS.length - 1;
var GLYPH_BOX = 32;
var STEP_PX = 26;
var LIFT_PX = 10;
var STAR_URL = 'https://github.com/Laurent928/dsh-thinking-guard';

var SEG_W = 15;
var SEG_GAP = 3;
var SEG_H = 13;
var TRACK_H = 15;
var TRACK_W = LEVELS.length * SEG_W + (LEVELS.length - 1) * SEG_GAP;
/** 未点亮格子的底色。 */
var SEG_OFF = 'rgba(148,163,184,0.28)';

/**
 * 与宿主同步的轮询间隔（毫秒）。
 *
 * 档位可能被宿主以外的力量改掉：命令行 curl、另一个窗口、脚本。前端只在挂载时
 * 读一次的话，界面就会一直显示旧值——用户看到的是「底下改了我这儿没变」。
 * 1.2 秒一次的单请求在这个控件上可以忽略不计，换来的是改完立刻看得见。
 */
var SYNC_MS = 1200;

/** 拖动时把手向上抬多少像素算「要改全局」。 */
var ARM_DISTANCE = 10;

/** 长按 ↑ 多久算「要改全局」。 */
var HOLD_MS = 520;

/** 注入的 keyframes 的 id，避免重复注入。 */
var STYLE_ID = 'thinking-guard-anim';

/**
 * 注一次 keyframes。
 *
 * 两层光晕用两份不同周期的呼吸，相位错开——同一条元素挂两个速度不同的动画，
 * 看起来才不会像机械闪烁（CSS-Tricks 的 multiple animations 那套）。opacity
 * 是 GPU 友好的属性，动画本身只在合成层动，不触发重排。
 */
function ensureKeyframes() {
  if (typeof document === 'undefined' || !document.head) return;
  if (document.getElementById(STYLE_ID)) return;
  var style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    '@keyframes rg-breathe-a{0%,100%{opacity:.30}50%{opacity:.82}}',
    '@keyframes rg-breathe-b{0%,100%{opacity:.60}50%{opacity:.22}}',
  ].join('');
  document.head.appendChild(style);
}

ensureKeyframes();

/**
 * 读某会话的档位。
 * @param sessionId - 会话身份。
 * @returns 宿主返回的 payload，或 undefined。
 */
function readHostLevel(sessionId) {
  var url = ROUTE_STATE + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : '');
  return fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
    .then(function (response) { return response.json(); })
    .then(function (payload) { return payload && payload.ok ? payload : undefined; });
}

/**
 * 写档位。
 * @param body - { sessionId, level } 或 { level, scope: 'global' }。
 * @returns 请求 promise。
 */
function writeHostLevel(body) {
  return fetch(ROUTE_STATE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  }).then(function (response) { return response.json(); });
}

/**
 * 把宿主回报的作用域归一成三种。
 * 'default'（配置兜底）和 'global'（继承全局）都算「不是自己设的」——
 * 早先这里只认 'global'，其余一律当成 'session'，于是拖回默认值时
 * 反而被标成「已设」而亮起来。
 * @param payload - 宿主返回的 state payload。
 * @returns 'session' | 'global' | 'default'
 */
function scopeOf(payload) {
  if (!payload) return 'default';
  if (payload.scope === 'session') return 'session';
  if (payload.scope === 'global') return 'global';
  return 'default';
}

/**
 * 把指针横坐标换算成档位。
 * @param clientX - 指针横坐标。
 * @param left - 轨道左边界。
 * @returns 0..MAX_LEVEL。
 */
function levelAt(clientX, left) {
  var offset = clientX - left;
  if (offset <= 0) return 0;
  var slot = Math.floor(offset / (SEG_W + SEG_GAP));
  return Math.max(0, Math.min(MAX_LEVEL, slot));
}

/**
 * 5 段滑条本体。
 * @param props - 槽位标准入参（含 sessionId）与绑定服务。
 * @returns React 元素。
 */
/**
 * 一颗字形：颜色＝整理开关，形状＝打断档位。
 * 点一下开/关整理；左右拖换档位；按住往上抬 10px 松手设为全局（出紫色环 = 已生效）。
 * 悬停要停一会儿才出说明（第一次 600ms，之后几秒内是「热的」，直接出）。
 * @param props - 宿主注入的会话信息。
 * @returns React 元素。
 */
var tipWarmUntil = 0;   // 模块级：上次出过说明的时间，用来实现「热的秒出」

function GuardGlyph(props) {
  var sessionId = props && (props.sessionId || (props.session && props.session.id));
  var zh = (function () {
    var n = '';
    try { n = (navigator.language || '').toLowerCase(); } catch (e) { n = 'zh'; }
    return n.indexOf('zh') === 0;
  })();

  var [level, setLevel] = React.useState(1);
  var [scope, setScope] = React.useState('global');
  var [hover, setHover] = React.useState(false);
  var [ask, setAsk] = React.useState(null);
  var [pop, setPop] = React.useState(0);        // 每次变档 +1，用来触发一次缩放动画
  var [pulse, setPulse] = React.useState(0);    // 设为全局时闪一下紫环
  var drag = React.useRef({ on: false, x: 0, y: 0, base: 1, dx: 0, dy: 0 });
  var hoverTimer = React.useRef(null);

  var clamp = function (n) { return Math.max(0, Math.min(MAX_LEVEL, n)); };

  // 注入一次动画样式
  React.useEffect(function () {
    var id = 'thinking-guard-glyph-style';
    if (typeof document === 'undefined' || document.getElementById(id)) return;
    var style = document.createElement('style');
    style.id = id;
    style.textContent =
      '@keyframes tg-pop{0%{transform:scale(.72);opacity:.35}60%{transform:scale(1.12);opacity:1}100%{transform:scale(1)}}'
      + '@keyframes tg-breathe{0%,100%{opacity:.18;transform:scale(1)}50%{opacity:.42;transform:scale(1.18)}}'
      + '@keyframes tg-ring{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(1.9)}}';
    document.head.appendChild(style);
  }, []);

  var commit = React.useCallback(function (next, global) {
    var body = { level: next, scope: global ? 'global' : 'session' };
    if (!global && sessionId) body.sessionId = sessionId;
    writeHostLevel(body).then(function (payload) {
      if (payload && payload.ok) {
        setLevel(clamp(typeof payload.level === 'number' ? payload.level : next));
        setScope(payload.scope || 'session');
        if (global && payload.ok) setPulse(function (p) { return p + 1; });
      }
    }).catch(function () { /* 下一轮询会纠正 */ });
  }, [sessionId]);

  // 进到会打断的两档，每次都问一次（不提供「以后不再提示」）
  var request = function (next, global) {
    if (next >= 2) { setAsk({ next: next, global: global }); return; }
    commit(next, global);
  };

  React.useEffect(function () {
    var alive = true;
    var pull = function () {
      readHostLevel(sessionId).then(function (payload) {
        if (!alive || !payload) return;
        if (typeof payload.level === 'number') setLevel(clamp(payload.level));
        if (payload.scope) setScope(payload.scope);
      }).catch(function () {});
    };
    pull();
    var timer = setInterval(pull, SYNC_MS);
    return function () { alive = false; clearInterval(timer); };
  }, [sessionId]);

  React.useEffect(function () {
    if (!hover) return;
    var now = Date.now();
    var warm = now < tipWarmUntil;
    if (warm) return;                                  // 热的，已经直接显示
    var t = setTimeout(function () { tipWarmUntil = Date.now() + 3000; setHover(true); }, 600);
    hoverTimer.current = t;
    return function () { clearTimeout(t); };
  }, [hover]);

  var showTip = function () {
    var now = Date.now();
    if (now < tipWarmUntil) { setHover(true); return; }
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(function () {
      tipWarmUntil = Date.now() + 3000;
      setHover(true);
    }, 600);
  };
  var hideTip = function () {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHover(false);
  };

  var onDown = function (e) {
    drag.current = { on: true, x: e.clientX, y: e.clientY, base: level, dx: 0, dy: 0 };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  };
  var onMove = function (e) {
    var d = drag.current;
    if (!d.on) return;
    d.dx = e.clientX - d.x;
    d.dy = e.clientY - d.y;
    if (Math.abs(d.dx) >= 12 && Math.abs(d.dy) < LIFT_PX) {
      var vis = clamp(d.base + Math.round(d.dx / STEP_PX));
      if (vis !== level) { setLevel(vis); setPop(function (p) { return p + 1; }); }
    }
  };
  var onUp = function (e) {
    var d = drag.current;
    if (!d.on) return;
    d.on = false;
    var dy = (typeof e.clientY === 'number' ? e.clientY : d.y + d.dy) - d.y;   // 快拖时 pointermove 可能没来，这里以抬起点为准
    var dx = (typeof e.clientX === 'number' ? e.clientX : d.x + d.dx) - d.x;
    if (dy <= -LIFT_PX && Math.abs(dx) < LIFT_PX) { request(level, true); return; }   // 上划 → 全局
    if (Math.abs(dx) < 4) { request(level === 0 ? 1 : 0, scope === 'global'); return; }
    var next = clamp(d.base + Math.round(dx / STEP_PX));
    if (next !== level) request(next, scope === 'global');
  };

  var lv = LEVELS[clamp(level)];
  var tip = zh ? lv.desc : lv.descEn;
  var isGlobal = scope === 'global';
  var ringColor = isGlobal ? '#8b5cf6' : 'transparent';

  var shapeEl = lv.shape === 'circle'
    ? React.createElement('circle', { cx: 12, cy: 12, r: 8, fill: lv.color })
    : lv.shape === 'triangle'
      ? React.createElement('path', { d: 'M12 3.6 L20.8 19.2 L3.2 19.2 Z', fill: lv.color })
      : React.createElement('rect', { x: 4.8, y: 4.8, width: 14.4, height: 14.4, rx: 1.6, fill: lv.color });

  var button = React.createElement('button', {
    type: 'button',
    'aria-label': (zh ? lv.short : lv.en) + ' · ' + tip,
    onPointerDown: onDown,
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onUp,
    onPointerEnter: showTip,
    onPointerLeave: hideTip,
    onFocus: showTip,
    onBlur: hideTip,
    onKeyDown: function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); request(clamp(level + 1), isGlobal); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); request(clamp(level - 1), isGlobal); }
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); request(level === 0 ? 1 : 0, isGlobal); }
    },
    style: {
      width: GLYPH_BOX + 'px', height: GLYPH_BOX + 'px', display: 'grid', placeItems: 'center',
      border: '0', borderRadius: '9px', padding: 0, cursor: 'pointer', touchAction: 'none',
      background: 'transparent', position: 'relative',
    },
  }, [
    // 呼吸光：当前档色，慢速呼吸，暗示「它在工作」
    React.createElement('span', {
      key: 'glow',
      style: {
        position: 'absolute', width: '26px', height: '26px', borderRadius: '50%',
        background: lv.color, opacity: 0.18, filter: 'blur(6px)', pointerEvents: 'none',
        animation: 'tg-breathe 3.2s ease-in-out infinite',
      },
    }),
    // 紫环：设为全局后常驻，加一次扩散动画
    React.createElement('span', {
      key: 'ring',
      style: {
        position: 'absolute', inset: '1px', borderRadius: '9px',
        border: '1.5px solid ' + ringColor, pointerEvents: 'none',
        transition: 'border-color 200ms ease',
      },
    }),
    pulse > 0 ? React.createElement('span', {
      key: 'pulse' + pulse,
      style: {
        position: 'absolute', inset: '1px', borderRadius: '9px', border: '1.5px solid #8b5cf6',
        pointerEvents: 'none', animation: 'tg-ring 520ms ease-out forwards',
      },
    }) : null,
    // 字形本体：换档时缩一下再弹回
    React.createElement('svg', {
      key: 'glyph' + pop,
      width: '24', height: '24', viewBox: '0 0 24 24', 'aria-hidden': 'true',
      style: { position: 'relative', animation: 'tg-pop 260ms cubic-bezier(.2,.9,.3,1.3)' },
    }, shapeEl),
  ]);

  var tipBox = hover ? React.createElement('div', {
    style: {
      position: 'absolute', bottom: '38px', right: '-2px', width: '250px',
      background: '#0f172a', color: '#fff', fontSize: '11.5px', lineHeight: 1.5,
      padding: '7px 10px', borderRadius: '8px', zIndex: 20, textAlign: 'left',
      boxShadow: '0 6px 20px rgba(15,23,42,0.18)',
    },
  }, [
    React.createElement('div', { key: 'd' }, tip),
    isGlobal ? React.createElement('div', { key: 'g', style: { marginTop: '4px', color: '#c4b5fd' } },
      zh ? '已应用到所有会话（往上划可以再切回本会话）' : 'Applied to all sessions') : null,
    React.createElement('a', {
      key: 's', href: STAR_URL, target: '_blank', rel: 'noreferrer',
      style: { display: 'block', marginTop: '6px', color: '#5eead4', textDecoration: 'none' },
    }, zh ? '★ 要是它帮到你了，求个 star 啦 🙏' : '★ If it helped at all, a star would mean a lot 🌱'),
  ]) : null;

  var dialog = ask ? React.createElement('div', {
    style: {
      position: 'absolute', bottom: '44px', right: 0, width: '270px',
      background: '#12131a', border: '1px solid #2a2b36', borderRadius: '10px',
      padding: '12px', zIndex: 30, color: '#e5e7eb', fontSize: '12px', lineHeight: 1.6,
    },
  }, [
    React.createElement('div', { key: 't', style: { fontWeight: 600, marginBottom: '6px' } },
      zh ? '这一档会真的打断生成' : 'This tier really interrupts generation'),
    React.createElement('div', { key: 'b', style: { color: '#9ca3af' } },
      zh ? '判断到真死循环时这一轮会被截断；快断还会在历史里留一条伪造的工具调用。'
         : 'When it detects a real loop the turn is cut; the fast tier also leaves a fake tool call in history.'),
    React.createElement('div', { key: 'a', style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '10px' } }, [
      React.createElement('button', {
        key: 'c', type: 'button', onClick: function () { setAsk(null); },
        style: { padding: '4px 10px', borderRadius: '7px', border: '0', background: '#1f2130', color: '#cbd5e1', cursor: 'pointer' },
      }, zh ? '算了' : 'Cancel'),
      React.createElement('button', {
        key: 'k', type: 'button',
        onClick: function () { var a = ask; setAsk(null); commit(a.next, a.global); },
        style: { padding: '4px 10px', borderRadius: '7px', border: '0', background: '#a78bfa', color: '#1e1b31', fontWeight: 600, cursor: 'pointer' },
      }, zh ? '我知道了' : 'Got it'),
    ]),
  ]) : null;

  return React.createElement('div', { style: { position: 'relative', display: 'inline-flex' } }, [button, tipBox, dialog]);
}

exports.name = 'thinking-guard';
exports.inject = ['slots'];
exports.apply = function apply(ctx) {
  ctx.inject(['slots'], function (scope) {
    scope.slots.inject('conversation.input.right', function () {
      return scope.slots.register({
        name: 'conversation.input.right',
        id: 'thinking-guard',
        order: 61,
      }, function (props) {
        return React.createElement(GuardGlyph, props);
      });
    });
  });
};

return module.exports; } });
