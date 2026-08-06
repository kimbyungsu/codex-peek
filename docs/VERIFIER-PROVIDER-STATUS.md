# 검증자 교체(VerifierProvider) — 보류 보관 문서 (재개용)

작성: 2026-08-06 · 사용자 결정: **기능은 보류(기본 미사용) 상태로 보관하되, 이미 구현·확인 통과까지
끝난 사실과 재개 절차를 이 문서로 고정**한다. 미래 세션이 기억 없이도 이 문서 하나로 빠르게 꺼내
쓸 수 있게 하는 것이 목적이다.

## 1. 지금 상태 (2026-08-06 기준 — 전부 사실)

- **Phase1 핵심 실행축 = 구현 완료 + Codex 확인 검증 통과(지적 0)**. 설계 정본은
  [VERIFIER-PROVIDER-DESIGN.md](VERIFIER-PROVIDER-DESIGN.md)(동결 v3 — 설계검증 3왕복 통과).
- 구현 커밋: `50180f1`(본 구현) + `e8d976f`(구현검증 blocker 3 반영). 시험:
  `tests/verifier-provider.test.js` 29단언 + 전체 체인 종료코드 0. 런타임 스모크 실측 완료
  (claude CLI 비대화식 ~3초·성공/오류 JSON 형태 확인).
- **기본값은 codex** — 아무것도 하지 않으면 종전과 완전히 동일하게 동작한다(무회귀가 계약).

## 2. 지금 당장 쓰는 법 (보류 해제는 이 한 줄)

```
node "C:\Users\MASTER\.codex-bridge\codex-bridge.js" verifier-provider claude   # Claude를 검증자로
node "C:\Users\MASTER\.codex-bridge\codex-bridge.js" verifier-provider codex    # 되돌리기
node "C:\Users\MASTER\.codex-bridge\codex-bridge.js" verifier-provider          # 현재값 확인
```
전환 후 일반 검증 흐름(ask-start → ask-wait)은 그대로다. 실행 중이던 검증 작업은 시작 시점 값으로
동결되므로 도중 전환에 오염되지 않는다.

## 3. Claude 검증자의 특성(전환 전에 알아야 할 것)

- **무상태**: 매 검증이 새 대화다. 자연어 맥락 연속(이전 왕복 기억)은 없다 — 대신 기계 연속성
  (지적 계보·입장 심사·회차 예산·재판단 규약 동결본)은 답 텍스트 기반이라 전부 유지된다.
  출력 헤더가 "# 연결 세션" 대신 "# 검증자: Claude(무상태)"로 표시된다.
- **자연 축퇴(Codex 전용 장치는 스스로 꺼짐)**: 대시보드 대화 뷰·연결 세션·기록 다룬 흔적
  대조(근거의심)·근거 재확인(바이트 프로브)·관찰일지 결합 '승격'은 동작하지 않는다.
  인용 파일·줄의 '존재성' 검사(evidence-mismatch)는 유지된다(시험으로 실증).
- 검증 성공 증명·종료 관문 인정은 공급자와 무관하게 동일하게 동작한다(저장 키=구현자 세션 불변).

## 4. 재개 시 1순위 — 남은 표면 조각 (기능 신설 아님·전부 소형)

Phase1 확인 검증에서 "미포함 후속"으로 고지된 그대로. 보류 해제 후 실사용 전환을 결정하면
이것부터 닫는 것이 순서다:
1. 대시보드에 현재 검증자 라벨 표시 + 결손 1줄 고지(설계 §4 — 대화 뷰·근거의심이 비는 이유).
2. 종료 관문(verify-guard) 통과 e2e + C-C 모드 durableProofGate 인정 e2e(설계 시험 6-1).
3. C-C 조합(구현자 Codex + 검증자 Claude) 스모크(설계 시험 6).
4. doctor에 claude 실행기 상태 줄.
5. 실 claude 유료 호출 1회 실전 스모크(가짜 실행기 아닌 실물 — 수동 확인이면 충분).

## 5. 범위 밖(별도 결정 전 착수 금지)

- **Phase2+ = 역할 전면 교체**(구현자 자리를 Codex 호스트로): 설계 §0이 명시 범위 밖.
  선행 검토는 세션 메모 codex-peek-extensibility(HostAdapter·I/O codec·Codex 훅 이식)에 있음.
- 요청문 관문 '거부 승격', 보관함 항목들은 이 기능과 무관한 별개 트랙.

## 6. 재개 절차 (미래 세션용 체크리스트)

1. 이 문서와 [VERIFIER-PROVIDER-DESIGN.md](VERIFIER-PROVIDER-DESIGN.md)를 읽는다(설계가 정본).
2. `node tests/verifier-provider.test.js`로 현재도 초록인지 확인(29단언 — 회귀 감지).
3. 사용자에게 "보류 해제(실사용 전환)" 여부를 확인받는다 — 해제면 §4를 위에서부터 닫는다.
4. §4 완료 후 실전 전환(`verifier-provider claude`)·1회 실전 검증으로 마감 확인.
