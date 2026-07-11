# Project MAP v2 — P2 patch pipeline 상세 설계 (정본 MAP-V2-DESIGN.md §5 P2의 위임 이행 · 사전검증 9차 확정)

정본이 "P2 설계에서 고정"으로 위임한 항목과 설계 사전검증 1차(12건)·2차(17건)를 시작으로 9차까지의
지적 전부를 반영해 구현 선택을 닫는다. 이 문서는 정본을 덮지 않는다 — 충돌 시 정본이 이긴다.
표기 규약: 해시 도메인 구분자는 문서에서 NUL(0x00)로 표기하고 구현에서만 실제 NUL 바이트를 사용한다(2차 #17).

## A. 비활성 계약의 실체 (1-30, 1차 #12)
- 자동 적용 트리거 0: 훅·부모·bootstrap 어디서도 pipeline을 호출하지 않는다. 진입은 CLI 수동 명령뿐.
- **marker 어휘 분리**: P2가 기록하는 것은 **guard/산출물 marker**(1-32)뿐. P3b의 **권위 marker**(cutover
  플래그)는 P2에 존재하지 않으며 어떤 표면도 '권위 활성'으로 해석될 수 없다.
- **pre-cutover apply 강제**: cutover 플래그가 없는 동안 `apply`는 `--pre-cutover` 명시 플래그를 요구하고
  decision에 `preCutover: true`를 기록한다. 플래그 없는 호출은 거부+사유.
- **분류 해소 증거 강제**: needs-investigation/blocked-conflict=거부, intent-choice=해소 레코드(P9 전 부재 →
  거부), verifier-resolved=유효 typed Verifier 결과(1-5 결속 검증 통과) 없으면 거부. auto=②b·CAS 통과로 충분
  (P2에서 apply 도달 가능한 실경로는 사실상 auto뿐).
- 2트랙: 모든 신규 CLI는 scoutMode 게이트 최선행(off=거부·파일 생성 0).

## B. identity·잠금·클레임 (1-29 — 1차 #10·2차 #6)
- `canonicalIdentityFor(repo)`: `physKey = realpath(worktree)` — 물리 쓰기 잠금 키는 이것만. `ctxFor`의 LOCK
  키를 `wsKeyFor(realOf(repo))`로 교체(현행 path.resolve — junction/symlink 별칭 결함 수정, P1 repoKeyFor와
  정규화 일치. P1 회귀 테스트 재잠금).
  `nsKey = sha1(realpath + NUL + gitCommonDirReal + NUL + (branch | "detached:"+HEAD))`,
  비-git은 `sha1(realpath + NUL + "nogit")` — 큐·WAL·pending 네임스페이스 키.
- **비중첩 잠금 프로토콜(2차 #6·3차 #5·#6)**:
  ① `nsLock` 아래 **apply-claim 원자 선점** — pending 파일을 `claimed`로 전이하고 **{pid, token, claimedAt,
  decisionId}를 기록**. 이미 claimed면 3대 분기(ⓑ는 2하위 — 5차 #1·6차 #1): ⓐ활성 WAL(wal/<decisionId>) 실존=거부(진행 중 —
  recoverWal 안내) ⓑ**wal-complete/<decisionId> 실존(+marker 정합 확인)=적용은 완결된 것 — pending을
  resolved로 '보충 종결'하고 재적용하지 않는다**(완결 이동~종결 사이 사망 중단점)
  ⓑ′**wal-complete 실존인데 marker 부재/불일치(6차 #1 — gc·수동 편집·이동 직후 손상)=재적용 금지 —
  완료 WAL 사본으로 decision·policy 파일을 재검증해 정합이면 marker 보충 후 resolved, 파일 불일치=conflict
  보고**(gc는 claimed pending이 참조하는 wal-complete 항목과 그 marker를 pending 종결까지 함께 보존 — C-5
  gc 예외에 편입)
  ⓒ둘 다 부재+보유 pid dead=nsLock 아래 원자 재선점(pre-WAL 사망 — 3차 #5) / 보유자 생존·판별 불가=거부
  → nsLock 해제
  ①′ claim 전 사전 검사(7차 #2): nsLock 안에서 활성 WAL 존재 시 claim을 만들지 않고 즉시 거부(recoverWal
  안내). ①″ mapLock 진입 후 §F ⓪ 재검사(claim~mapLock 사이 경쟁)에서 거부되면 — **mapLock callback은 거부 결과만 반환하고 mapLock을 완전히 해제한 뒤**(비중첩 계약: mapLock 보유 중 nsLock 취득 금지 — 8차 #3) nsLock 아래 {patchId,
  decisionId, token} CAS로 **자기 claim만 proposal 상태로 복구**(다른 주체의 재claim 미간섭 — 방치 시 dead
  claim 회수 경로를 불필요하게 타는 반례 차단).
  ② `withMapLock`(물리) 트랜잭션(§F — 내부에서 writeRs·funlock을 부르지 않음)
  ③ `nsLock` 아래 종결(pending→resolved, 멱등: patchId 상태 전이).
  P2는 잠금 중첩을 만들지 않는다(참고 — P1도 중첩이 아니다: finishDone의 mapLock이 반환된 '뒤' writeRs가
  funlock을 취득한다. 3차 #6 정정).
- 서랍: `<BRIDGE_DIR>/map-pipeline/<nsKey>/<mapId>/{pending/<patchId>.json, wal/<decisionId>.json,
  wal-complete/<decisionId>.json, wal-aborted/<decisionId>.json, markers/<decisionId>.json,
  snapshots/<decisionId>.json}`(9차 표기 보완).

- **canonical writer 공통 barrier(7차 #1·8차 #1 확장)**: **topology·MAP.md를 쓰는 모든 P0.5/P1 경로** —
  수동 init·migrate·render(writeCanonicalLocked 소비자 전부), P1 부모(maybeSpawnBootstrap)·자식 runChild의
  init/ensure 양쪽(initTopologyForBootstrap 포함)·수동 bootstrap(runCli — 부모 미경유) — 는 쓰기 전에
  **현재 canonical identity(nsKey) 아래 활성 P2 WAL 전체를 검색**(topology 부재·손상으로 mapId를 읽을 수
  없어도 nsKey 스캔은 가능)하고, 존재하면 **canonical 산출물(topology·MAP.md·큐)은 쓰지 않고(자기 run-state rollback만 허용)** pipeline-recovery-pending 사유로 정지+
  recoverWal 안내를 고지한다. P2 내부 writer(apply·recoverWal)만 자기 decisionId의 WAL에 한해 명시 우회.
  부모 게이트 검사로 매 턴 ensure 헛기동 차단. t9/t7x의 '자동 재렌더 주체 없음' 전제는 이 barrier로 성립.
  **자식 race 종결(8차 #2)**: 부모 통과 직후 P2가 WAL을 만든 race에서 자식 barrier가 발동하면 — 자식은
  이미 childClaim으로 run-state를 running으로 바꾼 뒤이므로 — **자기 runId CAS 하에 rs를 cl.prev로 복원
  (prev 없으면 삭제=absent 복귀)하고 attempts를 증가시키지 않는다**(blocked를 쓰면 부모의 무조건 억제에
  걸려 WAL 해소 후 자동 재개가 막히고, 방치하면 dead running 회수 경로를 오염). 이후 자동 경로는 부모
  barrier가 침묵 보류하다 WAL 해소 시 자연 재개. 끝단 테스트: WAL 부재=파일 생성 0·기존 결과 동일 /
  부모 통과 후 WAL 생성 race / topology 부재+활성 WAL에서 manual bootstrap·init 무쓰기 / WAL 해소 후
  자동 ensure 재개.
  **구현 계약(9차 보완)**: ①barrier 검사는 preflight만이 아니라 mapLock 안 '실제 쓰기 직전'에 재수행
  (P2 WAL 생성도 mapLock 아래이므로 이 배치가 check-to-write 창을 닫는다) ②WAL 디렉터리 판독 실패는
  '활성 WAL 없음'이 아니다 — ENOENT만 없음, 권한·손상=fail-closed 정지 ③자식 race의 prev 복원·absent
  삭제는 기존 writeRs와 동수준(funlock 취득+runId CAS) ④끝단 테스트에 수동 migrate·render barrier,
  unreadable WAL 서랍 fail-closed, '자기 decisionId만 우회·타 WAL은 차단' 반례 추가.

## C. 스키마

### C-1. MapPatchV2 (discriminated union)
공통 envelope:
```
{ schema: "map-patch-v2", patchId(UUID), mapId(UUID),
  basis: PatchBasis, baseMapHash(40hex),
  baseAuthorityHash, baseDecisionContextHash,   ← CAS '재검사 진입 신호'(2차 #9 — 네임스페이스 키가 아님.
                                                   불일치=즉시 폐기가 아니라 read-set 재검사 진입, §3:389)
  baseDirtyFp(감사 메타 — 판정 불참, 1-1),
  operation(21종 리터럴), <대상 필드 union>, payload(op별 PAYLOAD_KEYS_V2 화이트리스트),
  readSet: ReadSet(§D — 필수 범주 누락=스키마 실패),
  evidence: EvidenceRef[](topology op — code/test/config ≥1) | authorizationRefs: AuthzRef[](정책 op 전용 —
    user-choice|intent-decision|policy-ref. EVIDENCE_KINDS와 별도 배열·상호 혼입 스키마 거부),
  rationale, detectedBy?, provider? }
```
- `PatchBasis`: `{kind:"git", ref: {type:"branch", name} | {type:"detached", head}, baseHead,
  oidFormat:"sha1"|"sha256"}` | `{kind:"historyless", basisFp, inventoryFp}`.
- `ExecutionOrigin`: `{kind:"git", worktreeReal, gitCommonReal}` | `{kind:"historyless", rootReal}` —
  **pending 파일과 WAL의 최상위 로컬 필드 `localOrigin`으로 결속(2차 #5 — 정본 1-1:23 'patch·pending·WAL'),
  저장소 decision 사본에서만 제외**(이식 가능성). cross-worktree WAL 복구는 localOrigin 불일치로 hard reject.
- 대상 필드 union: add_node/add_edge/create_intent_policy=대상 필드 금지 / set_state·add_anchor·add_evidence·
  add_condition·change_relation·tombstone_candidate·widen·narrow·supersede·change_steward·change_authority·
  rewrite_label=`targetId`(UUID 1) / split_node·split_edge=`targetId`(원본)+payload 신규 UUID 목록 /
  merge_node·merge_edge=`targetIds`(2+)+payload.survivorId / supersede_intent_policy=`targetPolicyIds`(1+) /
  revoke_intent_policy=`targetPolicyId`.

### C-2. 순수 적용기 applyOperationV2 (2차 #1·#11·#12 반영)
- `applyOperationV2(topo, patch, ctx) → { topo: 새 객체, changedIds[] }` — 입력 불변, 출력은 validateTopology
  전체 통과 필수(적용기 밖 재검증).
- **revision 규칙(2차 #1·3차 #1 정정)**: topology를 변경하는 적용 성공마다 루트 `Topology.revision`을 정확히
  1 증가(표시·감사용). **read-set의 T는 entity canonical 내용 지문만으로 판정한다** — 루트 revision을 T에
  넣으면 무관 patch 하나가 전체 pending의 T를 깨는 전역 기아가 재발(1-1의 목적 위반). 루트 revision은
  '빠른 변경 신호'(재검사 트리거 최적화)로만 쓰고 CAS 판정에 불참. entityRevision 필드 신설 금지(스키마·
  마이그레이터 불변).
- **정책 op는 topology 무변경(3차 #2)**: create/supersede/revoke_intent_policy는 topology·MAP.md·루트
  revision·mapHash를 일절 건드리지 않는다(정책은 authorityHash 밖 — §3). 정책 전용 트랜잭션은
  §F-2(스냅샷·topology·MAP.md 단계 생략)를 탄다.
- **entity 제거 규칙(2차 #12)**: supersede·(파생) tombstone은 entity를 제거하지 않는다 — lifecycle 상태
  (superseded/tombstoned)로 남는다(v1 LIFECYCLES 그대로). **merge의 흡수 entity만 topology에서 제거**되고
  분할표(absorbed[])를 decision이 보유(inverse=split 재료).
- **tombstone_candidate는 proposal-only op(2차 #11 — 정본 §3:441)**: apply 대상이 아니다. classify까지만
  진행하고(3층 사다리 1-27③), 결론이 하나면 **파생 set_state(lifecycle) patch를 새로 생성**해 그것이 apply
  경로를 탄다. 후보 자체는 decisions/에 기록되지 않는다(구조 무변경 op가 authorityHash를 바꾸는 반례 차단).
  proposal lifecycle 종결: resolved(파생 patch 생성됨)|resolved-noop|expired.
- **inverse 합타입(2차 #12·3차 잔여 확정)**: op별 `inverse: {kind:"patch", 재적용 가능한 MapPatchV2 페이로드}
  | {kind:"recovery", ref+note}`. patch=set_state/change_relation/change_steward/change_authority/
  rewrite_label/widen↔narrow/split↔merge/**create_intent_policy(inverse=revoke — 정본 §3 표)**.
  recovery=add_node/add_edge(remove op 부재 — ref=snapshotRef)/**supersede_intent_policy·
  revoke_intent_policy(정본: 복원 불가·부활은 새 create로만 — ref=감사용 이전 frontier 스냅샷, 스냅샷
  파일이 아니라 WAL 내 frontier 기록)**. 정책 op의 recovery ref는 topology 스냅샷을 가리키지 않는다
  (topology 무변경 — F-2).
- op별 의미(§3 표 준수): split_node edgeReroute[]=기존 전 edge 전수 매핑(누락=②b 실패), merge_node
  absorbed[]=anchors/evidence/edges 재지향 완전성, widen/narrow=anchors/conditions 추가/제거 목록+expect,
  rewrite_label=node label/description·edge notes만.

### C-3. MapDecisionV2 — 저장소 `project-map/decisions/<decisionId>.json` (**applied만**)
```
{ schema: "map-decision-v2", decisionId, mapId, patchId, opHash,
  patch: 정규화 MapPatchV2 사본(localOrigin 없음 — 이식 가능),
  actor: {kind:"auto"} | {kind:"verifier", resultFp} | {kind:"user-choice", cardId?}
       | {kind:"user-choice-delegated", policyId},
  classification: "auto"|"verifier-resolved"|"intent-choice",
  resolution: {outcome:"applied", 해소 증거 참조(verifier resultFp | 선택 레코드 id | auto)},  ← 2차 #13
  preCutover?: true,
  verification: VerificationBasis, evidenceFps: [{ref, contentHash}], verdict?: VerifierResultRef,
  audit: { ts, topologyBeforeHash, topologyAfterHash, mapMdAfterHash, authorityHashAfter,
           expectedMapHashAfter, walRef } }   ← 색인 제외(순환 차단)
```
- rejected/expired/unresolved/parked는 decisions/에 없다 — 로컬 proposal lifecycle(1-21 ③)만이 기록처.
- **AuthorityDecisionProjection(색인 입력 — 2차 #13 반영)**: `{decisionId, mapId, patchId, opHash, operation,
  targetIds[], verification, evidenceFps, classification, resolutionOutcome, verdictFp?}` — audit 블록 제외.
- **유효 applied decision(fail-closed — 3차 #14 강화)**: ①파일명=decisionId 일치 ②schema 유효 ③레코드
  mapId=대상 mapId AND patch.mapId 일치 ④opHash를 patch 사본에서 재계산해 일치 ⑤**정책 op 제외**(색인
  불참·파일은 존재) ⑥(미래 reset 세대 이후분 제외 — P2는 자리만). **mapId 판별이 불가능한 손상 파일은
  조용히 skip하지 않고 decisionIndexFor 결과를 st:"error"로 만든다**(confirmed 폴백 금지 계약과 연동).

### C-4. prepared WAL — 로컬 `wal/<decisionId>.json` (자기완결 — 2차 #2·#5, 4차 #2·#3·#5 반영)
**합타입(4차 #3)**: `transactionKind: "topology" | "policy"` —
topology WAL=snapshotRef **필수**·expectedTopologyAfterHash/expectedMapMdAfterHash 필수 /
policy WAL=snapshotRef **금지**·topology/MAP.md **불변 조건 기록**(topologyHashInvariant=현재 mapHash,
mapMdHashInvariant=현재 MAP.md 지문 — 복구 검증기가 '변하지 않았어야 함'을 대조).
**baseline 지문(4차 #4 재료)**: `baselineDecisionIndexHash`(prepare 시점의 '기존' 유효 색인 지문 —
이번 decision 불포함. D 부재 상태에서 타 decision 병합을 감지하는 기준)+정책 동반/전용 시
`baselinePolicyFrontierHash`.
**수명(4차 #5)**: 활성=wal/ 아래. 트랜잭션 완결(marker 후) 시 **wal/ → wal-complete/ 원자 이동**이 마지막
단계 — 복구·gc는 wal/(활성)만 소비하고, wal-complete/는 보존 상한 gc. complete 이동 전 사망=§G 0행이
이동을 보충.
**선계산 계약(2차 #2)**: WAL 기록 '전'에 잠금 안 메모리에서 전부 확정한다 —
출력 topology(applyOperationV2) → prospective ADP 색인(기존 유효 decision+이번 projection) → expected
decisionIndexHash/authorityHash → MAP.md 문자열·지문 → **완전한 decision 레코드(audit.ts 포함 고정)** →
decision 파일 canonical 지문. **WAL 스키마는 discriminated union 2변형(5차 #5 — 설명·구조 불일치 제거)**:
```
공통 필드:
{ schema:"map-wal-v2", transactionKind, localOrigin: ExecutionOrigin,
  patch 사본+patchId+opHash, basis, readSet, inverse(합타입),
  decision: 완전한 C-3 레코드 사본(보충=이 사본 그대로 기록 — 재구성 없음),
  expectedDecisionFileAfterHash, baselineDecisionIndexHash(이번 불포함 기존 색인),
  expectedDecisionIndexHashAfter, expectedAuthorityHashAfter,
  expectedMarker: {decisionId, decisionFileAfterHash, policyArtifact 지문 결속} }

transactionKind:"topology" 추가 필드:
{ topologyBeforeHash, mapMdBeforeHash(검증된 before 지문 — 5차 #4),
  snapshotRef: {path, contentHash}(필수),
  expectedTopologyAfterHash, expectedMapMdAfterHash,
  (정책 동반 시) policyArtifact(아래 합타입), baselinePolicyFrontierHash,
  expectedPolicyFrontierHashAfter, expectedDecisionContextHashAfter }

transactionKind:"policy" 추가 필드(snapshotRef 금지):
{ topologyHashInvariant(현재 mapHash — 불변 조건), mapMdHashInvariant(현재 MAP.md 지문 — 불변 조건),
  policyArtifact(필수 — 합타입), baselinePolicyFrontierHash,
  expectedPolicyFrontierHashAfter, expectedDecisionContextHashAfter }

policyArtifact 합타입:
  {kind:"intent-policy", policyId, 정규화 사본, expectedFileHash, supersedesPolicyIds}
| {kind:"policy-revocation", revocationId, targetPolicyId, 정규화 사본, expectedFileHash}
```

### C-5. guard marker — 로컬 `markers/<decisionId>.json`
- `{decisionId, decisionFileAfterHash, policyArtifact: null | {kind, id, fileAfterHash}}`(1-32 합타입).
- 수명: 생성=apply ⑨. 정리=`pipeline-gc` — git: 해당 파일이 HEAD에 존재+내용 일치 시 제거 / 비-git: 개수
  상한(env>설정>기본 클램프) 초과분 오래된 것부터. **gc 제외: 활성 WAL이 참조하는 marker·스냅샷+claimed pending이 참조하는 wal-complete 항목과 그 marker(§B ⓑ·ⓑ′의 종결 재료 — 7차 반영).**
- verify-guard 소비(§6): decision·policy 경로 변경은 markers/ 일치 항목 있으면 이번 생성분 제외,
  불일치·혼합=검증 대상. topology/MAP.md는 1-32(decision의 before/after·MAP.md 지문 정확 일치)로 판정하되
  **적용 조건 분리: decisions/가 존재하는 mapId=1-32 판정 / bootstrap-only(decisions/ 부재)=P1 exclude 유지.**

### C-6. snapshot — 로컬 `snapshots/<decisionId>.json` (2차 #16)
- `{ mapId, decisionId, topologyBeforeHash, basis, appliedCountAtSnapshot(그 시점 유효 applied decision 수),
  topology: 원문 사본 }`.
- **recoverCorruption의 '최신 유효' 결정론 규칙**: 후보=스키마 통과 스냅샷 중 `appliedCountAtSnapshot` 최대
  (동수면 decisionId 사전순 **최대(마지막)** — 3차 #15 확정. mtime·시계 불참). clone·복사에도 결정론.

## D. read-set 표 (1-1 4범주+색인 — 2차 #7·#8·#9·#10 반영)
범주: **T**=대상 entity canonical 내용 지문(루트 revision 불참 — C-2·4차 #1) / **E**=evidence·anchor 파일 내용 지문 /
**A**=인접성 지문 / **N**=음성 조건 / **P**=정책 범주(참조 policyFp[]+frontier 해시+revocation 부재) /
**X**=관련 entity의 ADP 색인 지문(2차 #10 — 정본 §3:392. **정의는 'op가 의미적으로 읽은 entity 전체'(3차
#9): targetIds뿐 아니라 supersede의 successor, add_edge/change_relation의 endpoints, merge의 전 원본** —
그 entity들에 대응하는 유효 decision 부분색인의 지문).
표기: ●필수 ○선택(제안 시 검사) ◐조건부 필수(validator가 현재 상태에서 유도 — 2차 #8: 대상의 decisionLocks
또는 적용 가능한 IntentPolicy가 존재하면 P는 필수로 승격, 생략=스키마 실패. **predicate가 P2 판정기 미지원
형식이면 생략 허용이 아니라 needs-investigation — 3차 #8, 정본 1-35 '미지원 predicate' 명문과 동형**) ✕금지.

| op | T | E | A | N | P | X |
|---|---|---|---|---|---|---|
| add_node | ✕ | ● | ✕ | ●(신규 id 부재+anchors 디렉터리 인벤토리) | ◐ | ✕ |
| add_edge | ●(from·to) | ● | ●(from/to 존재+인접 edge 집합 해시) | ●(동일 (from,to,relation) 부재) | ◐ | ● |
| set_state | ● | ● | ✕ | ✕ | ◐ | ● |
| add_anchor | ● | ●(anchor 파일) | ✕ | ○(중복 부재) | ◐ | ● |
| add_evidence | ● | ●(evidence 파일) | ✕ | ✕ | ◐ | ● |
| add_condition | ● | ● | ✕ | ✕ | ◐ | ● |
| change_relation | ●(edge) | ● | ●(from·to 노드) | ●(새 (from,to,toRelation) 동일 edge 부재 — 3차 #8) | ◐ | ● |
| tombstone_candidate | ● | ●(부재 증거) | ●(인접 edge — 소비자 확인, 2차 #7) | ●(관련 디렉터리 인벤토리) | ◐ | ● |
| split_node | ●(원본) | ● | ●(전 입출력 edge 집합) | ●(신규 UUID 부재) | ◐ | ● |
| split_edge | ●(원본) | ● | ●(endpoints) | ●(신규 UUID 부재) | ◐ | ● |
| merge_node | ●(전부) | ● | ●(전 입출력 edge·steward·decisionLocks 해시) | ✕ | ◐ | ● |
| merge_edge | ●(전부) | ● | ●(endpoint 노드 존재+각 endpoint의 parallel edge 집합 해시 — T가 내용을 이미 결속하므로 A는 인접성만, 3차 #8) | ✕ | ◐ | ● |
| widen | ● | ● | ○ | ●(관련 디렉터리 인벤토리 — '없었음') | ◐ | ● |
| narrow | ● | ● | ○ | ●(제거 대상 미이관) | ◐ | ● |
| supersede | ●(구 entity) | ● | ●(successor 내용 지문+구 entity 인접 집합) | ●(구↔후속 supersede 관계 부재 — 3차 #8) | ◐ | ●(구+successor — 3차 #9) |
| change_steward | ● | ● | ✕ | ✕ | ◐ | ● |
| change_authority | ●(node 한정) | ● | ○(gate 연결) | ✕ | ◐ | ● |
| rewrite_label | ● | ● | ✕ | ✕ | ◐ | ● |
| create_intent_policy | ✕ | ✕ | ✕ | ●(신규 policyId 부재) | ●(frontier) | ✕ |
| supersede_intent_policy | ✕ | ✕ | ✕ | ✕ | ●(대상 전부 policyFp+frontier+각 revocation 부재) | ✕ |
| revoke_intent_policy | ✕ | ✕ | ✕ | ✕ | ●(대상 policyFp+revocation 부재+frontier) | ✕ |

**CAS 판정(1-1 — 2차 #9·3차 #7 확정)**:
- hard reject: ①ExecutionOrigin 불일치(worktree/root 이동 — cross-worktree 적용 금지) ②git: branch 이름
  변경·detached head 이탈 ③git: 같은 브랜치라도 현재 HEAD가 baseHead의 **후손이 아님**(reset·rebase —
  `merge-base --is-ancestor` 판정. 전진(ancestor)만 재기반 대상) ④historyless: **rootReal 변경만**(basisFp/
  inventoryFp 변경은 같은 root의 상태 전진 — 재검사 신호).
- 재검사 진입 신호(하나라도 불일치 → read-set 재검사): 같은 브랜치 baseHead 전진 / historyless basisFp·
  inventoryFp 변경 / baseMapHash(topology 변경) / baseAuthorityHash(decision만 병합) /
  baseDecisionContextHash(정책만 변경).
- 재검사 결과 확정(3차 #7 — '±' 제거): read-set 보존=재기반(base 3해시·basis 갱신 후 진행) /
  **read-set 파손=stale-expired**(1-10 ① — 자동 정리. needs-investigation은 ②b 단계 실패의 진입점이지
  read-set 파손의 경로가 아니다).
- baseDirtyFp=감사 로그만.

## E. 이중 해시·effectiveConfidence (2차 #14·#15 반영)
- 도메인 분리(구분자=NUL(0x00), 문서 표기만 텍스트): `sha1("adp" + NUL + canonical(projection))`,
  decisionIndexHash=`sha1("dih" + NUL + 정렬된 projection 지문 배열)`, authorityHash=`sha1("ah" + NUL +
  mapHash + NUL + dih)`, policyFrontierHash=`sha1("pfh" + NUL + frontier canonical)`(빈 frontier도 결정론 값),
  decisionContextHash=`sha1("dch" + NUL + ah + NUL + pfh)`.
- **판독기 분리(2차 #15 — 혼합 스냅샷 차단)**: `decisionIndexFor(repo, mapId) → {st:"ok", index, dih} |
  {st:"none"} | {st:"error"}`(decisions/만 읽음 — topology 안 읽음). authorityHash는 **호출자가 이미 확보한
  동일 raw topology 스냅샷의 mapHash와 결합**해 계산(`authorityOf(mapHash, dih)`). apply ⑥은 디스크 판독이
  아니라 **prospective projection(이번 decision 포함 메모리 색인)**을 명시 전달.
- effectiveConfidence(정본 수식 그대로 — 2차 #14 정정): **stored confirmed인 entity만** 강등 대상.
  `storedConfidence !== "confirmed" → 그대로(candidate/unknown 불변)` / confirmed → provenance 4검사 통과=
  confirmed, 실패=unknown. **decisionIndex가 error — 또는 none인데 stored confirmed ≥1 — 이면 confirmed
  entity만 전부 unknown+degraded 사유 표기**(candidate/unknown은 어느 경우에도 그대로).
- none+confirmed 0(순수 draft — P0.5·P1 산출물)=종전 렌더와 **바이트 동일**(P1 exclude 지문 무회귀 —
  끝단 테스트로 잠금). MAP.md 머리말의 authorityHash 표기는 decisions/ 존재 시에만 추가.
- P1 finishDone·map-runtime render/status는 이 공용 경로(decisionIndexFor+authorityOf+effective 렌더러)로
  P2에서 이관.

## F. apply 트랜잭션 (withMapLock 안 — 2차 #2·#4, 3차 #2·#3·#4·#12 반영)

### F-1. topology op
선행: §B 클레임(nsLock 선점 — decisionId 발급). 이후 withMapLock 안에서:
**⓪활성 WAL 존재 검사(6차 확정·7차 #3: F-1/F-2 공통 선행 barrier — 정책 apply도 활성 WAL 동안 불가. P2는 수동 전용이라 이 직렬화 마찰은 수용)**: 이 nsKey+mapId에 활성 WAL(wal/)이 하나라도
있으면 이번 apply를 거부하고 recoverWal 선행을 안내한다. 이 계약으로 '중단된 WAL 위에 다른 decision이
정상 병합되는' 로컬 경로가 소멸한다(남는 병합 경로는 git pull뿐 — 그 경우 topology decision은 T를 함께
바꾸므로 t14로, 정책 파일만의 pull은 F/C 변경으로 관측된다). →
①CAS 재검사(§D) → ②semantic validation ②b(1-20 — 실패=needs-investigation 전이·중단·claim 해제) →
**③메모리 선계산 일괄**: 출력 topology(applyOperationV2)→prospective ADP 색인→expected dih/ah→MAP.md
문자열·지문→**(정책 동반 시) prospective policy artifact→expected pfh/dch(3차 #3 — 정책 예상값도 WAL 전
확정)**→완전한 decision 레코드(ts 고정)→decision 파일 지문→marker 기대값 →
④스냅샷 기록(C-6)+검증 → ⑤WAL 기록(C-4 확정값 전부 — transactionKind:"topology") → ⑥topology 원자 교체
→ ⑦MAP.md 기록(선계산 문자열 그대로) → ⑧decision 파일 기록(사본 그대로) → ⑨(정책 동반 시) policy 파일
→ ⑩marker 기록 → **⑪WAL을 wal-complete/로 원자 이동(4차 #5 — 완결 표식)** → 잠금 해제 → §B ③ 종결.
**실패 처리(3차 #4 정정)**: ⑤ 전 실패=durable 산출물은 orphan 스냅샷 하나뿐일 수 있다 — **즉시 삭제
시도, 실패 시 gc가 회수**(WAL 미참조 스냅샷=orphan). claim 해제·pending은 분류 상태로 복귀. **⑤ 후
중단=recoverWal이 동일 decisionId로 처리(§G — 재검사 선행)**. 같은 patch의 재시도는
`pipeline-abort <decisionId>` 선행 필수 — **abort 허용 조건(3차 #12): §G의 9요소 관측이 전부 pre-apply
상태(topology=before·MAP.md≠expected 산출·decision/policy/marker 파일 전부 부재)일 때만.** 하나라도
존재하면 abort 불가·roll-forward 또는 conflict 처리만. abort=wal/ → wal-aborted/ 이동(감사 보존).

### F-2. 정책 전용 op (3차 #2·4차 #2 — topology 무변경, 별도 WAL·복구표)
⓪공통 barrier(§F-1 ⓪과 동일 — 7차 #3) → ①CAS 재검사(**§D 전체 — hard boundary(origin/branch/detached/root) 포함+P·frontier. 5차 #6: 정책 op도
cross-worktree·branch 이탈·baseDecisionContextHash 변경을 검사한다**) → ②정책 semantic validation(op별 —
§3 정책 op 계약) → ③선계산(prospective
artifact→expected pfh/dch→완전한 decision 레코드→decision 파일 지문→marker 기대값 — **topology·MAP.md·
mapHash·루트 revision 불참**) → ④WAL 기록(transactionKind:"policy" — snapshotRef 없음·topology/MAP 불변
조건 기록) → ⑤decision 파일 → ⑥policy 파일(.json | .revoke.json) → ⑦marker → ⑧wal-complete/ 이동 →
종결. 복구는 §G 정책 표(topology before/after를 진행 단계로 쓰지 않음 — 4차 #2).

## G. recover 이원 (2차 #3 반영)
- **recoverWal**(1-19 — 전진만, 4차 #4·#6 재작성): wal/(활성)의 각 항목에 대해.
  **선행 검사(4차 #6 — 이층 분리)**:
  ⓐ **hard boundary(항상 — T 상태 무관)**: localOrigin 불일치 / branch 이름·detached identity 이탈 /
  historyless rootReal 변경 → hard reject(복구 진행 금지·보고).
  ⓑ **내용 재검사(T=before에서만)**: HEAD 전진·basisFp·base 3해시·read-set — 전부 보존=WAL 그대로 진행 /
  기반 변경+read-set 보존=abort 후 새 prepare / read-set 파손=stale-expired. T=after면 ⓑ 생략(전진만).
  **관측 요소**: T=topologyHash, M=mapMdHash, D=decision 파일(부재|=exp|≠exp), I=decisionIndexHash,
  A=authorityHash, Pf=policy artifact 파일, F=policyFrontierHash, C=decisionContextHash, K=marker(부재|=exp|≠exp).
  pol=WAL.policyArtifact 존재. base(I)=WAL.baselineDecisionIndexHash(이번 decision 불포함 기존 색인 —
  D 부재 상태의 병합 감지 기준. 4차 #4).

**표 적용 전 공통 fail-closed 분기(7차 #4)**: decision index 판독 st:error / policy frontier 계산 불능
(정책 파일 손상) / MAP.md unreadable(ENOENT 아님 — t7의 '부재'는 ENOENT만) / decision·policy·marker 파일
unreadable / WAL 자체 스키마·지문 오류 — 전부 **자동 보충 없이** state-invalid|unreadable 진단+conflict/
recovery 안내로 종료(1-32 fail-closed와 동형).

**topology WAL 복구표(위에서 첫 일치 행 — 상호 배타는 순서로 보장)**:

| # | 조건 | 판정 | 동작 |
|---|---|---|---|
| t1 | D≠exp(실존 불일치) | decision 변조/혼합 | conflict |
| t2 | pol && Pf 실존≠exp | policy 변조 | conflict |
| t3 | K 실존 && (K≠exp ‖ D 부재 ‖ M≠exp ‖ (pol && Pf 부재)) | marker 고아/선행 파손 위 marker | conflict |
| t4 | T=before && (D 실존 ‖ Pf 실존 ‖ K 실존) | 불가능/변조(적용 전 산출물) | conflict |
| t5 | T=before | 적용 미개시 | 선행 검사 ⓑ 결과대로: 진행(⑥부터·동일 decisionId) / abort+새 prepare / stale-expired |
| t6 | T=after && I∖이번≠base(I)(현재 유효 색인에서 이번 decisionId 기여분을 뺀 값이 baseline과 다름) | 색인 외부 개입(6차 단순화 — 정상 경로 없음: 활성 WAL 중 신규 apply는 ⓪이 차단하고, topology decision 병합은 T를 바꿔 t14로 감. 남는 것은 수동 파일 조작·부분 pull) | conflict — re-prepare 없음(5차의 re-prepare in place는 6차에서 폐기: MAP baseline·감사 해시 DAG를 여는 비용 대비 정상 발생 경로가 없다) |
| t7 | T=after && D 부재 && M∈{before, 부재} | ⓪ | MAP.md 기록→D→(pol)→K→complete 이동 |
| t7x | T=after && D 부재 && M∉{before, 부재, exp} | 중단 사이 MAP 수동 편집(혼합 — 5차 #4) | conflict(자동 덮어쓰기 금지 — 1-32) |
| t8 | T=after && D 부재 && M=exp | ① | D 보충(WAL 사본)→(pol)→K→complete |
| t9 | T=after && D=exp && M≠exp | MAP 손상/수동 편집(D 이후 혼합 — T=after 고정 하에 MAP을 다시 렌더하는 자동 주체는 없다: 후속 topology decision은 T를 바꾸고 정책은 MAP 불변) | conflict(자동 재렌더 금지 — 1-32) |
| t10 | T=after && D=exp && M=exp && pol && Pf 부재 | 정책 중단 | **현재 F=baseline F 확인(5차 #2)** — 일치=Pf 보충→K→complete / 불일치(외부 정책 유입)=P read-set 재검사: 보존=artifact의 전제가 유효 — Pf 보충 진행(expected F/C는 '기록 시점 참고값'으로 강등 — 아래 완결 판정 참조), 파손=conflict(② 오분류 금지 — 정본 16차) |
| t12 | T=after && D=exp && M=exp && (¬pol ‖ Pf=exp) && K 부재 | ② | K 보충→complete |
| t13 | T=after && D=exp && M=exp && (¬pol ‖ Pf=exp) && K=exp | complete | wal-complete/ 이동 보충(4차 #5) |
| t14 | T∉{before, after} | 기반 이탈(git pull의 topology decision 동반 병합 포함) | conflict — recoverCorruption/수동 정리 안내 |

**완결 판정에서 F/C 제외(6차 확정)**: policyFrontierHash·decisionContextHash는 전역 상태라 이 트랜잭션 완결
후에도 후속 정책 op가 정당하게 바꾼다 — 완결 판정은 **자기 산출물(T·M·D·Pf·K)의 expected 정합만** 본다.
expectedPolicyFrontierHashAfter/expectedDecisionContextHashAfter는 감사 참고값(기록 시점 기대)이며 t10의
baseline F 검사에만 참여한다. I/A는 자기 산출물 파생(이번 decision 포함 색인)이므로 판정 참여 — 단 t6의
'이번 기여분 제외 비교'로 외부 개입만 걸러낸다.

**policy WAL 복구표(4차 #2 — T/M은 '불변 조건'으로만 검사: 변했으면 즉시 conflict)**:

| # | 조건 | 판정 | 동작 |
|---|---|---|---|
| p0 | topologyHashInvariant ‖ mapMdHashInvariant 불일치 | 외부 변경 혼입 | conflict(정책 트랜잭션은 topology/MAP 불변이어야 함) |
| p1 | D≠exp ‖ Pf 실존≠exp | 변조 | conflict |
| p2 | K 실존 && (K≠exp ‖ D 부재 ‖ Pf 부재) | marker 고아 | conflict |
| p3 | D·Pf·K 전부 부재 | 미개시 | P read-set(frontier) 재검사: 보존=⑤부터 진행 / 변경+보존=abort+새 prepare / 파손=stale-expired |
| p4 | D 부재 && Pf 실존 | 순서 위반(D 전 Pf) | conflict(정상 경로에 없음) |
| p5 | D=exp && Pf 부재 | 정책 중단 | **현재 F=baseline F 확인(5차 #2)** — 일치=Pf 보충→K→complete / 불일치(외부 정책 유입)=P read-set 재검사: 보존=Pf 보충 진행(expected F/C는 참고값 강등 — 완결 판정 제외 규칙), 파손=conflict |
| p6 | D=exp && Pf=exp && K 부재 | K 보충 | K→complete(**F/C는 판정 불참 — 6차 확정: 자기 artifact 파일 지문=exp 존재가 유일 판정. frontier leaf 여부는 보지 않는다 — 이 정책이 이후 정상 supersede/revoke돼도 immutable 파일은 남으므로 complete 판정이 흔들리지 않음. 5차 '유효 leaf 존재' 기준 폐기**) |
| p7 | D=exp && Pf=exp && K=exp | complete | wal-complete/ 이동 보충 |

  abort 허용 조건(topology=t5·policy=p3 상태 한정 — 4차 #12 승계): 관측 요소 전부 pre-apply·산출물 부재.
- **recoverCorruption**(1-18): topology 손상(파싱·스키마 실패) 시 ①스냅샷(C-6 결정론 최신) ②git 이력 마지막
  유효본 순으로 **별도 파일**(topology.recovered.json) 복구·원본 보존. 수동 CLI(카드는 P9). 적용된 decision을
  되돌리는 경로가 아님을 출력에 명시.

## H. 분류기 (§4)
- 입력: (증거로 가능한 결론 수[결정론 근사 — 스키마·expect·②b·정책 매칭], 제품 의도 필요, 코드↔문서 충돌,
  가역성, authority 경계). §3 표의 기본 분류는 출발점.
- verifier-resolved는 분류까지만 — 유효 typed 결과 없이 apply 불가(§A). intent-choice도 해소 레코드 없이
  적용 불가. tombstone 3층(1-27③)·merge 3단(1-13) 사다리 규칙표 포함(tombstone_candidate는 proposal-only —
  C-2).

## I. 마이그레이션
- 구 v1 pending: mapId·basis·read-set 사후 재구성 불가 → **일괄 stale-expired**.
- v1 decisions.jsonl: 존재 시 `decisions/legacy/`로 분해 보존(권위 색인 불참·감사 전용 legacy-quarantine).
- v1 API(PATCH_OPS 8·validatePatch·validateDecision·policyTier·opHashOf)는 동결, v2는 전부 신규 이름.

## J. 완료 조건
- PRIVACY/README ko·en 선갱신(map-pipeline/* 로컬 서랍·decisions/·policies/ 저장소 산출물) — 구현 착수 전.
- BRIDGE_SCRIPTS 11파일(map-pipeline.js)+hook-setup.ts/install.js 쌍+패리티 테스트.
- map-runtime↔map-pipeline lazy require 순환 exports 초기화 테스트.
- 끝단 회귀: P0 96·P0.5 155(AST 기준)·P1 149 전부 통과+draft 바이트 동일 렌더+P1 finishDone 이관 후 exclude
  지문 유지+realpath 잠금 교체 후 P1 재잠금.
