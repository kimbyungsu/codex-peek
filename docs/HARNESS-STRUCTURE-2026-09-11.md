# 하네스 구조 정비 설계 — 2026-09-11 (v8 · 사용자 결정 반영: 압축 무반응)

> 출발점: 2026-09-09~11 대화 판단(사용자 정정 포함). 원칙 하나 — **프롬프트 문장을 더하는 대신 하네스 구조(파서·관문·계수·자료)로 막는다.**
> 이 문서는 "이렇게 고쳐야 한다"(판단) 다음 단계인 "어디를 어떻게"(설계)다. 구현은 사용자 승인 뒤. 버전업·푸시 없음.
> 판 이력: v1→v2 1판 14건 수용 · v2→v3 2판 5건 수용 · v3→v4 3판 5건 수용(**A1 방향 전환**: "압축 판을 인용 대조로 살린다"는 안을 폐기하고 "권위 없음은 유지하되 같은 회차 안에서 자동 재판 1회"로. git 근거의 코드 근거 관문 통과 규칙, 인용 대조의 루트 확인, 회전 부분 상태 자기치유, 행 번호 정정) · v4→v5 4판 4건 수용(폐기 판=부작용 0 조기 종료, 부분 상태는 job 스키마 키 `rotationPartial`, 변환기 이름 `convertItem`, 정본 행 1608·1666) · v5→v6 5판 2건 수용(폐기 판은 시도 추적기 `discard`로 종료 훅의 판정 행 생성 차단, `rotationPartial.head`는 정본과 같은 objectFormat 결속 sha1 40hex / sha256 64hex) · v6→v7 6판 1건 수용(시험 ⑨의 "부작용 0"은 폐기 판에만·최종 보류 판은 별도 단언으로 분리) · **v7→v8 사용자 결정(2026-09-11, 결정 장부 5f44378c1c318fe2)**: A1을 "압축 무반응"으로 전면 개정 — 자동 재판·보류·세션 교체 전부 폐기, 압축은 판정·증명·회차에 영향 없음, 규약만 다음 판에 조용히 재전송. D2=교체 켜기(79ecddca7639f03f)·D3=정보 줄(2a89097203a7ce9b)·D4=개요 패널(7ecd4f037ba27fd6) 확정.
> 정본 소스 규칙: 지도 정본은 `src/project-map.ts`이고 `bridge/project-map.js`는 동기화 사본(MAP-RESOLUTION-DESIGN 137행) — project-map 변경은 전부 정본에 넣고 bridge로 sync한다.

## 0. 범위와 순서

| 순서 | 항목 | 성격 | 크기 |
|---|---|---|---|
| A1 | 압축 규칙 — 하네스는 압축에 **반응하지 않는다**(판정·증명·회차 영향 없음·규약만 다음 판 재전송) | 하네스 자기수정 | 소 |
| A2 | 강제 새 방 플래그 관문 — 연결이 있으면 결정 장부 번호 없이는 거부 | 하네스 자기수정 | 소 |
| B2 | 지도 칸 회전 — 활성 계수·사실 기반 내리기·필요 시 교체·요청 계획 | 지도 | 중 |
| B1 | 근거 확인 — 인용을 실제 파일과 대조(루트 안에서만) | 검증 | 중 |
| B3 | 수칙 화면 — 항상 보이는 4칸 흐름 | 화면 | 중 |

A1·A2 한 묶음 먼저(매 캠페인 왕복을 태우는 마찰·뒤 작업 검증 비용 절감). B2는 (1)(4)(5) 소형 → (2)(3) 순. B1·B3는 독립.

---

## A1. 압축 규칙 — 하네스는 검증자의 기억 정리(압축)에 반응하지 않는다

### 경위
- **원칙은 사용자 지시**: HARNESS-REALIGNMENT-2026-08-29.md §4-B(295행) "프로젝트가 오래·크게 갈수록 주입 글이 자라지 않는 구조"(2026-08-30).
- **장치는 구현자 설계**: "정적 지시 세션 1회 전달 + 기록 기반 재전송 4종 + 검증 도중 압축=권위 없음(보류)"(306~307·330~333·474~479행). 보류 판의 통과 증명 생략은 확인 검증 blocker①(ab-3) 봉합(`bridge/codex-bridge.js` 4710행 주석).
- **사용자 결정(2026-09-11, 결정 장부 risk 항목 "압축 무반응")**: 압축은 Codex에서 원래 계속되며 08-31 이전까지 검증에 문제가 없었다. 압축이 잡힐 때마다 보류·세션 교체·재판 같은 별도 동작을 하면 몇 턴마다 반복돼 토큰만 늘고 효용이 없다. **압축 상태에 반응하는 하네스가 문제**이므로, 보류도 자동 재판도 아닌 **무반응**이 요구다. 설계 검증 7판 통과안이던 "자동 재판 1회"(v4~v7)는 이 결정으로 기각·폐기한다.

### 현재
- `postflightHeld(carrier)`(4082) → `applyPostflightHold`(4083~4088: 강등·판단 관문 마커·안내) → `finishVerifyRun`(4709~4713 proof 생략·4765~4767 `HOLD_EXIT_CODE`). `resolveJudgeRequired`(`contract-lib.js` 5708~5729) 보류 마커는 close-oos 불가.
- 압축 판정 재료: `postflightDelivery`(4853에서 호출) — 검증자 기록(rollout)의 `compacted` 시각과 전달 레코드를 대조해 `carrier.postflight={compacted, ts, st}`를 만들고, 전달 레코드를 `pending: compacted-mid-ask`로 적어 **다음 ask가 규약 전문을 재전송**하게 한다(이 부분은 그대로 유지).
- 실측: 08-31 이후 거의 모든 캠페인에서 보류 발생(09-09~11 설계 검증도 1·2·4·5판 보류). 보류 뒤 재전송 판은 내용이 같았다.

### 변경(사용자 결정 반영)
1. **권위 규칙**: `postflight.compacted===true`는 판정 권위·통과 증명·회차·판단 관문에 **아무 영향도 주지 않는다**. `applyPostflightHold`의 압축 분기(강등·마커·안내문)를 제거하고, `finishVerifyRun`의 `held9`에서 압축을 뺀다(정상 판과 동일한 꼬리·proof·종료코드).
2. **남기는 것(무음·무비용)**: `postflightDelivery`가 적는 전달 레코드 `pending: compacted-mid-ask`(다음 ask 전문 재전송 — 이미 있는 동작)와, 답 하단 상태 줄 1줄 `[규약 전달] 검증 도중 압축 감지(시각) — 다음 판에 규약 전문 재전송`. 대시보드 카드·배지의 "보류" 표기는 압축 사유에서 사라진다.
3. **판독 불가(`postflight.st!=="ok"`)**: 하네스 자신의 기록 판독 실패이며 압축과 무관하므로 **현행 보류 유지**(드묾·안전 방향). 이 보류의 close-oos 금지 규칙도 유지.
4. **재판·세션 교체·환급 신설 없음**: `HOLD_RETRY_EXIT_CODE`·작업자 재실행·`hold-retry` 환급·`attempt.discard`는 도입하지 않는다(v4~v7 안 폐기).
5. 형식 보류(블록 손상·판정 줄 없음)는 별도 기존 장치로 그대로 동작한다 — 압축이 서식을 망가뜨리면 이 장치가 잡는다.

### ab-3 검토(정직 고지)
- 위험: 답하는 도중 압축이 규약 요약을 잃게 해 검증 기본 원칙·검증 지시가 빠진 채 답할 수 있다. 08-31 이전(매 판 전문 동봉)에도 답 도중 압축은 같은 위험이 있었고 실측 문제는 없었다. 사용자가 이 위험을 **감수하기로 결정**했다(결정 장부 항목). 완화: 답 서식 기계 검사·다음 판 전문 재전송·지적 입장 심사(origin·supported)·근거 대조(B1).
- 검증 없이 도장이 찍히는 통로(ab-3)의 해석: 압축 판도 검증자가 요청문을 받고 낸 실제 답이다. "검증을 안 받았다"에 해당하지 않는다는 것이 사용자 판단이며, 이 절은 그 판단을 정본에 기록한다.

### 정본 개정(이 결정으로)
- HARNESS-REALIGNMENT-2026-08-29.md §4-B ① 표(306~307행) "검증 도중 압축=권위 없음" 삭제 → "압축 감지=다음 판 규약 전문 재전송(판정 영향 없음)". 478행 쉬운 말 절 같은 취지. `codex-bridge.js` 4710행 주석(ab-3 봉합) 개정. `contract-lib.js` `resolveJudgeRequired`의 `compacted-mid-ask` 사유는 더 이상 생기지 않으므로 목록에서 제거(옛 마커 호환은 유지).

### 시험(`tests/directive-delivery.test.js`·`tests/claude-directive-delivery.test.js` 확장)
① 압축 감지 판 → proof 기록·정상 종료코드·판단 관문 마커 없음·전달 레코드 pending·다음 ask 전문 재전송·상태 줄 1줄 ② 판독 불가 판 → 현행 보류(마커·`HOLD_EXIT_CODE`) ③ 형식 손상 판 → 현행 형식 보류(압축 여부 무관) ④ 비압축 판 출력 바이트 변경 전후 동일(VerifierProvider §3 1급 인수조건) ⑤ 대시보드·배지에서 압축 사유 보류 표기 부재 ⑥ 종료 훅: 압축 판의 통과가 이번 턴 결속 증명으로 인정.

### 사용자 결정 D1
결정 장부 항목 "압축 무반응"으로 **확정**(none). 대안(자동 재판·매 판 전문 동봉·현행)은 기각.

---

## A2. 강제 새 방 플래그 관문

### 현재
- `cmdAsk`(`codex-bridge.js` 4568~4570): `--force-new`는 `--allow-new`를 함의하고 4882행의 "새 방 폴더가 이 대화 폴더와 다름" 방어를 건너뛴다. 4637~4644행 연결 판독. 4806행: 유효한 연결이 있으면 `--force-new`여도 기존 연결 재개. 4811행 lease는 유효 연결 분기 안 검사(실패=거부·새 방 생성 경로 아님).
- `ASK_FLAGS`(2814)에 값 인자 플래그가 없고 `askRequest`는 값 인자를 구분하지 않는다 → `--decision <id>`를 그냥 붙이면 id가 프롬프트에 섞인다. `ask-start` 경로는 필터된 플래그만 `job.flags`에 보존(3130). 작업자는 `job.flags` 배열을 그대로 spawn 인자로 넘긴다(`ask-job-worker.js` 231).
- 09-09 실측: 연결 세션(01a0023c)이 있는 상태에서 `--force-new`로 새 방이 생겼다 → 연결이 '유효하지 않음'으로 판정된 경로(rollout 파일 미발견·stale 마커 등)가 있었다는 뜻. 시험 ⑥이 확정.
- 선례: `--folder-changed-ok`(3025~3040), `round-judge escalate --decision <id>`(3484~3509 + `contract-lib.js` 5708~5729·5722 저장소 대조).

### 변경
1. 규칙 두 줄을 코드로: ① 이 워크스페이스에 연결 기록이 **없으면** `--allow-new`가 새 방을 만든다(정상·결정 불요). ② 연결 기록이 **있으면**(유효 여부 불문) `--force-new`는 `--decision <id>`가 있어야 통과. 없으면 `die(..., 3)`: "연결 세션 X가 있음 · 새 방을 강제하려면 decisions raise 뒤 --decision <id>".
2. 값 플래그 파싱: `askRequest`에 `--decision <id>` 값 인자 인식 추가(프롬프트에서 제거), `ASK_FLAGS`에 등록, `ask-start`의 `job.flags`에 `["--decision", id]` 쌍으로 보존 → 작업자 spawn 인자로 그대로 전달돼 ask 경로가 같은 관문을 적용.
3. 결정 실존·저장소 표식 대조를 한 함수 `requireDecision(ws, id, repoKey)`(contract-lib)로 뽑아 escalate(5722)와 공유(ab-1).
4. 연결이 있는데 무효로 판정돼 새 방으로 가는 경로는 **침묵 생성 금지**: stderr 한 줄 + ask 결과 상태 줄 `[세션] 연결 X 무효(사유) → 새 방 Y 생성`. 대시보드 세션 카드에 표시.
5. 구현자 기억 문장(새 방 규칙 메모)은 관문이 들어온 뒤 삭제(구조가 대신함).

### 시험(새 `tests/ask-force-new-gate.test.js`)
① 연결 없음+`--allow-new` → 생성 ② 연결 있음+`--force-new` → exit 3 ③ 연결 있음+`--force-new --decision <실존 id>` → 진행·프롬프트에 id 없음 ④ 미존재 id → `decision-required` ⑤ 다른 저장소 id → `decision-repo-mismatch` ⑥ 연결 있으나 rollout 부재 → 상태 줄에 사유·새 방 id ⑦ `ask-start` 경로 `job.flags`의 `--decision` 쌍 보존·작업자 전달.

---

## B2. 지도 칸 회전

### 현재(검증된 사실)
- 정본 상한: `src/project-map.ts`(정본) `MAX_FILE_NODES=60`, add_node 거부(정본 1628 / bridge 1947)·split 거부(정본 1684 / bridge 2036~2040)는 **lifecycle 무관** 전체 file 노드 수. 보강 사전검사 `validateEnrichResult`(`map-enrich.js` 672~ · 활성 상한 계산·failureDetail 719~730)도 같은 계수. `applyOperationV2` set_state는 state 병합만(bridge 2292~2313).
- 근거 관문: 정본 `validatePatchV2`(940~944) — topology op는 evidence ≥1이고 그중 `CODE_EVIDENCE_KINDS`(code/test/config) 하나 이상 필수(자기확인 고리 차단). `EVIDENCE_KINDS = ["ledger","ask","test","code","config","doc"]`(bridge 78, 어휘 확장=추가만 허용). patch에 `provider`·`detectedBy` 선택 문자열(1055~1056).
- 실분류: `map-pipeline.js` `DEFAULT_CLASSIFICATION`(396~417) set_state=auto·supersede=verifier-resolved·tombstone_candidate=needs-investigation. `policyTier`(bridge 543)는 호출자 없음(죽은 코드).
- 강등 관문: `map-enrich.js` `isDemotion`(1693)·`needVerifier`(1739~1762) — 보강 실행기 `applyOnePatch`(1716, 호출부 1600) 안의 provider 충돌 프레이밍.
- 적용 흐름: `proposePatch`(379)→`classifyPatch`(404)→`applyPatch`(577): `semanticValidateV2`는 검증기(775), `applyOperationV2`가 단일 patch 적용(783), decision은 단일 patch+`affectedIds`(827)·actor는 파이프라인이 `{kind:"auto"}` 객체로 생성(827~834, v3 검증기 정본 1521~1525 객체 필수), 복구 스냅샷은 원본 `rt.raw`(852). evidence 파일 부재는 `__missing__` 지문으로 기록(806). 검증기 안에서 topology를 바꾸면 WAL·decision·스냅샷이 갈라진다(ab-5).
- 변경 연결: `expandChangedWithConsumedDelta`(`map-enrich.js` 42~60) `git diff --name-only -z` — 삭제·이름변경 구분 없음.
- 요청: `buildEnrichPrompt`(`enrich-providers.js` 110·124~147) 잔여 칸 미계산·add_node 견본 상시.
- 전송 예산 `REF_BUDGET.map=1500`(최대치)은 노드 수와 무관. 60은 저장·보강 비용 상한.
- 화면: job payload `lastFailure` 구조만(`src/extension.ts` 2762~2768)·6035행 일반 문구.
- 노드별 검증 인용 이력 기록은 없다.

### 원칙
사람은 기준(상한·보호·켜기/끄기), 기계는 노동(계수·사실 반영·교체). 시간 경과만으로 지우지 않는다. 기록은 지우지 않는다(ab-5). 모든 상태 변경은 **정규 패치 파이프라인**(propose→classify→apply)을 지난다.

**구현 위치(2026-09-12)**: (2)(3)의 사실 판독·정규 패치 조립·내리기·복귀·교체·보상은 새 모듈 `bridge/map-rotation.js`(배포 목록 3사본 편입)에 두고, `map-enrich.js`는 두 훅만 갖는다 — 실행 시작 통과(`runEnrichLocked` 진입 직후 `factPass`: 부분 상태 보상 재시도→사실 전이→복귀, topology 캡처 '전')와 add_node 직전 교체(`applyItems`의 `applyOnePatch` 호출 직전 `rotateBeforeAdd`, 직후 완료/보상 처리). 교체 정책은 계약 `mapRotation {enabled, protectDays, hubMinDegree}`(기본 켜기·14일·3).
**구현 검증 1판 수용분(2026-09-12)**: ① 표식 정산의 재료는 '그 반복의 방출 여부'가 아니라 **작업에 남은 표식**(`rotationPartial`) — 일시 재시도 뒤 다음 반복에서 성공한 add_node도 표식을 지우고, 거부·보류면 되돌린다(순수 `settleRotation(step, pending)`: clear/compensate/keep/none). 되돌리기(`rotationCompensate`)는 활성 칸이 이미 상한이면 되살리지 않는다(새 칸이 자리를 차지했으므로 교체 완료로 정산·표식만 정리 — 되살리면 활성 61). **확인 검증 2판 수용분**: 이 상한 판정의 권위는 잠금 밖 조기 검사가 아니라 정본 `semanticValidateV2` 의 set_state 상한 검사(내려간 file 노드를 active 로 올리는 전이=+1, `activeFileDelta`)다 — 경합으로 정본이 거부하면 되돌리기는 실물 재판독으로 cap-full 정산. 또 되돌리기·표식 유지는 결정 기록이 '이 교체(head)'의 것일 때만(`rotationOwns`: detectedBy=rotation + rationale 커밋 표기) — 다른 결정의 강등은 되돌리지 않고 표식만 회수한다. **3판 수용분**: 그 결정 기록은 노드의 `provenance.decisionId`(=가장 최근 결정 — 뒤의 add_evidence·add_anchor 가 덮어쓴다)가 아니라, provenance 가 강등 결정이 아니면 결정 색인에서 이 노드를 겨냥한 set_state(→deprecated) 후보를 모으고(`demotionDecisionOf`), 후보가 여럿이면 시각(같은 밀리초 가능 — 4판 blocker)이 아니라 **topology 해시 사슬**(각 결정의 audit.topologyBeforeHash→AfterHash, 현재 topology 의 mapHashOf 가 끝)을 거슬러 처음 만나는 후보를 고른다(`orderByChain`). 사슬이 끊기거나 모호하면 null=소유 아님(되돌리지 않음·표식 회수). 기준점 없는 실행 시작 통과도 복귀 실패면 `ok=false`. ② 방출 패치 적용 단계 실패는 실물이 이미 내려갔을 수 있으므로 topology를 다시 읽어 **후보가 deprecated면 표식을 유지**하고(다음 실행 시작이 보상), 상태 변화가 없는 실패(조립·분류 단계)만 표식을 회수한다. ③ HEAD 판독은 하나 — 실행 시작 통과(`factPass`)가 본 HEAD를 돌려주고 실행기가 같은 값을 소화 기준점 끝점(`srcHead`)으로 쓴다(그 값이 있으면 실행기는 `rev-parse`를 다시 부르지 않는다 — 3판 보완; 없을 때만 별도 판독하되 그 실행은 `factsOk=false`라 기준점이 전진하지 않는다). 사실 전이·복귀 중 하나라도 못 붙거나 HEAD 판독·중간 topology 재판독이 실패하면(`ok=false`) 완료 시 기준점을 전진시키지 않아(`st.factsOk===true` 일 때만 전진 — 복구 경로 2곳도 전달·값 없음=전진 금지) 다음 실행이 같은 구간을 다시 먹는다. 보상 실패는 표식(`rotationPartial`)이 다음 실행에서 다시 시도하므로 기준점 축과 별개다. ④ 기준점·끝점·표식의 커밋 id 형식은 sha1 40자·sha256 64자 둘 다(`OID_RE`).

### 변경
**(1) 계수 단일 함수 + 활성 순증분** — 정본에 두 함수 export: `activeFileNodeCount(topo)`(entityType==="file" && lifecycle 부재 또는 "active")와 `activeFileDelta(topo, op)`(add_node: 들어오는 노드가 활성 file이면 +1 / split_node: −(원본이 활성 file이면 1) + 신규 노드 중 활성 file 수 / set_state: 내려간 file 노드를 active 로 올리면 +1(확인 검증 2판 수용) / 그 밖 0). 검사식은 넷 다 `activeFileNodeCount(t) + activeFileDelta(t, op) > MAX_FILE_NODES`: add_node(정본 1634)·set_state(정본 1657)·split(정본 1690, 현재 `curF − srcF + addF`를 활성 기준으로)·`validateEnrichResult`(672~ · 상한 계산·failureDetail 719~730, 라운드 add_node 합산). deprecated 원본을 활성 노드들로 분할해도 활성 상한을 넘기지 못한다. `MAX_FILE_NODES`=활성 file 노드 상한으로 문서 갱신. bridge sync.

**(2) 사실 기반 내리기 — 정규 패치 + 사실 근거 규칙** — `expandChangedWithConsumedDelta`에 `git diff --name-status -M -z base..end` 병행 판독 → `facts={deleted:[path], renamed:[{from,to}]}`. 새 함수 `applyFactTransitions(repo, mapId, facts, head)`(보강 실행기 옆·run-lock 안):
- 패치=`{operation:"set_state", targetId, payload:{to:{lifecycle:"deprecated"}, expect:{lifecycle:"active"}}, rationale:"file-gone@<head7>"|"renamed-to:<to>@<head7>", provider:"harness-git", detectedBy:"git-name-status", evidence:[{kind:"git", ref:"<head>", note:"D <path>"|"R <from> -> <to>"}]}`.
- **사실 근거 규칙(3판 blocker)**: `EVIDENCE_KINDS`에 `"git"` 추가(추가만 허용 규칙). 정본 관문(944)의 "코드 계열 근거 ≥1"은 다음처럼 확장: `CODE_EVIDENCE_KINDS` 하나 이상 **또는** (`kind:"git"` 근거가 있고 `patch.detectedBy ∈ FACT_DETECTED_BY = ["git-name-status","rotation","rotation-revert"]`). `detectedBy`는 보강 변환기(`map-enrich.js convertItem`, 1683행)가 결코 만들지 않는 필드라 모델 출력이 이 규칙을 탈 수 없다(시험으로 고정). 실행기(`applyPatch`)는 git 근거의 `ref`가 저장소에 실존하는 커밋인지 `git cat-file -e <ref>` 로 검사(실패=적용 거부). `CODE_EVIDENCE_KINDS` 자체는 불변 → 보강 항목의 자기확인 고리 차단은 그대로.
- 분류·기록: `proposePatch → classifyPatch(set_state=auto) → applyPatch` 그대로. decision `actor`는 파이프라인 객체 그대로(하네스 불개입). 표식은 patch의 `provider`·`detectedBy`·`rationale` 접두(`file-gone@`·`renamed-to:`·`rotated-out@`·`revived@`·`rotation-reverted@`)로만. 새 키 없음. **`applyOnePatch`의 provider 충돌·`needVerifier` 프레이밍은 거치지 않는다**(근거가 git 사실이고 의미 판단이 아님). 각 전이=독립 decision·WAL·스냅샷(ab-5).
- 이름변경: 옛 노드 deprecated + rationale에 새 경로. 새 경로 노드는 다음 보강 add_node가 생성(anchor 교체 op는 v2 후속).
- 복귀: 변경 연결 통과에서 `changed` 경로의 노드가 deprecated이고 rationale이 `file-gone|renamed-to|rotated-out`이며 파일 실존 → 같은 통로로 `active` 복귀(rationale `revived@<head7>`).
- tombstone·supersede는 종전대로(사람·검증자).

**(3) 필요할 때만 교체 — 순차 두 패치** — 보강 실행기의 `applyOnePatch` **호출부(`map-enrich.js` 1632행)** 직전, add_node 패치를 적용하기 전에:
- `activeFileNodeCount(topo)==MAX_FILE_NODES && rotation.enabled`면 `rotateCandidate(topo, gitAges, policy)`(순수 함수)로 방출 대상 1개 선택 → 하네스 set_state(deprecated) 패치(rationale `rotated-out@<head7> for <새 경로>`, provider `harness-git`, detectedBy `rotation`, evidence git)를 **먼저** propose→classify→apply → 성공 시 add_node 패치 적용. 방출 패치가 실패하면 add_node는 `parkReason:"rotation-failed:<stage>"`로 보류(아무 상태도 안 바뀜).
- **완료 조건과 둘째 패치 실패**: 교체 완료 = 방출 decision과 add_node decision이 둘 다 적용된 상태. 방출은 됐는데 add_node가 거부되면 실행기가 즉시 **보상 패치**(같은 통로 set_state deprecated→active, rationale `rotation-reverted@<head7>`, detectedBy `rotation-revert`)를 propose→classify→apply해 순 상태를 되돌리고 add_node는 그 거부 사유로 보류. 보상까지 실패하면 `parkReason:"rotation-partial"`로 보류하고 job에 `rotationPartial:{victimId, objectFormat, head, at}`를 기록.
- **job 스키마(4판 blocker)**: `map-enrich.js` `JOB_KEYS`(145)에 `rotationPartial`을 **선택 키**로 추가하고 `validateJob`(197~)에 내용 검증을 넣는다 — 없음 또는 `null` 또는 `{victimId: UUID, objectFormat: "sha1"|"sha256", head, at: ISO}`. `head`는 정본 `VerificationBasis`와 **같은 규칙**(`src/project-map.ts` 52~55·303~310: sha1→40hex, sha256→64hex — 5판 blocker: SHA-256 저장소의 64자 HEAD를 손상으로 오판하지 않는다). 그 밖 이형=손상. 옛 job(키 없음)은 그대로 유효. `ATTEMPT_KEYS`·`FAILURE_*` 열거는 불변(`parkedReason` 값 `rotation-partial`·`rotation-failed:<stage>`만 추가 — 화면 문구표에 등재).
- **부분 상태 자기치유(3판 보완)**: 다음 보강 실행 시작 시(자기치유 재개 경로) job의 `rotationPartial`을 먼저 읽어 보상 패치를 **재시도**하고 성공하면 `null`로 지운다 — 밀려난 파일이 다시 변경되지 않아도 복귀한다. `changed` 경로 복귀 규칙은 별도로 유지. 세 경우 모두 decision·WAL이 남아 기록 파괴는 없다(ab-5). 회전 시도·보상·부분 상태는 route 로그에 종류별로 남긴다.
- 후보·보호: active file 노드 중 `confidence==="confirmed" && degree>=policy.hubMinDegree`(허브) 제외, 마지막 커밋이 `policy.protectDays` 이내 제외.
- 점수(낮을수록 먼저): 마지막 커밋 오래됨 → confidence candidate 우선 → degree 적음 → evidence 적음 → id 사전순(결정성).
- 마지막 커밋 시각: 교체 시점에 `git log -1 --format=%ct -- <path>`(5초 timeout·실패=미상=보호). 노드 파일에 캐시하지 않는다.
- 정책값(계약 `mapRotation`): `{enabled:true, protectDays:14, hubMinDegree:3}` 기본값 고지(P7 ⓒ 절 재사용). `enabled:false`면 종전 거부.
- 검증기(`semanticValidateV2`) 안에서는 어떤 변이도 하지 않는다.

**(4) 요청 계획** — `buildEnrichPrompt(ctx)`에서 `remaining = MAX_FILE_NODES − activeFileNodeCount(ctx.topo)`. `remaining===0 && !rotation.enabled`면 add_node 견본을 목록에서 빼고 자료 한 줄 `(지도 가득: 새 파일 칸 요청 불가 — 활성 60/60)`. `rotation.enabled`면 add_node 유지. 사후 검사는 (1)의 계수로.
- 화면: job payload에 `lastFailure.code`·`lastFailure.detail`(예 `schema-invalid`·`61>60`) 구조화, 6035행 문구 대신 실사유. 자유 문자열 원문(failReason)은 종전대로 비전송(ab-7).

**(5) 정리** — `policyTier`는 v1 동결 계층(`src/project-map.ts` 496행(v1 동결 주석))이고 `tests/project-map.test.js`·`tests/map-patch-v2.test.js`가 존재·동작을 잠근 API라 **삭제 대신 표기**로 닫는다(구현 시 판단 2026-09-12): 함수 위에 "v1 동결·실경로 미호출·실분류 정본은 map-pipeline DEFAULT_CLASSIFICATION" 경고 주석, `DEFAULT_CLASSIFICATION` 위에 의도(소멸·대체=사람/검증자, 상태 변경=auto, 강등=관문) 주석 이관.

### 정본 개정(D2 승인 시)
MAP-RESOLUTION-DESIGN.md §2-3(100행 "지도 전체 file 노드 60개" → "활성 file 노드 60개"), §6(166행 "파일 삭제 시 file 노드 잔존" → "사실 전이로 deprecated·복귀 규칙"), 근거 관문 절에 "사실 근거(git·detectedBy 결속·커밋 실존 검사)" 추가, 정본 소스 `src/project-map.ts` 변경 항목 명시(137행 규칙).

### 시험
- `tests/map-apply-v2.test.js`: 계수 단일 함수(deprecated 59+active 1 add_node 허용·active 60 거부)·활성 순증분(deprecated 원본→활성 2개 분할 거부·활성 원본 분할 −1+n).
- `tests/map-patch-v2.test.js`: git 근거 규칙 — `detectedBy` 없는 git-only 패치 거부·`detectedBy:"git-name-status"`+git 근거 통과·보강 변환기 출력에 `detectedBy` 부재 고정·커밋 실존 검사 실패=거부.
- `tests/map-pipeline.test.js`: 사실 전이 패치(삭제·이름변경·복귀)가 정규 파이프라인으로 각각 decision·WAL을 남김·actor 객체 불변.
- 새 `tests/map-rotation.test.js`: 후보·보호·점수·동점 결정성·git 실패=보호·enabled:false=거부·방출 실패=보류·방출 성공+add_node 거부=보상·보상 실패=`rotationPartial` 기록+다음 실행 재시도 복귀·route 로그.
- `tests/p8-enrich-run.test.js`(job 스키마): `rotationPartial` 없음/`null`/정상 객체(sha1 40hex·sha256 64hex 각각)=유효, 이형(필드 누락·형식 오류·objectFormat과 길이 불일치)=손상, 옛 job 파일 판독 회귀.
- `tests/p8-enrich-run.test.js`: 사전검사 계수·요청 계획(가득+꺼짐=견본 없음·자료 줄).
- `tests/enrich-visibility.test.js`: 화면 실사유.
- 회귀: consumed.json 기준점 무변경·`CODE_EVIDENCE_KINDS` 관문 무영향(보강 항목 doc-only 여전히 거부).

### 사용자 결정 D2
교체 기본 `enabled:true`(추천) / `false`(사실 기반 내리기까지만).

---

## B1. 근거 확인 — 인용을 실제 파일과 대조

### 현재(정정)
- `bridge/codex-bridge.js resolveCitedPath`(481~495): 절대경로가 실존하면 **루트 확인 없이** 수락(491), 상대는 ws 기준, 그 밖은 basename 유일 일치. `checkCitedEvidence`(496~518): 본문 마크다운 링크 `(경로.확장자:줄)`만 대상 → 유일 해석 → **EOF 초과만 경고**(`evidence-mismatch`). 해석 불가·읽기 실패는 건너뜀.
- `evidence-unseen`(1792): 검증자 명령 기록에서 읽은 파일을 추정(`templateScriptCommands` 888·`citedFilesUnseen(Exact)` 1570·1654) — **warning(판정 비권위)** + 재확인 발송. EVIDENCE-RECONFIRM-DESIGN.md 11행(재확인 신호)·24행(판정·proof 불변)·26행(자동 해소=동결 구간 일치만).
- 파서 `contract-lib.js parseFindingsBlock`(857~900·892): `file`만 보존(빈 값 허용), `line`·`detail`은 버린다.
- 문제: 읽기 추정은 검증 도구 출력 모양에 묶여 헛경보(09-06~09 12판). 모양 목록 확대는 전역 원칙(패턴 목록 누적 금지)에 반하고, 그 시험 방식이 안전장치를 건드렸다. 또 루트 밖 인용이 수락되는 구멍이 있다(3판 blocker ab-1).

### 변경
1. 파서: `line`(양의 정수·선택)·`detail`(문자열·선택·400자 상한) 보존. 형식 무효=드롭(기존 규칙).
2. `citationCheck(answer, parse, roots)` = `checkCitedEvidence`의 확장(같은 해석 경로 + **루트 확인**): 대상 = 지적 행 `{file,line,detail}` + 본문 링크 `(경로:줄)`·`경로:줄`. 판정 순서: 해석 → **realpath가 `roots`(exec·ws·정찰 저장소 — `flagEvidence`의 `chRoots`와 동일) 안** → 실존 → 줄 범위 → `detail`의 식별자 토큰이 `line±3`에 출현. 결과 `ok / outside-root / file-missing / line-out-of-range / token-not-near-line / no-location / no-token`. `outside-root`는 흔적도 경보도 아니며 상태 줄 개수로만 표시(다른 저장소 파일의 오귀속 차단·ab-1). `checkCitedEvidence`의 루트 없는 절대경로 수락은 이 함수로 대체된다.
3. 토큰(ab-7): `detail`의 **백틱 코드 스팬 안 식별자**(`[A-Za-z_$][\w$]{2,}`)만 추출. 따옴표 문자열은 제외. 경보 문구·장부에는 토큰 원문을 넣지 않는다 — `file·line·kind·tokenFp(sha1 8자)`만. 문구 예: `파일 X 줄 N 근처에 지적 상세의 식별자가 없음`.
4. 경보 kind `citation-mismatch`(file-missing·line-out-of-range·token-not-near-line) — 대시보드 기존 경보 카드 통로 재사용, 지적 id 결속. `no-location`은 입장 심사에서 "위치 미기재"(약한 근거) 열로 분류.
   - **저장소 결속(ab-1)**: 이 kind의 이벤트는 `workspace`에 더해 `repoKey`(검증 시작 스냅샷 `repoKeySnap9`)를 싣는다. `appendIntegrityEvent`(contract-lib 221~)의 같은 종류 갈아끼우기도 이 kind는 `workspace+repoKey`로 판정. 대시보드 `readVisibleIntegrity`(extension.ts 1878~1881)는 이 kind에 한해 현재 정찰 저장소 `repoKey` 일치 행만 보인다. 기존 kind의 필터는 변경하지 않는다.
5. 해소: `citation-mismatch`는 구간 재인용 challenge로 해소하지 않는다(그 판정은 동결 구간 바이트 일치만 — `evidence-challenge.js` 262). 해소 = 같은 지적 계보(id·prevId)의 다음 답에서 `citationCheck` ok, 또는 사용자 확인. 자동 재발송 없음.
6. `evidence-unseen`·재확인 장치: **정본 유지**(재확인 신호·자동 해소 규칙 그대로). 바꾸는 것은 표시 등급뿐 — 경보 카드 → 상태 정보 줄 `읽기 흔적: 확인 k/n`(D3). `templateScriptCommands` 정형 목록은 확대하지 않는다.
7. 요청문에 "파일·줄을 꼭 적어라" 문장을 추가하지 않는다.

### 정본 개정(D3 승인 시)
EVIDENCE-RECONFIRM-DESIGN.md에 1줄: "evidence-unseen의 표시 등급=정보 줄(경보 카드 아님) · 재확인 신호·해소 규칙 불변". 새 `citation-mismatch`는 이 문서 B1이 정본.

### 한계(정직 고지)
부재 주장·범위 주장은 줄 대조로 확인 불가 → 정보 줄. 지금 방식도 못 하던 것.

### 시험
- 새 `tests/citation-check.test.js`: 7종 판정·링크 3형·한글 경로·**루트 밖 절대경로=outside-root(흔적·경보 아님)**·CRLF·토큰 원문이 이벤트·장부·문구에 없음(따옴표 문자열 미추출)·이벤트 repoKey 결속과 화면 필터(같은 workspace·다른 repoKey 행 비표시 — ab-1).
- 파서 회귀: line·detail 보존·무효 드롭.
- `tests/evidence-unseen.test.js`: 표시 등급 강등 뒤 재확인 발송·해소 규칙 무변경. `tests/evidence-ui.test.js`: 새 kind 카드·정보 줄.

### 사용자 결정 D3
`evidence-unseen` 표시=정보 줄(추천) / 경보 카드 유지.

---

## B3. 수칙 화면 — 항상 보이는 4칸 흐름

### 현재
- 자료(`src/extension.ts` 1140~1200): `rules9`(target core|archive·tag always|rel), `ride9`(1158 — 마지막 비-preview 영수증 개수만 문자열), `arc9 {state,count,max}`, 라벨. 영수증(`ask-job-worker.js` 180)에는 `ts·wsKey·repoKey·askId·selectedIds`. 정리 요약 `curation.js curationSummary`(684~687)·`readTickState`(700 export).
- 렌더(7403~7470): `d.curation`일 때만 11px 한 줄 + 버튼 "마지막 정리 결과 보기"(모달), 제안함은 `cands.length>0`일 때만.
- 없는 값: 마지막 선별 영수증 시각·이번 판 선별 항수·코어 주입 실물 글자 수(`contract-lib.js envelopeInjectionFor` 3706)·선별 상한(`SELECTOR_UNION_MAX=12`·`SELECTOR_UNION_BYTES_MAX=4000`, 5292~5293).

### 변경
1. 자료: `flow` 객체(계산은 `bridge/rules-flow.js` 순수 함수):
   - `core: { count, injectedChars }` — `envelopeInjectionFor(...).text.length`.
   - `archive: { state, count, max, selectCap: { items: SELECTOR_UNION_MAX, bytes: SELECTOR_UNION_BYTES_MAX }, lastSelection: { ts, selectedCount, askId } | null }` — `readSelectorUsage` 행 중 `purpose!=="preview"`이고 `wsKey`와 `repoKey`(현재 정찰 저장소 `repoKeyOf(resolveScoutRepo(...))`)가 **모두 일치**하는 마지막 행(ab-1·CURATION P6 동형).
   - `proposals: { pending, max, nextCheck: { tickK, tickCount, unusedDays, lastTickTs } }`.
   - `curator: { lastTs, lastOutcome, lastReason, lastTrigger, lastItems }`.
2. 렌더: 항상 4칸. 빈 상태 문장(제안 0 → "지금 제안 없음 · 다음 검사: 훅 10회마다(지금 n회) · 30일 미사용 관측 · 마지막 검사 …", 서고 0 → "관련될 때만 적용되는 수칙 0항 · 정리 담당이 제안하면 채워집니다").
3. 위치: 검증 설정 탭 → **개요 패널 '수칙 흐름' 카드**. 설정 탭엔 승인·편집만. 교차 패널 이동은 `gotoEl` 단일 경로.
4. "마지막 정리 결과 보기" 모달 → 정리 담당 칸 인라인 접기.
5. 비용 근거: `core.injectedChars`·`archive.selectCap`·`archive.max`를 숫자로.

### 시험
- 새 `tests/rules-flow.test.js`: 빈 서고·제안 0·영수증 없음·정상·wsKey 같고 repoKey 다른 영수증 제외(ab-1)·글자 수=실물 길이·selectCap 상수 일치.
- 웹뷰: `tests/evidence-ui.test.js` 관례로 4칸 존재·빈 상태 문장.

### 사용자 결정 D4
위치: 개요 패널 카드(추천) / 별도 탭.

---

## 결정 항목 요약(사용자)
| id | 질문 | 추천 |
|---|---|---|
| D1 | 압축 규칙 | **확정: 압축 무반응**(5f44378c1c318fe2) |
| D2 | 지도 교체 기본 켜기 | **확정: 켜기**(79ecddca7639f03f) |
| D3 | 읽기 추정 표시 등급 | **확정: 정보 줄**(2a89097203a7ce9b) |
| D4 | 수칙 흐름 위치 | **확정: 개요 패널**(7ecd4f037ba27fd6) |

## 같은 내용을 쉬운 말로
- **압축**: 검증자가 답하다가 기억을 정리해도 하네스는 아무 것도 하지 않는다. 그 답은 보통 답과 똑같이 인정되고 왕복도 보통대로 센다. 규약만 다음 판에 조용히 다시 보낸다. 보류·재판·방 바꾸기는 없다.
- **새 방**: 연결된 검증 방이 없으면 하네스가 새 방을 만드는 게 정상. 방이 있는데 억지로 새 방을 만들려면 결정 장부 번호가 있어야 한다. 메모가 아니라 명령줄 관문이 막는다.
- **지도**: 빈자리 세기는 "활성"만. 저장소에서 파일이 사라지거나 이름이 바뀌면 그 칸은 정식 절차(기록 남김·근거는 커밋)로 자동으로 내려간다. 꽉 찼는데 새 파일이 오면 가장 오래 안 바뀐 칸을 먼저 정식 절차로 내리고 새 칸을 받는다. 도중에 실패하면 되돌리고, 되돌리기도 실패하면 다음 실행이 먼저 되돌린다. 기준은 사용자가 정한다.
- **근거 확인**: 검증자가 파일을 열었는지 감시하는 대신, 검증자가 적은 "파일 X 줄 N"을 실제로 펴서 그 내용이 있는지 본다. 이 프로젝트 밖 파일은 세지 않는다. 비밀이 될 수 있는 원문은 기록하지 않는다.
- **수칙 화면**: 항상 적용 몇 항(글자 수), 관련될 때만 몇 항(마지막 선별 시각·상한), 제안함(비었으면 왜), 정리 담당 마지막 실행. 네 칸이 늘 보인다.
