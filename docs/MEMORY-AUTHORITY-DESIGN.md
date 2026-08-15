# MEMORY-AUTHORITY-DESIGN — 기억 권위 결속 (v3)

> 발단: Real Benchmark F6 선재현 캠페인(scope-stability-benchmark/real-benchmark-f6-codex/REPORT-F6-CODEX.md).
> 제품 기본 codex 검증자에서 '기억 동봉+결함+통과'가 재현됐고(V1-R: 결함 식별 후 [주의] 강등),
> 동봉물 2/2가 '참고 — 판정 기준 아님' 자기표기로 전달됨이 확정 — 원인은 검증자 병리가 아니라
> **강한 제약을 강한 제약으로 전달하는 채널의 부재**. 본 설계는 결함 수정이 아닌 **신규 능력 추가**다.
> v2: 설계 검증 1차 blocker 5건 반영(공급 원천 단일화·병합 초안 명령·영수증 배선·복구 조정·상한 정의).
> v3: 2차 blocker 3·보완 2 반영(병렬 축 결정론 복제·조정 3지점·oos 정확 일치 억제·스키마 필드·16hex id).

## 0. 핵심 설계 판단 — 새 채널을 만들지 않는다

정찰 결과(2026-08-13), 제품에는 이미 '판정 경계' 계층이 존재한다:

- **Verification Envelope** — 레포 안 `verify-envelope.json`, 3축 `supportedEnv/alwaysBlocker/outOfScope`(contract-lib.js:3485-3489), **승인 지문 결속**(contract.envelopeHash — 지문 불일치 시 주입 생략+경고, :3523·:3528), **ask별 세대 동결**(freezeEnvelopeForAsk :3837), **입장 심사 결속**(judgeAdmission :3880). 검증 요청문 head에 **요청 축 게이트와 무관하게 항상** 실린다(codex-bridge.js:121 — head=[baseline, baseQual, envText, inj, scout] 중 envText).
- **후보→사용자 채택 흐름**의 뼈대도 있다: `verify-envelope-candidates/<wsKey>.jsonl`, 상태는 이미 `proposed|adopted|declined|failed` 4종(contract-lib.js:3698). 단 **현행 채택(adopted) 버튼은 장부 기록만 하고 아무것도 실행하지 않으며**(extension.ts:3877·:3891), 승인 전이는 완성된 수칙서 전문 proposalText가 있어야만 진행된다(contract-lib.js:3613·:3665) — 이 공백이 본 설계의 부품 A-4다.
- 반면 **Project MAP 동봉(scout 자리)은 설계상 '참고 — 판정 기준 아님'**(map-reader.js:398/401·contract-lib.js:3085)이고 요청 축 게이트(map-reader.js:311-319)에 삼켜질 수 있는 계층이다. v2 지시문도 "stale·unknown 지도=참고 전용·supported/oosId 주장 근거 금지"(codex-bridge.js:2682-2683)를 명시한다.

따라서 외부 지시문 §2의 "[확인된 프로젝트 제약]" 절 = **Envelope 계층이 이미 그 자리**다. F6에서 그 절이 비어 있었던 이유는 채널 부재가 아니라 **공급 부재**(사고 교훈이 envelope 후보로 흘러들어가는 파이프라인이 없음)와 **충돌 처리 지시 부재**다. 본 설계는 다음 세 부품만 추가한다:

| 부품 | 성격 | 반패턴 회피 |
|---|---|---|
| A. 공급 파이프라인 | 'blocker→수정→통과 마감' 계보 → envelope **후보 제안**(채택·승인은 사용자) | 자동 승격 없음 — 승인 전이만이 권위 부여 |
| B. 충돌 처리 지시 1항 | ab축 직접 위반 시 '주의 강등 금지·무효화 증거 확인 후 blocker' | 문구는 프로필(편집 가능), 어휘·통로는 기존 코드 계약 재사용 |
| C. 판정 영수증 | 동봉 기억별 used/rejected/superseded/irrelevant 기록 — askId 결속 배선 포함 | 기존 attach.jsonl·verdicts.jsonl 확장(새 저장소 0) |

지도(MAP)는 **계속 약한 필터/구조 앵커**로 남긴다(지시문 §1 명시 요구). 지도 계층에 판정 권위를 부여하는 변경은 하지 않는다.

## 1. §1 승격 6조건 → 기존 구조 매핑

blocker 후보 승격은 아래 전부 성립 시에만. 각 조건의 판정 주체와 근거 구조:

| 조건 | 판정 주체 | 구조 매핑 |
|---|---|---|
| ③신뢰 상태 강함 | **구조(코드)** | **ab축 등재 + 승인 지문 일치**가 유일한 '강함'. 검증 확인 결합(claimed·cited)·effectiveConfidence=confirmed·finding 처분 이력은 **후보 공급의 필터·반증 자료일 뿐 권위 원천이 아님**(F6 검토 확정) |
| ⑤지원 세계 안 | 구조 | supportedEnv 축 — 기존 입장 심사(judgeAdmission) 그대로 |
| ⑥outOfScope 강등 아님 | 구조 | oos축 — 기존 강등 규칙 그대로(oosId 결속) |
| ①현재 작업 직접 관련 | 검증자 | 지시 B + 영수증 relevance 기록(C) |
| ②현재 변경과 명시 충돌 | 검증자 | 지시 B — '직접 위반'만. 간접 연관은 [주의]/[보완] 유지 |
| ④현재 코드 증거가 반박하지 않음 | 검증자 | 지시 B — 무효화 증거 존재 시 blocker 금지+영수증 superseded 기록 |

즉 조건 ③⑤⑥은 **이미 코드에 있고**, ①②④가 이번에 추가하는 지시+영수증의 몫이다.

## 2. 부품 A — 공급 파이프라인 (해소된 blocker 계보 → envelope 후보)

### A-1. 후보 원천 — v1은 단일 원천으로 한정
**'blocker finding이 수정 라운드를 거쳐 통과로 마감된 계보'만** 후보 원천이다.

- 근거 실물: verify-findings 장부의 finding(tag="blocker") + 그 계보의 close(closeReason="resolved") 레코드(codex-bridge.js:2961·:2969).
- v1에서 **제외하는 원천**(1차 검증 blocker 반영): user_confirm/user_dispute(사용자 정정 이벤트일 뿐 제약 문안이 아님)·rehabilitated(유도 상태 — 결정론적 ab 문안 변환 규칙이 없음). 이들은 후속 확장 후보로만 남긴다.
- '[주의] 위험 인접' 필터는 폐기한다 — finding 스키마에 그런 구조 필드가 없고(1차 검증 확인: F6-V1-B의 원 finding은 tag="blocker"), **blocker로 등재됐다 해소된 것 자체가 위험 실증**이므로 태그 필터는 tag="blocker" 하나로 충분하다.

### A-2. 문안 생성 — 자동 작문 금지
후보 문안 = **검증자 지적의 title 원문(titleNorm이 아닌 표시용 title)을 그대로 인용**하고 근거(finding id·campaignId·마감 askId)를 메타데이터로 결속한다. 하네스가 문안을 재작성하지 않는다 — 200자 초과분은 절단 표시와 함께 자르고, 다듬기는 사용자가 채택·승인 단계에서 한다.

**스키마 보강(2차 검증 반영)**: 현행 finding 레코드에는 무표식 200자 절단된 titleNorm만 있고(contract-lib.js:519·codex-bridge.js:2965), close 레코드에는 askId가 없다(:2970). 따라서 ①finding 레코드에 `title`(표시용 원문 — 절단 시 절단 표식 포함) ②close 레코드에 `askId` 필드를 추가한다. machineFindingsLayer에는 askId가 이미 전달되므로 국소 변경이며, 두 필드는 §5의 스키마 회귀 시험으로 고정한다.

### A-3. 생성 방식 — 결정론 id 기반 재스캔 조정(중단 복구 내장)
append 이벤트 훅이 아니라 **파생 뷰 조정(reconciliation)**으로 만든다:

- `candidateId = sha1(wsKey + "|" + campaignId + "|" + rootFindingId).slice(0,16)` — 계보 뿌리 결속·결정론. **기존 16자리 순수 hex 계약 준수**(2차 검증 반영: CLI·대시보드·시험이 16hex를 고정 — codex-bridge.js:2355·extension.ts:3877·gov7-candidates.test.js:340. 접두사를 붙이지 않아 판독기·DTO 무개정).
- **조정 실행 지점 3곳**(2차 검증 반영 — 판정 말미만으로는 마지막 판정 후 종료 시 복구 불가): ①판정 처리 말미(machineFindingsLayer 이후) ②후보 조회(CLI list·대시보드 후보 화면 로드) ③draft 실행 전. 세 지점 모두 동일 잠금(기존 계약 잠금 유틸) 아래 같은 멱등 스캔 — resolved 계보 중 **후보 장부에 없는 candidateId만 append**. finding 마감과 후보 기록 사이에서 죽어도 다음 판정 없이 후보 화면만 열면 복구된다.
- 억제 조건(스캔 시 제외 — 전부 결정론): 이미 존재하는 candidateId / 동일 정규화 문안(titleNorm 동형 정규화 기준 **정확 일치**)이 현행 envelope ab축 또는 oos축에 이미 등재 / pending 상한 초과(A-5). **'같은 주제' 유사도 판정은 하지 않는다**(2차 검증 반영 — 의미 유사도는 자동 추론 금지와 충돌): oos 관련성의 정확 일치 밖 판단은 억제가 아니라 draft 화면의 oos축 병렬 표시(A-4)로 사용자 몫.
- **구행(legacy) fail-closed**(3차 검증 반영): 장부는 스키마 버전 없는 append-only(contract-lib.js:3564·:3570)라 A-2 보강 이전의 finding 행에는 title 원문이, close 행에는 askId가 없다. 조정 스캔은 이 행을 `legacy-unbound`로 **후보 생성에서 제외**하고 제외 사실을 스캔 로그 1줄로 기록한다 — 불완전 근거(무표식 절단 titleNorm·마감 askId 부재)로 후보를 만들지 않는다.

### A-4. 채택→승인 병합 초안 명령 (신규 — 1차 검증 blocker 해소)
현행 adopted 기록은 실행이 없으므로, **병합 초안 명령**을 신설한다:

- CLI `envelope-candidate draft <candidateId>` (대시보드 버튼은 이 명령의 표면): 현행 envelope 전문(3축·ko/en·메타 보존)+후보 1건을 ab축에 병합한 **proposalText 초안**을 생성해 기존 제안 저장(`verify-envelope-proposed/<wsKey>.json` — readEnvelopeProposal :3613)에 넣는다. 이후 승인은 **기존 전이 경로 그대로**(applyEnvelopeTransition :3660 — 잠금·WAL·지문 갱신).
- **병렬 축 처리(2차 검증 반영 — 결정론 복제)**: 정본 검사(writeEnvelopeProposal :3625)는 `alwaysBlockerEn`·`alwaysBlockerEx`가 존재하면 기본 축과 길이 일치를 요구한다(:3597·:3603). draft는 병렬 축이 존재할 때 **후보 원문을 그대로 복제**해 같은 위치에 추가한다(번역·예시 작문 금지 — 임의성 없는 명시 규칙). 번역·예시 다듬기는 승인 전 사용자 편집이 정식 경로다(승인은 어차피 사용자 행위). draft 화면에는 oos축 전체를 병렬 표시해 정확 일치 밖의 범위 충돌 판단을 사용자가 하게 한다(A-3의 억제 규칙과 짝).
- **복제 경고의 저장·표시 계약(3차 검증 반영)**: '병렬 축 복제됨 · 사용자 편집 필요' 경고는 **기존 proposal `note` 필드**에 기록한다(신규 필드 없음 — note는 이미 후보 카드에 표시됨 extension.ts:1026). 승인 모달은 현재 proposalText만 보여주므로(extension.ts:3930), 병렬 축 복제 초안의 승인 모달에 note 경고가 함께 노출되는 것을 §5 회귀 시험으로 고정한다.
- 결속·안전: 초안에 생성 시점 envelope sha1(baseHash)을 기록 — 승인 시점에 불일치면 전이 거부·재생성 요구(기존 mismatch 규약과 동형). ab축 12항 상한 초과 병합은 거부(어떤 항목을 뺄지는 사용자 몫 — 자동 삭제 금지). 동일 정규화 문안 중복은 병합 억제.
- 채택 상태 전이: draft 성공 시 후보 status=adopted(기존 enum — 신설 없음), 병합 실패 시 failed+사유.

### A-5. 상한·만료·공정성 (1차 검증 blocker 해소)
- **pending 상한 = 12**(ab축 상한 :3488과 동일 값·별도 상수) — 초과 시 신규 제안을 억제하고 억제 사실을 스캔 로그 1줄로 기록(침묵 누락 금지).
- **만료 없음·감사 보존**: 후보 장부는 append-only 유지, declined/failed도 잔존. '자연 만료' 개념은 폐기(v1 문서의 오류 — 실물엔 TTL이 없다).
- **baseHash stale**: 승인 세대(envelopeHash)가 바뀌면 기존 pending 후보에 stale 표시(승인 전이 후 조정 스캔이 재평가 — 이미 등재된 문안이면 자동 declined 처리+사유).
- **표시 공정성**: 대시보드 후보 목록의 8건 절단(extension.ts:1063)은 표시 제한일 뿐이므로, 후보 화면은 '더 보기'로 전량 접근 가능해야 한다(개별 모달 금지 — UX 교훈 준수).

### A-6. 적용 범위 — Envelope 활성 프로젝트 한정 (부트스트랩 경계)
resolved 마감(close 레코드)은 **Envelope 활성 심사 분기에만** 존재한다(codex-bridge.js:2969 — 비활성 v2 경로는 open finding만 기록 :2980). 따라서 이 파이프라인은 **수칙서(envelope)가 이미 승인된 프로젝트의 증분 공급**이다. 정합적이기도 하다: 승인 지문 없는 프로젝트에는 ab축 자체가 안 실리므로 공급해도 전달 경로가 없다. 첫 수칙서 부트스트랩은 기존 후보 고지 흐름(envelopeCandidateNoticeFor codex-bridge.js:2761)의 소관으로 남긴다 — 본 설계는 건드리지 않는다.

### A-7. 명시 비목표
- 지도·정찰 산출물의 자동 승격 없음(태생 candidate 강제 map-enrich.js:189 유지).
- 캡처 채널 3중 복제 없음(지시문 §4) — ledger 1/4 최약 진단은 별도 과제.
- 구현자 직접 주입 없음(지시문 §5) — Minimal Constraint Packet은 이 설계 검수 후에도 첫 구현 오류율이 높을 때만 후속 실험.

## 3. 부품 B — 충돌 처리 지시

### B-1. 위치
- **판정 '기준' 문구**이므로 프로필 문안 계층: `BASE_CORE.verifyBaseline`(contract-lib.js:3336)의 blocker 실질 영향 목록에 1항 추가(ko/en 쌍 — BASE_CORE_EN :3354 동반). integrity 프로필(BASE_DEFAULTS :3306)에도 대응 1항.
- 문구(초안): "⑥승인된 항상-차단 제약(ab축)과 현재 구현의 직접 충돌 — 단 현재 코드 증거가 그 제약을 무효화함을 확인했다면 blocker로 올리지 말고 그 증거를 인용해 '제약 재검토 필요'로 표기하라. 직접 충돌이 아닌 간접 연관은 기존 세 갈래([주의]/[보완]/[백로그])를 유지하라." + 처리 표기 1줄(C-2의 행 단독 표기 지시).
- **어휘·서식은 무변경**: blocker/주의/보완/백로그 enum(VERIFIER_FORMAT :3413)과 v2 필드 규칙(v2DirectiveFor :2676-2694)은 그대로. ab 결속은 기존 abId 필드·범위확장 통로(:2679-2680) 재사용.

### B-2. 무엇이 아닌가
- 문턱 전면 강화가 아니다 — F6 실측에서 codex 검증자는 4중 3을 이미 차단했다. 이 지시는 **ab축 항목이 실려 있고 직접 위반일 때의 경계선 판정 1종**만 수렴시킨다(V1-R의 '요청이 기존 정책 준수 명시' 논리를 "코드 증거로 무효화되는가"라는 잣대로 치환).
- LLM 지시문만으로 끝내지 않는다(지시문 §2 요구) — ab 항목은 이미 구조 필드(id·축·지문·세대)로 전달되며, 영수증(C)이 처리 결과를 구조로 남긴다.

## 4. 부품 C — 판정 영수증 (askId 결속 배선 포함)

1차 검증이 확정한 결속 공백 4가지를 전부 배선한다: ①attach.jsonl에 askId 없음 ②carrier에 envelope 실물 없음(envelopeSliceFor 반환은 텍스트뿐 :138·:173) ③askId(UUID)가 withContract에 미전달(:3244에서 생성되나 함수 밖) ④verdicts 행에 askId 없음+flagVerdict에 carrier 미전달.

### C-1. askId 전달과 동봉 실물 고정
- `cmdAsk`가 생성하는 실행 UUID를 `withContract(…, askId)`로 전달(codex-bridge.js:3244→:70).
- `envelopeSliceFor`가 **잠금 안에서 실제 주입한 실물 스냅샷**(축별 항목 id 목록+envelopeHash)을 반환에 추가하고, withContract가 이를 carrier에 고정한다(판정 후 재판독 금지 — 세대 동결과 같은 이유: 판정 사이 파일이 바뀔 수 있다).
- attach.jsonl 행(codex-bridge.js:130)에 `askId`+`envelope:{hash, sup:[id], ab:[id], oos:[id]}` 추가. 기존 소비자(usedMemory 카드 extension.ts:2488)는 추가 필드에 전방 호환 — 카드 로직 무변경.

### C-2. 처리 표기와 판정 행 확장
- 검증자 표기(행 단독·B-1 지시에 동반): `제약적용 <abId>` / `제약기각 <abId>` / `제약대체 <abId>` — 기존 `결합확인 #id` 규약(codex-bridge.js:1197)과 동형. 파서는 독립 함수로 신설하되 **carrier에 고정된 동봉 abId만 인정**(byId 결속 동일), 적용/기각/대체 동시 표기=상충 거부. 무표기 ab 항목=irrelevant 집계.
- `flagVerdict` 시그니처에 carrier 전달(codex-bridge.js:3162 호출부), `appendVerdict` 행(:1400)에 `askId`+`memAttached`(동봉 요약: map 수·couplings 수·envelope 축별 수)+`memHandling`(파싱 결과 배열) 필드 추가 — **"검증 1회=통계 1행" 계약(:1396·:1401) 준수, 별도 append 금지**.
- 목적: 벤치의 핵심 교훈 — **'기억을 못 찾음'(attach에 없음)과 '찾았지만 검증자가 버림'(attach에 있고 memHandling=rejected/irrelevant)의 구분**이 askId 조인으로 기계 판독 가능해진다.

### C-3. 영수증 표면
- machineFindingsLayer의 [입장 심사] 영수증(out 배열, codex-bridge.js:2837·:2891)에 memHandling 요약 1줄 합류(사용자 가시화). flagLedgerConfirms(:3160)가 먼저 호출되는 순서는 유지 — memHandling 파서는 별도이므로 반환값 개조 불필요.

## 5. §7 회귀 반례 9종 → 시험 매핑 (구현 시 필수 시험)

| # | 반례 | 시험(전부 기존 시험 체계에 추가) |
|---|---|---|
| 1 | stale MAP이 코드보다 우선 | 지도 계층 라벨·게이트 무변경 스냅샷 시험(참고 문구 존재+v2 지시문 stale 금지 문구 존재) |
| 2 | Scout 추정이 권위 획득 | add_node confidence="candidate" 강제(map-enrich.js:189) 회귀 핀 + 후보 스캔 원천이 verify-findings 계보뿐임 단언 |
| 3 | 새 정책이 옛 정책을 이김 | envelope 편집→지문 갱신→구세대 freeze 불일치 시 주입 생략 경로 시험(기존 mismatch 경로 재사용)+draft baseHash 불일치=전이 거부 |
| 4 | outOfScope 부활 | judgeAdmission oos 강등 회귀 핀 + **정규화 문안 정확 일치** 시 후보 스캔 억제 단언(유사도 판정 없음 — 정확 일치 밖은 draft 화면 병렬 표시로 사용자 판단) |
| 5 | 무관 기억으로 검증 비대 | ab축 12항·항목 200자 상한 핀 + 요청 축 게이트 무변경(지도 생략 경로 스냅샷) |
| 6 | 간접 연관이 blocker화 | B-1 문구의 '직접 충돌' 한정 — 간접 서술 픽스처에서 [주의] 유지 시험(프롬프트 계약 시험) |
| 7 | 코드 증거로 superseded 가능 | `제약대체` 표기 파싱→memHandling=superseded 기록+blocker 미발행 경로 시험 |
| 8 | 동일 기억 무한 왕복 | 기존 finding 계보(재등장=id 인용만·dispositionValid 라운드 결속) 회귀 핀 + candidateId 결정론으로 동일 계보 중복 제안 0 단언 |
| 9 | 사용자 승인 남발 | pending 상한 12·초과 억제 기록·후보 화면 전량 접근(개별 모달 금지)·중단 후 재실행이 중복 후보를 만들지 않음(reconciliation idempotency) 단언 |

기존 계약 개정 시험(1차 검증 지적 반영): 기존 후보 시험이 고정한 "해소 계보 제외"·"채택 버튼은 기록만" 계약은 본 설계가 **의식적으로 개정**하는 지점이므로, 해당 시험을 새 계약(해소 계보=후보 원천·draft 명령 실행)으로 갱신하고 개정 사유를 시험 주석에 남긴다.

추가 스키마·계약 시험(2·3차 검증 반영): ①finding 레코드 `title` 원문·close 레코드 `askId` 필드 존재+절단 표식 회귀 ②candidateId 16hex 형식이 기존 판독기(CLI :2355·대시보드 DTO)와 호환 ③병렬 축(En/Ex) 존재 픽스처에서 draft가 길이 일치 초안을 생성하고 정본 검사를 통과 ④조정 3지점(판정 말미·후보 조회·draft 전) 각각에서 중단 복구 멱등성 ⑤구행(legacy-unbound — title 원문/askId 부재) 제외+로그 1줄 기록 ⑥병렬 축 복제 경고가 proposal note에 저장되고 승인 모달에 노출.

## 6. 검수 기준 (지시문 §6 — 소형 재벤치)

- **F6 두 변형 4 run 재실행**(real-benchmark-f6-codex 러너 재사용·새 캠페인 디렉터리·독립 장부):
  - 사용자 행위 대행 스크립트에 2종 추가(기존 대행 전례 위): ⓐ사고 조성 전 **초기 envelope 승인**(A-6 경계 — ab축이 실릴 전달 경로 확보. 초기 내용은 빈 축 또는 무관 항목만: 벤치 정답 주입 금지 유지) ⓑ사고 검증 blocker 해소 후 생성된 후보의 **draft→승인**(문안은 하네스 산출 원문 그대로 — 대행은 클릭만 대신한다).
  - R 조건 목표: ab 동봉 확인(attach.jsonl envelope 스냅샷) + 직접 충돌 시 명시 처리(memHandling 기록) + blocker면 수정 라운드 개방 + hidden invariant 통과. B 조건은 기존 동작 무회귀.
- 이후 F1/F4/F12 중 1~2개 smoke. 228회 전체 벤치는 하지 않는다.
- 기존 전체 시험 체인 EXIT=0.

## 7. 구현 순서 (승인 후)

1. C-1(askId 전달·carrier 고정·attach 확장) → C-2 파서·행 확장 + 시험
2. B-1 프로필 문구(ko/en·core/integrity) + 프롬프트 계약 시험
3. A-3 조정 스캔(candidateId·억제 조건) + A-4 draft 명령 + A-5 상한 + 시험(기존 계약 개정 포함)
4. §7 회귀 시험 9종 완비 → 전체 체인
5. F6 소형 재벤치 → 결과 보고(버전업·푸시는 사용자 승인 후 — 로컬 우선 정책)

## 8. 비목표 재확인 (지시문 금지 목록)
모든 MAP 항목 blocker화 / stale 정본화 / scout 즉시 승격 / 기억 무조건 우선 / envelope 우회 blocker 부활 / 검증 폭주 재도입 / 캡처 3중 복제 / 구현자 대량 주입 — 전부 하지 않는다. 지도는 약한 필터로 유지하고 현재 코드 증거가 항상 우선할 수 있다(superseded 통로가 그 보장).
