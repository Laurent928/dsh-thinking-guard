#!/usr/bin/env bash
# dsh-thinking-guard 一键安装脚本（Windows / Git Bash 或 WSL）
#
# 做的事：把本仓库 link 进 DSH 的 desktop profile，并登记到 bundle 列表。
# 不碰任何会话数据，不重启 DSH——装完告诉你下一步该做什么。
#
# 用法：
#   bash install.sh              # 从当前目录安装
#   bash install.sh --dry-run    # 只打印计划，不动手
set -euo pipefail

PLUGIN_NAME="dsh-thinking-guard"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY=0
for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && DRY=1
done

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# 1) 找到 DSH_HOME：优先环境变量，其次默认位置
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
[ -d "$DSH_HOME" ] || die "找不到 DSH 目录：$DSH_HOME（可用 DSH_HOME 环境变量指定）"

PROFILE_DIR="$DSH_HOME/profiles/desktop"
[ -f "$PROFILE_DIR/package.json" ] || die "找不到 profile：$PROFILE_DIR/package.json
  先启动一次 DSH 桌面版，让它把 profile 建好再运行本脚本。"

say "插件目录 : $HERE"
say "DSH 目录 : $DSH_HOME"
say "profile  : $PROFILE_DIR"

# 2) 先确认要用的命令都在：node 用来改 profile，pnpm 用来让 link 依赖生效
MISSING=""
for need in node pnpm; do
  command -v "$need" >/dev/null 2>&1 || MISSING="$MISSING $need"
done
if [ -n "$MISSING" ]; then
  die "缺命令：${MISSING# }。先装好这两样再回来：
  · Node.js  https://nodejs.org/  （选 LTS 版）
  · pnpm     npm install -g pnpm
  装完把窗口关掉重开一次（让 PATH 生效），再运行本脚本。"
fi

# 3) 备份 profile 的 package.json
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$DSH_HOME/_backups/thinking-guard-install-$STAMP"
if [ "$DRY" = "0" ]; then
  mkdir -p "$BACKUP_DIR"
  cp "$PROFILE_DIR/package.json" "$BACKUP_DIR/package.json.bak"
  [ -f "$PROFILE_DIR/pnpm-lock.yaml" ] && cp "$PROFILE_DIR/pnpm-lock.yaml" "$BACKUP_DIR/pnpm-lock.yaml.bak" || true
  say "已备份   : $BACKUP_DIR"
fi

# 4) 用 node 改 profile：加 link 依赖 + 加进 dsh.profile.bundles
if [ "$DRY" = "1" ]; then
  say "[dry-run] 会在 dependencies 加：$PLUGIN_NAME -> link:$HERE"
  say "[dry-run] 会在 dsh.profile.bundles 里补：$PLUGIN_NAME"
  exit 0
fi

node - "$PROFILE_DIR/package.json" "$PLUGIN_NAME" "$HERE" <<'NODE'
const fs = require('node:fs');
const [file, name, dir] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.dependencies = pkg.dependencies ?? {};
pkg.dependencies[name] = `link:${dir}`;
const bundles = pkg.dsh?.profile?.bundles;
if (Array.isArray(bundles)) {
  if (!bundles.includes(name)) bundles.push(name);
} else {
  throw new Error('这个 profile 里没有 dsh.profile.bundles，跳过登记（依赖已加）');
}
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('✓ profile/package.json 已更新');
NODE

say ""
say "下一步（两步，都得你手动做）："
say "  1. 在 $PROFILE_DIR 里跑：pnpm install"
say "  2. 重启 DSH 桌面版"
say ""
say "重启后：输入框工具条右侧会出现五格小滑条，档位含义见 README 的「五档滑条」。"
say ""
say "回退办法：把 $BACKUP_DIR/package.json.bak 覆盖回 profile，再跑一次 pnpm install。"
