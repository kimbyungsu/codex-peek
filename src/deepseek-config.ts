// ── DeepSeek 설정(고급 탐색용 키) — 순수 로직 (설계: SCOUT-TRACK §3.2, D4: env/파일 우선·대시보드 UI는 이번에 사용자 요청으로 추가) ──
// 보안 원칙: 키는 런타임 홈(~/.codex-bridge/deepseek.json)에만 저장(레포 밖 — 커밋 불가 영역). 웹뷰에는 원문을 절대 되돌려주지
// 않고 마스킹만 보낸다. 이 키로 나가는 외부 요청은 deepseek-bridge.js의 다섯 명령뿐 — ping(3트랙 켤 때 연결 점검 1회)·capability(준비 점검)·
// enrich(의미 보강)·map(정찰 지도 생성 시 꾸러미)·page(탐색 담당이 DeepSeek일 때 정리 담당 재료 — 2026-09-06 추가). 그 외 어떤 경로도 이 키로 전송하지 않는다
// (PRIVACY.md '외부로 나가는 것' 참조 — 옛 '예외 둘' 문구는 capability·enrich 추가 시점부터 낡았던 것을 2026-09-06 정정).
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
