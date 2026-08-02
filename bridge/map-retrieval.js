"use strict";

// ── 요청 기준 지도 검색 — 정수 채점기(구현 1조각) ──────────────────────────────────────────
// 정본: docs/MAP-RETRIEVAL-SPEC.md §3 '씨앗 규칙' — 확정 산식 4단계·단조성 계약·고정 벡터 20쌍.
// 순수 계층: fs·프로세스 상태 접근 없음. 부동소수 연산 없음(전부 정수) — 언어·플랫폼 무관 동일 값.
//
// idf1000(N, df): 말뭉치 N개 파일 중 df개에 나온 씨앗의 감점 가중치(1000배 고정소수점).
//   - N < 20            → 1000 (소규모 말뭉치는 감점 미적용 — 명세 '20개 미만')
//   - df >= N           → 1    (어디에나 있는 씨앗 — 바닥. 0이 되지 않아 '사라지지 않는다')
//   - 그 외 4단계 정수 산식:
//       q   = floor(N * 65536 / df)                 (Q16 몫 · df<=N이라 q>=65536)
//       b   = q의 최상위 비트 위치(= floor(log2 q))
//       f16 = floor((q - 2^b) * 65536 / 2^b)        (소수부 선형 근사 0..65535)
//       L   = (b - 16) * 65536 + f16                (Q16 log2(N/df))
//       idf = floor(L * 693 / 65536), 1 미만이면 1  (ln2×1000 ≈ 693)
//   근사값이므로 round(1000*ln(N/df))와 다를 수 있다 — 순위용 값이라 필요한 성질은 정확도가
//   아니라 단조성이고, 유효 영역 전수(1,125,750건)에서 위반 0건을 테스트가 잠근다.
//   유효 영역: 정수 1 <= df, 1 <= N <= 1500(검색 대상 파일 상한 HL.maxScanFiles와 동일).
//   영역 밖·비정수 = null — 호출자 결함을 조용히 점수로 바꾸지 않는다(정밀도 보증 밖 값 차단).
const IDF_CORPUS_MIN = 20;
const IDF_N_MAX = 1500;
function idf1000(N, df) {
  if (!Number.isInteger(N) || !Number.isInteger(df) || N < 1 || df < 1 || N > IDF_N_MAX) return null;
  if (N < IDF_CORPUS_MIN) return 1000;
  if (df >= N) return 1;
  const q = Math.floor((N * 65536) / df);
  const b = 31 - Math.clz32(q);
  const f16 = Math.floor(((q - 2 ** b) * 65536) / 2 ** b);
  const L = (b - 16) * 65536 + f16;
  const v = Math.floor((L * 693) / 65536);
  return v < 1 ? 1 : v;
}

// 동점 비교(명세 §3): 슬래시 통일 · NFC 정규화 후, 대소문자를 보존한 채 '코드 포인트' 순서.
// 로캘 의존 비교(localeCompare) 금지 — 환경마다 순위가 갈린다. 문자열 < 비교도 쓰지 않는다:
// UTF-16 코드 유닛 순서라 서러게이트 쌍(보충 평면)에서 코드 포인트 순서와 어긋난다.
function normPathForTie(p) {
  return String(p == null ? "" : p).replace(/\\+/g, "/").normalize("NFC");
}
function comparePaths(a, b) {
  const A = Array.from(normPathForTie(a));
  const B = Array.from(normPathForTie(b));
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const ca = A[i].codePointAt(0);
    const cb = B[i].codePointAt(0);
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return A.length === B.length ? 0 : A.length < B.length ? -1 : 1;
}

module.exports = { idf1000, comparePaths, normPathForTie, IDF_CORPUS_MIN, IDF_N_MAX };
