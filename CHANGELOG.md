# Changelog

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

有人在朋友机器上双击 `install.cmd`，窗口吐出一串看不懂的错。查下来是三个问题叠在一起。

### 修复

- **`install.cmd` 的编码和行尾全错了**：原来存成 UTF-8 + LF。cmd.exe 按本地代码页读批处理，
  中文行被读串，连带把 `setlocal` 这类纯 ASCII 行也切坏——报出来的是
  「'p' 不是内部或外部命令」「'tlocal' 不是内部或外部命令」这种完全无法定位的错。
  现在改成**纯 ASCII + CRLF**，并在开头 `chcp 65001` 让 install.sh 的中文输出正常显示
- **找不到 bash 就罢工，而 Git 默认不在 PATH 上**：原脚本只试 `where bash`，
  失败就退出。可 Git for Windows 默认不把 `bin` 加进 PATH。现在依次找：
  PATH → `%ProgramFiles%\Git` → `%ProgramFiles(x86)%\Git` → `%LocalAppData%\Programs\Git` →
  由 `git.exe` 反推 `..\bin\bash.exe`；同时跳过 WSL 的 `System32\bash.exe`（它跑不了这个脚本）
- **默认档位和文档不一致**：`DEFAULTS.level` 是 `2`（慢断，会掐断生成并自动续轮），
  而 README 和代码注释都写「默认停在提示档」。`2` 是五档重排前的残留——那会儿 2 还是「只提醒」。
  改回 **`1`**，与文档一致，新装的人也不会一上来就被掐
- `install.sh` 缺 `node` / `pnpm` 时报错含糊（`node: command not found` 或一大段 Node 栈），
  现在开始动手前先自检，直接说缺哪个、去哪装
- README 的 `streamKillMinChars` 还写着 `1000`（v0.2.0 已改成 `600`）；
  「详细步骤」那个指向 `#-安装-1` 的锚点是死的

## [0.2.0] — 2026-11-24

第一次正式发版。从「能跑」做到「能给别人用」。

### 新增

- **历史消毒**（`scrubDegenerateHistory`）：发请求前把历史上已退化的 reasoning 块换成一句短注记。
  这是唯一治本的手段——退化的思考会被逐轮回传，模型模仿自己、越滚越深
- **英文版全套**：README、7 张章节头、动图、滑条图、拖动图都有 `-en` 版本
- **宣传物料**：`promo.png`（横版）、`promo-phone.png`（手机卡）、`promo-square.png`（朋友圈）、
  `promo-safe.png`（安全区版，内容收在中心 640×640，手机裁切不丢信息）
- **`drag.svg` 拖动动图**：五档逐档说明，停在哪一档就显示那一档做什么、代价是什么

### 变更

- 包名 `dsh-reasoning-guard` → **`dsh-thinking-guard`**
- 状态文件 `thinking-guard.json`（旧文件名仍可读，有 fallback）
- 文档全面重写成第一人称叙述，段落和标题不带句号

### 修复

- **快断档光效闪烁**：呼吸周期 0.9s ≈ 1.1Hz 落在人眼最敏感的闪烁频率上，改为 1.6s / 2.3s；
  两层呼吸加 `animationDelay: '-1.1s'` 错开相位；opacity 摆动范围收敛
- **光效熄灭太快**：340ms → 620ms（点亮仍 180ms）
- **掐断太晚**：`streamKillMinChars` 默认 1000 → **600**。
  实测：开发这个插件的当天，它命中 6 次掐流，但每次都是在 1000 字符才动手——
  在那之前已经空转了七八十行。连续 15 行短行本身就是强信号，不必再等 1000 字符
- 滑条卡片外发光在底边露出一条亮线
- README 里的语言切换链接写成 `<p>` 内的 markdown，根本点不动

### 文档

- README 按「症状 → 背景 → 做什么 → 安装 → 滑条 → 原理」重排，配图全部统一成白底 + 符号点阵
- 所有图片宽度改为 `100%` 自适应，手机端字号按 40% 缩放反推

## [0.1.0] — 2026-11-23

内部版本。五档滑条、流内掐断、免责声明、中英 README 初版。
