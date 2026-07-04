// ── cc-model 두뇌 drift의 '의도(intent)' 해석 — 프로젝트별 정확화 ──
// 배경(사용자 실측 2026-07-04): Claude Code의 /model 선택은 전역 settings.json 한 파일에 저장된다. 프로젝트 2개를
// 동시에 다른 모델로 돌리면(P1=fable, P2=opus) P1의 /model이 전역 설정을 fable로 바꿔, P2에서 '설정 fable vs 실제 opus'
// 거짓 경고가 구조적으로 발생한다. 전역 설정은 '새 대화의 기본값'이지 '이 대화의 의도'가 아니다.
// 해법: 의도를 '그 프로젝트 대화 자신이 기록한 마지막 /model'에서 읽는다(transcript의 구조화된 로컬커맨드 기록 —
// 자연어 와딩 매칭이 아니라 Claude Code가 남기는 구조 신호). 없으면 '대화 시작 전에 정해져 있던 설정'만 인정.
// 원칙: 과소경고는 허용, 거짓경고는 불허(기존 '둘 다 알 때만 비교'의 연장).
// vscode 의존 없음 — 파일 IO는 호출측(extension.ts) 책임. 테스트(tests/brain-intent.test.js)가 out/brain-intent.js를 직접 import.

export type ModelCmd = { model: string; ts: number };

// 모델 '계열'(별칭·전체ID 공통) — drift는 계열로 비교(opus↔claude-opus-4-8 동일, haiku≠opus만 어긋남).
// extension.ts에서 이동(단일 정본 — 확장·테스트가 같은 함수를 import, 사본 드리프트 방지).
export function modelFamily(m: string): string {
  const s = (m || "").toLowerCase();
  if (s.includes("haiku")) return "haiku";
  if (s.includes("sonnet")) return "sonnet";
  if (s.includes("opus")) return "opus";
  if (s.includes("fable")) return "fable";
  return "";
}

// transcript 꼬리 텍스트에서 '마지막 /model 확정 기록'을 찾는다.
// 신뢰 소스는 stdout형 엔트리 하나뿐: content가 정확히 '<local-command-stdout>Set model to <모델></local-command-stdout>'
// 로 시작하는 type:user 엔트리(실데이터 확인 — [1m] 접미가 붙기도, 탈락하기도 함 → 계열 비교라 무해).
// ★인용 함정 방어(실데이터서 발생): 사용자가 /model 기록을 메시지에 '인용'하면 그 태그가 큰 본문 중간에 들어간다 →
//   trim()이 해당 태그로 '시작'하는 엔트리만 인정해 배제한다. args형(<command-args>)은 취소/미확정일 수 있어 안 쓴다(과소경고 감수).
// cwd strict: normWs(cwd)===normWs(ws)인 엔트리만(다른 폴더로 이동한 세션 방어) — cwd 없는 엔트리도 배제.
const STDOUT_PREFIX = "<local-command-stdout>Set model to ";
export function parseLastModelCommand(tailText: string, ws: string, normWs: (p: string) => string): ModelCmd | null {
  const want = normWs(ws);
  const lines = String(tailText).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i];
    if (!s || s.indexOf("Set model to") < 0) continue; // 빠른 사전 필터
    let o: any; try { o = JSON.parse(s); } catch { continue; } // tail 경계로 잘린 첫 줄/깨진 줄 skip
    if (!o || o.type !== "user" || o.isSidechain) continue;
    if (normWs(String(o.cwd || "")) !== want) continue; // 이 폴더 엔트리만(strict)
    const c = o.message && o.message.content;
    const texts: string[] = typeof c === "string" ? [c] : Array.isArray(c) ? c.map((x: any) => (x && x.type === "text" && typeof x.text === "string" ? x.text : "")) : [];
    for (const t of texts) {
      const tt = String(t).trim();
      if (!tt.startsWith(STDOUT_PREFIX)) continue; // 시작 앵커 — 인용(본문 중간 포함)은 배제
      const end = tt.indexOf("</local-command-stdout>", STDOUT_PREFIX.length);
      const model = (end > 0 ? tt.slice(STDOUT_PREFIX.length, end) : tt.slice(STDOUT_PREFIX.length)).trim();
      if (!model) continue;
      const ts = Date.parse(o.timestamp || "");
      return { model, ts: Number.isFinite(ts) ? ts : 0 };
    }
  }
  return null;
}

// transcript 머리 텍스트에서 첫 timestamp = 대화 시작 시각. 못 찾으면 null(→ settings 폴백 자체를 포기).
// fs.stat의 birthtime/ctime은 복사·백업·파일시스템 차이로 흔들려 쓰지 않는다(Codex 보완 수용).
export function parseSessionStartTs(headText: string): number | null {
  for (const s of String(headText).split(/\r?\n/)) {
    if (!s || s[0] !== "{") continue;
    let o: any; try { o = JSON.parse(s); } catch { continue; }
    const ts = Date.parse((o && o.timestamp) || "");
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

// transcript 텍스트에서 '마지막 실제 답 모델'(assistant message.model)을 찾는다 — cwd strict, "<synthetic>" 제외.
// lastModelInFile(꼬리 128KB 고정)과 달리 증분 스캔 조각에도 쓰이므로 ts를 함께 반환(신선도 판정은 호출측).
export function parseLastAssistantModel(text: string, ws: string, normWs: (p: string) => string): { model: string; ts: number } | null {
  const want = normWs(ws);
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i];
    if (!s || s[0] !== "{" || s.indexOf('"model"') < 0) continue; // 빠른 사전 필터
    let o: any; try { o = JSON.parse(s); } catch { continue; }
    if (o.isSidechain) continue;
    if (normWs(String(o.cwd || "")) !== want) continue; // 이 폴더 entry만(strict)
    const m = o && o.message && o.message.model;
    if (typeof m === "string" && m && m !== "<synthetic>") {
      const ts = Date.parse(o.timestamp || "");
      return { model: m, ts: Number.isFinite(ts) ? ts : 0 };
    }
  }
  return null;
}

// 의도 결정 v3(포커스 귀속, 2026-07-04 사용자 실측 반영):
//   후보 = ① 이 대화의 마지막 터미널 /model 기록(cmd) ② 이 프로젝트에 '포커스 귀속'된 설정 변경(attr — 아래 shouldAttribute
//   가 기록한 것: UI 피커/터미널 어느 쪽이든 '그 순간 이 창이 포커스였던' 변경) → 둘 중 **시각이 더 최신인 쪽** 승리.
//   둘 다 없으면 ③ '대화 시작 전에 정해져 있던' 전역 설정만(settingsMtime <= sessionStart), 아니면 null=비교 skip.
// v0.1.78의 '계열 불일치+mtime → skip' 가드는 폐기 — 귀속(attr)이 생겨 구별이 가능해졌고, 그 가드는 '타 창이 설정을
//   바꾼 뒤 이 창 새 턴이 전역값으로 침묵 전환되는' 진짜 drift(사용자 실측)까지 억제했다. 이제: 변경이 이 창 귀속이면
//   attr이 최신 의도(즉시 경고 UX 복원), 타 창 귀속이면 이 ws는 자기 의도 유지(침묵 전환 시 진짜 경고), 귀속 없는
//   변경(비포커스·외부 편집·구버전 시절)은 cmd/폴백 규칙대로 — 과도기(귀속 도입 전 UI 전환)엔 한 번 애매할 수 있음(README 명시).
export function resolveCcIntent(
  cmdModel: string | null,
  cmdTs: number | null,
  attrModel: string | null,
  attrTs: number | null,
  settingsModel: string,
  settingsMtimeMs: number | null,
  sessionStartTs: number | null,
): { model: string; source: "command" | "attributed" | "settings" } | null {
  const cmd = cmdModel && cmdModel.trim() ? cmdModel.trim() : "";
  const attr = attrModel && attrModel.trim() ? attrModel.trim() : "";
  const cTs = typeof cmdTs === "number" && Number.isFinite(cmdTs) ? cmdTs : 0;
  const aTs = typeof attrTs === "number" && Number.isFinite(attrTs) ? attrTs : 0;
  if (cmd && attr) return aTs >= cTs ? { model: attr, source: "attributed" } : { model: cmd, source: "command" };
  if (cmd) return { model: cmd, source: "command" };
  if (attr) return { model: attr, source: "attributed" };
  const set = (settingsModel || "").trim();
  if (
    set &&
    typeof settingsMtimeMs === "number" && Number.isFinite(settingsMtimeMs) &&
    typeof sessionStartTs === "number" && Number.isFinite(sessionStartTs) &&
    settingsMtimeMs <= sessionStartTs
  ) return { model: set, source: "settings" };
  return null;
}

// ── 포커스 귀속 판정(순수) — '이 설정 변경을 이 창(프로젝트)의 선택으로 볼 것인가' ──
// 원리: UI 피커/터미널 조작은 그 순간 OS 포커스를 가진 창에서만 가능하다. 각 창의 확장은 자기 포커스 구간
// (focusStartMs~focusEndMs, 진행 중이면 focusEndMs=null)을 알므로, 설정 파일의 변경 시각(settingsMtimeMs)이
// '이 창이 포커스였던 구간' 안(+감시 지연 여유 graceMs)에 들어야만 귀속한다.
// → 변경 직후 사용자가 다른 창으로 이동해 이벤트가 늦게 와도(내 구간 안) 잡고, 반대로 변경 '후'에 포커스를 받은
//   창(focusStart > 변경 시각)이 자기 것으로 오귀속하는 race는 차단(Codex 보완 수용). 모델 값이 실제로 안 변했으면 기록 안 함.
export function shouldAttributeSettingsChange(
  settingsMtimeMs: number,
  focusStartMs: number | null,
  focusEndMs: number | null, // null=지금도 포커스 중
  nowMs: number,
  prevModel: string,
  newModel: string,
  graceMs = 2000,
): boolean {
  if (!newModel || !newModel.trim()) return false;
  if ((prevModel || "").trim() === newModel.trim()) return false; // 값 무변화(다른 키 변경·중복 이벤트) → 기록 안 함
  if (typeof focusStartMs !== "number" || !Number.isFinite(focusStartMs)) return false; // 포커스 이력 없음
  if (!Number.isFinite(settingsMtimeMs)) return false;
  if (settingsMtimeMs < focusStartMs) return false; // 변경이 내 포커스 시작 '전' — 다른 창에서 바꾼 뒤 내가 포커스 받음 → 오귀속 차단
  const end = typeof focusEndMs === "number" && Number.isFinite(focusEndMs) ? focusEndMs : nowMs;
  return settingsMtimeMs <= end + graceMs; // 내 포커스 구간(+지연 여유) 안의 변경만 내 것
}

// cc-intent 맵 정리 — 오래된 프로젝트 귀속 제거(active/ 30일 정리와 동형). 원본을 바꾸지 않고 새 맵 반환.
export function pruneIntentMap<T extends { ts: number }>(map: Record<string, T>, nowMs: number, ttlMs = 30 * 24 * 60 * 60 * 1000): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(map || {})) {
    const v = map[k];
    if (v && typeof v.ts === "number" && Number.isFinite(v.ts) && nowMs - v.ts <= ttlMs) out[k] = v;
  }
  return out;
}
