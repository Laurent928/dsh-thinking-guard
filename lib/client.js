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
var STEP_PX = 18;
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
 * 短按＝开关颜色；按住左右拖＝换档位（三档在字形上方浮出，按鼠标真实位置命中）；
 * 往上抬 10px＝设为全局。所有提示都在字形上方，操作结束才出。
 * @param props - 宿主注入的会话信息。
 * @returns React 元素。
 */
var tipWarmUntil = 0;

function GuardGlyph(props) {
  var sessionId = props && (props.sessionId || (props.session && props.session.id));
  var zh = (function () {
    var n = '';
    try { n = (navigator.language || '').toLowerCase(); } catch (e) { n = 'zh'; }
    return n.indexOf('zh') === 0;
  })();

  var [level, setLevel] = React.useState(1);
  var [tier, setTier] = React.useState(1);   // 形状记在这里；颜色关掉时它还在
  var [armed, setArmed] = React.useState(false);   // 正在上划、准备设全局
  var [lift, setLift] = React.useState(0);         // 上划时字形被抬起的像素
  var [settling, setSettling] = React.useState(false);   // 松手回弹中（交给 CSS 弹簧）
  var liftNow = React.useRef(0);      // 当前位移（逐帧逼近目标）
  var liftTarget = React.useRef(0);   // 目标位移
  var rafId = React.useRef(null);
  var [scope, setScope] = React.useState('global');
  var [hover, setHover] = React.useState(false);
  var [notice, setNotice] = React.useState(null);
  var [open, setOpen] = React.useState(false);
  var [pop, setPop] = React.useState(0);
  var [pulse, setPulse] = React.useState(0);
  var drag = React.useRef({ on: false, x: 0, y: 0, base: 1, axis: null });   // axis: 'v' 上划 / 'h' 换档
  var hoverTimer = React.useRef(null);
  var hideTimer = React.useRef(null);
  var noticeTimer = React.useRef(null);
  var levelRef = React.useRef(1);
  var itemRefs = React.useRef([]);
  var stripRef = React.useRef(null);
  var ITEM_W = 21;
  var ITEM_GAP = 5;

  React.useEffect(function () { levelRef.current = level; }, [level]);

  var clamp = function (n) { return Math.max(0, Math.min(MAX_LEVEL, n)); };

  React.useEffect(function () {
    var id = 'thinking-guard-glyph-style';
    if (typeof document === 'undefined' || document.getElementById(id)) return;
    var style = document.createElement('style');
    style.id = id;
    style.textContent =
      '@keyframes tg-pop{0%{transform:scale(.72);opacity:.35}60%{transform:scale(1.12);opacity:1}100%{transform:scale(1)}}'
      + '@keyframes tg-ring{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(1.8)}}'
      + '@keyframes tg-item{0%{opacity:0;transform:translateY(6px) scale(.7)}100%{opacity:1;transform:translateY(0) scale(1)}}'
      + '@keyframes tg-panel{0%{opacity:0;transform:translateY(4px) scale(.94)}100%{opacity:1;transform:translateY(0) scale(1)}}';
    document.head.appendChild(style);
  }, []);

  var commit = React.useCallback(function (next, global, shape) {
    var tier = global ? 1 : Math.max(1, Math.min(3, shape || (next >= 1 ? next : 1)));
    var body = { level: next, tier: tier, scope: global ? 'global' : 'session' };
    if (!global && sessionId) body.sessionId = sessionId;
    writeHostLevel(body).then(function (payload) {
      if (payload && payload.ok) {
        setLevel(clamp(typeof payload.level === 'number' ? payload.level : next));
        setScope(payload.scope || 'session');
        if (global) setPulse(function (p) { return p + 1; });
      }
    }).catch(function () {});
  }, [sessionId]);

  var warnIfCutting = function (next) {
    if (next < 2) return;
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(zh ? '这一档会真的打断生成' : 'this tier really interrupts generation');
    noticeTimer.current = setTimeout(function () { setNotice(null); }, 3000);
  };

  // 警告：点页面任意别处就消失（除了点字形自己）
  React.useEffect(function () {
    if (!notice) return;
    var away = function () { setNotice(null); };
    var t = setTimeout(function () { window.addEventListener('pointerdown', away, true); }, 50);
    return function () { clearTimeout(t); window.removeEventListener('pointerdown', away, true); };
  }, [notice]);

  React.useEffect(function () {
    var alive = true;
    var pull = function () {
      readHostLevel(sessionId).then(function (payload) {
        if (!alive || !payload) return;
        if (typeof payload.level === 'number' && !drag.current.on) {
          setLevel(clamp(payload.level));
          if (payload.level >= 1) setTier(clamp(payload.level));
        }
        if (payload.scope) setScope(payload.scope);
      }).catch(function () {});
    };
    pull();
    var timer = setInterval(pull, SYNC_MS);
    return function () { alive = false; clearInterval(timer); };
  }, [sessionId]);

  // 悬停：整块容器管进出，弹窗里也能停住（否则一移进去就消失，链接点不到）
  var showTip = function () {
    if (drag.current.on) return;
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    if (hover) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    // 每次都等 600ms，不搞「热窗口」（他反馈那样看着像没延迟）
    hoverTimer.current = setTimeout(function () { setHover(true); }, 600);
  };
  var hideTip = function () {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(function () { setHover(false); }, 260);   // 留出移进弹窗的时间
  };

  // 位置用指数平滑逼近：先快后慢、帧率无关（等价于 1-exp(-dt/tau)）
  var tick = function () {
    var cur = liftNow.current;
    var target = liftTarget.current;
    var next = cur + (target - cur) * 0.26;
    if (Math.abs(next - target) < 0.35) next = target;
    liftNow.current = next;
    setLift(next);
    rafId.current = next === target ? null : requestAnimationFrame(tick);
  };
  var pushLift = function (target) {
    liftTarget.current = target;
    if (typeof requestAnimationFrame !== 'function') { liftNow.current = target; setLift(target); return; }
    if (rafId.current === null) rafId.current = requestAnimationFrame(tick);
  };
  // 越过阈值后做橡皮筋：越拉越费劲，给「拉到头了」的手感
  var rubber = function (dy) {
    if (dy >= -LIFT_PX) return Math.max(-LIFT_PX, dy);
    var extra = Math.abs(dy) - LIFT_PX;
    return -LIFT_PX - Math.min(8, extra * 0.35);
  };

  var levelFromDx = function (base, dx) {
    var from = base < 1 ? 1 : base;
    return Math.max(1, Math.min(MAX_LEVEL, from + Math.round(dx / STEP_PX)));
  };

  var levelFromPoint = function (x, y) {
    // 用容器 + 固定格宽算，不用每颗放大后的矩形——否则选中一颗会让邻居位置变，越选越偏
    var box = stripRef.current;
    if (!box || typeof box.getBoundingClientRect !== 'function') return null;
    var r = box.getBoundingClientRect();
    if (!r || r.width === 0) return null;
    if (y < r.top - 14 || y > r.bottom + 14) return null;     // 竖向离太远就不算选中
    var cell = ITEM_W + ITEM_GAP;
    var idx = Math.floor((x - r.left) / cell);
    return Math.max(1, Math.min(3, idx + 1));
  };

  var onDown = function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    drag.current = { on: true, x: e.clientX, y: e.clientY, base: level, axis: null, maxUp: 0, maxSide: 0 };
    setSettling(false);
    liftNow.current = 0;
    liftTarget.current = 0;
    setLift(0);
    setHover(false);
    setNotice(null);
    e.preventDefault();

    var move = function (ev) {
      var d = drag.current;
      if (!d.on) return;
      var ddx = ev.clientX - d.x;
      var ddy = ev.clientY - d.y;
      // 记整段位移的极值：抬手时按它判定，不再靠中途锁方向
      if (-ddy > d.maxUp) d.maxUp = -ddy;
      if (Math.abs(ddx) > d.maxSide) d.maxSide = Math.abs(ddx);

      // 竖向往上：图标一律跟着抬（不判方向、不锁模式）
      var over = ddy <= -LIFT_PX;
      if (over !== armed) setArmed(over);
      pushLift(ddy < 0 ? rubber(ddy) : 0);
      if (Math.abs(ddx) >= 8) setOpen(true);      // 真的在拖了才排开，轻点不排
      if (Math.abs(ddx) < 8) return;               // 还不到一档，不动档位
      var hit = levelFromPoint(ev.clientX, ev.clientY);
      var next = hit !== null ? hit : levelFromDx(d.base, ddx);
      if (levelRef.current === 0) { setTier(next); return; }   // 颜色关着：只换形状
      if (next !== levelRef.current) {
        levelRef.current = next;
        setLevel(next);
        setPop(function (p) { return p + 1; });
      }
    };
    var up = function (ev) {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      var d = drag.current;
      if (!d.on) return;
      d.on = false;
      setOpen(false);
      setArmed(false);
      setSettling(true);
      liftTarget.current = 0;
      liftNow.current = 0;
      setLift(0);
      var dx = (typeof ev.clientX === 'number' ? ev.clientX : d.x) - d.x;
      var dy = (typeof ev.clientY === 'number' ? ev.clientY : d.y) - d.y;
      // 只认三件事，按顺序判：
      // ① 往上抬够 10px、且横向始终没超过 12px → 设全局（其他什么都不做）
      // ② 横向超过 8px → 换档
      // ③ 都没超 → 轻点，只换颜色
      // 上划看「松手那一刻」的高度：拖上去了又拖回来＝取消，不设全局
      if (dy <= -LIFT_PX) { commit(levelRef.current, true, 1); return; }
      if (d.maxSide < 8) { commit(levelRef.current === 0 ? 1 : 0, false, levelRef.current === 0 ? 1 : levelRef.current); return; }
      var hit = levelFromPoint(ev.clientX || d.x, ev.clientY || d.y);
      var next = hit !== null ? hit : levelFromDx(d.base, dx);
      if (levelRef.current === 0) { setTier(next); commit(0, false, next); return; }   // 颜色关着：只记形状，不整理但会打断
      commit(next, false, next);
      warnIfCutting(next);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  };

  var lv = LEVELS[clamp(level)];
  var tip = zh ? lv.desc : lv.descEn;

  var drawShape = function (cfg, size) {
    return React.createElement('svg', {
      width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true',
      style: { display: 'block' },
    }, cfg.shape === 'circle'
      ? React.createElement('circle', { cx: 12, cy: 12, r: 8, fill: cfg.color })
      : cfg.shape === 'triangle'
        ? React.createElement('path', { d: 'M12 3.6 L20.8 19.2 L3.2 19.2 Z', fill: cfg.color })
        : React.createElement('rect', { x: 4.8, y: 4.8, width: 14.4, height: 14.4, rx: 1.6, fill: cfg.color }));
  };

  // 档位浮层：在字形正上方，带底和边框（不透明，浮起来像 popover，不压别的字）
  var strip = open ? React.createElement('span', {
    key: 'strip',
    ref: function (el) { stripRef.current = el; },
    style: { display: 'inline-flex', alignItems: 'center', gap: ITEM_GAP + 'px' },
  }, [1, 2, 3].map(function (n) {
    var base = LEVELS[n];
    var cfg = { shape: base.shape, color: level > 0 ? base.color : '#9aa3ad' };   // 没上色就一律灰
    var active = (level > 0 ? clamp(level) : clamp(tier)) === n;
    return React.createElement('span', {
      key: 's' + n,
      ref: function (el) { (itemRefs.current || (itemRefs.current = []))[n - 1] = el; },
      style: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '21px', height: '21px',
        transform: active ? 'scale(1.08)' : 'scale(.84)',
        opacity: active ? 1 : 0.42,
        transition: 'transform 110ms ease, opacity 110ms ease',
        animation: 'tg-item 150ms ease-out both',
        animationDelay: ((n - 1) * 34) + 'ms',
      },
    }, drawShape(cfg, active ? 19 : 14));
  })) : null;

  var button = React.createElement('button', {
    type: 'button',
    'aria-label': (zh ? lv.short : lv.en) + ' · ' + tip,
    onPointerDown: onDown,
    onKeyDown: function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); var n1 = Math.max(1, clamp(level + 1)); commit(n1, false); warnIfCutting(n1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); var n2 = clamp(level - 1); commit(n2, false); warnIfCutting(n2); }
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); commit(level === 0 ? 1 : 0, false); }
    },
    style: {
      minWidth: GLYPH_BOX + 'px', height: GLYPH_BOX + 'px', display: 'inline-flex',
      alignItems: 'center', justifyContent: 'center', padding: '0',
      border: '0', borderRadius: '9px', cursor: 'pointer', touchAction: 'none',
      background: 'transparent', position: 'relative',
    },
  }, [
    pulse > 0 ? React.createElement('span', {
      key: 'pulse' + pulse,
      style: {
        position: 'absolute', inset: '1px', borderRadius: '9px', border: '1.5px solid #8b5cf6',
        pointerEvents: 'none', animation: 'tg-ring 520ms ease-out forwards',
      },
    }) : null,
    React.createElement('span', {
      key: 'lift',
      style: {
        position: 'relative', display: 'inline-flex',
        transform: 'translateY(' + lift + 'px) scale(' + (armed ? 1.06 : 1) + ')',
        filter: 'drop-shadow(0 ' + (-lift * 0.35) + 'px ' + (2 + Math.abs(lift) * 0.5) + 'px rgba(139,92,246,' + Math.min(0.9, Math.abs(lift) / 16) + '))',
        // 拖动中由 rAF 逐帧驱动（不给过渡）；松手后交给弹簧曲线回弹，会略微过冲再落定
        transition: settling
          ? 'transform 340ms cubic-bezier(.34,1.42,.58,1), filter 340ms ease-out'
          : 'transform 80ms linear, filter 80ms linear',
      },
    }, [
      scope === 'global' ? null : React.createElement('span', {
        key: 'glow',
        style: {
          position: 'absolute', left: '50%', top: '50%', width: '30px', height: '30px',
          marginLeft: '-15px', marginTop: '-15px', borderRadius: '50%',
          background: lv.color, opacity: 0.34, filter: 'blur(5px)', pointerEvents: 'none',
          animation: 'tg-breathe 2.4s ease-in-out infinite',
          transition: 'background 260ms ease, opacity 260ms ease',
        },
      }),
      strip || React.createElement('span', {
        key: 'glyph' + pop,
        style: { display: 'inline-flex', position: 'relative', animation: 'tg-pop 240ms cubic-bezier(.2,.9,.3,1.3)' },
      }, drawShape(lv, 24)),
    ]),
  ]);

  var tipBox = (hover && !open) ? React.createElement('div', {
    style: {
      position: 'absolute', bottom: 'calc(100% + 8px)', right: '-2px', width: '250px',
      background: '#0f172a', color: '#fff', fontSize: '11.5px', lineHeight: 1.5,
      padding: '7px 10px', borderRadius: '8px', zIndex: 20, textAlign: 'left',
      boxShadow: '0 6px 20px rgba(15,23,42,0.18)',
    },
  }, [
    React.createElement('div', { key: 'd' }, tip),
    scope === 'global' ? React.createElement('div', { key: 'g', style: { marginTop: '4px', color: '#c4b5fd' } },
      zh ? '正作用于所有会话' : 'applies to all sessions') : null,
    React.createElement('a', {
      key: 's', href: STAR_URL, target: '_blank', rel: 'noreferrer',
      style: { display: 'block', marginTop: '6px', color: '#5eead4', textDecoration: 'none' },
    }, zh ? '★ 要是它帮到你了，求个 star 啦 🙏' : '★ If it helped at all, a star would mean a lot 🌱'),
  ]) : null;

  // 「会打断」的提示：操作结束后在字形上方短暂出现
  var noticeBox = (notice && !open) ? React.createElement('div', {
    style: {
      position: 'absolute', bottom: 'calc(100% + 8px)', right: 0, whiteSpace: 'nowrap',
      fontSize: '11px', color: '#f3c9c4', background: '#241a1a',
      border: '1px solid #4a2c2a', borderRadius: '7px', padding: '3px 8px', zIndex: 16,
      pointerEvents: 'none', animation: 'tg-panel 140ms ease-out',
    },
  }, notice) : null;

  // 容器统一管悬停：指针从字形移到弹窗上时不会触发隐藏
  return React.createElement('div', {
    onPointerEnter: showTip,
    onPointerLeave: hideTip,
    style: { position: 'relative', display: 'inline-flex' },
  }, [button, tipBox, noticeBox]);
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
