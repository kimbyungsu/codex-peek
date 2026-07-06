# Claude Code ↔ Codex Bridge

Connect **Claude Code** (implementation) and **OpenAI Codex** (verification) into one workflow — no human copy-pasting between the two AIs. Pin a Codex session, inject your fixed rules every turn, and (opt-in) let the harness **force** an implement → verify loop with real proof.

![Dashboard](https://raw.githubusercontent.com/kimbyungsu/codex-peek/main/docs/dashboard.en.png)

## What it does

- **Session pinning** — links your workspace to one Codex session; the link survives reloads, compaction, and restarts. Once the hooks are set up, raw `codex` calls **from Claude Code** are guarded so Claude's Codex access goes through the bridge (your own terminal is untouched).
- **Per-project contract** — rules you write in the dashboard are injected every turn (Claude via hook, Codex prepended to every ask). Per-project only, no inheritance; empty boxes cost zero tokens.
- **Verify mode (opt-in, default OFF)** — on code change / plan confirm / every turn (your pick), a Stop hook blocks Claude from finishing until it gets a **real, successful** Codex verification. Fake or echoed commands don't count: the bridge writes a proof only on actual success, and editing after verification forces re-verification. Bounded retries (default 3) so it never hard-locks your session.
- **Live visualization** — status bar flow (`[Claude] ▶▶ verifying [Codex]`), red/yellow integrity alerts (turn ended unverified, verdict failed, cited file:line doesn't exist, model/effort drift), and a dashboard showing the *actual* verification conversation with 4-color verdict chips (pass / pass-with-notes / hold / fail).
- **Verification statistics tab** — verdict distribution (donut + bars, 28 days), 14-day trend, weekday×hour activity heatmap, tokens per model·reasoning-effort·verify-mode, Claude work tokens + turns, per-project comparison. All local, metadata only (no prompt/answer bodies stored).
- **Track selector (2-track default / 3-track advisory)** — 3-track adds a **scope ledger** card: for the files you're changing right now, it mines *this project's own git history* for "what historically changed together" candidates. Purely local git queries (nothing sent anywhere — no GitHub/remote account needed; a never-pushed repo works identically), blocks/forces nothing, saved per project, and when the sample is too small it honestly says "no data" instead of guessing. **Prerequisite: it reads local git *commit history* — in folders without git, or projects that rarely commit, "no data" is the normal, honest state (not a bug).**
- **One-click setup, clean uninstall** — the extension deploys its bridge engine into its own folder automatically. Claude Code hooks are registered **only after you review and consent** (you see the exact file, backup path, and the 3 hook lines first; other hooks are preserved). Uninstalling the extension removes only what it installed — your links, contracts, and stats are kept.

## Requirements

- **Claude Code** CLI (hooks support) and **OpenAI Codex** CLI (`codex exec`) — the codex binary is auto-detected (ChatGPT VS Code extension, `PATH`, or `CODEX_BIN`).
- **Node.js 20+** (used by the hooks; the setup flow verifies the path actually runs).

## Getting started

1. Install this extension.
2. A notification appears if verification hooks aren't registered — click **Review & install**, check what will change (file, backup, 3 hook lines), then click **Install**. (Command palette: `Codex Bridge: Claude Code 검증 훅 설치` any time.)
3. Click the status bar item to open the dashboard: link a Codex session, write your contract, pick a verify mode.
4. Verification takes effect from the next Claude Code session.

## Safety & privacy

- **The extension and bridge add no telemetry and no server of their own.** All bridge data stays in local files. Calling Codex runs *your* local `codex` CLI — network traffic to OpenAI/Anthropic is whatever those CLIs normally do, nothing extra. **Single exception**: when DeepSeek map generation *runs* (3-track scouting) — either you run it directly, or Claude runs it under the 3-track auto-directive (key registration = consent; the extension/hooks themselves never transmit) — the evidence package is sent to the DeepSeek API; what is sent, what is auto-excluded, and the trigger conditions are documented in [PRIVACY](https://github.com/kimbyungsu/codex-peek/blob/main/PRIVACY.md).
- Codex session files are **read-only** (single exception: the "permanently delete" button you explicitly confirm).
- `settings.json` is only modified after your consent, with a timestamped backup; other hooks are preserved.
- Full policy docs: [PRIVACY](https://github.com/kimbyungsu/codex-peek/blob/main/PRIVACY.md) · [SECURITY](https://github.com/kimbyungsu/codex-peek/blob/main/SECURITY.md) · [COMPATIBILITY](https://github.com/kimbyungsu/codex-peek/blob/main/COMPATIBILITY.md)

## Honest limits

Injection keeps rules in front of the model every turn, and the verify loop enforces that a real verification happened — but no harness can guarantee a model's *judgment* is correct. That's why the dashboard shows you the actual verification conversation instead of just a green badge.

## Docs & source

Full documentation (Korean): **https://github.com/kimbyungsu/codex-peek**
Issues & feedback: https://github.com/kimbyungsu/codex-peek/issues

## License

MIT
