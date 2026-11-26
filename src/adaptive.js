/**
 * 自适应门控：决定「这个会话现在该不该允许开火」。
 *
 * 为什么不是又一条判据（2026-11-26 实测结论）：
 * 真实语料 177 个会话 / 2,421 轮上，固定阈值（占位率 > 20% / > 30%）都能 4/4 抓到事故会话，
 * 但**每一次都误伤同一个 game 会话**——它的占位率是缓慢爬升的（13.6→14.0→17.2→18.5→19.5%，
 * 最高摸到 31.4%），那是正常思考的节奏；而真事故是突跳的（基线 11.8% → 某轮 87.3%）。
 *
 * 「基线中位数 × 2」正好抓住这个差别：渐变的永远追不上自己的两倍，突变的立刻超。
 * 参数扫描（行数门槛 20/30/50/80 × 绝对下限 15/20/25%，共 12 组）：2× 全部 4/4 命中 + 0 误伤，
 * 开火 15 轮 / 2,421 轮 = 0.62%；1.5× 每格都带误伤，2.5× 掉到 3/4，3× 掉到 2/4。
 *
 * 所以它是**门控**而不是新判据：现有判据照旧，只是动手之前先过这一关。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 磁盘格式版本。 */
export const ADAPTIVE_VERSION = 1;

/** 最多记住多少个会话的统计（超出丢最旧的）。 */
export const MAX_ADAPTIVE_SESSIONS = 128;

/**
 * 中位数。比均值抗离群——一次爆发不会立刻把基线拉高。
 * @param {number[]} values - 数值数组。
 * @returns {number} 中位数；空数组返回 0。
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 判断这一次该不该允许开火。
 *
 * @param {object} input - 判断需要的全部输入。
 * @param {number} input.rate - 这一块（这一步到目前为止）的占位率 0..1。
 * @param {number} input.lines - 已经出现的非空行数。
 * @param {number[]} input.history - 这个会话之前若干步的占位率（不含当前步）。
 * @param {number} input.lockUntil - 锁定期截止到第几步（从 0 数）。
 * @param {number} input.step - 当前是第几步（= 历史长度）。
 * @param {object} cfg - 生效配置。
 * @returns {{allow: boolean, reason: string, baseline: number|null, threshold: number|null}} 判定结果。
 */
export function adaptiveDecision({ rate, lines, history, lockUntil, step, cfg }) {
  const minLines = Math.max(1, Math.floor(cfg.adaptiveMinLines ?? 30));
  const floor = Math.max(0, Math.min(1, cfg.adaptiveFloor ?? 0.20));
  const multiplier = Math.max(1, cfg.adaptiveMultiplier ?? 2);
  const warmup = Math.max(0, Math.floor(cfg.adaptiveWarmupSteps ?? 3));
  const window = Math.max(1, Math.floor(cfg.adaptiveWindow ?? 8));

  // 行数太少时占比没有意义：13 行里 2 行占位就是 15%，跟 2886 行里 40% 不是一回事
  if (lines < minLines) return { allow: false, reason: 'too-short', baseline: null, threshold: null };

  const past = Array.isArray(history) ? history : [];

  // 锁定期：刚开过火，别指望基线又马上追上——直接按绝对下限放行
  if (Number.isFinite(lockUntil) && step < lockUntil) {
    return { allow: rate >= floor, reason: rate >= floor ? 'locked' : 'locked-idle', baseline: null, threshold: floor };
  }

  // 冷启动：还没有基线可依，退回绝对下限。
  // 为什么不是「完全不判」：那样新会话的第一步就不设防，而第三方回放器（以及真实用户）
  // 第一步就直接喂一整块爆发的话，会看到「装了插件却一刀都不落」——比误伤更像坏了。
  if (past.length < warmup) {
    const allow = rate > floor;
    return { allow, reason: allow ? 'cold-spike' : 'cold', baseline: 0, threshold: floor };
  }

  const baseline = median(past.slice(-window));
  const threshold = Math.max(baseline * multiplier, floor);
  if (rate > threshold) return { allow: true, reason: 'spike', baseline, threshold };
  return { allow: false, reason: 'normal', baseline, threshold };
}

/** 空状态。 */
const emptyState = () => ({ version: ADAPTIVE_VERSION, sessions: {}, order: [] });

/**
 * 读自适应状态。坏文件当空状态处理，不抛。
 * @param {string} file - 状态文件路径。
 * @returns {{version: number, sessions: object, order: string[]}} 状态。
 */
export function readAdaptive(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return emptyState(); }
  if (!raw || typeof raw !== 'object') return emptyState();
  const sessions = {};
  const order = [];
  const source = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  for (const [key, value] of Object.entries(source)) {
    if (!value || typeof value !== 'object') continue;
    const rates = Array.isArray(value.rates)
      ? value.rates.filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)
      : [];
    sessions[key] = {
      rates,
      steps: Number.isInteger(value.steps) && value.steps >= 0 ? value.steps : rates.length,
      lockUntil: Number.isInteger(value.lockUntil) && value.lockUntil >= 0 ? value.lockUntil : 0,
    };
    order.push(key);
  }
  const declared = Array.isArray(raw.order) ? raw.order.filter((k) => typeof k === 'string') : [];
  return { version: ADAPTIVE_VERSION, sessions, order: [...new Set([...declared, ...order])].filter((k) => k in sessions) };
}

/**
 * 原子写回自适应状态。
 * @param {string} file - 状态文件路径。
 * @param {object} state - 状态对象。
 */
export function writeAdaptive(file, state) {
  const trimmed = { ...state };
  if (trimmed.order.length > MAX_ADAPTIVE_SESSIONS) {
    const keep = trimmed.order.slice(-MAX_ADAPTIVE_SESSIONS);
    const sessions = {};
    for (const key of keep) sessions[key] = trimmed.sessions[key];
    trimmed.order = keep;
    trimmed.sessions = sessions;
  }
  const body = JSON.stringify({ version: ADAPTIVE_VERSION, sessions: trimmed.sessions, order: trimmed.order }, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 一步结束时把这一轮的占位率记进历史。
 *
 * **被掐断的那一步不记**：它天然占位率极高，记进去会把基线越拉越高，
 * 下一次就再也够不到 2 倍门槛——等于掐一次把自己掐残了。
 *
 * @param {string} file - 状态文件路径。
 * @param {string} sessionId - 归一化后的会话 id。
 * @param {object} input - { rate, killed, cfg }。
 * @returns {object} 更新后的该会话记录。
 */
export function noteStep(file, sessionId, { rate, killed, cfg }) {
  const state = readAdaptive(file);
  const current = state.sessions[sessionId] ?? { rates: [], steps: 0, lockUntil: 0 };
  const window = Math.max(1, Math.floor(cfg?.adaptiveWindow ?? 8));
  current.steps += 1;
  if (!killed) {
    current.rates.push(Math.max(0, Math.min(1, rate)));
    if (current.rates.length > window) current.rates = current.rates.slice(-window);
  }
  state.sessions[sessionId] = current;
  state.order = [...state.order.filter((k) => k !== sessionId), sessionId];
  writeAdaptive(file, state);
  return current;
}

/**
 * 给会话上锁：接下来这么多步，门控按绝对下限放行，不等基线追上来。
 * @param {string} file - 状态文件路径。
 * @param {string} sessionId - 归一化后的会话 id。
 * @param {object} cfg - 生效配置。
 * @returns {object} 更新后的该会话记录。
 */
export function lockSession(file, sessionId, cfg) {
  const state = readAdaptive(file);
  const current = state.sessions[sessionId] ?? { rates: [], steps: 0, lockUntil: 0 };
  const span = Math.max(0, Math.floor(cfg?.adaptiveLockSteps ?? 5));
  current.lockUntil = current.steps + span;
  state.sessions[sessionId] = current;
  state.order = [...state.order.filter((k) => k !== sessionId), sessionId];
  writeAdaptive(file, state);
  return current;
}
