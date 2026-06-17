import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const HOME = os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const LINKS_FILE = path.join(HOME, ".codex-bridge", "links.json");
const CONTRACT_FILE = path.join(HOME, ".codex-bridge", "contract.json");
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

interface Turn {
  user: string | null;
  assistant: string[];
}
interface Candidate {
  id: string;
  when: string;
  snippet: string;
  linked: boolean;
}
interface BridgeState {
  workspace: string | null;
  linkedId: string | null;
  linkedSnippet: string;
  linkedAt: string | null;
  lastActivity: string | null;
  turns: Turn[];
  candidates: Candidate[];
  contract: Contract;
}

function normWs(p: string): string {
  return path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase();
}

function currentWorkspace(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function loadLinks(): { bySession: Record<string, any>; byWorkspace: Record<string, any> } {
  try {
    const o = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
    return { bySession: o.bySession || {}, byWorkspace: o.byWorkspace || {} };
  } catch {
    return { bySession: {}, byWorkspace: {} };
  }
}

type VerifyMode = "off" | "code" | "plancode" | "always";
const VERIFY_MODES: VerifyMode[] = ["off", "code", "plancode", "always"];
function normVerifyMode(o: any): VerifyMode {
  if (o && VERIFY_MODES.includes(o.verifyMode)) return o.verifyMode;
  if (o && o.verify === true) return "code"; // 레거시 verify:true → code 마이그레이션
  return "off";
}

interface Contract {
  claude: string[];
  codex: string[];
  claudeChecklist: boolean;
  codexChecklist: boolean;
  verifyMode: VerifyMode;
}

function loadContract(): Contract {
  try {
    const o = JSON.parse(fs.readFileSync(CONTRACT_FILE, "utf8"));
    return {
      claude: Array.isArray(o.claude) ? o.claude : [],
      codex: Array.isArray(o.codex) ? o.codex : [],
      claudeChecklist: o.claudeChecklist !== false,
      codexChecklist: o.codexChecklist !== false,
      verifyMode: normVerifyMode(o),
    };
  } catch {
    return { claude: [], codex: [], claudeChecklist: true, codexChecklist: true, verifyMode: "off" };
  }
}

function saveContract(c: Contract): void {
  fs.mkdirSync(path.dirname(CONTRACT_FILE), { recursive: true });
  fs.writeFileSync(CONTRACT_FILE, JSON.stringify({ ...c, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

function workspaceLink(links: ReturnType<typeof loadLinks>, ws: string | null): any | null {
  if (!ws) return null;
  const n = normWs(ws);
  for (const k of Object.keys(links.byWorkspace)) {
    if (normWs(k) === n) return links.byWorkspace[k];
  }
  return null;
}

function findRolloutById(uuid: string): string | undefined {
  let found: string | undefined;
  const walk = (d: string, depth: number) => {
    if (found || depth > 6) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (found) return;
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && it.name.includes(uuid) && it.name.endsWith(".jsonl")) found = full;
    }
  };
  walk(SESSIONS_DIR, 0);
  return found;
}

function recentRollouts(limit: number): Array<{ id: string; file: string; mtime: number }> {
  const out: Array<{ id: string; file: string; mtime: number }> = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && /^rollout-.*\.jsonl$/.test(it.name)) {
        const m = it.name.match(UUID_RE);
        if (!m) continue;
        let mt = 0;
        try {
          mt = fs.statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        out.push({ id: m[1], file: full, mtime: mt });
      }
    }
  };
  walk(SESSIONS_DIR, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function isInjected(t: string): boolean {
  const s = t.trimStart();
  return /^<(environment_context|user_instructions|system)/i.test(s) || s.startsWith("# AGENTS.md");
}

function readMessages(file: string): Array<{ role: "user" | "assistant"; text: string }> {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    let o: any;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (o.type !== "response_item" || o.payload?.type !== "message") continue;
    const role = o.payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = (o.payload.content || []).map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("").trim();
    if (!text) continue;
    if (role === "user" && isInjected(text)) continue;
    out.push({ role, text });
  }
  return out;
}

function firstSnippet(file: string): string {
  for (const m of readMessages(file)) {
    if (m.role === "user") return m.text.replace(/\s+/g, " ").slice(0, 70);
  }
  return "(내용 미상)";
}

function toTurns(msgs: Array<{ role: string; text: string }>): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const m of msgs) {
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

function computeState(turnsN: number): BridgeState {
  const ws = currentWorkspace();
  const links = loadLinks();
  const link = workspaceLink(links, ws);
  const linkedId: string | null = link?.codexSession ?? null;

  let turns: Turn[] = [];
  let lastActivity: string | null = null;
  if (linkedId) {
    const file = findRolloutById(linkedId);
    if (file) {
      turns = toTurns(readMessages(file)).slice(-Math.max(1, turnsN));
      try {
        lastActivity = new Date(fs.statSync(file).mtimeMs).toLocaleString();
      } catch {
        /* ignore */
      }
    }
  }

  const candidates: Candidate[] = recentRollouts(12).map((r) => ({
    id: r.id,
    when: r.mtime ? new Date(r.mtime).toLocaleString() : "",
    snippet: firstSnippet(r.file),
    linked: r.id === linkedId,
  }));

  return {
    workspace: ws,
    linkedId,
    linkedSnippet: linkedId ? candidates.find((c) => c.id === linkedId)?.snippet ?? "" : "",
    linkedAt: link?.linkedAt ?? null,
    lastActivity,
    turns,
    candidates,
    contract: loadContract(),
  };
}

function relink(id: string): void {
  const ws = currentWorkspace();
  if (!ws) return;
  let o: any = {};
  try {
    o = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
  } catch {
    o = {};
  }
  o.bySession = o.bySession || {};
  o.byWorkspace = o.byWorkspace || {};
  const n = normWs(ws);
  // 이 워크스페이스의 세션 고정/옛 워크스페이스 키 정리 → UI 선택을 우선시.
  for (const k of Object.keys(o.bySession)) {
    if (o.bySession[k] && normWs(o.bySession[k].workspace || "") === n) delete o.bySession[k];
  }
  for (const k of Object.keys(o.byWorkspace)) {
    if (normWs(k) === n) delete o.byWorkspace[k];
  }
  o.byWorkspace[n] = { codexSession: id, workspace: ws, linkedAt: new Date().toISOString(), via: "ui" };
  fs.mkdirSync(path.dirname(LINKS_FILE), { recursive: true });
  fs.writeFileSync(LINKS_FILE, JSON.stringify(o, null, 2), "utf8");
}

class Dashboard {
  private panel?: vscode.WebviewPanel;
  constructor(private readonly uri: vscode.Uri, private readonly turnsN: () => number) {}

  show(): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("codexBridge", "Codex Bridge", vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.uri],
      });
      this.panel.webview.html = this.html(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((m) => {
        if (m?.type === "relink" && m.id) {
          relink(String(m.id));
          this.post();
          vscode.commands.executeCommand("codexBridge.refresh");
        }
        if (m?.type === "saveContract") {
          saveContract({
            claude: Array.isArray(m.claude) ? m.claude : [],
            codex: Array.isArray(m.codex) ? m.codex : [],
            claudeChecklist: !!m.claudeChecklist,
            codexChecklist: !!m.codexChecklist,
            verifyMode: normVerifyMode({ verifyMode: m.verifyMode }),
          });
          this.post();
        }
        if (m?.type === "refresh") this.post();
      });
      this.panel.onDidDispose(() => (this.panel = undefined));
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside);
    }
    this.post();
  }

  post(): void {
    this.panel?.webview.postMessage({ type: "data", data: computeState(this.turnsN()) });
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
  .shell{max-width:1000px;margin:0 auto;padding:16px}
  h2{font-size:14px;margin:18px 0 8px;color:var(--vscode-descriptionForeground)}
  .card{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px;background:var(--vscode-sideBar-background);margin-bottom:10px}
  .muted{color:var(--vscode-descriptionForeground);font-size:12px}
  .id{font-family:var(--vscode-editor-font-family);font-size:12px}
  .role{font-weight:600;font-size:12px;margin:8px 0 3px;color:var(--vscode-descriptionForeground)}
  .text{white-space:pre-wrap;overflow-wrap:anywhere}
  button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:4px;padding:4px 10px;cursor:pointer;font:inherit}
  .cand{display:flex;gap:8px;align-items:flex-start;justify-content:space-between;border:1px solid var(--vscode-panel-border);border-radius:6px;padding:8px 10px;margin-bottom:6px}
  .cand.linked{border-color:var(--vscode-charts-green)}
  .star{color:var(--vscode-charts-green);font-size:12px}
  .top{display:flex;align-items:center;gap:10px;margin-bottom:10px}
  h1{font-size:16px;margin:0}
  textarea{width:100%;box-sizing:border-box;margin-top:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:4px;padding:6px;font:var(--vscode-editor-font-family);font-size:12px;resize:vertical}
  .row{display:flex;align-items:center;gap:10px;margin:10px 0 0}
  label.ck{display:flex;align-items:flex-start;gap:6px;font-size:12px;color:var(--vscode-descriptionForeground);margin-top:6px;cursor:pointer}
  label.ck.verify{margin-top:12px;color:var(--vscode-foreground);border-top:1px solid var(--vscode-panel-border);padding-top:10px}
  label.ck input{margin-top:2px}
</style></head>
<body><main class="shell">
  <div class="top"><h1>Codex Bridge</h1><button id="refresh">새로고침</button></div>
  <div id="status" class="card"></div>
  <h2>고정 계약 — 매 턴 AI에 자동 주입</h2>
  <div class="card">
    <div class="muted">Claude Code 지침 — 매 턴 UserPromptSubmit 훅으로 주입</div>
    <textarea id="cClaude" rows="4" placeholder="예) 추측하지 말고 파일을 직접 읽어라&#10;예) 테스트 통과 전 완료 보고 금지"></textarea>
    <label class="ck"><input type="checkbox" id="ckClaude"> 체크리스트 강제 — 위 각 줄(규칙)마다 AI가 [준수/위반+근거]를 답에 달게 함 (해제 시 규칙 텍스트만 주입)</label>
    <div class="muted" style="margin-top:12px">Codex 규약 — 브릿지 ask마다 prepend</div>
    <textarea id="cCodex" rows="4" placeholder="예) 검증 결과 첫 줄에 통과/실패&#10;예) 변경한 파일 경로를 명시"></textarea>
    <label class="ck"><input type="checkbox" id="ckCodex"> 체크리스트 강제 — 위 각 줄(규칙)마다 AI가 [준수/위반+근거]를 답에 달게 함 (해제 시 규칙 텍스트만 주입)</label>
    <label class="ck verify">🔁 검증 모드 — Codex 자동 검증→보고를 Stop 훅이 강제 (트리거는 transcript 신호만 사용, 추가 추론 없음)
      <select id="selVerify" style="margin-left:8px">
        <option value="off">꺼짐</option>
        <option value="code">코드 변경 시</option>
        <option value="plancode">플랜 확정(ExitPlanMode) + 코드 변경 시</option>
        <option value="always">모든 턴</option>
      </select>
    </label>
    <div class="row"><button id="saveC">저장</button><span id="savedAt" class="muted"></span></div>
    <div class="muted">입력 방법: 규칙을 <b>한 줄에 하나씩</b> 쓰고 Enter로 줄을 나눕니다. 각 줄이 개별 규칙이 되어 매 턴 주입됩니다(글자수 무관). 칸을 비우면 그쪽은 주입하지 않습니다.</div>
  </div>
  <h2>연결된 세션 최근 대화</h2>
  <div id="conv"></div>
  <h2>다른 세션으로 연결 (첫 발화로 식별)</h2>
  <div id="cands"></div>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({type:"refresh"}));
  function el(tag, cls, text){ const e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=text; return e; }
  $("cands").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-relink]");
    if (b) vscode.postMessage({type:"relink", id:b.getAttribute("data-relink")});
  });
  $("saveC").addEventListener("click", () => {
    const toLines = (s) => s.split("\\n").map((x) => x.trim()).filter(Boolean);
    vscode.postMessage({type:"saveContract",
      claude: toLines($("cClaude").value), codex: toLines($("cCodex").value),
      claudeChecklist: $("ckClaude").checked, codexChecklist: $("ckCodex").checked, verifyMode: $("selVerify").value});
    $("savedAt").textContent = "저장됨 ✓ (다음 턴부터 적용)";
  });
  window.addEventListener("message", (ev) => {
    if (ev.data?.type !== "data") return;
    const d = ev.data.data;
    if (d.contract){
      if (document.activeElement !== $("cClaude")) $("cClaude").value = (d.contract.claude||[]).join("\\n");
      if (document.activeElement !== $("cCodex")) $("cCodex").value = (d.contract.codex||[]).join("\\n");
      $("ckClaude").checked = d.contract.claudeChecklist !== false;
      $("ckCodex").checked = d.contract.codexChecklist !== false;
      $("selVerify").value = d.contract.verifyMode || "off";
    }
    const st = $("status"); st.replaceChildren();
    if (!d.workspace) { st.appendChild(el("div","muted","워크스페이스가 열려있지 않습니다.")); }
    else if (d.linkedId) {
      st.appendChild(el("div",null,"🔗 연결됨"));
      const idl = el("div","id", d.linkedId); st.appendChild(idl);
      st.appendChild(el("div","muted", "주제: " + (d.linkedSnippet||"-")));
      st.appendChild(el("div","muted", "연결: " + (d.linkedAt? new Date(d.linkedAt).toLocaleString():"-") + " · 마지막 활동: " + (d.lastActivity||"-")));
    } else {
      st.appendChild(el("div",null,"🔌 연결 없음"));
      st.appendChild(el("div","muted","아래에서 세션을 골라 연결하세요. (브릿지 ask는 연결 없으면 보고만 함)"));
    }
    const conv = $("conv"); conv.replaceChildren();
    if (!d.linkedId) conv.appendChild(el("div","muted","연결된 세션이 없습니다."));
    else if (!d.turns.length) conv.appendChild(el("div","muted","대화 내용을 찾지 못했습니다(세션 파일 없음?)."));
    else {
      d.turns.forEach((t) => {
        const c = el("div","card");
        if (t.user){ c.appendChild(el("div","role","👤 사용자")); c.appendChild(el("div","text", t.user)); }
        if (t.assistant.length){ c.appendChild(el("div","role","🤖 Codex")); c.appendChild(el("div","text", t.assistant.join("\\n\\n"))); }
        conv.appendChild(c);
      });
    }
    const cs = $("cands"); cs.replaceChildren();
    d.candidates.forEach((c) => {
      const row = el("div","cand" + (c.linked?" linked":""));
      const left = el("div");
      const idline = el("div","id", c.id + (c.linked?"  ":""));
      if (c.linked) idline.appendChild(el("span","star","★연결됨"));
      left.appendChild(idline);
      left.appendChild(el("div","muted", c.when + " · " + c.snippet));
      row.appendChild(left);
      if (!c.linked){ const b=el("button",null,"연결"); b.setAttribute("data-relink", c.id); row.appendChild(b); }
      cs.appendChild(row);
    });
  });
</script></body></html>`;
  }
}

function getNonce(): string {
  const p = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let t = "";
  for (let i = 0; i < 32; i++) t += p.charAt(Math.floor(Math.random() * p.length));
  return t;
}

export function activate(context: vscode.ExtensionContext): void {
  const turnsN = () => Math.max(1, vscode.workspace.getConfiguration("codexBridge").get<number>("recentTurns", 5));
  const dashboard = new Dashboard(context.extensionUri, turnsN);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 950);
  status.command = "codexBridge.openDashboard";
  status.name = "Codex Bridge";

  const render = () => {
    const ws = currentWorkspace();
    const link = workspaceLink(loadLinks(), ws);
    if (!ws) {
      status.text = "$(plug) Codex";
      status.tooltip = "워크스페이스 없음";
    } else if (link?.codexSession) {
      const file = findRolloutById(link.codexSession);
      const snip = file ? firstSnippet(file) : "";
      status.text = `$(link) Codex: ${(snip || link.codexSession).slice(0, 14)}`;
      status.tooltip = new vscode.MarkdownString(
        `**Codex Bridge — 연결됨**\n\n` +
          `세션: \`${link.codexSession}\`\n\n` +
          `주제: ${snip || "-"}\n\n` +
          `연결: ${link.linkedAt ? new Date(link.linkedAt).toLocaleString() : "-"}\n\n` +
          (file ? "" : "⚠️ 세션 파일을 찾을 수 없음\n\n") +
          `클릭 → 대시보드`,
      );
      status.backgroundColor = file ? undefined : new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      status.text = "$(plug) Codex: 미연결";
      status.tooltip = "연결된 Codex 세션 없음 · 클릭 → 대시보드에서 연결";
      status.backgroundColor = undefined;
    }
    status.show();
  };

  let debounce: NodeJS.Timeout | undefined;
  const scheduleRender = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      render();
      dashboard.post();
    }, 800);
  };

  const watchers: fs.FSWatcher[] = [];
  try {
    fs.mkdirSync(path.dirname(LINKS_FILE), { recursive: true });
    watchers.push(fs.watch(path.dirname(LINKS_FILE), () => scheduleRender()));
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(SESSIONS_DIR)) watchers.push(fs.watch(SESSIONS_DIR, { recursive: true }, () => scheduleRender()));
  } catch {
    /* ignore */
  }

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("codexBridge.openDashboard", () => dashboard.show()),
    vscode.commands.registerCommand("codexBridge.refresh", () => {
      render();
      dashboard.post();
    }),
    { dispose: () => watchers.forEach((w) => w.close()) },
  );

  render();
}

export function deactivate(): void {}
