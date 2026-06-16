import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface Turn {
  user: string | null;
  assistant: string[];
}
interface PeekData {
  file: string;
  when: string;
  msgCount: number;
  turnCount: number;
  mode: "turns" | "last";
  n: number;
  turns: Turn[];
  lastOutput: string | null;
  error?: string;
}

function codexHome(): string {
  const cfg = vscode.workspace.getConfiguration("codexPeek").get<string>("codexHome", "").trim();
  if (cfg) {
    return cfg;
  }
  if (process.env.CODEX_HOME) {
    return process.env.CODEX_HOME;
  }
  return path.join(os.homedir(), ".codex");
}

function findLatestSession(sessionsDir: string): string | undefined {
  let best: { path: string; mtime: number } | undefined;
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) {
      return;
    }
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        walk(full, depth + 1);
      } else if (it.isFile() && /^rollout-.*\.jsonl$/.test(it.name)) {
        let m: number;
        try {
          m = fs.statSync(full).mtimeMs;
        } catch {
          continue;
        }
        if (!best || m > best.mtime) {
          best = { path: full, mtime: m };
        }
      }
    }
  };
  walk(sessionsDir, 0);
  return best?.path;
}

function isInjected(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("<environment_context") ||
    t.startsWith("<user_instructions") ||
    t.startsWith("<system") ||
    t.startsWith("# AGENTS.md") ||
    t.startsWith("<EXIT") ||
    t.startsWith("<INTERRUPT")
  );
}

function textOf(payload: { content?: Array<{ text?: unknown }> }): string {
  if (!Array.isArray(payload.content)) {
    return "";
  }
  return payload.content
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .join("")
    .trim();
}

function extractMessages(file: string): Array<{ role: "user" | "assistant"; text: string }> {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (!s || s[0] !== "{") {
      continue;
    }
    let o: any;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (o.type !== "response_item" || o.payload?.type !== "message") {
      continue;
    }
    const role = o.payload.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = textOf(o.payload);
    if (!text) {
      continue;
    }
    if (role === "user" && isInjected(text)) {
      continue;
    }
    out.push({ role, text });
  }
  return out;
}

function toTurns(messages: Array<{ role: string; text: string }>): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      cur = { user: m.text, assistant: [] };
      turns.push(cur);
    } else {
      if (!cur) {
        cur = { user: null, assistant: [] };
        turns.push(cur);
      }
      cur.assistant.push(m.text);
    }
  }
  return turns;
}

function readCodex(mode: "turns" | "last", n: number): PeekData {
  const base: PeekData = {
    file: "",
    when: "",
    msgCount: 0,
    turnCount: 0,
    mode,
    n,
    turns: [],
    lastOutput: null,
  };
  const home = codexHome();
  const file = findLatestSession(path.join(home, "sessions"));
  if (!file) {
    return { ...base, error: `Codex 세션 파일을 찾지 못했습니다 (${path.join(home, "sessions")}).` };
  }
  const messages = extractMessages(file);
  const turns = toTurns(messages);
  let when = "?";
  try {
    when = new Date(fs.statSync(file).mtimeMs).toLocaleString();
  } catch {
    /* ignore */
  }
  const data: PeekData = {
    ...base,
    file: path.basename(file),
    when,
    msgCount: messages.length,
    turnCount: turns.length,
  };
  if (mode === "last") {
    const last = [...turns].reverse().find((t) => t.assistant.length);
    data.lastOutput = last ? last.assistant.join("\n\n") : null;
  } else {
    data.turns = turns.slice(-Math.max(1, n));
  }
  return data;
}

class PeekPanel {
  private panel?: vscode.WebviewPanel;
  private mode: "turns" | "last" = "turns";
  private n = 5;

  constructor(private readonly extensionUri: vscode.Uri) {}

  show(mode: "turns" | "last", n: number): void {
    this.mode = mode;
    this.n = n;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "codexPeek",
        "Codex Peek",
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] },
      );
      this.panel.webview.html = this.html(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === "refresh") {
          this.mode = msg.lastOnly ? "last" : "turns";
          this.n = Math.max(1, Number(msg.n) || this.n);
          this.post();
        }
      });
      this.panel.onDidDispose(() => (this.panel = undefined));
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside);
    }
    this.post();
  }

  refresh(): void {
    if (this.panel) {
      this.post();
    } else {
      this.show(this.mode, this.n);
    }
  }

  private post(): void {
    this.panel?.webview.postMessage({ type: "data", data: readCodex(this.mode, this.n) });
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Codex Peek</title>
<style>
  body { margin:0; color:var(--vscode-foreground); background:var(--vscode-editor-background);
    font-family:var(--vscode-font-family); font-size:var(--vscode-font-size); }
  .shell { max-width: 980px; margin:0 auto; padding:16px; }
  .bar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:12px; }
  h1 { font-size:16px; margin:0 8px 0 0; }
  .muted { color:var(--vscode-descriptionForeground); font-size:12px; }
  button { color:var(--vscode-button-foreground); background:var(--vscode-button-background);
    border:0; border-radius:4px; padding:5px 10px; cursor:pointer; font:inherit; }
  input[type=number] { width:64px; padding:4px 6px; background:var(--vscode-input-background);
    color:var(--vscode-input-foreground); border:1px solid var(--vscode-panel-border); border-radius:4px; font:inherit; }
  label { font-size:12px; display:flex; align-items:center; gap:4px; }
  .turn { border:1px solid var(--vscode-panel-border); border-radius:6px; padding:10px 12px; margin-bottom:10px;
    background:var(--vscode-sideBar-background); }
  .role { font-weight:600; font-size:12px; margin:8px 0 4px; color:var(--vscode-descriptionForeground); }
  .role:first-child { margin-top:0; }
  .text { white-space:pre-wrap; overflow-wrap:anywhere; }
  .err { color:var(--vscode-charts-red); }
</style>
</head>
<body>
<main class="shell">
  <div class="bar">
    <h1>Codex Peek</h1>
    <label>최근 <input type="number" id="n" min="1" value="5"> 턴</label>
    <label><input type="checkbox" id="lastOnly"> 마지막 출력만</label>
    <button id="refresh">새로고침</button>
  </div>
  <div id="meta" class="muted"></div>
  <div id="body"></div>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const nInput = document.getElementById("n");
  const lastOnly = document.getElementById("lastOnly");
  const meta = document.getElementById("meta");
  const body = document.getElementById("body");
  function send() {
    vscode.postMessage({ type:"refresh", n: Number(nInput.value)||5, lastOnly: lastOnly.checked });
  }
  document.getElementById("refresh").addEventListener("click", send);
  nInput.addEventListener("change", send);
  lastOnly.addEventListener("change", () => { nInput.disabled = lastOnly.checked; send(); });

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;   // textContent = HTML/따옴표 안전
    return e;
  }
  window.addEventListener("message", (ev) => {
    if (ev.data?.type !== "data") return;
    const d = ev.data.data;
    body.replaceChildren();
    if (d.error) { meta.textContent = ""; body.appendChild(el("div","err", d.error)); return; }
    meta.textContent = d.file + " · " + d.when + " · 메시지 " + d.msgCount + " · 턴 " + d.turnCount;
    if (d.mode === "last") {
      const card = el("div","turn");
      card.appendChild(el("div","role","🤖 Codex 마지막 출력"));
      card.appendChild(el("div","text", d.lastOutput || "(어시스턴트 출력 없음)"));
      body.appendChild(card);
      return;
    }
    if (!d.turns.length) { body.appendChild(el("div","muted","(표시할 대화 없음)")); return; }
    const start = d.turnCount - d.turns.length;
    d.turns.forEach((t, i) => {
      const card = el("div","turn");
      const head = el("div","role","── 턴 " + (start + i + 1) + " ──");
      card.appendChild(head);
      if (t.user) { card.appendChild(el("div","role","👤 사용자")); card.appendChild(el("div","text", t.user)); }
      if (t.assistant.length) { card.appendChild(el("div","role","🤖 Codex")); card.appendChild(el("div","text", t.assistant.join("\\n\\n"))); }
      body.appendChild(card);
    });
  });
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function activate(context: vscode.ExtensionContext): void {
  const panel = new PeekPanel(context.extensionUri);
  const defTurns = () =>
    Math.max(1, vscode.workspace.getConfiguration("codexPeek").get<number>("defaultTurns", 5));

  context.subscriptions.push(
    vscode.commands.registerCommand("codexPeek.open", () => panel.show("turns", defTurns())),
    vscode.commands.registerCommand("codexPeek.lastOutput", () => panel.show("last", defTurns())),
    vscode.commands.registerCommand("codexPeek.refresh", () => panel.refresh()),
  );
}

export function deactivate(): void {}
