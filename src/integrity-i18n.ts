// ── 무결성 경고문 현지화(표시 시점) — integrity.json의 detail은 '기록 시점 언어'로 저장된 데이터라,
// 언어를 바꾼 뒤에도 경고가 옛 언어로 남는다(실측: EN 전환 후 상태바 툴팁·대시보드 배너가 한국어). 그래서 표시 직전에 현재 언어로 고른다.
// 우선순위: ① 기록부가 함께 저장한 detailKo/detailEn(동적 값 포함 — 신규 이벤트는 양언어 동시 저장)
//          ② kind(+severity/sig)만으로 문구가 온전히 정해지는 종류는 여기서 재생성 — 과거(단일 detail만 저장) 이벤트도 즉시 현재 언어
//          ③ 둘 다 안 되면 저장된 detail 그대로(정직 폴백 — 없는 번역을 지어내지 않음)
// 문구는 기록부(bridge/codex-bridge.js flagVerdict·src/extension.ts syncSessionMissing 등)와 자구 일치를 유지할 것.
// vscode 의존 없음 — 테스트(tests/integrity-i18n.test.js)가 out/integrity-i18n.js를 직접 import한다.

export type IntegrityEventLike = { kind?: string; severity?: string; sig?: string; detail?: string; detailKo?: string; detailEn?: string };

const STATIC: Record<string, { ko: string; en: string }> = {
  "verdict-missing": {
    ko: "Codex 답에 마지막 '검증: 통과/통과(보완)/보류/실패' 판정 줄이 없습니다 — 대시보드 색 표시가 비고, 결론을 직접 확인해야 합니다.",
    en: "Codex's answer has no final verdict line ('Verdict: pass/pass (notes)/inconclusive/fail') — the dashboard chip stays empty; check the conclusion yourself.",
  },
  "verdict-nonclean:error": {
    ko: "Codex 결론이 '검증 실패'입니다 — 통과가 아닙니다. 대시보드 대화에서 결론과 근거를 확인하세요.",
    en: "Codex's verdict is FAIL — not a pass. Check the conclusion and evidence in the dashboard conversation.",
  },
  "verdict-nonclean:warning": {
    ko: "Codex 결론이 '통과'가 아닙니다(보류·불가·정보 부족 등 — 결론을 못 냄). 대시보드 대화에서 결론을 확인하세요.",
    en: "Codex's verdict is not a pass (hold/unable/insufficient info — no conclusion). Check the conclusion in the dashboard conversation.",
  },
  "session-missing:blocked": {
    ko: "현재 연결된 Codex 세션이 없고, 자동 생성이 멈춰 있습니다. 'Codex 세션 연결'에서 수동으로 연결하세요. 계속되면 개발자에게 문의해 주세요.",
    en: "No Codex session is linked and auto-creation is paused. Link one manually under 'Codex Session Link'. If this persists, please report it.",
  },
  "session-missing:normal": {
    ko: "현재 연결된 Codex 세션이 없습니다. 'Codex 세션 연결'에서 수동으로 연결하거나, 검증을 계속 진행하면 새 세션 생성·연결을 자동으로 시도합니다.",
    en: "No Codex session is linked. Link one manually under 'Codex Session Link', or keep verifying and a new session will be created and linked automatically.",
  },
};

// brain-drift 과거 이벤트 폴백 — sig에 비교값 두 개가 들어 있어(`cc-model:a!b` 형식) 문구를 재생성할 수 있다.
// (sig의 cx-model 값은 기록 시 소문자 정규화본이라 원문 표기와 다를 수 있음 — 과거 이벤트 한정 폴백이라 허용.)
function brainDriftFromSig(sig: string, en: boolean): string | null {
  const m = /^(cc-model|cx-model|cx-effort|ci-model|ci-effort):([^!]*)!(.*)$/.exec(sig || "");
  if (!m) return null;
  const a = m[2], b = m[3];
  if (m[1] === "cc-model") return en
    ? `Claude: configured model is '${a}' but the latest answer used '${b}'. Your selection may not have taken effect yet (re-select the model in the app).`
    : `Claude: 설정한 모델은 '${a}'인데 최근 답한 모델은 '${b}'예요. 고른 모델이 아직 안 먹었을 수 있어요(앱에서 모델을 다시 선택).`;
  if (m[1] === "cx-model") return en
    ? `Codex: configured model is '${a}' but the latest answer used '${b}'. The change may apply from the next answer.`
    : `코덱스: 설정한 모델은 '${a}'인데 최근 답한 모델은 '${b}'예요. 바꾼 게 다음 답부터 반영될 수 있어요.`;
  if (m[1] === "cx-effort") return en
    ? `Codex: configured reasoning is '${a}' but the latest answer used '${b}'. The change may apply from the next answer.`
    : `코덱스: 설정한 생각강도는 '${a}'인데 최근 답은 '${b}'였어요. 바꾼 게 다음 답부터 반영될 수 있어요.`;
  if (m[1] === "ci-model") return en
    ? `Implementer Codex: the model at automatic pinning was '${a}', but the latest answer used '${b}'. Confirm that the user intended this model change.`
    : `구현 코덱스: 자동 고정 당시 모델은 '${a}'인데 최근 답은 '${b}'였어요. 사용자가 의도한 변경인지 확인하세요.`;
  return en
    ? `Implementer Codex: reasoning at automatic pinning was '${a}', but the latest answer used '${b}'. Confirm that the user intended this reasoning change.`
    : `구현 코덱스: 자동 고정 당시 생각강도는 '${a}'인데 최근 답은 '${b}'였어요. 사용자가 의도한 변경인지 확인하세요.`;
}

// verify-incomplete 과거 이벤트 폴백 — 저장 원문에서 동적 값(검증 모드·강제 횟수)을 되읽어 반대 언어로 재생성(Codex 보완 수용).
// 형식이 안 맞으면 null(원문 폴백) — 억지 번역을 지어내지 않음.
function verifyIncompleteFromDetail(detail: string, en: boolean): string | null {
  let m = /^검증 모드:(\S+) — (\d+)회 강제했으나/.exec(detail);
  if (!m) m = /^Verify mode:(\S+) — forced (\d+) times\b/.exec(detail);
  if (!m) return null;
  return en
    ? `Verify mode:${m[1]} — forced ${m[2]} times, but this turn ended without a completed verification (this turn's result is UNVERIFIED).`
    : `검증 모드:${m[1]} — ${m[2]}회 강제했으나 검증이 완료되지 않은 채 이 턴이 종료됨(이 턴 결과는 미검증).`;
}

export function localizeIntegrityDetail(e: IntegrityEventLike, en: boolean): string {
  const stored = en ? e.detailEn : e.detailKo;
  if (stored) return stored; // ① 신규 이벤트 — 기록부가 양언어를 함께 저장
  const k = String(e.kind || "");
  const st = STATIC[k] || STATIC[`${k}:${e.severity || ""}`] || (e.sig ? STATIC[String(e.sig)] : undefined);
  if (st) return en ? st.en : st.ko; // ② 문구가 kind/severity/sig로 정해지는 종류 — 과거 이벤트도 현재 언어로
  if (k === "brain-drift" && e.sig) {
    const bd = brainDriftFromSig(String(e.sig), en);
    if (bd) return bd;
  }
  if (k === "verify-incomplete" && e.detail) {
    const vi = verifyIncompleteFromDetail(String(e.detail), en);
    if (vi) return vi;
  }
  return e.detail || ""; // ③ 동적 값 포함 과거 이벤트(근거 불일치 목록 등) — 기록된 원문 유지(정직 폴백)
}
