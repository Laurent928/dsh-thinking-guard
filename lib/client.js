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
    short: '关',
    color: '#94a3b8',
    desc: '关闭。插件完全不介入：不记账、不提醒、不改任何请求参数，'
      + '想彻底当它没装过就选这档。',
  },
  {
    short: '提示',
    color: '#60a5fa',
    desc: '在系统提示里禁止写「做。」「好。」「写。」这三个词，并给它一个收尾模板：'
      + '「调用 <工具名>，参数 <值>」。代价：每次请求多几十个字。零风险。',
  },
  {
    short: '慢断',
    color: '#2dd4bf',
    desc: '在「提示」之上：边生成边数短行，数够了就砍掉这次生成，'
      + '然后用官方的 followup 让它自己起下一轮。'
      + '代价：要等 7–21 秒（这一轮收尾 + 唤醒的开销），但历史是干净的。',
  },
  {
    short: '快断',
    color: '#fbbf24',
    desc: '在「慢断」之上：同样砍掉生成，但补一个只读工具调用（get_goal）'
      + '让这一轮直接进下一步，延迟 <1 秒。'
      + '代价：会话历史里会多一条假的工具调用记录。',
  },
  {
    short: '熔断',
    color: '#f87171',
    desc: '在「快断」之上：本轮里连续第 3 次空转就直接中止这一轮。'
      + '最凶，也最容易误伤。',
  },
];

var MAX_LEVEL = LEVELS.length - 1;
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
    '@keyframes rg-breathe-a{0%,100%{opacity:.18}50%{opacity:.9}}',
    '@keyframes rg-breathe-b{0%,100%{opacity:.7}50%{opacity:.1}}',
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
function GuardSlider(props) {
  var sessionId = props.sessionId || (props.session ? props.session.sessionId : undefined);
  var state = React.useState(null);
  var level = state[0];
  var setLevelRaw = state[1];
  // 未知时按「继承」处理：先不发光，等宿主回了真实作用域再说
  var scopeState = React.useState('default');
  var scope = scopeState[0];
  var setScope = scopeState[1];
  var armedState = React.useState(false);
  var armed = armedState[0];
  var setArmed = armedState[1];
  var lockState = React.useState(false);
  var justLocked = lockState[0];
  var setJustLocked = lockState[1];
  // 轨道平时收起（只显示当前那一格），按下或键盘聚焦时才展开成整条
  var expandedState = React.useState(false);
  var expanded = expandedState[0];
  var setExpanded = expandedState[1];

  var ref = React.useRef(null);
  var dragRef = React.useRef(false);
  var levelRef = React.useRef(null);
  var startYRef = React.useRef(0);
  var holdRef = React.useRef(null);
  var holdFiredRef = React.useRef(false);
  /** 最后一次亮过的颜色：光要灭的时候靠它做淡出，而不是节点直接消失。 */
  var lastGlowRef = React.useRef(null);

  var setLevel = function (next) {
    levelRef.current = next;
    setLevelRaw(next);
  };

  // 首次读取 + 之后持续同步：宿主那边被外部改掉（curl、别的窗口、脚本）也要跟上。
  React.useEffect(function () {
    if (!sessionId) return undefined;
    var alive = true;
    var timer = null;

    var sync = function () {
      if (!alive || dragRef.current) return; // 正在拖的时候别被远端覆盖
      readHostLevel(sessionId).then(function (payload) {
        if (!alive || !payload) return;
        setLevel(payload.level);
        setScope(scopeOf(payload));
      }).catch(function () { /* 宿主没起来就保持未知，不炸整行 */ });
    };

    var startTimer = function () {
      if (timer !== null || typeof setInterval !== 'function') return;
      timer = setInterval(sync, SYNC_MS);
    };
    var stopTimer = function () {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    var onVisibility = function () {
      var visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
      if (visible) { sync(); startTimer(); } else stopTimer();
    };

    sync();
    onVisibility();

    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('focus', sync);
    if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', onVisibility);

    return function () {
      alive = false;
      stopTimer();
      if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('focus', sync);
      if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [sessionId]);

  /**
   * 免责声明分级：
   * - 档 2（慢断）/ 档 3（快断）：勾「以后不用再提醒」就不再来烦——它们只是慢或者留条假记录。
   * - 档 4（熔断）：**每次必弹**，没有免检——它会把整轮直接中止。
   */
  var ACK_KEY = 'rg-kill-disclaimer-ack';
  var ackRead = function () {
    try { return window.localStorage.getItem(ACK_KEY) === '1'; } catch (e) { return false; }
  };
  var ackWrite = function () {
    try { window.localStorage.setItem(ACK_KEY, '1'); } catch (e) { /* 存不了就下次再问 */ }
  };
  var dialogState = React.useState(false);
  var showDialog = dialogState[0];
  var setShowDialog = dialogState[1];
  var dontAskState = React.useState(false);
  var dontAsk = dontAskState[0];
  var setDontAsk = dontAskState[1];
  var pendingRef = React.useRef(null);

  /** 真正落盘一次：isGlobal 决定写全局还是写本会话。 */
  var commit = function (next, isGlobal) {
    if (!sessionId && !isGlobal) return;
    var body = isGlobal
      ? { level: next, scope: 'global' }
      : { sessionId: sessionId, level: next };
    writeHostLevel(body).then(function (payload) {
      var nextScope = scopeOf(payload);
      setScope(nextScope);
      if (nextScope === 'global') {
        // 落定确认：设完全局给一下紫色余韵，然后回到安静——继承值不该一直亮
        setJustLocked(true);
        setTimeout(function () { setJustLocked(false); }, 460);
      }
    }).catch(function () { /* 下一轮询会纠正回来 */ });
  };

  /**
   * 对外入口：会打断生成的档位先过免责声明。
   * 熔断还有一条硬限制——**不能设为全局**：它会中止整轮，全局生效等于给所有对话埋雷。
   */
  var push = function (next, isGlobal) {
    if (!sessionId && !isGlobal) return;
    var mustAsk = next >= 4 || !ackRead();
    var globalBlocked = next >= 4 && isGlobal;
    if (next >= 2 && (mustAsk || globalBlocked)) {
      pendingRef.current = { next: next, isGlobal: isGlobal, askAgain: next >= 4, globalBlocked: globalBlocked };
      setDontAsk(false);
      setShowDialog(true);
      return;
    }
    commit(next, isGlobal);
  };

  var onPointerDown = function (event) {
    if (!sessionId) return;
    dragRef.current = true;
    startYRef.current = event.clientY;
    setArmed(false);
    setExpanded(true);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) { /* 老浏览器不支持 capture */ }
    var box = event.currentTarget.getBoundingClientRect();
    setLevel(levelAt(event.clientX, box.left));
  };

  var onPointerMove = function (event) {
    if (!dragRef.current) return;
    var box = event.currentTarget.getBoundingClientRect();
    var next = levelAt(event.clientX, box.left);
    var lifted = (event.clientY - startYRef.current) <= -ARM_DISTANCE;
    if (lifted !== armed) setArmed(lifted);
    if (next !== levelRef.current) setLevel(next);
  };

  var finishDrag = function (cancelled) {
    if (!dragRef.current) return;
    dragRef.current = false;
    setExpanded(false);
    var wasArmed = armed;
    setArmed(false);
    if (cancelled) return;
    var next = typeof levelRef.current === 'number' ? levelRef.current : 0;
    push(next, wasArmed);
  };

  var onDoubleClick = function (event) {
    if (!sessionId) return;
    event.preventDefault();
    var next = typeof levelRef.current === 'number' ? levelRef.current : 0;
    push(next, true);
    setArmed(false);
  };

  var onKeyDown = function (event) {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (event.repeat) return;
      holdFiredRef.current = false;
      holdRef.current = setTimeout(function () {
        holdRef.current = null;
        holdFiredRef.current = true;
        var next = Math.min(MAX_LEVEL, (typeof levelRef.current === 'number' ? levelRef.current : 0) + 1);
        setLevel(next);
        setArmed(true);
        push(next, true);
        setTimeout(function () { setArmed(false); }, 420);
      }, HOLD_MS);
      return;
    }
    if (event.key === 'ArrowRight') { event.preventDefault(); bump(1); return; }
    if (event.key === 'ArrowLeft') { event.preventDefault(); bump(-1); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); bump(-1); return; }
    if (event.key === 'Home') { event.preventDefault(); commitLocal(0); return; }
    if (event.key === 'End') { event.preventDefault(); commitLocal(MAX_LEVEL); }
  };

  var onKeyUp = function (event) {
    if (event.key !== 'ArrowUp') return;
    if (holdRef.current !== null) {
      clearTimeout(holdRef.current);
      holdRef.current = null;
    }
    if (holdFiredRef.current) {
      holdFiredRef.current = false; // 长按已经改成全局了，短按不再叠加
      return;
    }
    bump(1);
  };

  var bump = function (delta) {
    var base = typeof levelRef.current === 'number' ? levelRef.current : 0;
    commitLocal(Math.max(0, Math.min(MAX_LEVEL, base + delta)));
  };

  var commitLocal = function (next) {
    setLevel(next);
    push(next, false);
  };

  var known = typeof level === 'number';
  var shown = known ? level : 0;
  var activeColor = LEVELS[shown].color;

  // 收起来时只露出当前那一格——四周留 4px 余量，好让泛光也露出来
  var viewX = expanded ? 0 : (shown * (SEG_W + SEG_GAP)) - 4;
  var viewY = expanded ? 0 : -4;
  var viewW = expanded ? TRACK_W : SEG_W + 8;
  var viewH = expanded ? TRACK_H : TRACK_H + 8;

  var children = [];
  children.push(React.createElement('defs', { key: 'defs' }, [
    React.createElement('filter', {
      key: 'soft', id: 'rg-glow-soft',
      x: '-90%', y: '-90%', width: '280%', height: '280%',
      'color-interpolation-filters': 'sRGB',
    }, React.createElement('feGaussianBlur', { stdDeviation: '2.6' })),
    React.createElement('filter', {
      key: 'wide', id: 'rg-glow-wide',
      x: '-140%', y: '-140%', width: '380%', height: '380%',
      'color-interpolation-filters': 'sRGB',
    }, React.createElement('feGaussianBlur', { stdDeviation: '5.5' })),
  ]));

  // 描边只在拖动（展开）期间出现，松手就收——平时不留框，只留泛光。
  // 上拉准备设全局时换成琥珀色并加粗，当作「要生效到所有对话」的提示。
  if (expanded) {
    children.push(React.createElement('rect', {
      key: 'drag-outline',
      x: '-1.5',
      y: '-1.5',
      width: String(TRACK_W + 3),
      height: String(TRACK_H + 3),
      rx: '9',
      ry: '9',
      fill: 'none',
      // 改档位的过程中（拖动 / 按下展开）边框就是紫色——
      // 紫色在这套界面里专指「作用域」，动手时先亮起来，落定后再回到档位色。
      stroke: (armed || expanded) ? '#a78bfa' : activeColor,
      strokeWidth: armed ? '1.4' : '1',
      opacity: armed ? '0.9' : '0.5',
      style: { transition: 'stroke 180ms ease, opacity 180ms ease' },
    }));
  }

  // 泛光只表示「这个会话被手动设过」，颜色一律用本档色——紫色留给描边。
  // 早先把设全局时的呼吸光做成紫色，在深色背景上发灰、看着很脏，已改回档位色。
  // 继承来的值（全局默认 / 配置默认）不发光——安静是默认状态。
  var liveGlow = (armed || justLocked || scope === 'session') ? activeColor : null;
  if (liveGlow) lastGlowRef.current = liveGlow;
  var glowColor = liveGlow || lastGlowRef.current;
  if (glowColor) {
    var glowX = shown * (SEG_W + SEG_GAP);
    var glowY = (TRACK_H - SEG_H) / 2;
    var fast = armed || justLocked;
    // 显隐交给外层 <g> 的 opacity 过渡，内层的呼吸动画一直播着不被打断。
    // 早先的写法是换 key 播一次性淡出，结果旧节点瞬间消失、新节点从 0.85 重开，
    // 看起来就是「灭→亮→灭」闪两下。
    children.push(React.createElement('g', {
      key: 'glow',
      style: {
        opacity: liveGlow ? '1' : '0',
        transition: liveGlow ? 'opacity 180ms ease-out' : 'opacity 340ms ease-out',
        pointerEvents: 'none',
      },
    }, [
      React.createElement('rect', {
        key: 'soft',
        x: String(glowX - 2),
        y: String(glowY - 2),
        width: String(SEG_W + 4),
        height: String(SEG_H + 4),
        rx: '6',
        ry: '6',
        fill: glowColor,
        filter: 'url(#rg-glow-soft)',
        style: {
          animation: 'rg-breathe-a ' + (fast ? '0.9s' : '2.6s') + ' ease-in-out infinite',
          transition: 'fill 180ms ease-out',
        },
      }),
      React.createElement('rect', {
        key: 'wide',
        x: String(glowX - 4),
        y: String(glowY - 4),
        width: String(SEG_W + 8),
        height: String(SEG_H + 8),
        rx: '8',
        ry: '8',
        fill: glowColor,
        filter: 'url(#rg-glow-wide)',
        style: {
          animation: 'rg-breathe-b ' + (fast ? '1.4s' : '3.7s') + ' ease-in-out infinite',
          transition: 'fill 180ms ease-out',
        },
      }),
    ]));
  }

  // 收起时只画当前这一格——不画邻格，免得它的浅色边露到外面跟文字挤在一起
  var firstSeg = expanded ? 0 : shown;
  var lastSeg = expanded ? MAX_LEVEL : shown;
  for (var i = firstSeg; i <= lastSeg; i++) {
    var filled = known && i <= shown;
    children.push(React.createElement('rect', {
      key: 'seg' + i,
      x: String(i * (SEG_W + SEG_GAP)),
      y: String((TRACK_H - SEG_H) / 2),
      width: String(SEG_W),
      height: String(SEG_H),
      rx: '4',
      ry: '4',
      fill: filled ? LEVELS[i].color : SEG_OFF,
    }));
  }

  var scopeText = scope === 'global' ? '全局默认（继承）' : (scope === 'session' ? '仅本对话（已设）' : '配置默认');
  var label = known
    ? '空转守卫：' + LEVELS[shown].short + '（' + shown + '/' + MAX_LEVEL + '，' + scopeText + '）'
    : '空转守卫：未连接';
  var REPO = 'github.com/Laurent928/dsh-thinking-guard';
  var tip = known
    ? '空转守卫 · ' + shown + '/' + MAX_LEVEL + '「' + LEVELS[shown].short + '」　' + scopeText + '\n'
      + LEVELS[shown].desc + '\n\n'
      + '拖动/点击改本对话（会亮起来）　·　拖动时向上抬＝设为所有对话的默认\n'
      + '双击轨道、或长按 ↑ 同效\n\n'
      + '★ 用着顺手就给颗星吧，写它的那只鲸会开心\n' + REPO
    : '空转守卫：宿主未响应。\n拖动或点一下试试。';

  var slider = React.createElement('button', {
    type: 'button',
    ref: ref,
    title: tip,
    'aria-label': label,
    role: 'slider',
    'aria-valuemin': 0,
    'aria-valuemax': MAX_LEVEL,
    'aria-valuenow': shown,
    tabIndex: 0,
    onPointerDown: onPointerDown,
    onPointerMove: onPointerMove,
    onPointerUp: function () { finishDrag(false); },
    onPointerCancel: function () { finishDrag(true); },
    onDoubleClick: onDoubleClick,
    onKeyDown: onKeyDown,
    onKeyUp: onKeyUp,
    onFocus: function () { setExpanded(true); },
    onBlur: function () { setExpanded(false); },
    onContextMenu: function (event) { event.preventDefault(); },
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '0 6px',
      height: '26px',
      border: '0',
      borderRadius: '7px',
      background: 'transparent',
      cursor: armed ? 'ns-resize' : 'pointer',
      touchAction: 'none',
      userSelect: 'none',
      WebkitTapHighlightColor: 'transparent',
      transform: armed ? 'translateY(-2px) scale(1.06)' : 'translateY(0) scale(1)',
      filter: armed ? 'drop-shadow(0 0 7px rgba(251,191,36,0.6))' : 'none',
      transition: 'transform 280ms cubic-bezier(.2,.8,.2,1), filter 280ms cubic-bezier(.2,.8,.2,1)',
    },
  }, [
    React.createElement('svg', {
      key: 'track',
      viewBox: viewX + ' ' + viewY + ' ' + viewW + ' ' + viewH,
      'aria-hidden': 'true',
      focusable: 'false',
      style: {
        display: 'block',
        width: viewW + 'px',
        height: viewH + 'px',
        overflow: 'visible',
        transition: 'width 200ms cubic-bezier(.2,.8,.2,1), height 200ms cubic-bezier(.2,.8,.2,1), filter 280ms cubic-bezier(.2,.8,.2,1)',
      },
    }, children),
    React.createElement('span', {
      key: 'text',
      style: {
        fontSize: armed ? '10px' : '11px',
        lineHeight: '1',
        fontWeight: armed ? '600' : '500',
        letterSpacing: armed ? '0.04em' : '0',
        color: armed ? '#a78bfa' : (known ? activeColor : 'rgba(148,163,184,0.9)'),
        minWidth: '1.6em',
        textAlign: 'center',
        transition: 'color 220ms ease, font-size 220ms ease',
      },
    }, armed ? '全局' : (known ? LEVELS[shown].short : '–')),
  ]);

  if (!showDialog) return slider;

  var pending = pendingRef.current || { next: shown, isGlobal: false };
  var dialog = React.createElement('div', {
    key: 'disclaimer',
    role: 'dialog',
    'aria-modal': 'true',
    style: {
      position: 'fixed',
      zIndex: 2147483000,
      left: '50%',
      bottom: '96px',
      transform: 'translateX(-50%)',
      width: '340px',
      maxWidth: 'calc(100vw - 32px)',
      padding: '14px 16px',
      borderRadius: '12px',
      background: 'rgba(24,24,28,0.97)',
      border: '1px solid rgba(167,139,250,0.45)',
      boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
      color: '#e5e7eb',
      font: '12px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif',
      textAlign: 'left',
    },
  }, [
    React.createElement('div', {
      key: 't',
      style: { fontWeight: 700, fontSize: '13px', marginBottom: '8px', color: '#c4b5fd', letterSpacing: '0.02em' },
    }, pending.globalBlocked
      ? '⛔ 熔断不能设为全局，只能设本对话'
      : (pending.next >= 4 ? '⚠ 熔断：会直接中止本轮' : (pending.next >= 3 ? '⚠ 快断：会往历史里塞一条假记录' : '⚠ 慢断：要等十几秒'))),

    pending.globalBlocked
      ? React.createElement('div', {
        key: 'gb',
        style: {
          padding: '9px 11px',
          borderRadius: '9px',
          marginBottom: '8px',
          background: 'rgba(248,113,113,0.14)',
          border: '1px solid rgba(248,113,113,0.5)',
          color: '#fca5a5',
        },
      }, '熔断会把整轮直接中止。设成全局等于给每个对话都埋一颗雷，所以这一档只允许对当前对话生效。')
      : null,

    // 三条警告必须一眼能分清——差异用加粗 + 各自的高亮色标出来
    React.createElement('div', {
      key: 'diff',
      style: {
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-start',
        padding: '9px 11px',
        borderRadius: '9px',
        marginBottom: '8px',
        background: pending.next >= 4 ? 'rgba(248,113,113,0.14)' : (pending.next >= 3 ? 'rgba(251,191,36,0.13)' : 'rgba(45,212,191,0.13)'),
        border: '1px solid ' + (pending.next >= 4 ? 'rgba(248,113,113,0.5)' : (pending.next >= 3 ? 'rgba(251,191,36,0.45)' : 'rgba(45,212,191,0.45)')),
      },
    }, [
      React.createElement('span', {
        key: 'k',
        style: {
          flex: '0 0 auto',
          fontWeight: 700,
          color: pending.next >= 4 ? '#fca5a5' : (pending.next >= 3 ? '#fcd34d' : '#5eead4'),
        },
      }, pending.next >= 4 ? '代价' : (pending.next >= 3 ? '代价' : '代价')),
      React.createElement('span', { key: 'v', style: { color: '#e5e7eb' } },
        pending.next >= 4
          ? '同一轮里连续第 3 次空转就中止本轮——你会看到一条「本轮运行失败」，那一轮白跑了。'
          : (pending.next >= 3
            ? '延迟 <1 秒，但会话历史里会多一条「调用了 get_goal」的假记录，模型下一步能看见它。'
            : '会话历史保持干净，但要等 7–21 秒才能续上——这一轮收尾加唤醒的开销，省不掉。')),
    ]),

    React.createElement('div', { key: 'b', style: { color: '#9ca3af' } },
      '空转本身不破坏内容，只是白烧时间。跑不能被打断的任务时，建议留在「提示」档。'),

    React.createElement('div', {
      key: 'star',
      style: { marginTop: '6px', fontSize: '11px', color: '#6f6f88' },
    }, '★ 真觉得好用，回仓库点颗星 —— 阿鲸会记着' + '\n' + REPO),

    React.createElement('label', {
      key: 'ack',
      style: { display: 'flex', alignItems: 'center', gap: '6px', margin: '10px 0 8px', cursor: 'pointer', color: '#9ca3af' },
    }, [
      React.createElement('input', {
        key: 'cb',
        type: 'checkbox',
        checked: dontAsk,
        onChange: function (event) { setDontAsk(!!event.target.checked); },
      }),
      pending.askAgain ? '我知道这一档会中止本轮（每次都会再问）' : '我了解代价，以后不用再提醒',
    ]),
    React.createElement('div', {
      key: 'btns',
      style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
    }, [
      React.createElement('button', {
        key: 'no',
        type: 'button',
        onClick: function () {
          setShowDialog(false);
          pendingRef.current = null;
          // 宿主没被改过，让下一轮同步把界面拉回去（本地只是先显示成拖到的样子）
          if (typeof sync === 'function') sync();
        },
        style: { padding: '5px 12px', borderRadius: '7px', border: '1px solid rgba(148,163,184,0.4)', background: 'transparent', color: '#cbd5e1', cursor: 'pointer' },
      }, '先不用'),
      React.createElement('button', {
        key: 'yes',
        type: 'button',
        disabled: pending.askAgain && !dontAsk,
        onClick: function () {
          // 只有非熔断档才把「不再提醒」记下来；熔断每次都重新问
          if (dontAsk && !pending.askAgain) ackWrite();
          setShowDialog(false);
          // 熔断即使是从「上拉设全局」进来的，也只落本对话
          commit(pending.next, pending.globalBlocked ? false : pending.isGlobal);
          pendingRef.current = null;
        },
        style: {
          padding: '5px 12px',
          borderRadius: '7px',
          border: '0',
          background: (pending.askAgain && !dontAsk) ? 'rgba(167,139,250,0.3)' : '#a78bfa',
          color: (pending.askAgain && !dontAsk) ? '#9ca3af' : '#1e1b31',
          fontWeight: 600,
          cursor: (pending.askAgain && !dontAsk) ? 'not-allowed' : 'pointer',
        },
      }, pending.globalBlocked ? '只设本对话' : '继续'),
    ]),
  ]);

  return React.createElement('div', {
    style: { position: 'relative', display: 'inline-flex' },
  }, [slider, dialog]);
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
        return React.createElement(GuardSlider, props);
      });
    });
  });
};

return module.exports; } });
