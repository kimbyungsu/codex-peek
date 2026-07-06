# HANDOFF — 다른 로컬 환경에서 이어서 개발하기 (자립형 인수인계)

> 이 문서 하나로 이어갈 수 있게 쓰였다. 상세 설계 원본(SCOUT-TRACK.md·SCOPE-LEDGER.md)은 **의도적으로 레포 밖 로컬 문서**라
> 다른 환경에는 없다 — 그래서 이 파일이 그 요지를 포함한다. ⚠ **실 API 키·토큰은 어떤 파일·픽스처·예시에도 절대 넣지 말 것.**
> 마지막 갱신: 2026-07-06 (버전 0.1.86 · 이 문서를 포함해 push된 main 기준 — 로컬이 더 앞서 있을 수 있음)

## 0. 프로젝트 한 줄

**Codex Bridge**: Claude Code(구현) ↔ Codex CLI(검증)를 잇는 VS Code 확장 + 브릿지 런타임(`~/.codex-bridge/*.js`) + Claude 훅.
여기에 **3트랙(탐색)** — "지금 바꾸는 것이 어디까지 영향을 주는가"를 별도 AI(탐색자)가 지도로 그려주는 축 — 을 얹는 중.

## 1. 개발 규칙 (사용자 확정 — 위반 시 재작업됨)

1. **로컬 우선**: 기능 묶음 완성 전까지 로컬 개발·로컬 설치·테스트·**로컬 커밋**만. 푸시는 묶음 완성 또는 사용자 지시 시.
   ⚠ 오해 금지(2026-07-07 사용자 정정): **로컬 설치(`node install.js` → ~/.codex-bridge 즉시 반영)는 승인 불요·기본 동작**이다.
   승인이 필요한 건 대외 배포 3종 세트(버전 bump·깃헙 push·마켓 게시)뿐 — "버전 불변"을 "로컬 미반영"으로 읽지 말 것.
2. **버전 정책**: 커밋·푸시는 버전 불변. bump는 의미 묶음 완성 + **사용자 승인** 시에만. 마켓 게시는 별도 지시가 있을 때만.
3. **마법 시간 상수 금지**: "15분", "24시간" 같은 임의 시간 창으로 실사용을 재단하지 말 것(실제 사고 2회 — 두뇌설정 15분,
   무이력 seeds 24h). 시간 대신 **작업 신호·상태 서명** 기반으로 설계하고, 불가피한 상수는 근거를 주석에 남기고 사용자 확인.
4. **정직성**: 자른 것·못 보는 것·간주한 것은 반드시 산출물에 고지. "완료" 선언은 구조적 해결에만. 예시 하나 통과=완료 아님.
5. **경직성 금지**: 구체어·패턴 목록 누적으로 증상을 막지 말 것. 범주 규칙·구조 신호로.
6. **검증 2트랙**: 모든 결론은 `node ~/.codex-bridge/codex-bridge.js ask "..."`로 Codex 검증(원격 확인 필요시만 `--net`) →
   지적을 항목별 [수용/반박/보류]+근거로 재판단 → 통과 후에만 보고·커밋. 검증 후 수정했으면 재검증.
7. **모든 UI 문구는 한/영 쌍**(t/T/tE). 한국어만 넣으면 EN 모드 회귀.

## 2. 개발 루프 & 환경

- 루프: 수정 → `npm test`(전체 스위트 — package.json의 test 체인이 정본) → `node install.js`(빌드+확장 설치+브릿지 동기화) → **창 리로드** → Codex 검증 → 로컬 커밋(`git commit -F <메시지파일>` — PowerShell 5.1은 메시지 속 큰따옴표가 인자를 깨뜨리므로 파일 경유).
- 지뢰: 셸 인라인에 한글 경로·`\t`·`$`·따옴표를 넣지 말 것 — **스크립트는 항상 파일로 써서 실행**.
- 지뢰: `src/extension.ts`의 웹뷰 `<script>`는 바깥 템플릿 리터럴 안 — 웹뷰 JS 문자열의 개행 표기는 **백슬래시 두 겹**이어야 한다
  (한 겹이면 HTML 생성 시 실제 개행으로 변환 → 웹뷰 전체 사망 — 실사고). `tests/webview-syntax.test.js`가 산출물 기준으로 검출.
- 지뢰: DeepSeek `deepseek-v4-flash`는 **추론 모델** — 출력 상한이 작으면 생각(reasoning)에 다 쓰고 본문이 빈 채 온다.
  `bridge/deepseek-bridge.js`가 이미 대응(ping은 본문 안 물음·map은 상한 8000+오류 구분).
- DeepSeek 키: `~/.codex-bridge/deepseek.json`(레포 밖) 또는 env `DEEPSEEK_API_KEY`. 대시보드 ⚙️고급설정 탭에서 입력 가능.
- 디버깅 무기: **jsdom 재현기** — 실제 `html()` 산출물을 jsdom(runScripts)에서 실행 + 실제 `computeState` 데이터 주입
  (`npm i --no-save jsdom` 후 out/extension.js를 vscode 스텁으로 require·내부 함수 노출). 대시보드 무반응류는 이걸로 잡는다.
- 무거운 판독은 `cachedRead`(mtime+size 키) — computeState가 5초를 넘겨 확장 호스트를 포화시킨 실사고 있음. 새 판독기 추가 시 준수.

## 3. 3트랙(탐색) 아키텍처 — 현재 완성 상태

원칙: **발견은 기계가, 판단만 LLM이**(탐색자에게 구현 AI의 요약을 주면 맹점을 물려받는 가시성 역설 회피).

```
[꾸러미 빌더(결정론)] → [탐색자(분리 LLM 1회 호출·무세션)] → [영향지도] → 게시판+Claude
 scripts/scope-package.js      self 팔 | DeepSeek 팔              scouts/ 보관함
```

- **꾸러미**: `src/scope-package.ts`(순수 조립·렌더) + `scripts/scope-package.js`(수집 드라이버).
  내용 = 바뀐 파일·diff·바뀐 식별자의 역참조·함께변경 통계·테스트 목록·최근 검증 실패·(있으면) MAP + **못 보는 것 각주**.
  민감 범주 파일(diff의 .env*·secret/credential/token/apikey·pem/key/p8 등)은 `redactSensitiveDiff`가 전송 전 통째 제외+고지.
- **무이력(비-git) 모드**: git 없으면 자동 폴백 — seeds는 시간 창이 아니라 **작업 신호 계단**:
  ①물때표(마지막 지도 생성 이후 수정된 파일 — 우선) ②첫 지도면 Claude 세션이 실제 편집한 파일(대화 기록 도구 호출)
  ③최근 수정 상위 N. diff 대신 발췌, 역참조는 폴더 스캔. 간주 기준은 꾸러미 1절에 항상 표기.
- **두 팔(D5 A/B 설계)**: 같은 꾸러미·같은 지시.
  - self 팔: `node scripts/scope-scout-self.js <repo>` — `claude -p` 분리 호출(도구 전면 차단)·무추가비용.
  - DeepSeek 팔: `node scripts/scope-scout-deepseek.js <repo>` — `bridge/deepseek-bridge.js map` 경유·외부 전송.
- **보관함**: `scripts/scout-store.js` → `~/.codex-bridge/scouts/<wsKey>/`(md+json, 최근 10장).
  **wsKey = sha1(normWs(경로)) 앞 16자 — 계약 파일·확장과 반드시 동일 규칙**(한쪽만 바꾸면 게시판이 빈다).
  메타에 basis(간주 기준)·seedFiles(근거 파일 — 낡음 배지·물때표의 재료) 기록.
- **자동 지시(지시 주입형)**: `bridge/contract-lib.js buildScoutDirective` — 3트랙 프로젝트에서 지도 없음/낡음이면
  턴 시작 훅(contract-inject)이 Claude에게 갱신 지시 주입. **재지시 억제 = 상태 서명(`no-map` | `stale:<최신 지도 파일명>`) 1회**(시간 상수 0).
  동의 모델: **키 등록=DeepSeek 팔 자동 사용 동의**(PRIVACY에 명시). 확장·훅 자체는 어떤 전송도 하지 않음.
- **가시화**: 대시보드 탐색 카드("지금:" 상태 요약·연결 줄·기초 탐색 통계·영향지도 게시판·낡음 배지) + 흐름 지도 둘째 줄
  (Claude→탐색자→게시판) + 히어로 탐색자 카드 + 상태바(망원경 아이콘·생성 도는 동안만 "탐색중" — scout-live 신호).
- **검증 동봉(Phase 3 — 2026-07-07 구현)**: `contract-lib.js extractMapHighlights`(지도 MD에서 ①~④ 구획의 high만 구조화 —
  제외 표기 우선·자유서식 폴백·백트래킹 없는 토큰 파서) + `buildScoutAttach`(3트랙+지도+high 있을 때만 [탐색 지도·참고] 블록,
  낡음 라벨·ko/en·advisory 명시) → `codex-bridge.js withContract`가 모든 ask에 동봉(별도 try — 실패해도 계약 주입 불침).
  러너 두 팔은 저장 시 `meta.highlights`(구조화 계층) 기록. 테스트 `tests/scout-attach.test.js`(31단언).

## 4. 사전 등록 판정 기준 (매몰비용 방지 — 바꾸려면 사용자 합의)

- 통계(함께변경) 단독은 이미 **불합격 판정 완료**: 소급 실측 hit@10 16~51% < 합격선 60% — 원인은 '사상 처음 생기는 결합'
  (원리상 예측 불가 63~74%). 그래서 중심은 LLM 지도+MAP. 통계 카드는 참고용으로만 유지.
- **(완료된 사전등록) D5 A/B 소급 실측**: 완료된 실제 변경들에 두 팔 지도를 소급 생성 → 명중·치명 누락·소음 비교.
  사전 등록 판정 규칙: **차이가 오차 수준이면 self 채택**(무료), DeepSeek 유의미 우위면 DeepSeek.
  → 아래 2026-07-07 실측으로 **종결(self 채택)** — 상세는 아래 두 단락.
- **2026-07-07 실측 결과(러너 `scripts/scope-ab-retro.js` — worktree로 부모 시점 복원+씨앗 1파일 diff만 적용, 커밋 6건·정답쌍 29)**:
  S0 통계 13.8%(커밋당 소음 3.3) / L12 결정론 꾸러미 37.9%(16.2) / **L3 self 지도 48.3%(12.8)**.
  L3는 명중 기준 6커밋 모두 L12와 같거나 우위, 전체 평균 소음은 16.2→12.8로 감소(단 커밋별로는 141b10f에서 23→25 증가).
  L3의 추가 명중은 3건 — e64109e의 package.json·tests/scout-store.test.js, 76a316e의 package.json — 모두 '새 테스트 추가에
  따른 test 체인·관련 테스트 갱신' 같은 관례형 결합(결정론이 원리상 못 잡는 유형: 씨앗이 새 파일인 신규기능 커밋에서
  S0·L12 0/12, L3 2/12). 문서 3종(PRIVACY·README·README.en)은 L3도 놓쳤다 — '문서 갱신까지 잡는다'는 근거 없음.
  표본 6커밋은 작음 — 판 뒤집기용이 아니라 방향 확인용. 씨앗 1파일 재현은 실사용(작업트리 전체가 씨앗)보다 세 레벨 모두에게
  불리한 보수적 조건. L3 텍스트 채점은 '경로 포함 또는 8자 이상 basename 포함' 규칙이라 hit/소음이 일부 부풀 수 있음.
- **2026-07-07 두 팔 비교 완료 → D5 판정: self 채택**. 키 등록 후 `--arm deepseek` 재실행. ⚠ 실행 간 새 커밋(5685a6f)이 최신 6건에
  끼어 세트가 어긋남 → 공정 비교는 **공통 5커밋·27쌍**으로: 결정론(S0 4/27·L12 11/27·소음까지)은 두 실행에서 완전 동일(재현성 확인).
  L3는 self 13/27=48.1%(소음 15.4) vs DeepSeek 10/27=37.0%(소음 9.8) — 불일치쌍 self만 맞힘 3(e64109e package.json·
  7132726 bridge/deepseek-bridge.js·141b10f tests/deepseek-config.test.js) / DeepSeek만 맞힘 0. DeepSeek 우위 없음(명중 열세·
  소음만 우위) → 사전등록 규칙("오차 수준이면 self, DeepSeek 유의미 우위면 DeepSeek")상 어느 해석이든 **self**. 두 팔은 같은
  꾸러미·같은 지시 계열이나 문장이 글자까지 동일하진 않음(도구차단 문구·온도 고정 차이 — deepseek-bridge.js 36~40행).
- 그 뒤: 지도 high 항목 구조화+검증 요청에 지도 동봉 → stable MAP(확정 지식층) 구축 → **강제 게이트는 성능 입증 후에만**.

## 5. 파일 지도 (이 작업에서 자주 만지는 곳)

| 무엇 | 어디 |
|---|---|
| 꾸러미 순수부(조립·렌더·민감 제외·무이력 라벨) | `src/scope-package.ts` |
| 수집 드라이버(git/무이력 계단·역참조·공용 수집) | `scripts/scope-package.js` |
| 두 팔 러너 | `scripts/scope-scout-self.js` · `scope-scout-deepseek.js` |
| 지도 보관함·생성중 신호 | `scripts/scout-store.js` |
| DeepSeek 호출(ping/map) | `bridge/deepseek-bridge.js` |
| 자동 지시·계약·검증 지시 | `bridge/contract-lib.js` · `contract-inject.js` |
| 대시보드·상태바·게시판·판독 캐시 | `src/extension.ts` |
| 통계 채굴기(참고 카드) | `src/scope-ledger.ts` |
| 테스트(전 스위트 체인) | `package.json`의 `test` + `tests/*.test.js` |

## 6. 이어서 할 일 (우선순위)

1. ~~D5 A/B 소급 실측~~ — **완료·판정 확정: self 채택**(§4 두 팔 비교 참조). 러너 `scripts/scope-ab-retro.js`·불변식 `tests/ab-retro.test.js`.
2. ~~Phase 3(지도 high 구조화 + 검증 동봉)~~ — **구현+로컬 런타임 반영 완료 2026-07-07**(§3 '검증 동봉' 참조 · install.js로
   ~/.codex-bridge 반영, 배포 사본 해시 일치·실동작 확인). 대외 배포는 사용자 승인 시. 효과 관찰 시작(검증이 지도 경로를 실제
   지적하는 빈도). 알려진 소음: 파서가 'ko/en' 같은 슬래시 표기를 경로로 오인할 수 있음(advisory라 무해 — 관찰 항목).
3. **(진행 중) stable MAP 2층** — 1차 단위 구현 완료 2026-07-07: `extractMapPatches`(⑥ 제안 파서) → 러너가 meta.mapPatches로
   제안층 저장 → `scripts/scope-reconcile.js`(list/approve/reject — approve만이 확정층 MAP.md 승격 경로, 승인/기각 서명은
   브릿지 홈 map-reconcile/). 확정층(docs/MAP.md)은 꾸러미 collectCommon이 이미 신뢰 입력으로 읽음. 테스트
   `tests/map-reconcile.test.js`(25단언). **대시보드 'MAP 장부' 카드 완료 2026-07-07**: 대기·승인·기각 카운터 칩 +
   대기 제안 목록(출처 표기)과 [승인]/[기각] 버튼(모달 동의, sig 기준이라 번호 밀림 원천 차단) + 승인/기각 이력 +
   확정 장부 열람. 계산·형식은 `src/map-ledger.ts` 공유 모듈이 단일 출처(CLI `scope-reconcile.js`도 out/map-ledger.js
   require — 형식 두 벌 금지). **남은 것**: 실사용 제안 축적 후 첫 승인 사이클 관찰.
   **방향 전환 합의 2026-07-07(사용자+양 모델)**: 건별 수동 승인은 실사용 불가 판정 — memento(assertionStatus 4단계·재통합)+
   tg-chat-engine(삭제 금지·disputed 상태 전이·supersedes·learning_events '이벤트 먼저 정책 나중') 패턴으로 **자동 관측 장부**로 전환.
   3층: ①관측 장부(자동) ②오버라이드(pin/ban) ③docs/MAP.md(명시 내보내기만). 로드맵: ①이벤트 적재→②약한 전이→③꾸러미
   신뢰 차선→④발화 기반 강등(보수적)→⑤카드 역할 전환→⑥플랜 게이트 실험(PreToolUse:ExitPlanMode 가능 여부 실험 선행 —
   미확정. 강제 게이트 기본 off: 사전등록 60% vs 실측 48.1% 미달, 사용자 명시 선택만).
   **①②③ 구현 2026-07-07**: `src/ledger-events.ts`(이벤트 파싱·약한 전이 derive — banned>superseded>tombstone>disputed>
   verified>inferred, pinned은 차선 오버라이드·꾸러미 선별 selectForPackage 씨앗 교집합 우선)+`contract-lib.js`
   appendLedgerEvent(map-ledger-events/<wsKey>.jsonl·상한 2000 정직 고지)+러너 proposed 적재+`scope-package.js`
   ledgerForPackage(동봉分 attached 적재 — 자기강화 차단 재료)+렌더 §7.5(확인됨/미검증/틀림판명 3차선).
   ⚠ confirmed/refuted/user_dispute 이벤트는 스키마만 — 배선(검증 답변·발화 감지)은 ④단계.
4. (관찰 항목) 한 폴더 다중 프로그램 구분 — 권장 관행은 프로그램별 폴더 분리, 보강 후보는 seed 클러스터 자동 좁힘.

## 6.5 아직 구현 안 된 설계 요지 (레포 밖 설계 원본의 알맹이 — 이 요지만으로 이어갈 수 있게)

- **확정된 결정 레지스트리(변경하려면 사용자 합의)**: D1 MAP은 핵심 파일채널부터(예: proofs/·integrity·phase 같은
  '한쪽이 쓰고 다른 쪽이 읽는' 결합) / D2 탐색자는 프롬프트형(꾸러미 떠먹임 — 도구 탐색형은 후순위) / D3 advisory 유지
  (강제 게이트는 성능 입증 후) / D4 키는 env·파일 수기(UI는 이미 추가됨) / D5 self-preflight A/B(오차 수준이면 self 채택) /
  D6 순서=빌더→self 팔→DeepSeek 연결(완료) → A/B → Phase 3.
- **L1 '사용 장부'(미구현·다음다음 후보)**: 하네스가 이미 관찰하는 것들(이 턴에 변경된 파일·읽힌 파일·검증에 인용된 파일)을
  세션 단위로 자동 누적하는 장부. 목적: ①비-git 폴더의 '함께 변경' 통계 대체 ②한 폴더 다중 프로그램의 자연 클러스터링.
  필수 위생 4종(고아 데이터 방지): 묘비(삭제 파일 표시)·감쇠(오래된 항목 약화)·상한(항목 수 cap)·죽은 키 린트. ws 격리+TTL.
- **stable MAP 2층(미구현)**: 확정층(stable — 사람이/검증이 승인한 의미 결합)과 제안층(탐색자 지도의 'MAP patch 후보')을
  분리하고, 승인 절차(reconcile)를 거쳐야 확정층에 들어간다. 탐색자·꾸러미는 확정층만 신뢰 입력으로 쓴다.
- **scoutMode 원안 확장(현재 off|on)**: 원안은 off|manual|gate|always — gate(쓰기 도구·플랜 확정 시 자동)·always는
  A/B 성능 입증 후에만 검토. 현재 자동 지시(지시 주입형)는 manual과 gate 사이의 중간형으로 이미 동작.
- **한 폴더 다중 프로그램(관찰 항목)**: 권장 관행=프로그램별 폴더 분리(도구 전체가 폴더 키 체계). 보강 후보=seed가 특정
  하위 폴더에 몰리면 탐색 범위 자동 축소+고지, 수동 하위 경로 인자. 장기 정답=L1 클러스터.

## 7. 검증 절차 요약 (다른 환경에서 처음 여는 사람용)

1. `node install.js` → 창 리로드 → 상태바 Codex 항목 확인.
2. 대시보드에서 Codex 세션 연결(없으면 ask가 자동 생성·연결) · 검증 모드 선택 · 트랙(2/3) 선택 — 전부 프로젝트별 저장.
3. 매 턴 훅이 검증 지시를 주입하고, Stop 훅이 "검증 없이 종료"를 막는다. 판정은 통과/통과(보완)/보류/실패 4단.
4. 3트랙이면: 지도 없음/낡음 시 자동 지시가 오고, `scope-scout-self.js`를 돌리면 게시판·상태바가 반응한다.
