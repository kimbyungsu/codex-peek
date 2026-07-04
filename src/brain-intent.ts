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

// 의도 결정: ① 이 대화의 마지막 /model(cmdModel) — 단 'cmd 유효성 가드' 통과 시에만(아래)
//           ② 없으면 '대화 시작 전에 정해져 있던' 전역 설정만
//   (settingsMtime <= sessionStart — 대화 도중 바뀐 설정은 다른 창의 /model일 수 있어 이 대화의 의도로 귀속 불가)
// ③ 둘 다 아니면 null → cc-model 비교 자체를 skip(거짓경고 0 우선).
// ★cmd 유효성 가드(사용자 실측 후속, 2026-07-04): 모델 전환에는 transcript에 기록되는 터미널 /model 외에
//   'UI 피커'(Claude Code 패널의 Switch model)도 있는데, 이는 전역 settings.json만 바꾸고 기록을 안 남긴다.
//   옛 /model(fable) 기록이 남은 채 UI로 opus를 고르고 opus 답이 오면 'fable 의도 vs opus 답' 거짓경고가 나므로:
//   settings 계열이 cmd와 같으면 → cmd 유효(터미널 /model 자신이 settings도 곧바로 쓰므로 일치가 정상 — 실측 +8s).
//   계열이 다르고 settings가 cmd '이후' 갱신 → 누군가(이 창 UI든 타 창이든) 바꿈 = 귀속 불가 → skip.
//   계열이 다른데 settings가 cmd보다 오래됨 → cmd가 최신 의도 → 유효. settings 빈값/읽기실패 → 반대 신호 없음 → 유효.
export function resolveCcIntent(
  cmdModel: string | null,
  cmdTs: number | null,
  settingsModel: string,
  settingsMtimeMs: number | null,
  sessionStartTs: number | null,
): { model: string; source: "command" | "settings" } | null {
  const cmd = cmdModel && cmdModel.trim() ? cmdModel.trim() : "";
  const set = (settingsModel || "").trim();
  if (cmd) {
    if (!set || modelFamily(set) === modelFamily(cmd)) return { model: cmd, source: "command" };
    if (
      typeof settingsMtimeMs === "number" && Number.isFinite(settingsMtimeMs) &&
      typeof cmdTs === "number" && Number.isFinite(cmdTs) && settingsMtimeMs > cmdTs
    ) return null; // cmd 이후 다른 계열로 설정 변경 — 이 창 UI 피커/타 창 구별 불가 → 비교 skip
    return { model: cmd, source: "command" };
  }
  if (
    set &&
    typeof settingsMtimeMs === "number" && Number.isFinite(settingsMtimeMs) &&
    typeof sessionStartTs === "number" && Number.isFinite(sessionStartTs) &&
    settingsMtimeMs <= sessionStartTs
  ) return { model: set, source: "settings" };
  return null;
}
