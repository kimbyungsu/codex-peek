import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

const HOME = os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const LINKS_FILE = path.join(HOME, ".codex-bridge", "links.json");
const CONTRACT_FILE = path.join(HOME, ".codex-bridge", "contract.json"); // 전역 기본값(상속 시드)
const CONTRACTS_DIR = path.join(HOME, ".codex-bridge", "contracts"); // 프로젝트별 계약
// 프로젝트별 계약 파일. 키=normWs의 sha1 앞16자 — bridge/contract-lib.js의 contractFileFor와 반드시 동일 규칙.
function contractFileFor(ws: string): string {
  const key = crypto.createHash("sha1").update(normWs(ws)).digest("hex").slice(0, 16);
  return path.join(CONTRACTS_DIR, key + ".json");
}
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
  baseDirective: { verifyBaseline: string; transmit: string; rejudge: string; overridden: boolean };
  baseAvailable: boolean;
  permissionMode: string;
  codexReady: boolean;
}

function normWs(p: string): string {
  return path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase();
}

function currentWorkspace(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

// '지금 Claude가 실제 도는 폴더'(훅이 active.json에 기록). 대시보드/상태바는 VS Code 첫 폴더가 아니라
// 이걸 우선해, 보여주는 세션이 검증이 실제 가는 세션과 일치하게 한다. 없으면 VS Code 폴더로 폴백.
function activeWorkspace(): string | null {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(HOME, ".codex-bridge", "active.json"), "utf8"));
    // 신선도 가드: 오래된 active(지난 작업/다른 세션 잔재)는 무시하고 VS Code 폴더로 폴백.
    // 6시간 = 한 작업 세션 동안 유효로 보는 보수적 기본값.
    const ts = o && o.ts ? Date.parse(o.ts) : NaN;
    const fresh = Number.isFinite(ts) && Date.now() - ts < 6 * 60 * 60 * 1000;
    if (fresh && o && typeof o.workspace === "string" && o.workspace.trim()) return o.workspace;
  } catch {
    /* ignore */
  }
  return null;
}

// 지금 Claude가 플랜 모드인지(훅이 active.json에 기록한 permissionMode). 오래된 값은 무시(6h).
function activePermissionMode(ws: string | null): string {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(HOME, ".codex-bridge", "active.json"), "utf8"));
    const ts = o && o.ts ? Date.parse(o.ts) : NaN;
    const fresh = Number.isFinite(ts) && Date.now() - ts < 6 * 60 * 60 * 1000;
    // 이 창의 워크스페이스와 active 기록이 같을 때만 — 다른 창의 플랜 상태가 새어 보이지 않게(창 격리).
    if (fresh && ws && o && typeof o.workspace === "string" && normWs(o.workspace) === normWs(ws) && typeof o.permissionMode === "string") {
      return o.permissionMode;
    }
  } catch {
    /* ignore */
  }
  return "";
}

// 이 대시보드 창이 다룰 워크스페이스. 핵심: 창마다 '자기 폴더'를 봐서 여러 VS Code 창이 안 섞이게 한다.
// 멀티루트(한 창에 폴더 여러 개)일 때만, 활성 Claude 폴더가 이 창의 폴더 중 하나면 그걸 고른다.
function dashboardWorkspace(): string | null {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  if (!folders.length) return null; // 폴더 없는 빈 창 = 프로젝트 없음 → 아무것도 안 봄(전역 active 누수 차단)
  const active = activeWorkspace();
  if (active && folders.some((f) => normWs(f) === normWs(active))) return active;
  return folders[0];
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

// 사용자 계약(Claude 행동규칙) 주입 시점. off=주입 안 함 / plan=Claude Code 플랜 모드일 때만 / always=매 턴.
// 코드모드 없음(코드 변경은 사후 신호라 턴 시작 주입 불가 — verify-guard가 Stop에서 판정). 기본 always=무회귀.
type InjectMode = "off" | "plan" | "always";
const INJECT_MODES: InjectMode[] = ["off", "plan", "always"];
function normInjectMode(o: any): InjectMode {
  if (o && INJECT_MODES.includes(o.claudeInjectMode)) return o.claudeInjectMode;
  return "always";
}

interface Contract {
  claude: string[];
  codex: string[];
  claudeChecklist: boolean;
  codexChecklist: boolean;
  verifyMode: VerifyMode;
  claudeInjectMode: InjectMode;
}

function loadContract(ws?: string | null): Contract {
  const read = (p: string): any | null => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  // 1) 프로젝트별 계약 → 2) 전역 기본값(상속) → 3) 빈 기본값
  const o = (ws ? read(contractFileFor(ws)) : null) ?? read(CONTRACT_FILE) ?? {};
  return {
    claude: Array.isArray(o.claude) ? o.claude : [],
    codex: Array.isArray(o.codex) ? o.codex : [],
    claudeChecklist: o.claudeChecklist !== false,
    codexChecklist: o.codexChecklist !== false,
    verifyMode: normVerifyMode(o),
    claudeInjectMode: normInjectMode(o),
  };
}

function saveContract(ws: string | null, c: Contract): void {
  // 프로젝트별 파일에 저장(전역 기본값은 다른 미설정 프로젝트의 시드로 보존). ws 없으면 전역에 저장.
  const file = ws ? contractFileFor(ws) : CONTRACT_FILE;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...c, workspace: ws || undefined, updatedAt: new Date().toISOString() }, null, 2), "utf8");
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

// 런타임 브릿지 라이브러리(단일 출처)를 불러 기본 지침 기본값/오버라이드 로직을 재사용한다.
// 확장이 자체 복제하지 않고 ~/.codex-bridge/contract-lib.js 를 그대로 쓴다(드리프트 방지).
function bridgeLib(): any | null {
  try {
    return require(path.join(HOME, ".codex-bridge", "contract-lib.js"));
  } catch {
    return null;
  }
}
function loadBaseDirectiveSafe(): { verifyBaseline: string; transmit: string; rejudge: string; overridden: boolean } {
  try {
    const lib = bridgeLib();
    if (lib && typeof lib.loadBaseDirective === "function") {
      const cur = lib.loadBaseDirective();
      const def = lib.BASE_DEFAULTS || {};
      const overridden =
        cur.verifyBaseline !== def.verifyBaseline || cur.transmit !== def.transmit || cur.rejudge !== def.rejudge;
      return { verifyBaseline: cur.verifyBaseline || "", transmit: cur.transmit || "", rejudge: cur.rejudge || "", overridden };
    }
  } catch {
    /* ignore */
  }
  return { verifyBaseline: "", transmit: "", rejudge: "", overridden: false };
}

function computeState(turnsN: number): BridgeState {
  const ws = dashboardWorkspace();
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
    contract: loadContract(ws),
    baseDirective: loadBaseDirectiveSafe(),
    baseAvailable: bridgeLib() !== null,
    permissionMode: activePermissionMode(ws),
    codexReady: !!resolveCodexPathForBridge(),
  };
}

function relink(id: string): void {
  const ws = dashboardWorkspace();
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
          saveContract(dashboardWorkspace(), {
            claude: Array.isArray(m.claude) ? m.claude : [],
            codex: Array.isArray(m.codex) ? m.codex : [],
            claudeChecklist: !!m.claudeChecklist,
            codexChecklist: !!m.codexChecklist,
            verifyMode: normVerifyMode({ verifyMode: m.verifyMode }),
            claudeInjectMode: normInjectMode({ claudeInjectMode: m.claudeInjectMode }),
          });
          this.post();
        }
        if (m?.type === "saveBase") {
          try {
            bridgeLib()?.saveBaseDirective?.({ verifyBaseline: m.verifyBaseline, transmit: m.transmit, rejudge: m.rejudge });
          } catch {
            /* ignore */
          }
          this.post();
        }
        if (m?.type === "resetBase") {
          try {
            bridgeLib()?.resetBaseDirective?.();
          } catch {
            /* ignore */
          }
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
  .shell{max-width:960px;margin:0 auto;padding:28px 26px 40px}
  .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
  h1{font-size:18px;margin:0;display:flex;align-items:baseline;gap:8px}
  h1 .sub{font-size:12px;font-weight:400;color:var(--vscode-descriptionForeground)}
  h2{font-size:15px;font-weight:700;margin:40px 0 14px;color:var(--vscode-foreground);display:flex;align-items:center;gap:9px;letter-spacing:.2px}
  h2 .sub2{font-size:11px;font-weight:400;color:var(--vscode-descriptionForeground);letter-spacing:0}
  /* 역할별 섹션 헤더 마커 — 파랑=Claude, 초록=Codex/검증, 회색=기본지침/연결 */
  h2.sec::before{content:"";width:4px;height:17px;border-radius:2px;background:var(--vscode-panel-border);flex:none}
  h2.sec.claude::before{background:var(--vscode-charts-blue)}
  h2.sec.codex::before{background:var(--vscode-charts-green)}
  h2.sec.base::before{background:var(--vscode-descriptionForeground)}
  .hint{font-size:11px;color:var(--vscode-descriptionForeground);margin:4px 0 0 22px;line-height:1.5}
  .hint code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background,var(--vscode-panel-border));padding:0 4px;border-radius:3px}
  .hint .ic{cursor:help;border-bottom:1px dotted currentColor;white-space:nowrap}
  /* 규칙 입력 메타 칩(선택·형식·비움) */
  .rulemeta{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
  .rchip{font-size:10px;color:var(--vscode-descriptionForeground);border:1px solid var(--vscode-panel-border);border-radius:999px;padding:1px 8px;white-space:nowrap}
  .rchip.opt{color:var(--vscode-charts-blue);border-color:var(--vscode-charts-blue);font-weight:700}
  .card{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:17px 18px;background:var(--vscode-sideBar-background);margin-bottom:14px}
  .muted{color:var(--vscode-descriptionForeground);font-size:12px}
  .id{font-family:var(--vscode-editor-font-family);font-size:11px;color:var(--vscode-descriptionForeground);word-break:break-all}
  .role{font-weight:600;font-size:12px;margin:8px 0 3px;color:var(--vscode-descriptionForeground)}
  .text{white-space:pre-wrap;overflow-wrap:anywhere}
  button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:5px;padding:5px 12px;cursor:pointer;font:inherit}
  button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  /* 히어로: Claude ⇄ Codex */
  .hero{display:flex;align-items:stretch;gap:10px;margin-bottom:16px}
  .agent{flex:1;text-align:center;padding:16px 10px;border-radius:10px;border:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background)}
  .agent .emo{font-size:30px;line-height:1}
  .agent .nm{font-weight:600;margin-top:6px}
  .agent .ro{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px}
  .agent.claude{border-color:var(--vscode-charts-blue)}
  .agent.codex{border-color:var(--vscode-charts-green)}
  .link{flex:0 0 108px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px}
  .link .bar{width:100%;height:3px;border-radius:2px;background:var(--vscode-panel-border)}
  .link .emo{font-size:20px;filter:grayscale(1);opacity:.6}
  .link .st{font-size:11px;color:var(--vscode-descriptionForeground)}
  .link.on .bar{background:var(--vscode-charts-green)}
  .link.on .emo{filter:none;opacity:1}
  .link.on .st{color:var(--vscode-charts-green);font-weight:600}
  .statusline{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:2px 0 4px;font-size:12px}
  .badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid currentColor}
  .wschip{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:6px;font-size:11px;font-weight:600;border:1px solid var(--vscode-charts-orange);color:var(--vscode-charts-orange)}
  .b-off{color:var(--vscode-descriptionForeground)}
  .b-code{color:var(--vscode-charts-blue)}
  .b-plancode{color:var(--vscode-charts-purple)}
  .b-always{color:var(--vscode-charts-orange)}
  /* 계약 블록: 에이전트 색 구분 */
  .cblock{border-left:3px solid var(--vscode-panel-border);padding-left:10px}
  .cblock.claude{border-left-color:var(--vscode-charts-blue)}
  .cblock.codex{border-left-color:var(--vscode-charts-green)}
  .chead{font-weight:700;font-size:13px;display:flex;align-items:center;gap:6px;margin-bottom:3px}
  textarea{width:100%;box-sizing:border-box;margin-top:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:5px;padding:7px;font-family:var(--vscode-editor-font-family);font-size:12px;resize:vertical}
  select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,var(--vscode-panel-border));border-radius:4px;padding:3px 6px;font:inherit}
  .row{display:flex;align-items:center;gap:10px;margin:12px 0 0}
  label.ck{display:flex;align-items:flex-start;gap:6px;font-size:12px;color:var(--vscode-descriptionForeground);margin-top:6px;cursor:pointer}
  label.ck.verify{margin-top:14px;color:var(--vscode-foreground);border-top:1px solid var(--vscode-panel-border);padding-top:12px;align-items:center;flex-wrap:wrap}
  label.ck input{margin-top:2px}
  .cand{display:flex;gap:8px;align-items:flex-start;justify-content:space-between;border:1px solid var(--vscode-panel-border);border-radius:6px;padding:8px 10px;margin-bottom:6px}
  .cand.linked{border-color:var(--vscode-charts-green);background:var(--vscode-editor-background)}
  .star{color:var(--vscode-charts-green);font-size:12px;font-weight:600}
  /* 모노그램 에이전트(이모지 대신) */
  .mono{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;margin:0 auto 2px;color:#fff;letter-spacing:.5px}
  .mono.c{background:var(--vscode-charts-blue)}
  .mono.x{background:var(--vscode-charts-green)}
  /* 검증 모드 세그먼트 토글 */
  .seg{display:inline-flex;flex-wrap:wrap;max-width:100%;border:1px solid var(--vscode-panel-border);border-radius:7px;overflow:hidden;margin-left:8px;vertical-align:middle}
  .seg button{background:transparent;color:var(--vscode-foreground);border:0;border-right:1px solid var(--vscode-panel-border);padding:5px 11px;font-size:11px;cursor:pointer;border-radius:0;display:inline-flex;flex-direction:column;align-items:center;gap:1px;line-height:1.25}
  .seg button small{font-size:9px;font-weight:400;opacity:.72}
  .seg button:last-child{border-right:0}
  .seg button.on{background:var(--vscode-charts-orange);color:#fff;font-weight:700}
  .seg button.on small{opacity:.92}
  .nowbadge{font-size:10px;font-weight:700;padding:1px 8px;border-radius:999px;border:1px solid var(--vscode-charts-purple);color:var(--vscode-charts-purple)}
  /* 온보딩 배너 */
  .onboard{border:1px solid var(--vscode-charts-orange);border-radius:9px;padding:12px 15px;margin:0 0 16px;background:var(--vscode-editor-background)}
  .obtitle{font-size:12.5px;font-weight:700;margin-bottom:9px}
  .obstep{font-size:11.5px;margin:6px 0;line-height:1.5}
  .obstep .k{font-weight:700;margin-right:5px}
  .obstep.done{color:var(--vscode-charts-green)}
  .obstep .where{color:var(--vscode-descriptionForeground);font-size:10.5px}
  /* 검증 시 적용되는 지침 요약(수신자별) */
  /* 검증 대화: 사용자=오른쪽 말풍선 / Codex=왼쪽 전폭 카드 */
  .turn{margin-bottom:14px}
  .umsg{margin:0 0 7px auto;max-width:82%;width:fit-content;background:var(--vscode-charts-blue);color:#fff;padding:7px 12px;border-radius:13px 13px 4px 13px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
  .vmsg{border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-charts-green);border-radius:4px 13px 13px 13px;padding:9px 13px;background:var(--vscode-sideBar-background)}
  .vmsg.fail{border-left-color:var(--vscode-charts-red)}
  .vhead{display:flex;align-items:center;gap:8px;margin-bottom:5px}
  .vname{font-size:11px;font-weight:600;color:var(--vscode-charts-green)}
  .vchip{font-size:11px;font-weight:700;padding:1px 9px;border-radius:999px;border:1px solid currentColor}
  .vchip.pass{color:var(--vscode-charts-green)}
  .vchip.fail{color:var(--vscode-charts-red)}
  .vbody{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.55}
  .vbody.clip{max-height:170px;overflow:hidden;-webkit-mask-image:linear-gradient(180deg,#000 72%,transparent)}
  .more{margin-top:7px;font-size:11px;color:var(--vscode-textLink-foreground);background:none;border:0;padding:0;cursor:pointer}
  .flash{animation:savedflash 1.3s ease-out}
  @keyframes savedflash{0%,15%{color:var(--vscode-charts-green);font-weight:700}100%{color:var(--vscode-descriptionForeground);font-weight:400}}
  button:active{transform:translateY(1px)}
  /* 한눈에 보기: Claude↔Codex 흐름 지도 */
  .flowmap{margin:8px 0 26px}
  .fmtitle{font-size:12.5px;font-weight:700;margin-bottom:11px;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
  .flow{display:flex;align-items:stretch;gap:0;flex-wrap:wrap}
  .fnode{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:1px solid var(--vscode-panel-border);border-radius:9px;padding:9px 13px;background:var(--vscode-editor-background);text-align:center;font-size:11.5px;font-weight:600;min-width:72px}
  .fnode small{font-weight:400;color:var(--vscode-descriptionForeground);font-size:10px}
  .fnode.rule{border-style:dashed}
  .fnode.actor.claude{border-color:var(--vscode-charts-blue)}
  .fnode.actor.codex{border-color:var(--vscode-charts-green)}
  .fnode .mono{width:26px;height:26px;border-radius:7px;font-size:11px;margin:0 0 1px}
  .farrow{flex:1 1 78px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;min-width:78px;padding:0 5px 10px}
  .farrow .lbl{font-size:10px;line-height:1.35;text-align:center;color:var(--vscode-foreground);margin-bottom:4px}
  .farrow .ln{width:100%;height:0;border-top:2px solid var(--vscode-charts-orange);position:relative}
  .farrow .ln::after{content:"▶";position:absolute;right:-3px;top:-8px;color:var(--vscode-charts-orange);font-size:10px;line-height:1}
  .farrow.off .lbl{color:var(--vscode-descriptionForeground)}
  .farrow.off .ln{border-top-color:var(--vscode-panel-border);border-top-style:dashed}
  .farrow.off .ln::after{color:var(--vscode-panel-border)}
  .flowback{margin-top:10px;font-size:10.5px;color:var(--vscode-descriptionForeground);line-height:1.55;border-top:1px dashed var(--vscode-panel-border);padding-top:9px}
  /* 카드 수신자 라벨 */
  .to{font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:999px;border:1px solid currentColor}
  .to.claude{color:var(--vscode-charts-blue)}
  .to.codex{color:var(--vscode-charts-green)}
  /* 검증 토글 직하: '단계별 기본 원칙' 연결 패널 */
  .stagebox{margin-top:13px;border-top:1px dashed var(--vscode-panel-border);padding-top:11px}
  .sbhead{font-size:11px;font-weight:600;margin-bottom:9px}
  .sbrow{font-size:11.5px;margin:7px 0;line-height:1.5;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
  .sbrow.off{opacity:.42}
  .sbmark{font-weight:700;width:11px;display:inline-block}
  .sbrow.on .sbmark{color:var(--vscode-charts-green)}
  .sbwhy{font-size:10px;color:var(--vscode-descriptionForeground)}
  .who2{font-size:9.5px;font-weight:700;padding:1px 7px;border-radius:999px;border:1px solid currentColor}
  .who2.claude{color:var(--vscode-charts-blue)}
  .who2.codex{color:var(--vscode-charts-green)}
  .dirtyhint{font-size:11px;color:var(--vscode-charts-orange);font-weight:600;margin-top:9px}
  /* 저장 시 바뀐 지점 펄스(배경 깜빡) */
  .flashpulse{animation:flashpulse 1.5s ease-out}
  @keyframes flashpulse{0%,22%{background:var(--vscode-charts-orange);color:#fff;border-radius:5px}100%{background:transparent}}
</style></head>
<body><main class="shell">
  <div class="top"><h1>🌉 Codex Bridge <span class="sub">Claude ⇄ Codex 자동 연결·검증</span></h1><button id="refresh" class="secondary">↻ 새로고침</button></div>

  <div class="hero">
    <div class="agent claude"><div class="mono c">C</div><div class="nm">Claude</div><div class="ro">구현 · implement</div></div>
    <div class="link" id="linkViz"><div class="bar"></div><div class="emo" id="linkEmo">🔌</div><div class="st" id="linkState">연결 없음</div></div>
    <div class="agent codex"><div class="mono x">Cx</div><div class="nm">Codex</div><div class="ro">검증 · verify</div></div>
  </div>
  <div id="status" class="statusline"></div>

  <section class="onboard" id="onboard" style="display:none">
    <div class="obtitle">🚀 시작하기 <span class="muted" style="font-weight:400">· 이 3가지가 되면 매 턴 자동 검증</span></div>
    <div class="obstep" id="ob1"></div>
    <div class="obstep" id="ob2"></div>
    <div class="obstep" id="ob3"></div>
  </section>

  <section class="flowmap" id="fmSection">
    <div class="fmtitle">🗺 한눈에 보기 <span class="muted" style="font-weight:400">· 누구에게 · 뭐가 · 언제 들어가나 (지금 <b>저장된</b> 설정 기준 — 저장하면 바뀐 곳이 깜빡여요)</span></div>
    <div class="flow">
      <div class="fnode rule">Claude<br>규칙</div>
      <div class="farrow" id="faInject"><span class="lbl">넣는 시점<br><b id="faInjectVal">항상</b></span><span class="ln"></span></div>
      <div class="fnode actor claude"><span class="mono c">C</span>Claude<small>구현</small></div>
      <div class="farrow off" id="faVerify"><span class="lbl">검증 맡김<br><b id="faVerifyVal">안 함</b></span><span class="ln"></span></div>
      <div class="fnode actor codex"><span class="mono x">Cx</span>Codex<small>검증</small></div>
    </div>
    <div class="dirtyhint" id="dirtyHint" style="display:none">● 토글을 바꿨어요 — <b>저장</b>해야 실제로 적용됩니다</div>
  </section>

  <h2 class="sec claude">Claude 규칙 <span class="to claude">→ 🧑 Claude에게</span> <span class="sub2">Claude가 지킬 행동규칙 — 검증과 별개</span></h2>
  <div class="card">
    <div class="cblock claude">
      <div class="chead">규칙 <span class="muted" style="font-weight:400">· 기본 원칙 말고, 이 프로젝트에만 필요한 것</span></div>
      <textarea id="cClaude" rows="3" placeholder="예) 이 레포에선 ○○ 라이브러리·패턴 쓰지 마라&#10;예) 보고는 기술용어 빼고 예시로 정리해라&#10;예) 플랜 모드로 쓸 때: 영향받는 호출부·마이그레이션 순서를 플랜에 포함해라"></textarea>
      <div class="rulemeta"><span class="rchip opt">선택</span><span class="rchip">⏎ 한 줄 = 규칙 1개</span><span class="rchip">∅ 비우면 이 칸의 규칙만 안 붙음</span></div>
      <label class="ck"><input type="checkbox" id="ckClaude"> 체크리스트 강제 — 각 규칙마다 [준수/위반+근거] 달게 함</label>
      <div class="hint">☑ 켜짐 → 답변 끝에 <code>[계약점검] 1) 준수 — &lt;근거&gt; / 2) 위반 — &lt;근거&gt;</code> 형식으로 규칙별 자가보고를 강제 · ☐ 꺼짐 → 규칙 텍스트만 주입</div>
    </div>
    <label class="ck verify">🧩 넣는 시점 — 이 규칙을 <b>언제</b> Claude에 넣을지 <span id="planNow" class="nowbadge" style="display:none"></span>
      <span class="seg" id="segInject">
        <button type="button" data-im="off">꺼짐<small>안 넣음</small></button><button type="button" data-im="plan">플랜 모드<small>플랜 때만</small></button><button type="button" data-im="always">항상<small>매 턴</small></button>
      </span>
    </label>
    <div class="hint"><span class="ic" title="'코드 변경 시'가 없는 이유: 코드 변경은 턴이 끝나야 아는 신호라, 턴 시작에 넣는 이 축에선 못 씁니다. 검증 모드와 무관한 별도 축이에요.">ⓘ '코드 변경 시'가 없는 이유</span></div>
  </div>

  <h2 class="sec codex">검증 <span class="to codex">→ 🔍 Codex</span> <span class="sub2">Codex에게 검증받기 — 끄면 검증만 안 함(Claude 규칙은 별개)</span></h2>
  <div class="card">
    <div class="cblock codex">
      <div class="chead">Codex 규칙 <span class="muted" style="font-weight:400">· 기본 검증원칙 말고, 이 프로젝트에서 특히 볼 것 · Codex 검증 때마다 붙음</span></div>
      <textarea id="cCodex" rows="3" placeholder="예) 동시성·레이스 컨디션을 중점으로 봐라&#10;예) 결제·정산은 중복 청구·반올림 오차·롤백까지 확인해라&#10;예) 단순 포맷·스타일 지적은 검증에서 빼라"></textarea>
      <div class="rulemeta"><span class="rchip opt">선택</span><span class="rchip">⏎ 한 줄 = 규칙 1개</span><span class="rchip">∅ 비우면 이 칸의 규칙만 안 붙음</span></div>
      <label class="ck"><input type="checkbox" id="ckCodex"> 체크리스트 강제 — 검증 답에 규칙별 [준수/위반+근거] 달게 함</label>
      <div class="hint">☑ 켜짐 → Codex 검증 답에도 규칙별 <code>[계약점검]</code> 자가보고 강제 · ☐ 꺼짐 → 규칙 텍스트만 붙음</div>
    </div>
    <label class="ck verify">🔁 검증 모드 — <b>언제</b> Codex 검증→보고를 강제할지
      <span class="seg" id="segVerify">
        <button type="button" data-vm="off">꺼짐<small>강제 안 함</small></button><button type="button" data-vm="code">코드 변경 시<small>편집한 턴</small></button><button type="button" data-vm="plancode">플랜 확정/코드 변경<small>플랜·편집 턴</small></button><button type="button" data-vm="always">모든 턴<small>매 응답</small></button>
      </span>
    </label>
    <div class="hint"><span class="ic" title="트리거에 걸린 턴에는 Codex 검증을 받고, 그 결과를 반영해 보고해야 턴을 끝낼 수 있습니다.">ⓘ 트리거 턴이란</span></div>
    <div class="stagebox" id="stageBox">
      <div class="sbhead">↑ 위 검증을 켜면 <b>흐름 단계마다 '단계별 기본 원칙'</b>이 적용돼요 <span class="muted" style="font-weight:400">· 지금 검증: <b id="sbState">—</b> · 내용은 아래 ⚙️ 단계별 기본 원칙에서</span></div>
      <div class="sbrow" id="sbTransmit"><span class="sbmark"></span><b>① Claude→Codex 넘길 때</b> · 전달 원칙 <span class="who2 claude">Claude</span> <span class="sbwhy"></span></div>
      <div class="sbrow" id="sbVerify"><span class="sbmark"></span><b>② Codex가 검증할 때</b> · 검증 기본원칙 + Codex 규칙 <span class="who2 codex">Codex</span> <span class="sbwhy"></span></div>
      <div class="sbrow" id="sbRejudge"><span class="sbmark"></span><b>③ Codex 답을 되짚을 때</b> · 재판단 원칙 <span class="who2 claude">Claude</span> <span class="sbwhy"></span></div>
    </div>
  </div>
  <div class="row"><button id="saveC">저장</button><span id="savedAt" class="muted">· 위 Claude 규칙 · Codex 규칙 · 검증 모드를 함께 저장</span></div>
  <details class="card" style="margin-top:10px">
    <summary style="cursor:pointer;font-weight:600;font-size:13px">⚙️ 단계별 기본 원칙 <span class="muted" style="font-weight:400">· 검증 흐름 3단계의 기본값 (미리 들어있는 기본값 · 필요할 때만 편집)</span> <span id="baseOv" class="muted" style="font-weight:400"></span></summary>
    <div class="hint" style="margin:8px 0 0 0">위 <b>Claude·Codex 규칙</b>(네가 쓰는 것)과 달리, 이건 검증이 제대로 굴러가게 하는 <b>흐름 단계별 기본값</b>입니다. 평소엔 손댈 필요 없고, 잘못 고쳐도 <b>기본값 복원</b>으로 되돌아갑니다.</div>
    <div class="chead" style="margin-top:12px">① 전달 원칙 <span class="muted" style="font-weight:400">→ Claude에게 · Claude가 Codex에 넘길 때 · 검증 ON일 때만</span></div>
    <textarea id="bTransmit" rows="4"></textarea>
    <div class="chead" style="margin-top:12px">② 검증 기본원칙 <span class="muted" style="font-weight:400">→ Codex에게 · Codex 검증 때마다</span></div>
    <textarea id="bVerify" rows="5"></textarea>
    <div class="chead" style="margin-top:12px">③ 재판단 원칙 <span class="muted" style="font-weight:400">→ Claude에게 · Codex 답을 되짚을 때 · 검증 ON일 때만</span></div>
    <textarea id="bRejudge" rows="5"></textarea>
    <div class="row"><button id="saveB">단계별 기본 원칙 저장</button><button id="resetB" class="secondary">기본값 복원</button><span id="savedB" class="muted"></span></div>
  </details>
  <h2 class="sec codex">🔍 Codex 검증 대화 <span class="sub2">실제 주고받은 내용 — 검증이 진짜 일어났는지 눈으로 확인</span></h2>
  <div id="conv"></div>
  <h2 class="sec base">🔗 Codex 세션 연결 <span class="sub2" id="cwsLabel">첫 발화로 식별</span></h2>
  <div id="cands"></div>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({type:"refresh"}));
  function el(tag, cls, text){ const e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=text; return e; }
  // 폼에서 고른 값(curVM/curIM, 저장 시 전송) vs 저장돼 실제 적용 중인 값(appVM/appIM, 지도·'지금 받는 것'에 표시).
  // 지도/패널은 "저장된 것"만 보여주고(거짓 미리보기 방지), 저장하는 순간 바뀐 곳을 깜빡인다.
  let curVM = "off", curIM = "always";
  let appVM = null, appIM = null;
  let curPerm = "";   // 지금 Claude Code 권한 모드(active.json) — plan 게이트 표시용
  let shownVM, shownIM, shownPerm;   // 마지막으로 그린 상태 — watcher 중복 렌더가 진행 중 깜빡임을 지우지 않게
  function lblIM(im){ return im==="off"?"꺼짐":im==="plan"?"플랜 때만":"항상"; }
  function lblVM(vm){ return vm==="off"?"안 함":vm==="code"?"코드 변경 시":vm==="plancode"?"플랜·코드 시":"모든 턴"; }
  function flashNode(n){ if(!n) return; n.classList.remove("flashpulse"); void n.offsetWidth; n.classList.add("flashpulse"); }
  function setStage(node, on, why){ if(!node) return; node.classList.toggle("off", !on); node.classList.toggle("on", on); const m=node.querySelector(".sbmark"); if(m) m.textContent=on?"✓":"✗"; const w=node.querySelector(".sbwhy"); if(w) w.textContent=why; }
  // 저장된 상태(appVM/appIM)로 지도 화살표 + '지금 받는 것'을 그린다. prev와 다른 항목은 깜빡.
  function renderApplied(prevVM, prevIM){
    if(shownVM===appVM && shownIM===appIM && shownPerm===curPerm) return;  // 변화 없으면 DOM 안 건드림 → 진행 중 깜빡임 보존
    shownVM=appVM; shownIM=appIM; shownPerm=curPerm;
    const inj=$("faInject"), ver=$("faVerify");
    if(inj){ inj.className="farrow"+(appIM!=="off"?"":" off"); const v=$("faInjectVal"); if(v) v.textContent=lblIM(appIM); }
    if(ver){ ver.className="farrow"+(appVM!=="off"?"":" off"); const v=$("faVerifyVal"); if(v) v.textContent=lblVM(appVM); }
    // 검증 토글 직하 단계 패널: 검증 ON이면 ①③ 켜짐, ②는 검증할 때. OFF면 ①③ 꺼짐, ②는 수동 ask 때만.
    const von = appVM!=="off";
    const st=$("sbState"); if(st) st.textContent = von ? lblVM(appVM) : "꺼짐";
    setStage($("sbTransmit"), von, von?"검증 켜짐 → 적용":"검증 꺼짐 → 안 들어감");
    setStage($("sbVerify"), von, von?"검증할 때 적용":"자동 검증 없음 (수동 ask 땐 들어감)");
    setStage($("sbRejudge"), von, von?"검증 켜짐 → 적용":"검증 꺼짐 → 안 들어감");
    if(prevIM!=null && prevIM!==appIM){ flashNode(inj); }
    if(prevVM!=null && prevVM!==appVM){ flashNode(ver); flashNode($("sbTransmit")); flashNode($("sbVerify")); flashNode($("sbRejudge")); }
  }
  function highlightSeg(segId, attr, v){ const s=$(segId); if(s) s.querySelectorAll("button").forEach((b)=>b.classList.toggle("on", b.getAttribute(attr)===v)); }
  function markDirty(){ const d=$("dirtyHint"); if(d) d.style.display = ((curVM!==appVM)||(curIM!==appIM)) ? "" : "none"; }
  $("segVerify").addEventListener("click", (ev)=>{ const b=ev.target.closest("[data-vm]"); if(b){ curVM=b.getAttribute("data-vm"); highlightSeg("segVerify","data-vm",curVM); markDirty(); } });
  $("segInject").addEventListener("click", (ev)=>{ const b=ev.target.closest("[data-im]"); if(b){ curIM=b.getAttribute("data-im"); highlightSeg("segInject","data-im",curIM); markDirty(); } });
  function flashSaved(node, msg){ if(!node) return; node.textContent = msg || "저장됨 ✓ (다음 턴부터 적용)"; node.classList.remove("flash"); void node.offsetWidth; node.classList.add("flash"); }
  $("cands").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-relink]");
    if (b) vscode.postMessage({type:"relink", id:b.getAttribute("data-relink")});
  });
  let pendingScroll;  // 대기 중 스크롤 타이머(연속 저장 시 취소용)
  $("saveC").addEventListener("click", () => {
    clearTimeout(pendingScroll);  // 직전 저장의 대기 스크롤 취소
    const toLines = (s) => s.split("\\n").map((x) => x.trim()).filter(Boolean);
    const imCh = curIM!==appIM, vmCh = curVM!==appVM;  // 저장 전 캡처: 도안(넣는 시점/검증 모드)에 영향 주는 변경인가
    vscode.postMessage({type:"saveContract",
      claude: toLines($("cClaude").value), codex: toLines($("cCodex").value),
      claudeChecklist: $("ckClaude").checked, codexChecklist: $("ckCodex").checked, verifyMode: curVM, claudeInjectMode: curIM});
    flashSaved($("savedAt"));
    // 넣는 시점/검증 모드가 바뀐 저장만: ack(✓)를 본 뒤(500ms) 도안으로 올라가며 바뀐 곳을 다시 펄스.
    // (규칙 텍스트·체크리스트는 도안을 안 바꾸므로 스크롤 안 함 — 보여줄 변화가 없음.)
    if((imCh || vmCh) && appVM !== null){  // appVM=null = 첫 렌더 전(초기화 미완) → 헛스크롤 방지
      pendingScroll = setTimeout(() => {
        const fm=$("fmSection"); if(fm) fm.scrollIntoView({behavior:"smooth", block:"start"});
        if(imCh) flashNode($("faInject"));
        if(vmCh){ flashNode($("faVerify")); flashNode($("sbTransmit")); flashNode($("sbVerify")); flashNode($("sbRejudge")); }
      }, 500);
    }
  });
  $("saveB").addEventListener("click", () => {
    vscode.postMessage({type:"saveBase", verifyBaseline:$("bVerify").value, transmit:$("bTransmit").value, rejudge:$("bRejudge").value});
    flashSaved($("savedB"));
  });
  $("resetB").addEventListener("click", () => { vscode.postMessage({type:"resetBase"}); flashSaved($("savedB"), "기본값으로 복원됨 ✓"); });
  window.addEventListener("message", (ev) => {
    if (ev.data?.type !== "data") return;
    const d = ev.data.data;
    curPerm = d.permissionMode || "";   // renderApplied의 plan 게이트 표시에 사용
    if (d.contract){
      if (document.activeElement !== $("cClaude")) $("cClaude").value = (d.contract.claude||[]).join("\\n");
      if (document.activeElement !== $("cCodex")) $("cCodex").value = (d.contract.codex||[]).join("\\n");
      $("ckClaude").checked = d.contract.claudeChecklist !== false;
      $("ckCodex").checked = d.contract.codexChecklist !== false;
      const first = (appVM===null);
      const pVM=appVM, pIM=appIM;
      appVM = d.contract.verifyMode || "off";
      appIM = d.contract.claudeInjectMode || "always";
      // 사용자가 저장 안 한 토글 변경을 들고 있으면(dirty) 폼 선택을 보존, 아니면 저장값으로 동기화.
      const dirty = !first && ((curVM!==pVM)||(curIM!==pIM));
      if(first || !dirty){ curVM=appVM; curIM=appIM; highlightSeg("segVerify","data-vm",curVM); highlightSeg("segInject","data-im",curIM); }
      renderApplied(first?undefined:pVM, first?undefined:pIM);  // 저장/변경 반영 후 바뀐 축을 깜빡(첫 렌더는 깜빡 없음)
      markDirty();
    }
    // ④ 플랜 라이브표시: 지금 플랜 모드인가(active.json permissionMode)
    const pn = $("planNow");
    if (pn){ if(d.permissionMode==="plan"){ pn.textContent="지금: 플랜 모드 ✓"; pn.style.display=""; } else if(d.permissionMode){ pn.textContent="지금: 일반"; pn.style.display=""; } else { pn.style.display="none"; } }
    // 온보딩: ① codex 준비 ② 연결 ③ 검증 켜기 — 셋 다 되면 배너 숨김
    (function(){
      const ob=$("onboard"); if(!ob) return;
      const codexReady = !!d.codexReady, linked = !!d.linkedId;
      const vOn = !!(d.contract && d.contract.verifyMode && d.contract.verifyMode!=="off");
      const set=(id,done,text,where)=>{ const e=$(id); if(!e) return; e.className="obstep "+(done?"done":"todo"); e.innerHTML='<span class="k">'+(done?"✓":"○")+'</span>'+text+(where?' <span class="where">'+where+'</span>':''); };
      set("ob1", codexReady, codexReady?"Codex 준비됨":"Codex 확장/경로 미확인", codexReady?"":"— 설치돼 있으면 보통 자동 동작 · 안 되면 설정에서 codexBridge.codexPath 지정 (PATH의 codex로도 동작 가능)");
      set("ob2", linked, linked?"Codex 세션 연결됨":"Codex 세션 미연결", linked?"":"— 아래 '🔗 Codex 세션 연결'에서 선택 (없으면 첫 검증 때 새 세션)");
      set("ob3", vOn, vOn?("검증 켜짐 ("+d.contract.verifyMode+")"):"검증 꺼짐", vOn?"":"— 위 '🔁 검증 모드'에서 켜기");
      ob.style.display = (linked && vOn) ? "none" : "";   // 연결+검증ON이면 사실상 동작 중(codex readiness 함의) → 숨김
    })();
    if (d.baseDirective){
      if (document.activeElement !== $("bVerify")) $("bVerify").value = d.baseDirective.verifyBaseline||"";
      if (document.activeElement !== $("bTransmit")) $("bTransmit").value = d.baseDirective.transmit||"";
      if (document.activeElement !== $("bRejudge")) $("bRejudge").value = d.baseDirective.rejudge||"";
      const ov=$("baseOv"); if(ov) ov.textContent = d.baseDirective.overridden ? "· (수정됨)" : "· (기본값)";
    }
    // 런타임 라이브러리 없으면 저장/복원이 무효 → 거짓 성공 방지: 버튼 비활성 + 경고(점2 수정).
    const baseOk = d.baseAvailable !== false;
    if ($("saveB")) $("saveB").disabled = !baseOk;
    if ($("resetB")) $("resetB").disabled = !baseOk;
    if (!baseOk){ const ov=$("baseOv"); if(ov) ov.textContent = "· ⚠ 런타임 라이브러리를 찾을 수 없어 편집 불가"; const sb=$("savedB"); if(sb) sb.textContent=""; }
    // 히어로 연결 상태 시각화
    const linked = !!d.linkedId;
    $("linkViz").className = "link" + (linked ? " on" : "");
    $("linkEmo").textContent = linked ? "🔗" : "🔌";
    $("linkState").textContent = linked ? "연결됨" : "연결 없음";
    // statusline: 검증 모드 배지 + 연결 요약
    const st = $("status"); st.replaceChildren();
    const vm = (d.contract && d.contract.verifyMode) || "off";
    const vmTxt = {off:"검증 꺼짐", code:"코드 변경 시 검증", plancode:"플랜+코드 검증", always:"모든 턴 검증"}[vm] || vm;
    st.appendChild(el("span","badge b-"+vm, "🔁 " + vmTxt));
    if (d.workspace) st.appendChild(el("span","wschip", "📁 " + d.workspace));
    if (!d.workspace) st.appendChild(el("span","muted","· 워크스페이스가 열려있지 않음"));
    else if (linked) {
      st.appendChild(el("span","muted","· " + (d.linkedSnippet || "(주제 미상)")));
      st.appendChild(el("span","id", d.linkedId));
    } else {
      st.appendChild(el("span","muted","· 아래에서 Codex 세션을 골라 연결 (미연결 시 ask는 보고만)"));
    }
    const cws = $("cwsLabel"); if (cws) cws.textContent = d.workspace ? ("선택 시 → " + d.workspace + " 에 연결") : "열린 워크스페이스 없음";
    const conv = $("conv"); conv.replaceChildren();
    if (!d.linkedId) conv.appendChild(el("div","card muted","아직 연결된 Codex 세션이 없어요. 아래에서 세션을 연결하면, 구현↔검증으로 실제 주고받은 대화가 여기에 그대로 표시됩니다(눈으로 검증 확인)."));
    else if (!d.turns.length) conv.appendChild(el("div","card muted","연결됨 — 아직 주고받은 대화가 없습니다(또는 세션 파일을 못 찾음)."));
    else {
      d.turns.forEach((t) => {
        const wrap = el("div","turn");
        if (t.user) wrap.appendChild(el("div","umsg", t.user));
        let body=null, more=null;
        if (t.assistant.length){
          const txt = t.assistant.join("\\n\\n");
          const first = txt.split("\\n")[0] || "";
          const pass = /통과/.test(first) && /검증/.test(first);
          const fail = /실패/.test(first) && /검증/.test(first);
          const v = el("div", "vmsg" + (fail ? " fail" : ""));
          const head = el("div","vhead");
          head.appendChild(el("span","vname","Codex"));
          if (pass || fail) head.appendChild(el("span","vchip " + (pass?"pass":"fail"), pass?"검증 통과":"검증 실패"));
          v.appendChild(head);
          body = el("div","vbody clip", txt);
          v.appendChild(body);
          more = el("button","more","펼치기 ▾");
          more.addEventListener("click", () => { const clipped = body.classList.toggle("clip"); more.textContent = clipped ? "펼치기 ▾" : "접기 ▴"; });
          v.appendChild(more);
          wrap.appendChild(v);
        }
        conv.appendChild(wrap);
        if (body && more && body.scrollHeight <= body.clientHeight + 2){ body.classList.remove("clip"); more.style.display = "none"; }
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

function readTextSafe(f: string): string {
  try {
    return fs.readFileSync(f, "utf8").trim();
  } catch {
    return "";
  }
}

// '사용자가 실제 쓰는 codex' 실행파일 경로를 정한다.
//  1) 설정 codexBridge.codexPath (직접 지정) — 최우선
//  2) 설치된 Codex 제공 확장(openai.chatgpt 등) 내부의 codex 실행파일 — vscode API로 위치 확인
//     (포터블/설치형·버전 폴더 변경에 안 깨짐). 우리 확장(codex-bridge/usage)은 제외.
// 못 찾으면 undefined → 브릿지가 PATH 의 codex 로 폴백.
function resolveCodexPathForBridge(): string | undefined {
  const configured = vscode.workspace.getConfiguration("codexBridge").get<string>("codexPath", "").trim();
  if (configured && fs.existsSync(configured)) return configured;
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  for (const ext of vscode.extensions.all) {
    const id = ext.id.toLowerCase();
    if (!/chatgpt|codex/.test(id) || /codex-bridge|codex-usage/.test(id)) continue; // 형제 codex만
    const binRoot = path.join(ext.extensionPath, "bin");
    try {
      for (const plat of fs.readdirSync(binRoot)) {
        const cand = path.join(binRoot, plat, exe);
        if (fs.existsSync(cand)) return cand;
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

// 위 결과를 ~/.codex-bridge/codex-bin.txt 에 기록(브릿지 훅이 읽음). 확장 활성화·설정변경마다 갱신.
// → 자동추적: 버전업/포터블↔설치형 전환에도 항상 현재 위치. 못 찾으면 파일을 지워 PATH 폴백.
function syncCodexBin(): void {
  const f = path.join(HOME, ".codex-bridge", "codex-bin.txt");
  const found = resolveCodexPathForBridge();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (found) {
      if (readTextSafe(f) !== found) fs.writeFileSync(f, found, "utf8");
    } else if (fs.existsSync(f)) {
      fs.rmSync(f, { force: true });
    }
  } catch {
    /* ignore */
  }
}

export function activate(context: vscode.ExtensionContext): void {
  syncCodexBin(); // 브릿지가 쓸 codex 경로를 최신 확장 기준으로 기록
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codexBridge.codexPath")) syncCodexBin();
    }),
  );
  const turnsN = () => Math.max(1, vscode.workspace.getConfiguration("codexBridge").get<number>("recentTurns", 5));
  const dashboard = new Dashboard(context.extensionUri, turnsN);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 950);
  status.command = "codexBridge.openDashboard";
  status.name = "Codex Bridge";

  const render = () => {
    const ws = dashboardWorkspace();
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
