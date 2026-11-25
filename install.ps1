# dsh-thinking-guard 一键安装（Windows · 无依赖）
#
# 只要 Windows 自带的 PowerShell，不需要 Git、不需要 Node、不需要 pnpm。
#
# 顺序是设计过的：中途任何一步失败，都会按反序退回原样。
#   0. 预检（只读）：插件目录、profile 结构、node_modules、目标链接位置
#   1. 备份 profile 的 package.json（按原始字节）+ 有的话 pnpm-lock.yaml
#   2. 内存里改清单：dependencies 加 link:、包名补进 dsh.profile.bundles
#   3. 写临时清单并解析校验；建临时 junction 并验证指向
#   4. 提交：旧链接改名备份 → 新链接就位 → 清单就位 → 双向核对
#   5. 全对才清理临时件；任一步出错按反序恢复
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

# ---------- 0) 预检：这一步全部只读 ----------
if (-not (Test-Path -LiteralPath $Here)) { Fail "插件目录不存在：$Here" }
if (-not (Test-Path -LiteralPath (Join-Path $Here 'package.json'))) {
  Fail "这个目录里没有 package.json，不像插件目录：$Here"
}

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

# 原样字节：回退时按字节还原，保证与原来逐字节一致
$originalBytes = [IO.File]::ReadAllBytes($pkgPath)
$text = [Text.Encoding]::UTF8.GetString($originalBytes)
if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
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

$nmDir = Join-Path $profileDir 'node_modules'
$linkPath = Join-Path $nmDir $PluginName

# 目标位置是什么？这一步决定了后面能不能动
$linkKind = 'none'
if (Test-Path -LiteralPath $linkPath) {
  $item = Get-Item -LiteralPath $linkPath -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    $linkKind = 'link'
  } else {
    Fail ("$linkPath 已经存在，而且不是链接。`n" +
          "为了不误删你的文件，这里停手：先手动处理它，或把它改名，再运行本脚本。`n" +
          "这份清单什么都没改。")
  }
}

$bundlesBefore = @($pkg.dsh.profile.bundles)
$linkTarget = $Here.Replace('\', '/')

Say ('插件目录 : ' + $Here)
Say ('DSH 目录 : ' + $dshHome)
Say ('profile  : ' + $profileDir)
Say ('链接状态 : ' + $(if ($linkKind -eq 'link') { '已有一个链接，会被替换（原链接先备份）' } else { '没有，会新建' }))

# ---------- 1) 算出新清单（还在内存里） ----------
if (-not $pkg.PSObject.Properties['dependencies']) {
  $pkg | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([pscustomobject]@{})
}
$pkg.dependencies | Add-Member -NotePropertyName $PluginName -NotePropertyValue ('link:' + $linkTarget) -Force

$bundlesAfter = @($bundlesBefore)
if (-not ($bundlesAfter -contains $PluginName)) { $bundlesAfter += $PluginName }
$pkg.dsh.profile.bundles = $bundlesAfter

if ($DryRun) {
  Say ''
  Say '[dry-run] 预检全部通过，什么都没改。'
  Say ('[dry-run] dependencies 会写：' + $PluginName + ' -> link:' + $linkTarget)
  Say ('[dry-run] bundles 会变成：' + ($bundlesAfter -join ', '))
  Say ('[dry-run] 链接动作：' + $(if ($linkKind -eq 'link') { '旧链接改名备份 → 新链接就位 → 成功后再删旧链接' } else { '直接新建' }))
  Say ''
  Say '去掉 -DryRun 再运行一次就真装。'
  exit 0
}

# ---------- 2) 备份 ----------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $dshHome ('_backups\thinking-guard-install-' + $stamp)
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$pkgBak = Join-Path $backupDir 'package.json.bak'
[IO.File]::WriteAllBytes($pkgBak, $originalBytes)
$lockPath = Join-Path $profileDir 'pnpm-lock.yaml'
if (Test-Path -LiteralPath $lockPath) {
  Copy-Item -LiteralPath $lockPath -Destination (Join-Path $backupDir 'pnpm-lock.yaml.bak') -Force
}
Say ('已备份   : ' + $backupDir)

# ---------- 3) 临时清单 + 临时链接（都还没碰正式位置） ----------
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$pkgTmp = $pkgPath + '.tmp-' + $stamp
$linkTmp = $linkPath + '.tmp-' + $stamp
$linkBak = $linkPath + '.old-' + $stamp

function Remove-LinkQuiet($path) {
  # 只删链接本身，绝不递归 —— 递归删 junction 会连带删掉目标目录里的东西（PS 5.1 的老坑）
  if (-not (Test-Path -LiteralPath $path)) { return }
  try { [IO.Directory]::Delete($path, $false) } catch {
    try { & cmd.exe /c ('rmdir "' + $path + '"') | Out-Null } catch { /* 删不掉就留着 */ }
  }
}

$committed = $false
try {
  if (-not (Test-Path -LiteralPath $nmDir)) {
    New-Item -ItemType Directory -Path $nmDir -Force | Out-Null
  }

  # 临时清单：先写再解析，解析不了就不往下走
  [IO.File]::WriteAllText($pkgTmp, (($pkg | ConvertTo-Json -Depth 40) + "`r`n"), $utf8NoBom)
  $checkTmp = $null
  try {
    $checkTmp = [IO.File]::ReadAllText($pkgTmp, [Text.Encoding]::UTF8) | ConvertFrom-Json
  } catch {
    throw ('临时清单解析不了：' + $_)
  }
  if (($checkTmp | ConvertTo-Json -Depth 40 -Compress) -ne ($pkg | ConvertTo-Json -Depth 40 -Compress)) {
    throw '临时清单的内容和预期不一致'
  }

  # 临时 junction：建完要能真的摸到目标目录
  New-Item -ItemType Junction -Path $linkTmp -Target $Here | Out-Null
  $probe = Get-Item -LiteralPath $linkTmp -Force
  if (-not ($probe.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw ('临时链接不是 junction：' + $linkTmp)
  }
  if (-not (Test-Path -LiteralPath (Join-Path $linkTmp 'package.json'))) {
    throw ('临时链接指不到插件目录：' + $linkTmp)
  }

  # ---------- 4) 提交：旧链接让位 → 新链接就位 → 清单就位 ----------
  if ($linkKind -eq 'link') {
    [IO.Directory]::Move($linkPath, $linkBak)
    Say ('旧链接已备份 : ' + $linkBak)
  }
  [IO.Directory]::Move($linkTmp, $linkPath)
  Copy-Item -LiteralPath $pkgTmp -Destination $pkgPath -Force
  $committed = $true
} catch {
  $reason = $_
  # 反序恢复：清单按字节还原 → 清掉刚就位的新链接 → 旧链接复位 → 清临时件
  $restoreProblems = @()
  try { [IO.File]::WriteAllBytes($pkgPath, $originalBytes) } catch { $restoreProblems += ('还原清单失败：' + $_) }
  if (Test-Path -LiteralPath $linkTmp) { Remove-LinkQuiet $linkTmp }
  if ($committed -or (Test-Path -LiteralPath $linkPath)) {
    # 只有确实是我们换上去的才删；原本没有链接时这一步什么也不做
    if ($linkKind -eq 'link' -and (Test-Path -LiteralPath $linkBak)) {
      try {
        if (Test-Path -LiteralPath $linkPath) { Remove-LinkQuiet $linkPath }
        [IO.Directory]::Move($linkBak, $linkPath)
      } catch { $restoreProblems += ('恢复旧链接失败：' + $_) }
    } elseif ($linkKind -eq 'none' -and $committed) {
      Remove-LinkQuiet $linkPath
    }
  }
  if (Test-Path -LiteralPath $pkgTmp) { Remove-Item -LiteralPath $pkgTmp -Force -ErrorAction SilentlyContinue }

  if ($restoreProblems.Count -eq 0) {
    Fail ("安装失败，已按反序退回原样：`n  " + $reason)
  } else {
    Fail ("安装失败，而且自动恢复没做完。`n  原因：" + $reason + "`n" +
          ($restoreProblems -join "`n") + "`n`n" +
          "请手动恢复（原件都在，不会丢）：`n" +
          "  1. 把 " + $pkgBak + " 复制回 " + $pkgPath + "`n" +
          "  2. 删掉 " + $linkPath + "（如果它还在）`n" +
          "  3. 如果 " + $linkBak + " 存在，把它改名回 " + $linkPath)
  }
}

# ---------- 5) 核对：清单说 link:、链接真指过去，两样都对才算成 ----------
$finalProblems = @()
try {
  $finalPkg = [IO.File]::ReadAllText($pkgPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  $depValue = $finalPkg.dependencies.$PluginName
  if (-not $depValue -or -not ($depValue -like ('link:' + '*'))) { $finalProblems += '清单里的依赖不是 link: 形式' }
  if (-not (@($finalPkg.dsh.profile.bundles) -contains $PluginName)) { $finalProblems += '清单里没有把包名补进 bundles' }
  if (-not (Test-Path -LiteralPath (Join-Path $linkPath 'package.json'))) { $finalProblems += ('链接指不到插件目录：' + $linkPath) }
} catch {
  $finalProblems += ('核对时出错：' + $_)
}

if ($finalProblems.Count -gt 0) {
  # 走和上面一样的反序恢复
  try { [IO.File]::WriteAllBytes($pkgPath, $originalBytes) } catch { }
  Remove-LinkQuiet $linkPath
  if ($linkKind -eq 'link' -and (Test-Path -LiteralPath $linkBak)) {
    try { [IO.Directory]::Move($linkBak, $linkPath) } catch { }
  }
  Fail ("装完核对没通过，已退回原样：`n  " + ($finalProblems -join "`n  ") + "`n`n备份在：" + $backupDir)
}

# ---------- 6) 清理 ----------
if ($linkKind -eq 'link' -and (Test-Path -LiteralPath $linkBak)) { Remove-LinkQuiet $linkBak }
if (Test-Path -LiteralPath $pkgTmp) { Remove-Item -LiteralPath $pkgTmp -Force -ErrorAction SilentlyContinue }
Say '✓ profile/package.json 已更新'
Say '✓ node_modules 已挂好（不需要 pnpm install）'

# ---------- 7) 说下一步 ----------
Say ''
Say '装完了，只剩一件事要做：'
Say '  自己重启 DSH 桌面版 —— 插件的宿主半要在启动时加载，不重启看不到那颗字形'
Say ''
Say '重启后：输入框工具条右侧会出现一颗小字形（默认绿圆＝「整理」），各档含义见 README 的「那颗字形」'
Say ''
Say ('回退办法（这次是' + $(if ($linkKind -eq 'link') { '覆盖安装：原来就有一个链接' } else { '首次安装：原来没有链接' }) + '）：')
Say ('  1. 把 ' + $pkgBak + ' 复制回 ' + $pkgPath)
if ($linkKind -eq 'none') {
  Say ('  2. 删掉 ' + $linkPath + '（删链接本身，别删插件目录）')
} else {
  Say ('  2. 删掉 ' + $linkPath + '，再重启 DSH；若想连旧链接一起还原，用这个脚本重装一遍更省事')
}
Say '  3. 重启 DSH'
Say ''
