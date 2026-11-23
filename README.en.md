<p align="center">
  <img src="assets/banner-v2.svg" alt="dsh-thinking-guard" width="880">
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-2dd4bf"></a>
  <a href="package.json"><img alt="Node" src="https://img.shields.io/badge/node-%3E%3D20-60a5fa"></a>
  <a href="package.json"><img alt="DSH" src="https://img.shields.io/badge/DSH-%E2%89%A50.2.0--rc.1-a78bfa"></a>
  <img alt="tests" src="https://img.shields.io/badge/tests-54%20passing-4ade80">
</p>

<p align="center">
  <b>A loop guard for the thinking channel</b> — detects and cuts the placeholder loop a model
  falls into while reasoning, with a five-step intensity slider in the composer toolbar.
</p>

<p align="center">
  <a href="#-the-symptom">Symptom</a> ·
  <a href="#-what-it-does">What it does</a> ·
  <a href="#-install">Install</a> ·
  <a href="#-the-five-step-slider">Slider</a> ·
  <a href="#-why-it-works">Why</a> ·
  <a href="#-configuration">Config</a>
</p>

<p align="center"><b>English</b> · <a href="README.md">中文</a></p>

---

<p align="center">
  <img src="assets/head/sym.svg" alt="" width="880">
</p>

## 😵 The symptom

The model suddenly starts chanting inside the **thinking channel**:

```
做。
好。
做。
```

No text, no tool call, just rolling — the community calls it "singing". After a few hundred lines it
usually does emit the right tool call, but **the time is already gone**, and from the outside you
cannot tell deep thinking from spinning.

**Measured** on one 157-turn session:

| Metric | Value |
|---|---|
| Worst block | 602 of 686 lines were placeholder verbs |
| Vocabulary | `做。`×1180, `好。`×1068 — two words carrying 2000+ lines |
| How those blocks ended | **All of them** emitted the correct tool call |

So it is not "thought of it but did not act" — it is **rehearsing the same line hundreds of times before acting**.

<p align="center">
  <img src="assets/loop.svg" alt="the loop being cut" width="880">
</p>

<p align="center">
  <img src="assets/head/why.svg" alt="" width="880">
</p>

## 📜 Background: how this came about

It did not start as an idea for a plugin. It started with a ghost.

In a drawing session the model sat on "thinking" for minutes. Opening the block:

```
做。
好。
做。
```

No text, no tool call, just rolling. Two thousand lines later it emitted a perfectly correct tool call —
**the task got done, but everything in between was burned for nothing**.

So I started from the cheapest ideas and falsified them one by one:

| What was tried | Result |
|---|---|
| `stop_sequences` | Reached the server, **does not apply to thinking** — the request carried it, the trigram appeared on line 19, generation ran to line 121 |
| `frequency_penalty` / `presence_penalty` | Documented as deprecated; sending them does nothing |
| `temperature` | No effect in thinking mode |
| `tool_choice: required` | 400 in thinking mode |
| Shrinking `max_tokens` | Truncates honest answers; rejected |
| Reminders in tool results | `tool/result` is a session event append, not a hook |

Only then came "count inside the stream and cut" — and cutting turned out to end the turn outright
(a stop with no tool call), which is why the fast tier synthesizes a read-only call to push the turn forward.

**The real fix came last**: DSH discussion #7270 shows degenerate thinking is replayed into every following
turn, so the model imitates itself. The plugin now strips that garbage from the context before each request.

> The community calls this "singing". It is not something you configured wrong — it is a known degeneration
> of reasoning models under long context and high effort.

---

<p align="center">
  <img src="assets/head/what.svg" alt="" width="880">
</p>

## 🛠 What it does

Five escalating tiers. The further down, the more effective and the more expensive. The default is the cleanest one.

| Tier | What it does | Price |
|---|---|---|
| 0 Off | Nothing | none |
| **1 Tell** (default) | System prompt forbids the empty verbs and hands out a closing template | a few dozen characters per request |
| 2 Cut slow | Cuts the generation, resumes via followup | waits 7–21 s, history stays clean |
| 3 Cut fast | Cuts, then injects a read-only tool call so the turn continues | a fake record in history, latency <1 s |
| 4 Abort | Third consecutive loop aborts the turn | you see a failed-run message |

Plus one step that is **not on the slider** and always on: before a request goes out, already-degenerate
reasoning is stripped from the context (see [Why](#-why-it-works)).

<p align="center">
  <img src="assets/head/install.svg" alt="" width="880">
</p>

## 🚀 Install

**One click** (no command line needed):

1. **Code → Download ZIP**, unzip to a location you will keep (the plugin loads from there)
2. Windows: double-click `install.cmd`; macOS / Linux: run `bash install.sh`
3. The script prints two steps — run `pnpm install` in the profile it names, then **restart DSH yourself**
4. After the restart you get a five-segment slider at the right of the composer toolbar, defaulting to Tell

The script only backs up the profile's `package.json`, adds a `link:` dependency, and registers the
package in `dsh.profile.bundles`. **It never touches session data and never restarts your DSH.**

<p align="center">
  <img src="assets/head/slider.svg" alt="" width="880">
</p>

## 🎚 The five-step slider

<p align="center">
  <img src="assets/slider.svg" alt="five-step slider" width="880">
</p>

- **Collapsed**, only the current step is drawn; press / drag / focus expands the whole track
- **Glow** means "this conversation was set by hand", always in the tier colour; inherited values stay quiet
- The outline turns **violet** while you drag; pull **up past 10px** to lock the value globally
- From tier 2 upward a one-time warning explains what that tier does and what it costs

<p align="center">
  <img src="assets/head/how.svg" alt="" width="880">
</p>

## 🧠 Why it works

1. **Abstraction is the disease, specifics are the cure.** Every degenerate block escapes the same way — `（输出 image_crop。）`. The prompt does not scold ("stop looping" is the same shape as the disease); it hands out a template: `调用 <tool名>，参数 <值>`.
2. **Cutting only stops this turn.** An early-ended generator looks like a normal stop — no error, no retry, just a step with no tool call.
3. **The real cause is next turn's input.** Degenerate thinking is replayed into every following turn ([DSH discussion #7270](https://github.com/deepseek-ai/deepseek-harness/discussions/7270)), so the model imitates itself. The plugin therefore replaces already-degenerate reasoning with a short note before each request — touching reasoning only.

## 📖 Contents

- [The symptom](#-the-symptom)
- [Background](#-background-how-this-came-about)
- [What it does](#-what-it-does)
- [Install](#-install)
- [The five-step slider](#-the-five-step-slider)
- [Why it works](#-why-it-works)
- [The cure: stripping degenerate thinking](#-the-cure-stripping-degenerate-thinking-from-context)
- [Detector](#-detector-what-counts-as-a-loop)
- [Install details](#-install-details)
- [Configuration](#-configuration)
- [Known limits](#-known-limits)
- [Tests](#-tests)

---

## 📊 1. What it actually treats

### The symptom

Inside the reasoning channel the model degrades into this:

```
…the hem is in the lower part (y 0.6-1.0).
Crop it and look.
Do.
Hmm, tiledup is 2048×2560.
Do.
Ok.
Do.
Ok.
Do.
Ok.
…(a few hundred more lines)
```

Three things to notice:

1. **`Do.` and `Ok.` have no object.** They are not reasoning — they are placeholders that *simulate* acting, without acting.
2. **The tool calls are fine.** When it finally escapes it emits exactly the right call. What is broken is the rhythm, not the judgment.
3. **It knows.** In the real log it scolded itself: "(I'm stuck in a loop, just output.)" "(This is absurd.)" "(I'm wasting tokens.)" — then went on for four hundred more lines.

### One measured breakdown

A single session, 420 reasoning blocks (2026-11-23):

| Metric | Value |
|---|---|
| Blocks with a run of 40+ placeholder lines | 10 |
| Worst block | 602 of 686 lines were placeholders |
| Vocabulary | `Do.`×1180, `Ok.`×1068 — two words carried 2000+ lines |
| How those 10 blocks ended | **all ten** emitted correct tool calls |

### Why not just lower the reasoning effort

Lowering effort trades global depth for stability: every task thinks less, including the ones that genuinely need depth. Loops only happen at specific moments. So this plugin does not take that route — it stays out of the way until the moment arrives.

### How it escapes (this drove the design)

Look at the last lines of each block; the escape is always the same shape:

- `(Output image_crop.)`
- `(Write bash: retry IPAdapter.)`
- `(I need to simplify. Call read_image.)`

**Abstraction is the disease; a concrete referent is the cure.** The moment it produces a sentence naming an actual tool, thinking ends and the hand moves. That is why "stop looping" style nudges are useless — they share the shape of the disease.

---

## 🎚 2. The slider: five steps, cool to warm

> [!WARNING]
> **Raising the tier really does change model behaviour, and one tier writes a fake record into your session history.**
>
> - **Tier 3 (Cut fast) synthesizes a `get_goal` tool call** to push the turn forward. That record is **fake**, it stays in history, and the model can see it on the next step. Choosing it trades a clean history for not waiting. It is a deliberate trade-off, not a defect — stay at tier 2 or below if that is unacceptable.
> - **Tier 4 (Abort) kills the turn outright**; you will see a failed-run message and that turn's work is lost.
> - **Tier 2 (Cut slow) writes nothing fake**, but costs 7–21 seconds.
> - The default, tier 1 (Tell), **does not touch the request at all** — it only adds a few dozen characters to the system prompt. Stay there if unsure.

Five small segments at the right of the composer toolbar. Colour runs **cool → warm** as intervention strength rises:

| Step | Colour | Name | What it does | Cost |
|---|---|---|---|---|
| 0 | grey `#94a3b8` | Off | No involvement at all | none |
| 1 | blue `#60a5fa` | Tell | The **system prompt** forbids 做。 好。 写。 and hands it a closing template | a few dozen characters per request |
| 2 | teal `#2dd4bf` | Cut slow | Counts short lines, **ends the generation**, then resumes via followup | waits 7–21 s, history stays clean |
| 3 | amber `#fbbf24` | Cut fast | Same cut, but injects a read-only tool call so the turn continues at once | a fake call lands in history, latency <1 s |
| 4 | red `#f87171` | Abort | Third consecutive loop in one session hard-aborts the turn | strongest, most likely to bite |

**Escalation**: Tell → Cut slow → Cut fast → Abort. Each step is more effective and more
expensive: slow buys cleanliness with time, fast buys time with history, abort ends the turn.

**From tier 2 upward a disclaimer appears**, spelling out what that tier does and what it costs —
teal for Cut slow, amber for Cut fast, red for Abort, each with its own wording.

| Tier | How often | Can it be silenced |
| --- | --- | --- |
| 2 Cut slow / 3 Cut fast | shown once, on first visit | tick "do not remind me again" and it stops asking |
| **4 Abort** | **every time** | **never silent** — you must tick "I know this aborts the turn" to continue |

Abort gets no exemption on purpose: it kills the whole turn, which is a different magnitude
from "slower" or "leaves a record". **Abort cannot be set globally either** — pulling up to lock it
is intercepted, the dialog explains why, and the button becomes "this conversation only".



- **Default is 1 (Tell).** Level 3 writes a fake tool call into history and level 4 aborts the turn — both are feel-changing choices, so they are off by default.
- Read the three layers together: **Tell** is the risk-free floor, **Cut** changes the stream itself, **Abort** ends the turn. The further down, the more effective and the dirtier.
- **Two scopes**:
  - **This conversation** (plain drag) — changes only the current conversation;
  - **Global default** — every conversation without its own override follows it. Three ways in: **drag upward past 10px** (the track gains a violet outline, the label switches to “全局”, the control lifts slightly), **double-click the track**, or **hold ↑** for about half a second.
  - Precedence: this conversation's override > global default > the fallback in the profile config. Setting the global value clears existing per-conversation overrides — “set for all” should mean all.
  - **The glow means “this conversation was set by hand”**: inherited values (global default / config default) stay quiet — the default state should not glow at you. Setting the global value gives a brief violet afterglow that fades once it settles.
  - A faint outline in the current step's colour marks a conversation that has its own override.
- Click or drag left/right; arrow keys, Home and End are supported.
- **The track stays collapsed** to the current step (glow included); pressing, dragging, or keyboard focus expands it, and releasing or blurring collapses it again.
- **Dragging back to the inherited value counts as “never set”**: the host drops this conversation's override and the glow fades out over ~0.3s instead of vanishing.
- Hovering a step shows its full explanation.

---

## 🔍 3. Detection: what counts as a loop

It counts **consecutive placeholder lines**, not the share of short lines.

The latter looks simpler but misreads genuine analytical openers — "maybe:", "I should:", "hmm, let me think:" — as placeholders. Measured: five false positives per session.

| Condition | Meaning |
|---|---|
| run ≥ `maxRun` (25) | flagged outright |
| or run ≥ `looseRun` (15) **and** unique-line ratio ≤ `looseUniq` (0.4) | catches short but dense loops |
| fewer than `minLines` (10) lines | not examined |

The union of the two keeps the detector working when the model switches to a different verbal tic.

**Measured headroom**: outside the one broken session (whose healthy blocks reached 20), the longest placeholder run across 968 healthy blocks in five other sessions was **1–3 lines**; broken blocks start at 40. The threshold at 25 sits between, with margin on both sides.

---

## 📦 4. Install

Link it into the profile (does not touch other packages under `node_modules`):

```bash
# from the profile directory, e.g. ~/.dsh/profiles/desktop
pnpm add link:<absolute path to this directory> -w
```

Then add the package name to `dsh.profile.bundles` in the profile's `package.json` and **restart DSH yourself**.

After the restart: a slider appears at the right of the composer toolbar, and `dsh-thinking-guard` shows up on the plugins page.

**Rollback**: remove the `link:` dependency line and the `bundles` entry, then restart. The plugin writes no existing data; its only output is `$DSH_HOME/thinking-guard.json` (per-session level), which is safe to delete.

---

<p align="center">
  <img src="assets/head/cfg.svg" alt="" width="880">
</p>

## ⚙️ 5. Configuration

Any key can be overridden from a profile patch:

| Key | Default | Meaning |
|---|---|---|
| `level` | `2` | Fallback intensity when a session has no slider record (0–4) |
| `maxRun` | `25` | Consecutive marker lines before it counts as a loop (strict: contentless imperatives only) |
| `looseRun` | `15` | Loose threshold, used together with `looseUniq` |
| `looseUniq` | `0.4` | Max unique-line ratio under the loose rule, so repeated-but-real content is not flagged |
| `minLines` | `10` | Below this many lines nothing is judged at all |
| `fuseAfter` | `3` | Consecutive hits before aborting the turn (tier 4 only); 0 disables |
| `promptText` | one Chinese sentence | System-prompt section; empty means not registered. The default targets the root cause |
| `noticeText` | `''` | Notice text for the next step; empty means never inject. Available: `{maxRun}` `{lines}` `{ratio}` |
| `stopSequences` | three Chinese trigrams | Sequences attached to the request, at most 16. **Measured to affect the answer body only, not thinking** |
| `stopEnabled` | `true` | Whether to attach `stop` sequences from tier 2 up |
| `degradedMaxTokens` | `0` | Budget cap for the step after a loop; **off by default** (capping truncates honest answers) |
| `streamKillEnabled` | `true` | Master switch for the mid-stream cut |
| `streamKillRun` | `15` | Trailing 1–6 character lines needed to cut; 0 disables |
| `streamKillMinChars` | `1000` | Never cut a thought shorter than this — protects short steps |
| `streamKillDryRun` | `false` | Dry run: log "would have cut" without cutting |
| `afterKillText` | one Chinese sentence | Message handed to the model after a cut; empty means none |
| `maxKillStreak` | `3` | Stop cutting after this many cuts in a row in one session; 0 disables |
| `streamKillFastContinue` | `true` | At tier 3+, use the synthesized continuation (<1 s); false forces followup |
| `fakeToolName` | `get_goal` | Tool name used by the synthesized call; must be read-only and idempotent |
| `followupFallback` | `true` | Slow path: resume by delivering a message via `agent.followup` |
| `traceEnabled` | `true` | Write middleware checkpoints to `$DSH_HOME/thinking-guard-trace.log` |

### Three remedies, three very different prices

All three treat the same disease, but they cost very different things. Only the first is on by default; the other two are yours to decide.

| Remedy | Gain | Price | Recommendation |
|---|---|---|---|
| **System prompt** (`promptText`) | Stops it from parking on contentless verbs, so loops happen less | A few dozen extra characters in every request | **On by default.** Zero latency, nothing fabricated, portable |
| **Post-hoc notice** (`noticeText`) | Tells it, on the next step, that it was spinning | This turn's waste already happened | Turn on if you want it to know |
| **Mid-stream cut** (`streamKill*`) | Cuts the generation, saving the following hundreds of lines | **Needs a follow-up turn**: the fast path injects a synthesized tool call (a fake call stays in history); the slow path waits 7–21 s | **Off by default.** Only when you are watching and would trade a fake history entry for time |

About `stopSequences`: measured to apply **to the answer text only, not to thinking** (DeepSeek does not truncate reasoning on it). It is kept because it may still constrain the answer body — do not count on it for loops.

**No personality is baked in.** A silent doorman is `noticeText` and `promptText` left empty; a nagging supervisor is one sentence; a post-hoc report is your own code reading the log at turn end. Whether it speaks, and what it says, is the user's call.

---

## 🧩 6. The browser half must be wrapped in `__ModuleLoader__`

`lib/client.js` is not a plain ES module:

```js
window.__ModuleLoader__.load({ id: "dsh-thinking-guard", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var React = require("react");
  // …body…
return module.exports; } });
```

`id` must equal the package name, and `React` must come from `require("react")`. Missing this wrapper fails in a nasty way: **the host half looks perfectly healthy** (its loopback route answers 200, the plugins page lists it) while nothing renders and nothing is logged.

---

## ⚠️ 7. Known unverified

- **Whether `stop_sequences` is actually accepted by DeepSeek's Messages API and takes effect in thinking mode has not been tested against a live request.** The code path is proven (`config.stop` → `GenerateOptions.stop` → serialised as `stop_sequences`), but only the server can confirm. First thing after installing: push the slider to 3, run a long task, and watch whether generation halts the moment it writes the loop string.
- Recall is evidenced by one session only; precision is zero-false-positive across 968 healthy blocks in five other sessions.

## ✅ 8. Tests

```bash
node --test "tests/*.test.mjs"
```

52 cases, covering: detector maths (strict and loose rules, blank-line skipping), per-tier behaviour (tier 1 must not cap the budget; tier 2 caps exactly one step), stream-cut thresholds and early stop, the synthesized continuation (finish must be `tool-calls` and a tool-call block must exist), followup resumption and the no-duplicate-notice rule, the hook requiring a session id, stop merging/dedup and the 16 limit, notice template substitution, abort and streak reset, per-session state isolation and corrupt-file tolerance, slider routes (GET/POST/403/400/405), browser-half load protocol and render path, colour-ramp ordering and tier count, and explanation-text length.
