# dsh-thinking-guard 一键安装（Windows · 无依赖）
#
# 只要 Windows 自带的 PowerShell，不需要 Git、不需要 Node、不需要 pnpm。
#
# 做四件事：
#   1. 备份 profile 的 package.json（+ 有的话 pnpm-lock.yaml）
#   2. 在 dependencies 里加一行  "dsh-thinking-guard": "link:<本目录>"
#   3. 把包名补进 dsh.profile.bundles
#   4. 直接在 node_modules 里建 junction —— 这一步平时是 pnpm install 干的，现在自己做
#
# 不碰会话数据、不联网、不重启 DSH。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun

[CmdletBinding()]
param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-thinking-guard'
$Here = $PSScriptRoot
if (-not $Here) { $Here = Split-Path -Parent $MyInvocation.MyCommand.Definition }

function Say($text) { Write-Host $text }
function Fail($text) {
  Write-Host ''
  Write-Host ('✗ ' + $text) -ForegroundColor Red
  Write-Host ''
  exit 1
}

# ---------- 1) 找 DSH ----------
$dshHome = $env:DSH_HOME
if (-not $dshHome -or $dshHome.Trim().Length -eq 0) {
  $dshHome = Join-Path $env:USERPROFILE '.dsh'
}
if (-not (Test-Path -LiteralPath $dshHome)) {
  Fail "找不到 DSH 目录：$dshHome`n  （可用 DSH_HOME 环境变量指定）"
}

$profileDir = Join-Path $dshHome 'profiles\desktop'
$pkgPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $pkgPath)) {
  Fail "找不到 profile：$pkgPath`n  先启动一次 DSH 桌面版，让它把 profile 建好，再运行本脚本。"
}

Say ('插件目录 : ' + $Here)
Say ('DSH 目录 : ' + $dshHome)
Say ('profile  : ' + $profileDir)

# ---------- 2) 读 profile ----------
$text = [IO.File]::ReadAllText($pkgPath, [Text.Encoding]::UTF8)
try {
  $pkg = $text | ConvertFrom-Json
} catch {
  Fail "profile 的 package.json 读不了（不是合法 JSON）：$pkgPath`n  $_"
}

if (-not $pkg.PSObject.Properties['dsh']) { Fail '这个 profile 里没有 dsh 字段，不像是 DSH 的 profile。' }
if (-not $pkg.dsh.PSObject.Properties['profile']) { Fail '这个 profile 里没有 dsh.profile，不像是 DSH 的 profile。' }
if (-not $pkg.dsh.profile.PSObject.Properties['bundles']) {
  Fail '这个 profile 里没有 dsh.profile.bundles。安装需要它来决定装哪些插件，请先确认这份 profile 是对的。'
}

$bundlesBefore = @($pkg.dsh.profile.bundles)
$linkTarget = $Here.Replace('\', '/')
$pkgText = $text

# ---------- 3) 改 JSON（先改内存里的副本） ----------
if (-not $pkg.PSObject.Properties['dependencies']) {
  $pkg | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([pscustomobject]@{})
}
$pkg.dependencies | Add-Member -NotePropertyName $PluginName -NotePropertyValue ('link:' + $linkTarget) -Force

$bundlesAfter = @($bundlesBefore)
if (-not ($bundlesAfter -contains $PluginName)) { $bundlesAfter += $PluginName }
$pkg.dsh.profile.bundles = $bundlesAfter

if ($DryRun) {
  Say ''
  Say ('[dry-run] 会在 dependencies 里写：' + $PluginName + ' -> link:' + $linkTarget)
  Say ('[dry-run] 会把 bundles 变成：' + ($bundlesAfter -join ', '))
  Say ('[dry-run] 会建 junction：' + (Join-Path $profileDir ('node_modules\' + $PluginName)))
  Say ''
  Say '什么都没改。去掉 -DryRun 再运行一次就真装。'
  exit 0
}

# ---------- 4) 备份 ----------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $dshHome ('_backups\thinking-guard-install-' + $stamp)
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item -LiteralPath $pkgPath -Destination (Join-Path $backupDir 'package.json.bak') -Force
$lockPath = Join-Path $profileDir 'pnpm-lock.yaml'
if (Test-Path -LiteralPath $lockPath) {
  Copy-Item -LiteralPath $lockPath -Destination (Join-Path $backupDir 'pnpm-lock.yaml.bak') -Force
}
Say ('已备份   : ' + $backupDir)

# ---------- 5) 写回去（UTF-8 无 BOM；带 BOM 会让 JSON.parse 直接炸） ----------
$json = $pkg | ConvertTo-Json -Depth 40
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($pkgPath, $json + "`r`n", $utf8NoBom)

# 读回来核对：能不能解析、内容是不是我们想写的那些
$after = [IO.File]::ReadAllText($pkgPath, [Text.Encoding]::UTF8)
try {
  $check = $after | ConvertFrom-Json
} catch {
  Copy-Item -LiteralPath (Join-Path $backupDir 'package.json.bak') -Destination $pkgPath -Force
  Fail "写回去的 package.json 解析不了，已经把备份还原回去了。请把这份报错发给作者：$_"
}
$want = ($pkg | ConvertTo-Json -Depth 40 -Compress)
$got = ($check | ConvertTo-Json -Depth 40 -Compress)
if ($want -ne $got) {
  Copy-Item -LiteralPath (Join-Path $backupDir 'package.json.bak') -Destination $pkgPath -Force
  Fail '写回去的内容和预期不一致，已经把备份还原回去了。这次什么都没改。'
}
Say '✓ profile/package.json 已更新'

# ---------- 6) node_modules 里建 junction（等价于 pnpm install 干的那一步） ----------
$nmDir = Join-Path $profileDir 'node_modules'
if (-not (Test-Path -LiteralPath $nmDir)) {
  New-Item -ItemType Directory -Path $nmDir -Force | Out-Null
}
$linkPath = Join-Path $nmDir $PluginName

function Remove-LinkIfAny($path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    # 只删链接本身，不递归 —— 递归删 junction 会连带删掉目标目录里的东西（PS 5.1 的老坑）
    try { [IO.Directory]::Delete($path, $false) } catch { & cmd.exe /c ('rmdir "' + $path + '"') | Out-Null }
    return
  }
  Fail "$path 已经存在，而且不是链接。为了不误删你的文件，这里停手：先手动处理它再运行本脚本。"
}

Remove-LinkIfAny $linkPath
try {
  New-Item -ItemType Junction -Path $linkPath -Target $Here | Out-Null
} catch {
  Copy-Item -LiteralPath (Join-Path $backupDir 'package.json.bak') -Destination $pkgPath -Force
  Fail "建 junction 失败：$linkPath`n  已经把 package.json 还原回去了。$_"
}
Say '✓ node_modules 已挂好（不需要 pnpm install）'

# ---------- 7) 说下一步 ----------
Say ''
Say '装完了，只剩一件事要做：'
Say '  **自己重启 DSH 桌面版** —— 插件的宿主半要在启动时加载，不重启看不到滑条'
Say ''
Say '重启后：输入框工具条右侧会出现五格小滑条，档位含义见 README 的「五档滑条」'
Say ''
Say '回退办法（两步）：'
Say ('  1. 把 ' + (Join-Path $backupDir 'package.json.bak') + ' 覆盖回 ' + $pkgPath)
Say ('  2. 删掉 ' + $linkPath + '，再重启 DSH')
Say ''
