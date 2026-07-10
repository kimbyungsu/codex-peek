// ── 탭2 검증 통계 집계(순수 함수) — verdicts.jsonl 원문(raw 문자열)을 받아 기간별 verdict 분포·검증횟수·전환·활동 히트맵을 낸다 ──
// 기간 정책: 즉각성 7일(week) / 추이 14일(twoWeek + daily14 일별) / 흐름 28일(month + heatmap 요일×시간). 깨진 줄은 skip(여러 창 동시 append 대비). ws 주면 그 프로젝트만.
// vscode 의존이 없도록 분리 — 파일 읽기는 호출측(extension.ts) 책임, normWs도 인자로 받는다. 그래서 extension과 테스트가 '같은 함수'를 쓴다(미러 복제 제거).

export interface VerifyBucket { pass: number; passNotes: number; inconclusive: number; fail: number; unparsed: number; total: number }
export function emptyVB(): VerifyBucket { return { pass: 0, passNotes: 0, inconclusive: 0, fail: 0, unparsed: 0, total: 0 }; }
function bumpVB(b: VerifyBucket, v: string): void {
  b.total++;
  if (v === "pass") b.pass++;
  else if (v === "pass-notes") b.passNotes++;
  else if (v === "inconclusive") b.inconclusive++;
  else if (v === "fail") b.fail++;
  else b.unparsed++;
}

export interface VerifyStats {
  week: VerifyBucket;      // 즉각성: 최근 7일 합계
  twoWeek: VerifyBucket;   // 추이: 최근 14일 합계
  month: VerifyBucket;     // 흐름: 최근 28일 합계
  daily14: VerifyBucket[]; // 추이: 14일 일별
  heatmap: number[][];     // 흐름: 4주 요일(월=0)×시간(0~23)
  resolved7: number;       // 최근 7일 '실패/보류 뒤 통과' 전환 근사(같은 세션·14일내 직전 unclean→pass). '잡은 문제 수'가 아님 — UI 라벨도 이 톤으로
  byModel: Record<string, { count: number; tokens: number }>; // 흐름 28일: 모델별 검증 건수·코덱스 토큰(1회분 합). 과거 기록은 model 없어 '(미상)'
  byMode: Record<string, { count: number; tokens: number }>;  // 흐름 28일: 검증모드(플랜/코드/올웨이즈)별 건수·토큰
}

// 정찰(3트랙) 비용 집계 — scout-usage.jsonl(append-only) → 28일 팔별 합계. 렌더는 통계 탭 '정찰 토큰' 구획.
// self 팔은 usage가 null(토큰 미제공) — 문자수 합계만 참(정직 표기는 렌더 몫). ping은 workspace가 비어 전역 합산.
export type ScoutCosts = {
  byArm: Record<string, { count: number; usageIn: number; usageOut: number; pkgChars: number; mapChars: number; lastTs: string }>; // lastTs=팔별 마지막 사용 시각(탐색자 카드 표시 재료 — 지도 10장 프루닝과 무관한 장부 기반, 감사 일치 2026-07-10)
  total: number; // 28일 기록 건수(전 팔)
};
export function computeScoutCosts(raw: string, now: number, ws: string, normWsFn: (s: string) => string): ScoutCosts {
  const out: ScoutCosts = { byArm: {}, total: 0 };
  const cut = now - 28 * 24 * 60 * 60 * 1000;
  const wsN = normWsFn(ws || "");
  for (const ln of String(raw || "").split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o: any; try { o = JSON.parse(ln); } catch { continue; }
    const t = Date.parse(o?.ts || "");
    if (!Number.isFinite(t) || t < cut) continue;
    if (!o.arm) continue;
    // ping은 프로젝트 무관(전역 1회 점검) — 항상 포함. 지도 기록은 이 폴더(정찰 대상) 것만.
    if (o.arm !== "ping" && normWsFn(String(o.workspace || "")) !== wsN) continue;
    const a = out.byArm[o.arm] || (out.byArm[o.arm] = { count: 0, usageIn: 0, usageOut: 0, pkgChars: 0, mapChars: 0, lastTs: "" });
    a.count++;
    if (!a.lastTs || t > (Date.parse(a.lastTs) || 0)) a.lastTs = o.ts;
    if (typeof o.usageIn === "number") a.usageIn += o.usageIn;
    if (typeof o.usageOut === "number") a.usageOut += o.usageOut;
    if (typeof o.pkgChars === "number") a.pkgChars += o.pkgChars;
    if (typeof o.mapChars === "number") a.mapChars += o.mapChars;
    out.total++;
  }
  return out;
}

export function computeVerifyStats(raw: string, now: number, ws: string | null, normWs: (p: string) => string): VerifyStats {
  const DAY = 24 * 60 * 60 * 1000;
  const d7 = now - 7 * DAY, d14 = now - 14 * DAY, d28 = now - 28 * DAY;
  const out: VerifyStats = {
    week: emptyVB(), twoWeek: emptyVB(), month: emptyVB(),
    daily14: Array.from({ length: 14 }, () => emptyVB()),
    heatmap: Array.from({ length: 7 }, () => new Array(24).fill(0)) as number[][],
    resolved7: 0,
    byModel: {}, byMode: {},
  };
  const events: { ts: number; v: string; session: string; model: string; mode: string; effort: string; tok: number }[] = [];
  let seq = 0;
  for (const ln of String(raw).split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o: any; try { o = JSON.parse(ln); } catch { continue; } // 깨진/반쪽 줄 skip(여러 창 동시 append 대비)
    if (ws && (!o.workspace || normWs(o.workspace) !== normWs(ws))) continue; // 이 프로젝트(폴더)만 — workspace 없는 구버전/깨진 줄도 제외
    const ts = Date.parse(o.ts);
    if (!Number.isFinite(ts) || ts > now) continue; // 미래 timestamp(시계 꼬임·수동편집·타 PC) 제외 — 안 그러면 합계엔 들고 일별엔 빠져 불일치
    // 전환 추적용 세션 키: Claude 세션 우선 → 없으면 Codex 세션 → 둘 다 비면 고유키(seq). 빈 세션 다발이 한 그룹으로 묶여 과대계상되는 것 차단.
    const session = String(o.claudeSession || o.codexSession || ("__u" + seq));
    const tk = (o.codexTokens && typeof o.codexTokens.total === "number") ? o.codexTokens.total : 0; // 이 검증 1회 코덱스 토큰(2순위-A 수집, 없으면 0)
    events.push({ ts, v: String(o.verdict || "unparsed"), session, model: String(o.model || ""), mode: String(o.mode || ""), effort: String(o.effort || ""), tok: tk });
    seq++;
  }
  events.sort((a, b) => a.ts - b.ts);
  const prevUncleanTsBySession: Record<string, number> = {}; // 세션별 직전 fail/inconclusive의 시각(0=없음/직전 통과)
  for (const e of events) {
    if (e.ts >= d7) bumpVB(out.week, e.v);
    if (e.ts >= d14) {
      bumpVB(out.twoWeek, e.v);
      const idx = Math.floor((e.ts - d14) / DAY);
      if (idx >= 0 && idx < 14) bumpVB(out.daily14[idx], e.v);
    }
    if (e.ts >= d28) {
      bumpVB(out.month, e.v);
      const dt = new Date(e.ts);
      out.heatmap[(dt.getDay() + 6) % 7][dt.getHours()]++;
      const mk = e.model ? (e.model + (e.effort ? " · " + e.effort : "")) : "(unknown)"; // 모델+추론강도별 28일 건수·토큰
      if (!out.byModel[mk]) out.byModel[mk] = { count: 0, tokens: 0 };
      out.byModel[mk].count++; out.byModel[mk].tokens += e.tok;
      const md = e.mode || "(unknown)"; // 검증모드별 28일 건수·토큰
      if (!out.byMode[md]) out.byMode[md] = { count: 0, tokens: 0 };
      out.byMode[md].count++; out.byMode[md].tokens += e.tok;
    }
    // 같은 세션에서 '실패/보류 뒤 통과'로 바뀐 전환만(최근 7일). 직전 unclean이 14일 이내일 때만 — 오래된 무관 실패가 이번 통과에 붙는 것 방지. '잡은 문제 수'가 아닌 전환 근사.
    const pts = prevUncleanTsBySession[e.session] || 0;
    if (e.ts >= d7 && (e.v === "pass" || e.v === "pass-notes") && pts && (e.ts - pts) <= 14 * DAY) out.resolved7++;
    prevUncleanTsBySession[e.session] = (e.v === "fail" || e.v === "inconclusive") ? e.ts : 0;
  }
  return out;
}

// ── 코덱스 세션 토큰 — rollout tail 문자열에서 '마지막 token_count의 total_token_usage'(세션 누적)를 뽑는다 ──
// usage-monitor codexHistory와 같은 구조: 줄의 payload.type==='token_count', payload.info.total_token_usage. 필드명은 그 normalizeUsage와 동일.
// 파일 IO는 호출측(extension) 책임 — 여기선 문자열만 받아 파싱(테스트로 필드명 고정 가능).
export type CodexTokens = { input: number; cachedInput: number; output: number; reasoning: number; total: number };
export function parseSessionTokens(rawTail: string): CodexTokens | null {
  let total: any = null;
  for (const ln of String(rawTail).split(/\n/)) {
    if (!ln.trim() || ln.indexOf("token_count") < 0) continue; // 빠른 사전 필터(JSON.parse 비용 절감)
    let o: any; try { o = JSON.parse(ln); } catch { continue; } // 잘린 첫 줄/깨진 줄 skip
    if (o?.payload?.type !== "token_count") continue;
    const t = o.payload.info?.total_token_usage;
    if (t) total = t; // 뒤로 갈수록 최신 누적
  }
  if (!total) return null;
  const n = (x: any) => (typeof x === "number" && isFinite(x) ? x : 0);
  const g = (s: string, c: string) => n(total[s] ?? total[c]); // snake_case 우선, camelCase 폴백 — usage-monitor normalizeUsage와 동일 견고함
  return { input: g("input_tokens", "inputTokens"), cachedInput: g("cached_input_tokens", "cachedInputTokens"), output: g("output_tokens", "outputTokens"), reasoning: g("reasoning_output_tokens", "reasoningOutputTokens"), total: g("total_tokens", "totalTokens") };
}

// ── 클로드 토큰 — transcript 줄들에서 28일 내 + 이 폴더(cwd) message.usage를 합(코덱스 토큰과 분리). 사이드체인(서브에이전트)은 제외 ──
// 줄 구조: obj.message.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens 또는 cache_creation.ephemeral_5m/1h}, obj.timestamp, obj.cwd, obj.isSidechain.
// ★usage 중복 방어: 한 API 응답이 transcript에 여러 줄(content 블록별)로 쪼개져도 각 줄이 '같은 usage'를 통째로 들고 있다(실측: 요청 3263개가
//   최대 7줄로 쪼개지고 그중 3260개가 전 줄 동일 usage → 줄 단위 합산은 ~2.3배 과대). requestId당 마지막 usage 1개만 합산한다.
// ★턴수: '사용자가 실제로 보낸 질문 수'만 센다(type:"user" 중 도구결과·메타·시스템주입 제외). 예전 'usage 있는 응답 줄 수'는
//   도구 왕복마다 1씩 늘어 사용자 체감 턴(질문 몇 번)과 수십 배 어긋났다(실측: 질문 430개가 10706으로 표시).
export type ClaudeTokens = { input: number; output: number; cacheRead: number; cacheCreate: number; total: number; turns: number };
// seenReq(선택): 호출측이 여러 파일에 걸쳐 공유하는 requestId 집합 — resume/fork로 이전 기록 줄이 새 파일에 복사돼도 파일 간 중복 합산 방지.
export function sumClaudeUsage(lines: string[], now: number, ws: string | null, normWs: (p: string) => string, seenReq?: Set<string>): ClaudeTokens {
  const d28 = now - 28 * 24 * 60 * 60 * 1000;
  const n = (x: any) => (typeof x === "number" && isFinite(x) ? x : 0);
  type U = { input: number; output: number; cacheRead: number; cacheCreate: number };
  const readU = (u: any): U => ({
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheCreate: n(u.cache_creation_input_tokens) || (n(u.cache_creation && u.cache_creation.ephemeral_5m_input_tokens) + n(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens)),
  });
  const byReq: Record<string, U> = {}; // requestId → 마지막 usage(같은 요청의 쪼개진 줄들은 동일 usage — 마지막이 최종)
  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0, turns = 0;
  for (const ln of lines) {
    if (!ln || !ln.trim()) continue;
    if (ln.indexOf("usage") < 0 && !/"type"\s*:\s*"user"/.test(ln)) continue; // 빠른 사전 필터(usage 합산용 + 턴수용) — 직렬화 공백 변형도 허용(Codex 보완 수용)
    let o: any; try { o = JSON.parse(ln); } catch { continue; }
    if (o.isSidechain) continue; // 서브에이전트(사이드체인) 제외 — 메인 대화 비용만
    if (ws && (!o.cwd || normWs(String(o.cwd)) !== normWs(ws))) continue; // 이 폴더(cwd)만 — cwd 없는 줄도 제외(프로젝트별 누수 차단, verdict 통계의 workspace 정책과 동일)
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts) || ts < d28 || ts > now) continue; // 28일 내만
    // 턴수 — 사용자가 직접 보낸 질문만: 도구 결과 반환(type:"user"지만 tool_result)·메타 줄·시스템 주입(origin.kind: 태스크 알림 등)은 제외
    if (o.type === "user" && o.message && !o.isMeta && !(o.origin && o.origin.kind)) {
      const c = o.message.content;
      const isToolResult = Array.isArray(c) && c.some((x: any) => x && x.type === "tool_result");
      const uk = o.uuid ? "u:" + String(o.uuid) : ""; // 파일 간 중복(resume/fork 복사 줄) 방지 — requestId와 같은 집합에 접두사로 격리
      if (!isToolResult && !(seenReq && uk && seenReq.has(uk))) { turns++; if (seenReq && uk) seenReq.add(uk); }
    }
    const u = o.message && o.message.usage;
    if (!u) continue;
    if (o.requestId) byReq[String(o.requestId)] = readU(u); // 같은 요청의 쪼개진 줄은 덮어쓰기(마지막 승리) → 1회만 합산
    else { const v = readU(u); input += v.input; output += v.output; cacheRead += v.cacheRead; cacheCreate += v.cacheCreate; }
  }
  for (const k of Object.keys(byReq)) {
    if (seenReq) { if (seenReq.has(k)) continue; seenReq.add(k); } // 파일 간 중복(resume/fork 복사 줄) 방지
    const v = byReq[k]; input += v.input; output += v.output; cacheRead += v.cacheRead; cacheCreate += v.cacheCreate;
  }
  return { input, output, cacheRead, cacheCreate, total: input + output + cacheRead + cacheCreate, turns };
}

// ── 프로젝트별 비교(3c) — ws 필터 없이 모든 workspace의 28일 검증 분포를 group-by. '이 폴더 통계'와 별개 섹션 ──
export type ProjectStat = { count: number; pass: number; passNotes: number; inconclusive: number; fail: number; unparsed: number };
export function computeProjectStats(raw: string, now: number, normWs: (p: string) => string): Record<string, ProjectStat> {
  const d28 = now - 28 * 24 * 60 * 60 * 1000;
  const out: Record<string, ProjectStat> = {};
  for (const ln of String(raw).split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o: any; try { o = JSON.parse(ln); } catch { continue; }
    const ts = Date.parse(o.ts);
    if (!Number.isFinite(ts) || ts < d28 || ts > now) continue;
    const w = o.workspace ? normWs(String(o.workspace)) : "(unknown)";
    if (!out[w]) out[w] = { count: 0, pass: 0, passNotes: 0, inconclusive: 0, fail: 0, unparsed: 0 };
    const p = out[w]; p.count++;
    const v = String(o.verdict || "unparsed");
    if (v === "pass") p.pass++; else if (v === "pass-notes") p.passNotes++; else if (v === "inconclusive") p.inconclusive++; else if (v === "fail") p.fail++; else p.unparsed++;
  }
  return out;
}
