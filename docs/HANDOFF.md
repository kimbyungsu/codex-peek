# HANDOFF — 다른 로컬 환경에서 이어서 개발하기 (자립형 인수인계)

> 이 문서 하나로 이어갈 수 있게 쓰였다. 상세 설계 원본(SCOUT-TRACK.md·SCOPE-LEDGER.md)은 **의도적으로 레포 밖 로컬 문서**라
> 다른 환경에는 없다 — 그래서 이 파일이 그 요지를 포함한다. ⚠ **실 API 키·토큰은 어떤 파일·픽스처·예시에도 절대 넣지 말 것.**
> 마지막 갱신: 2026-07-08 (버전 0.1.86 불변 · 이 갱신을 포함해 push된 main 기준). 이번 push 묶음(14커밋):
> ①전달 원칙 v3(검증 '응답' 축약 요청 금지 — 판정 표지누락 유도 방지, 사용자 문안) ②두뇌 '실제 답' 상시 표시
> (히어로+상태바 — 결정 실험: 앱 모델 피커 체크마크는 답을 지배하지 않는 표시 결함으로 확정, 커밋 9c65848 본문 참조)
> ③**관측 장부 점화**(이벤트 0건 공백 해소 — 파서 위생·legacy 지도 상태·버킷 재알림·씨앗 백필 CLI, §6-3 4-1)
> ④플랜 게이트 실험 성공 판정(§6-3 ⑥ — PreToolUse가 ExitPlanMode를 잡음 확정) ⑤꾸러미 렌더 민감 파일명 전면
> 가리기+pytest 테스트 발견(대형 Python 레포 실측 결함 2건 — tg급 서비스 1차 실증) ⑥정찰 UI 3연타(용어를 '정찰
> 흐름' 4단계로 통일·LLM 필수성 정직 고지·사람 언어 전면 순화·색 카드 시안성·구조 안내 새탭·유형별 기대 실효성).
> ⚠ 새 환경에서 첫 일: `node install.js` → 창 리로드(훅 4개·브릿지 7파일·확장 최신화 — 마켓 vsix는 개발중이라 미배포).
> ⚠ **3트랙 계약·장부·지도는 PC별**(~/.codex-bridge) — 새 환경에서 3트랙을 쓰려면 대시보드에서 켜거나 계약 파일 생성,
> 기존 지도가 있으면 `node scripts/scope-ledger-backfill.js`(멱등·--dry 지원)로 장부 씨앗을 소급 점화할 수 있다.

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
  동의 모델: **키 등록=DeepSeek 팔 자동 사용 동의**(PRIVACY에 명시). 확장이 직접 하는 외부 요청은 3트랙 켤 때 연결 점검 1회뿐 — 지도 꾸러미 전송은 확장·훅이 직접 수행하지 않음(2026-07-09 정정: 연결 점검 도입으로 '어떤 전송도 없음'은 더 이상 사실 아님).
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
   **④ 구현 2026-07-07**: (a) `codex-bridge.js flagLedgerConfirms` — 통과류 판정 + 장부 항목의 서로 다른 경로 2개 이상이
   '실존 확인된 인용'(citedResolvedBasenames)에 등장 + 다룬 흔적 미확인(unseen) 목록에 없음 + basename 8자 이상일 때만
   confirmed 적재(텍스트 메아리 무효 — 자기강화 차단). 제외는 '현재 차단 중'(ban 순계산)·대체·소멸만 — 반박 이력
   항목에도 확인은 기록되고(복권 재료), 승격은 derive의 복권 규칙(반박 이후 사람 1회/검증 2회 — §6-5)이 판정
   (2026-07-09 개정). refuted 자동 추출은 안 함(기계 판정
   불안정 — 정직 한계). (b) `scripts/scope-ledger-note.js` — 사용자 발화 기록 CLI(dispute/confirm/pin/ban/unpin/unban,
   유일 매칭만·모호하면 중단). **Claude 사용 관행**: 사용자가 장부 지식을 확정 어조로 정정/확인하는 발화를 하면 이 CLI로
   기록하라(--why에 발화 요지). 흔들림("맞나? 헷갈리네")·농담·가정법은 기록 금지(tg wavering-hold). 테스트
   `tests/ledger-signals.test.js`(18단언 — 패리티·보수 규칙·CLI).
   **⑤ 구현 2026-07-07(카드 역할 전환)**: 대시보드 MAP 장부 카드를 승인 큐→관측 패널로 — 관측 장부(이벤트→유도)가 1차
   재료(extension이 out/ledger-events.js 직접 import), 신분 칩(신뢰/미검증/틀림판명/제외)+항목별 신분 배지·사건 요약
   (제안·동봉·확인·반박 횟수)+최근 사건 타임라인+확정 장부 열람. 개입은 선택: 고정/해제/차단해제=즉시(가역),
   차단·내보내기=모달 동의(내보내기는 신뢰 차선만·중복 방지·exported 이벤트 기록). 이벤트 적재는 배포 런타임
   bridgeLib().appendLedgerEvent 재사용(낡은 런타임이면 정직 에러 — install.js 안내). 승인/기각 핸들러 제거.
   `scope-reconcile.js` CLI는 번호 기반 대안 경로로 존치(테스트 유지).
   **⑥ 구현 2026-07-07(플랜 게이트 — 실험 장치)**: 공식 문서 확인 결과 차단(exit 2=stderr 피드백)·페이로드는 명시,
   **ExitPlanMode가 PreToolUse에 잡히는지는 미명시**(전용 훅 요청 이슈 존재) → 관측 실험으로 판정.
   (a) `bridge/scout-gate.js` — PreToolUse:ExitPlanMode 훅: 항상 관측 로그(도구명·입력 키 이름만 — 플랜 본문 저장 안 함,
   scout-gate-log/), 게이트는 계약 scoutGate="plan"일 때만(기본 off — 사전등록 60% vs 실측 48.1% 미달), 지도 없음/낡음이면
   차단+생성 지시, **세션당 2회 상한 후 통과**(무한 잠금 방지), 모든 오류 fail-open. (b) `scripts/scope-gate.js` on|off|status
   (ko·en 계약 슬롯 동시 갱신). (c) 훅 4개 체계: 같은 이벤트 다중 훅에서 병합이 앞 훅을 지우던 함정 발견 →
   mergeHooks/installHooks를 **이벤트 단위 정리**로 재구조화(install.js·hook-setup.ts 동일 수정·회귀 테스트 잠금),
   isOurHookCmd·BRIDGE_SCRIPTS(7개)·훅 문구(4개) 갱신. (d) 확장 saveContract가 미지 필드(scoutGate)를 보존 병합하도록
   수정(대시보드 저장이 게이트 설정을 지우던 문제). 테스트 `tests/scout-gate.test.js`(22단언).
   **실험 절차(다음 사람/세션)**: ① `node install.js`(훅 4개 등록) 후 **새 Claude Code 세션** ② 플랜 모드 진입→플랜 확정 시도
   ③ 브릿지 홈 `scout-gate-log/<wsKey>.jsonl`에 tool:"ExitPlanMode" 줄이 찍혔는지 확인 — **찍힘=가로채기 가능 확정**(게이트
   `scope-gate.js on`으로 실험 계속), 안 찍힘=PreToolUse가 ExitPlanMode를 안 잡는 것(전용 훅 이슈 추적·Stop 게이트 대안 검토).
   **판정(2026-07-08, 자연 데이터): 찍힘 — 가로채기 가능 확정.** 실세션의 플랜 확정 2건(2026-07-07T19:44:44Z ·
   2026-07-07T21:10:30Z)이 `scout-gate-log/fff249c3aaa6cbb3.jsonl`에 기록됨(사용자가 거부한 ExitPlanMode도 훅이
   먼저 돌아 기록 — PreToolUse 확정). 다음은 원하는 프로젝트에서 `scope-gate.js on` 게이트 실험.
4. **(완료 2026-07-08) 플랜 게이트 실세션 실험** — 위 ⑥ 판정 참조(찍힘 확정). 남은 것: `scope-gate.js on` 상태의
   차단·문구 실사용 관찰(레거시 지도면 '판정 불가·재생성 필요' 문구가 나가는지 — 아래 4-1의 legacy 상태 참조).
4-1. **(완료 2026-07-08) 장부 점화 — '이벤트 0건' 구조 공백 진단·해소**. 진단(실측): 씨앗(proposed)의 유일한 자동
   입구가 '지도 러너 실행'인데 러너가 안 돌고, 자동 지시는 같은 낡음 상태에 1회 후 영구 침묵, 실개발 레포(codex-peek)는
   3트랙 계약조차 없어 대상 밖, confirmed 자동 적재는 장부가 비면 즉시 return(공회전) → 이벤트 0건. 조치 4종:
   (a) **파서 위생**(contract-lib extractMapPatches 내부 — 러너·백필 공용 단일 기준): 경로 토큰 ≥1+최소 길이,
   'yaml'·설명 부스러기 탈락 (b) **legacy-no-seeds 상태 신설**(scoutMapStatus): seedFiles 기록 없는 구버전 지도를
   fresh로 오판하던 것 분리 — 자동 지시·플랜 게이트 모두 '판정 불가·재생성 권고' 정직 문구 (c) **버킷 재알림**
   (buildScoutDirective): 같은 지도라도 낡음 정도가 2의 거듭제곱(1,2,4,8…) 상승 시 재지시(하강·동일은 침묵,
   시간 상수 0, 구형 {sig} 기억은 maxBucket=1로 해석) (d) **씨앗 백필 CLI**(scripts/scope-ledger-backfill.js,
   수동 1회·멱등·--dry): 기존 지도의 ⑥ 후보 소급 적재 — 라이브 29건 점화(codex-peek 13·에이전트활용 16,
   deriveLedger 유도 정상). +codex-peek에 3트랙 계약 생성(ko·en 양 슬롯 — en 전환 시 유실 방지).
   ⚠입구 전수(정정): proposed=러너·백필 / attached=꾸러미 빌더 / confirmed=검증 통과 자동(장부 비면 불가) /
   pinned·banned·unpinned·unbanned·exported=**대시보드 개입 경로도 있음**(extension.ts ledgerAct) / user_dispute=발화 CLI.
   ⚠남은 배치 한계였던 세션 cwd≠개발 레포 문제는 → **4-3에서 결정·구현(scoutRepo)로 종결**(2026-07-08).
4-2. **(방향 확정 2026-07-08) Reconciler(정리자 — 통합·분할·확대·축소·폐기)는 점화·축적 '뒤'.** 외부 대화
   제안(하네스 후보화→LLM 정리 제안→검증→이벤트 적재)은 타당하나 '다음 실험 전에 먼저'는 기각 — 전제(축적 잡음)가
   실측(0건)과 어긋났음. R0(조작 표현)는 새 이벤트 타입 신설 없이 기존 조합(선택 A: 새 문장 proposed + 옛 문장
   superseded / retire=tombstone / ban=banned)으로 표현 가능 — split만 향후 newSigs[] 검토. R1+(후보 생성기·
   LLM 제안·scope-curate CLI)는 장부에 실데이터가 쌓인 뒤 착수.
4-3. **(결정·구현 2026-07-08 — P1)** 세션 cwd≠개발 레포 문제 종결: 계약에 **scoutRepo(정찰 대상) 명시 필드**.
   결정 근거(사용자 승인+검증 합의): 관행 의존은 재발 위험, 전면 ws 재해석은 앵커 재설계 — 절충으로 **정찰 계열만**
   (지도·꾸러미 대상·변경감지 통계·관찰 일지·confirmed·플랜 게이트·자동지시 경로) 대상을 따르고 검증·연결·계약 앵커는 불변.
   구현: contract-lib `resolveScoutRepo`(절대경로·존재 검증·무효 시 ws 폴백 ws-fallback-invalid) + buildScoutDirective/
   buildScoutAttach/scoutMapStatus 호출부·codex-bridge flagLedgerConfirms(장부 기록 대상만 — 인용 해석은 execCwd 유지)·
   scout-gate(신선도·지시 명령=대상, 관측 로그에 ws·target 병기)·extension 정찰 판독기 전부(scoutTargetFor — 3카피 패리티
   테스트 잠금)+카드에 대상 고지. CLI: `scripts/scope-target.js`(status/set/auto[직하위 1단계 유일 git 루트만 자동·복수는
   나열]/clear — ~~ko·en 슬롯 동시~~ **2026-07-09 개정: 현재 언어 슬롯만 저장**(§6-9)) · `scripts/scope-ledger-migrate.js`(서랍 이관 — dry 선행·복사 보존·ts+type+sig 중복
   스킵=멱등). 테스트 `tests/scout-target.test.js`(28단언 — 상대경로 무효·빈 .git 오판·기존 지정 잔존 반례 잠금 포함).
4-4. **(후속 문서 정리)** README ko 본문 일부에 '함께-변경 통계·커밋 이력' 등 옛 표현 잔존(동작 오도 아님 —
   Codex 확인). UI는 '정찰 흐름' 사람 언어로 전거 완료(옛 용어 잔재는 테스트 부정 단언으로 잠김) — 문서만 후속.
5. **(관찰) 관측 장부 실데이터 축적** — confirmed/user_dispute가 쌓이면: DERIVE_V1 임계(현재 최약 1회) 데이터 기반
   조정 + 장부 학습 반영 후 지도 명중률 재실측(ab-retro) → 60% 넘으면 게이트 기본 승격 재논의(사전등록 §4).
   **복권·수명 4약점(2026-07-09 사용자 질문으로 확정 → 같은 날 사용자 방향 지시 "지식은 진화해야"로 (a)(b)(d)
   즉시 구현 완료 — 커밋 참조)**:
   (a) ~~confirmed 기록 차단~~ **해소**: dead-set에서 반박(user_dispute/refuted) 제외 — 반박 이력 항목에도 확인이
   '기록'되고, 승격은 유도기 복권 규칙이 판정(차단 ban·대체·소멸은 여전히 기록 제외 — 사람 오버라이드 존중).
   **복권 규칙(DERIVE_V1)**: 마지막 반박 '이후'의 확인만 인정(이전 확인은 이미 반박에게 진 증거 — 이벤트 순서
   기준) — 사람 재확인 1회(사람 반박과 동급) 또는 검증 확인 2회(기계는 한 단계 약함) → verified 복권 +
   rehabilitated 표기(반박 이력은 counts에 그대로 — 삭제 금지 유지). 재반박 시 카운터 리셋(마지막 판정이 이김).
   (b) ~~트림 부활~~ **해소**: 트림이 판정 이벤트(반박·차단·고정·대체·소멸류)를 보존하고 나머지만 최신순 유지.
   (d) ~~각주 전면 금지~~ **해소**: "같은 결론을 다시 내지 마라" → "근거 없는 재주장 금지 — 다시 제안하려면 반박
   이후 무엇이 바뀌었는지(코드 변경·새 근거)를 명시하라"(재발견 봉쇄 해제·재실수 방지 유지).
   (c) **잔존**: tombstone은 스키마·UI 라벨만 있고 쓰는 곳 없음(파일 소멸 자동 감지 미배선) — P3 임계 튜닝 때.
   잠금: ledger-events [2-1] 복권 6단언 · ledger-signals [3] 기록 정책·[4-1] 트림 보존.
6. (후보) 대시보드 게이트 토글 UI(현재 CLI만 — informed consent 문구에 실측 명중률 표기), 발화 기록(scope-ledger-note)
   흐름의 실사용 관찰.
7. (관찰 항목) 한 폴더 다중 프로그램 구분 — 권장 관행은 프로그램별 폴더 분리, 보강 후보는 seed 클러스터 자동 좁힘.
8. ~~가이드 배선도 + 훅·CLI 이중언어화~~ — **완료 2026-07-09**(사용자 지시 2건): ① 정찰 구조 새탭에 960×470 SVG 전체
   배선도(생성·기억·개입 지점 노드 + 점선 피드백 2개, 전 텍스트 tE ko/en — recon-ui 8단언 잠금) ② 훅(buildScoutDirective
   en 변형·scout-gate tB)·CLI 5종(scope-target/gate/ledger-migrate/ledger-note/reconcile) 전 출력 tB(ko,en) —
   `tests/cli-bilingual.test.js`(21단언: en 홈 실행 4종·ko 기본 무회귀·줄 단위 '출력 호출+한글→tB 필수' 잠금). 같은 턴
   Codex 반박 수용: 안내 표면(가이드 FAQ·고급설정·README ko/en)을 PRIVACY '예외 둘(꾸러미+연결 점검 1회)' 체계로 정합화
   (deepseek-bridge.test.js 잔재 금지 단언). **후속 후보**: (a) reconcile 상태 파일 from을 중립 구조 {arm,ts}로 저장하고
   렌더 시 번역(Codex 보완안 — sig 식별 무관·언어 전환 시 이력 표기 혼재는 미관 문제) (b) scope-ledger-backfill.js(타 PC
   작성)가 아직 한글 전용 — tB 이중언어화 필요(cli-bilingual 테스트 대상에도 추가) (c) **정찰 러너·꾸러미
   프롬프트가 한국어 고정**(scope-scout-self.js preface·deepseek-bridge.js map·scope-package.ts 지시/각주) —
   영어 모드에서도 지도·일지 '원문'이 한글로 생성됨(Codex 반례 2026-07-09). UI만 이중언어인 상태 — 데이터
   생성 언어도 loadLang을 따르게 할지는 채점기·파서(한글 구획 표기 의존) 영향 검토와 함께 별도 결정.
9. ~~정찰 설정 언어 슬롯 분리~~ — **완료 2026-07-09(사용자 결정)**: 한글 모드와 영어 모드는 사실상 다른 사용자
   (생활권 분리) — 정찰 부속 설정(scoutGate·scoutRepo)도 규칙·기본지침처럼 **현재 언어 슬롯에만** 저장.
   scope-gate·scope-target의 양슬롯 동기화(writeBothSlots) 폐기, 대신 반대 슬롯 값이 다르면 ⓘ 고지(소실 오해
   방지 — otherSlotHasRules 선례). **API 키(deepseek.json)만 전역 공유가 맞음(사용자 확정)**. 3트랙 선택
   스위치(scoutMode)는 원래부터 대시보드가 슬롯별 저장이라 무변경. 잠금: scout-gate [5]·scout-target [5-1].
   ⚠ 파생 원칙: 앞으로 '설정'은 언어 슬롯별, '전역'은 API 키·언어 자체뿐. 정찰 '데이터'(지도·일지·교범)는
   프로젝트 단위·언어 무차원 유지(기억을 언어로 쪼개면 반쪽 학습 — 변경하려면 사용자 합의).
10. **(다음 · 사용자 예고 2026-07-09) 검증 통계에 '3트랙 기여' 통계** — "2트랙이었으면 못 잡고 지나갔을 것"의
   기록. 반사실은 직접 측정 불가 → 측정 가능한 대리 신호로: (a) 검증 실패/보류 답이 '동봉된 지도 경로'를 실제
   지적에 인용한 사례 수(동봉 없었으면 그 지점을 안 봤을 개연) (b) 장부 신뢰분이 다음 꾸러미에 실려 재인용된
   횟수 (c) 게이트 차단→지도 갱신→플랜 수정 사례. 유도 가능성 정직 구분(Codex 정정 2026-07-09): (b)만 기존
   attached/confirmed 이벤트로 즉시 가능. (a)는 동봉 스냅샷·답변 인용 대조 기록이 현재 없음(동봉은 프롬프트에
   붙을 뿐 이벤트化 안 됨 — contract-lib buildScoutAttach·proofs는 메타만) → 동봉 시점 기록 신설 필요.
   (c)는 차단은 scout-gate-log에 있으나 '이후 플랜 수정' 신호가 없음 → 보강 필요. 추가 LLM 0 원칙은 유지.
   사용자 지시로 ①(슬롯 분리)·②(정정 로직 분석) 이후 착수.
11. **(제안 확정 · 사용자 승인 대기 2026-07-09) 정찰 프롬프트 노출 — 2트랙 '단계별 기본 원칙'과 대칭**.
   사용자 질문("3트랙도 프롬프트가 별도로 있나? 있다면 2트랙처럼 구현돼야 하지 않나")의 사실 확인: 있다,
   세 겹, 전부 하드코딩·비노출 — (1)역할 preface(scope-scout-self.js 26행 / deepseek-bridge.js buildMapRequest,
   두 벌) (2)형식 계약([탐색자 지시] — scope-package.ts, ①~⑥·high·판정 금지) (3)자료 취급 각주(§7.5).
   Codex 합의 설계(통과·보완 반영): 통째 편집 개방은 위험 — (2)(3)은 extractMapHighlights/extractMapPatches/
   일지 적재/ab-retro 채점기가 그대로 읽는 배선이라 편집 파괴가 '조용히' 죽음(advisory라 오류 없음. 2트랙
   verifyBaseline의 판정 문자열엔 표지누락 경보가 있지만 정찰엔 fail-visible 채널 없음). 따라서:
   (P1) 태도층만 편집 슬롯(scoutBaseline — 언어 슬롯별·기본값 복원), 두 팔 preface 공유 모듈 단일 출처화(필수)
   (P2) 형식 계약은 '보이되 잠금'(읽기 전용 노출) — 편집 개방은 형식 파괴 감지 신호와 세트일 때만. ⚠ 감지
   기준은 '추출 0건'이 아니라 구조 신호여야 함(Codex 정정: high 0건·⑥ 후보 0건은 정상 지도에서도 남 —
   0건을 파괴로 보면 거짓 경고): ①~⑥ 구획 헤더 자체의 부재·허용 구획 전무·형식 버전 불일치를 직접 감지,
   추출 0건은 보조 신호로만 (P3) §6-8 후속(c) 이중언어화와 같은 파일이므로 한 묶음 작업
   (P4) 지도 메타에 프롬프트 서명(arm·model·lang·scoutBaseline 해시·형식 계약 버전) — 수정본 지도가 사전등록
   48.1% 실측군에 섞이는 통계 오염 방지 (P5) 노출 위치: 정찰 카드에 기본 노출 + '단계별 기본 원칙' 패널엔
   링크/요약(Codex 보완 — 원인·결과가 정찰 카드에 있어 이해 흐름상 유리).

## 6.5 설계 요지와 남은 후보 (레포 밖 설계 원본의 알맹이 — 구현 여부는 각 항목에 표기)

- **확정된 결정 레지스트리(변경하려면 사용자 합의)**: D1 MAP은 핵심 파일채널부터(예: proofs/·integrity·phase 같은
  '한쪽이 쓰고 다른 쪽이 읽는' 결합) / D2 탐색자는 프롬프트형(꾸러미 떠먹임 — 도구 탐색형은 후순위) / D3 advisory 유지
  (강제 게이트는 성능 입증 후) / D4 키는 env·파일 수기(UI는 이미 추가됨) / D5 self-preflight A/B(오차 수준이면 self 채택) /
  D6 순서=빌더→self 팔→DeepSeek 연결(완료) → A/B → Phase 3.
- **L1 '사용 장부'(미구현·다음다음 후보)**: 하네스가 이미 관찰하는 것들(이 턴에 변경된 파일·읽힌 파일·검증에 인용된 파일)을
  세션 단위로 자동 누적하는 장부. 목적: ①비-git 폴더의 '함께 변경' 통계 대체 ②한 폴더 다중 프로그램의 자연 클러스터링.
  필수 위생 4종(고아 데이터 방지): 묘비(삭제 파일 표시)·감쇠(오래된 항목 약화)·상한(항목 수 cap)·죽은 키 린트. ws 격리+TTL.
- **stable MAP 2층(1차 구현 완료 — §6-3 참조)**: 확정층(docs/MAP.md)과 제안·관측층 분리는 구현됨 — 남은 것은 실사용
  데이터 축적과 임계 튜닝. 원 설계 취지(탐색자·꾸러미는 확정층만 신뢰 입력)는 유지.
- **scoutMode 원안 확장(현재 off|on)**: 원안은 off|manual|gate|always — gate(쓰기 도구·플랜 확정 시 자동)·always는
  A/B 성능 입증 후에만 검토. 현재 자동 지시(지시 주입형)는 manual과 gate 사이의 중간형으로 이미 동작.
- **한 폴더 다중 프로그램(관찰 항목)**: 권장 관행=프로그램별 폴더 분리(도구 전체가 폴더 키 체계). 보강 후보=seed가 특정
  하위 폴더에 몰리면 탐색 범위 자동 축소+고지, 수동 하위 경로 인자. 장기 정답=L1 클러스터.

## 7. 검증 절차 요약 (다른 환경에서 처음 여는 사람용)

1. `node install.js` → 창 리로드 → 상태바 Codex 항목 확인.
2. 대시보드에서 Codex 세션 연결(없으면 ask가 자동 생성·연결) · 검증 모드 선택 · 트랙(2/3) 선택 — 전부 프로젝트별 저장.
3. 매 턴 훅이 검증 지시를 주입하고, Stop 훅이 "검증 없이 종료"를 막는다. 판정은 통과/통과(보완)/보류/실패 4단.
4. 3트랙이면: 지도 없음/낡음 시 자동 지시가 오고, `scope-scout-self.js`를 돌리면 게시판·상태바가 반응한다.
