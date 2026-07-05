// ── DeepSeek 설정(고급 탐색용 키) — 순수 로직 (설계: SCOUT-TRACK §3.2, D4: env/파일 우선·대시보드 UI는 이번에 사용자 요청으로 추가) ──
// 보안 원칙: 키는 런타임 홈(~/.codex-bridge/deepseek.json)에만 저장(레포 밖 — 커밋 불가 영역). 웹뷰에는 원문을 절대 되돌려주지
// 않고 마스킹만 보낸다. 현재 버전은 이 키로 어떤 전송도 하지 않는다(LLM 지도 단계 미구현 — PRIVACY 명시).
// vscode/fs 의존 없음 — 파일 IO는 extension 책임. 테스트가 out/deepseek-config.js를 직접 import.

export const DEEPSEEK_DEFAULTS = { model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com" };

// 표시용 마스킹 — 앞 3자(sk-)와 끝 4자만. 원문 길이도 숨긴다(고정 4개 불릿).
export function maskKey(key: string): string {
  const k = (key || "").trim();
  if (!k) return "";
  if (k.length <= 8) return "••••";
  return k.slice(0, 3) + "••••" + k.slice(-4);
}

// 형식 타당성(느슨) — 저장 자체는 막지 않되 UI 경고용. DeepSeek 키는 'sk-' + 영숫자 관례.
export function isPlausibleKey(key: string): boolean {
  return /^sk-[A-Za-z0-9]{16,}$/.test((key || "").trim());
}

// 저장 병합: 키만 갈아끼우고 model/baseUrl 등 기존 설정은 보존(없으면 기본값 채움). 빈 키 = 키 삭제(다른 설정 유지).
export function mergeDeepseekConfig(existing: any, newKey: string): Record<string, unknown> {
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  const out: Record<string, unknown> = {
    ...base,
    model: typeof base.model === "string" && base.model ? base.model : DEEPSEEK_DEFAULTS.model,
    baseUrl: typeof base.baseUrl === "string" && base.baseUrl ? base.baseUrl : DEEPSEEK_DEFAULTS.baseUrl,
  };
  const k = (newKey || "").trim();
  if (k) out.apiKey = k; else delete out.apiKey;
  return out;
}
