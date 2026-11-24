/**
 * 按会话 + 全局持久化「强度」。
 *
 * 两层：
 *  - global   —— 默认值，所有没单独设过的会话都用它；
 *  - sessions —— 单个会话的特例覆盖。
 *
 * 会话 id 有两种写法：浏览器半拿到的带 `session-` 前缀（`session-abc…`），
 * 宿主侧 agent.session.id 是裸 UUID（`abc…`）。两者是同一个会话，所以落盘
 * 前统一归一化成裸 UUID，否则会变成两个互不相干的键——2026-11-23 就踩过：
 * 界面读到自己那个键、宿主读另一个，改了半天看不见变化。
 *
 * 写文件走临时文件 + 改名，崩了不会留半截；条数有上限，装久了也不会无限长。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 当前磁盘格式版本。 */
export const STATE_VERSION = 2;

/** 记住多少个会话的选择，超出丢最旧的。 */
export const MAX_SESSIONS = 256;

/** 会话 id 的前缀，落盘时剥掉。 */
const SESSION_PREFIX = 'session-';

/**
 * DSH 主目录。
 * @returns 绝对路径。
 */
export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
}

/**
 * 把两种会话 id 写法归一成裸 UUID。
 * @param id - 原始 id。
 * @returns 归一化后的 id；非法输入返回空串。
 */
export function normalizeId(id) {
  if (typeof id !== 'string') return '';
  const trimmed = id.trim();
  return trimmed.startsWith(SESSION_PREFIX) ? trimmed.slice(SESSION_PREFIX.length) : trimmed;
}

/**
 * 读整份状态，顺带把 v1 迁到 v2（归一化键）。
 *
 * 旧版本叫 reasoning-guard，状态文件也带那个名字；改名后如果读不到新文件，
 * 就顺手把旧文件读进来（只读、不改写旧文件），免得用户重启后档位全丢。
 * @param file - 状态文件路径。
 * @returns 状态对象。
 */
function readAll(file) {
  const empty = { version: STATE_VERSION, global: undefined, globalTier: undefined, sessions: {}, tiers: {}, order: [] };
  const candidates = [file];
  if (/thinking-guard\.json$/.test(file)) candidates.push(file.replace(/thinking-guard\.json$/, 'reasoning-guard.json'));
  let raw;
  for (const candidate of candidates) {
    try {
      raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      break;
    } catch {
      raw = undefined;
    }
  }
  if (!raw || typeof raw !== 'object') return empty;

  const sessions = {};
  const order = [];
  const source = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  // 旧五档的 4（熔断）已删档，读到就降到 2（慢续）——熔断现在由冷却窗兜底
  const migrate = (v) => (v > 3 ? 2 : v);
  for (const [key, value] of Object.entries(source)) {
    if (!Number.isInteger(value)) continue;
    const id = normalizeId(key);
    if (!id) continue;
    sessions[id] = migrate(value);
    if (!order.includes(id)) order.push(id);
  }
  const declared = Array.isArray(raw.order) ? raw.order.map(normalizeId) : [];
  const merged = [...new Set([...declared, ...order])].filter(id => id in sessions);

  // 形状（tier）单存一维：颜色关掉时它还在，用来表达「不整理但会打断」
  const tiers = {};
  const rawTiers = raw.tiers && typeof raw.tiers === 'object' ? raw.tiers : {};
  for (const [key, value] of Object.entries(rawTiers)) {
    const id = normalizeId(key);
    if (!id || !Number.isInteger(value) || value < 1 || value > 3) continue;
    tiers[id] = value;
  }

  return {
    version: STATE_VERSION,
    global: Number.isInteger(raw.global) ? migrate(raw.global) : undefined,
    globalTier: Number.isInteger(raw.globalTier) && raw.globalTier >= 1 && raw.globalTier <= 3 ? raw.globalTier : undefined,
    sessions,
    tiers,
    order: merged,
  };
}

/**
 * 原子写回整份状态。
 * @param file - 状态文件路径。
 * @param state - 状态对象。
 */
function writeAll(file, state) {
  const body = JSON.stringify({
    version: STATE_VERSION,
    ...state.global === undefined ? {} : { global: state.global },
    ...state.globalTier === undefined ? {} : { globalTier: state.globalTier },
    sessions: state.sessions,
    ...Object.keys(state.tiers ?? {}).length === 0 ? {} : { tiers: state.tiers },
    order: state.order,
  }, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 读全局默认强度。
 * @param file - 状态文件路径。
 * @returns 记录的全局值；没有返回 undefined。
 */
/**
 * 读某会话的形状档位（1..3）。
 * @param file - 状态文件路径。
 * @param sessionId - 会话 id。
 * @returns 存的档位；没有返回 undefined。
 */
export function readSessionTier(file, sessionId) {
  const id = normalizeId(sessionId);
  return id ? readAll(file).tiers[id] : undefined;
}

/**
 * 写某会话的形状档位；写 1 等于清掉（和默认一样）。
 * @param file - 状态文件路径。
 * @param sessionId - 会话 id。
 * @param tier - 1..3。
 */
export function writeSessionTier(file, sessionId, tier) {
  const id = normalizeId(sessionId);
  if (!id) return;
  const state = readAll(file);
  state.tiers = state.tiers ?? {};
  if (tier <= 1) delete state.tiers[id];
  else state.tiers[id] = tier;
  writeAll(file, state);
}

/**
 * 读全局的形状档位。
 * @param file - 状态文件路径。
 * @returns 1..3 或 undefined。
 */
export function readGlobalTier(file) {
  return readAll(file).globalTier;
}

/**
 * 写全局形状档位，并清掉所有会话的档位。
 * @param file - 状态文件路径。
 * @param tier - 1..3。
 */
export function writeGlobalTier(file, tier) {
  const state = readAll(file);
  if (tier <= 1) delete state.globalTier;
  else state.globalTier = tier;
  state.tiers = {};
  writeAll(file, state);
}

/**
 * 当前会话生效的形状档位：会话覆盖 > 全局 > 兜底（跟随 level）。
 * @param file - 状态文件路径。
 * @param sessionId - 会话 id。
 * @param fallback - 没有记录时用什么。
 * @returns 1..3。
 */
export function effectiveTier(file, sessionId, fallback) {
  const own = readSessionTier(file, sessionId);
  if (Number.isInteger(own)) return own;
  const global = readGlobalTier(file);
  if (Number.isInteger(global)) return global;
  return fallback;
}

export function readGlobal(file) {
  return readAll(file).global;
}

/**
 * 写全局默认强度，并清掉所有会话特例——「设为全局」就是要一处改、到处生效。
 * @param file - 状态文件路径。
 * @param level - 0..4。
 */
export function writeGlobal(file, level) {
  const state = readAll(file);
  state.global = level;
  state.sessions = {};
  state.order = [];
  writeAll(file, state);
}

/**
 * 读某个会话的覆盖强度（不含全局回落）。
 * @param file - 状态文件路径。
 * @param sessionId - 会话 id，两种写法都行。
 * @returns 会话自己的值；没有返回 undefined。
 */
export function readSessionLevel(file, sessionId) {
  const id = normalizeId(sessionId);
  if (!id) return undefined;
  const value = readAll(file).sessions[id];
  return Number.isInteger(value) ? value : undefined;
}

/**
 * 写某个会话的覆盖强度（原子写 + 上限淘汰）。
 * @param file - 状态文件路径。
 * @param sessionId - 会话 id，两种写法都行。
 * @param level - 0..4。
 */
export function writeSessionLevel(file, sessionId, level) {
  const id = normalizeId(sessionId);
  if (!id) return;
  const state = readAll(file);
  state.sessions[id] = level;
  const order = state.order.filter(x => x !== id);
  order.push(id);
  while (order.length > MAX_SESSIONS) {
    const dropped = order.shift();
    delete state.sessions[dropped];
  }
  state.order = order;
  writeAll(file, state);
}

/**
 * 删掉某个会话的覆盖记录——「值拖回跟默认一样」时用，等于回到继承。
 * @param file - 状态文件路径。
 * @param sessionId - 会话 id，两种写法都行。
 */
export function clearSessionLevel(file, sessionId) {
  const id = normalizeId(sessionId);
  if (!id) return;
  const state = readAll(file);
  if (!(id in state.sessions)) return;
  delete state.sessions[id];
  state.order = state.order.filter(x => x !== id);
  writeAll(file, state);
}

/** 运行时开关文件（不用重启就能拨的那种）：{ scrub: false } 之类。 */
function switchesFile() {
  return path.join(dshHome(), 'thinking-guard-switches.json');
}

const switchesCache = { at: -1, data: null };

/**
 * 读一个运行时开关。
 *
 * 为什么要有它：配置项改完得重启 DSH 才生效，做 A/B 太贵。开关放单独一个小文件、
 * 按 mtime 缓存，拨完下一次请求就吃到。找不到文件或键就返回 undefined，交回配置默认。
 * @param name - 开关名，比如 'scrub'。
 * @returns 布尔值或 undefined。
 */
export function readSwitch(name) {
  let stat;
  try { stat = fs.statSync(switchesFile()); } catch { return undefined; }
  if (stat.mtimeMs !== switchesCache.at) {
    try {
      switchesCache.data = JSON.parse(fs.readFileSync(switchesFile(), 'utf8'));
      switchesCache.at = stat.mtimeMs;
    } catch {
      switchesCache.data = null;
      switchesCache.at = stat.mtimeMs;
    }
  }
  const value = switchesCache.data?.[name];
  return typeof value === 'boolean' ? value : undefined;
}

/** 写一个运行时开关（临时文件 + 改名，写坏不会留半截）。 */
export function writeSwitch(name, value) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(switchesFile(), 'utf8')) ?? {}; } catch { data = {}; }
  data[name] = Boolean(value);
  const target = switchesFile();
  const temp = target + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, target);
  switchesCache.at = -1;
  return data;
}

/** 兼容旧名：直接按会话读。 */
export function readLevel(file, sessionId) {
  return readSessionLevel(file, sessionId);
}

/** 兼容旧名：直接按会话写。 */
export function writeLevel(file, sessionId, level) {
  writeSessionLevel(file, sessionId, level);
}

/**
 * 把记录值与默认值合成生效强度。
 * @param recorded - 记录值，可能没有。
 * @param fallback - 配置里的兜底默认。
 * @returns 生效强度。
 */
export function resolveLevel(recorded, fallback) {
  if (Number.isInteger(recorded)) return recorded;
  return Number.isInteger(fallback) ? fallback : 0;
}

/**
 * 合成一个会话最终生效的强度：会话覆盖 > 全局默认 > 配置兜底。
 * @param file - 状态文件路径。
 * @param sessionId - 会话 id。
 * @param fallback - 配置兜底。
 * @returns { level, scope } —— scope 说明这个值来自哪一层。
 */
export function effectiveLevel(file, sessionId, fallback) {
  const state = readAll(file);
  const id = normalizeId(sessionId);
  if (id && Number.isInteger(state.sessions[id])) return { level: state.sessions[id], scope: 'session' };
  if (Number.isInteger(state.global)) return { level: state.global, scope: 'global' };
  return { level: resolveLevel(undefined, fallback), scope: 'default' };
}
