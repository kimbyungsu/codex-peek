"use strict";
/*
 * 관측 장부(observed ledger) 순수 로직 — 이벤트 적재 → 약한 상태 전이 → 꾸러미용 선별.
 * 설계 원본: memento(assertionStatus 4단계·재통합) + tg-chat-engine(삭제 금지·disputed 상태 전이·
 * supersedes 링크·learning_events '이벤트 먼저, 정책 나중') — 2026-07-07 사용자·검증 합의 로드맵 ①②③.
 *
 * 원칙:
 *  - 이벤트는 append-only(사실의 기록). 상태는 이벤트에서 '유도'될 뿐 저장하지 않는다 — 규칙을 바꿔도 과거가 다시 해석된다.
 *  - 삭제 없음: 틀린 지식도 disputed로 남아 "이미 틀렸다고 판명된 길"을 알려준다(재실수 방지).
 *  - 전이 규칙은 v1 최약(임계 1회) — learning_events 철학대로 데이터를 본 뒤 임계를 조정한다(아래 상수에 근거 주석).
 * vscode/fs 의존 없음 — 파일 I/O는 bridge/contract-lib.js(appendLedgerEvent)와 확장/드라이버가 담당.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PKG_LEDGER_CAPS = exports.HEALTH_MIN_SAMPLE = exports.DERIVE_V2 = void 0;
exports.evWeight = evWeight;
exports.autoConfirmEligible = autoConfirmEligible;
exports.parseEventsJsonl = parseEventsJsonl;
exports.promotableConfirm = promotableConfirm;
exports.promotableDispute = promotableDispute;
exports.deriveLedger = deriveLedger;
exports.endpointsKeyOf = endpointsKeyOf;
exports.computeAliasCandidates = computeAliasCandidates;
exports.computeScoutHealth = computeScoutHealth;
exports.extractPathsFromText = extractPathsFromText;
exports.selectForPackage = selectForPackage;
// 가중 해석 — 압축본(n>1)과 일반 이벤트(1)를 한 규칙으로.
function evWeight(e) { return Number.isFinite(e.n) && e.n > 0 ? Math.floor(e.n) : 1; }
// 자동 확인 가능성 — 실제 확인기(flagLedgerConfirms)의 증거 키와 '동형'이어야 한다(Codex 설계검증:
// 경로 토큰 ≥2 같은 다른 규칙을 쓰면 분모가 확인기와 어긋남). 확인기 규칙 = 고유 basename(8자 이상) 2개.
function autoConfirmEligible(text) {
    const bns = new Set(extractPathsFromText(text).map((p) => p.split("/").pop() || "").filter((b) => b.length >= 8));
    return bns.size >= 2;
}
// JSONL 원문 → 이벤트 배열(깨진 줄·미지 type은 건너뜀 — 진단용 dropped 카운트 동봉).
// type 허용값 검증 이유: 임의 type이 counts에 들어가면 전이 집계를 조용히 오염시킨다(Codex 반례).
const EVENT_TYPES = new Set(["proposed", "attached", "confirmed", "refuted", "user_confirm", "user_dispute", "pinned", "unpinned", "banned", "unbanned", "superseded", "tombstone", "exported", "alias", "unalias"]);
function parseEventsJsonl(raw) {
    const events = [];
    let dropped = 0;
    for (const ln of String(raw || "").split(/\r?\n/)) {
        if (!ln.trim())
            continue;
        try {
            const o = JSON.parse(ln);
            if (o && typeof o.sig === "string" && o.sig && typeof o.type === "string" && EVENT_TYPES.has(o.type)
                && !((o.type === "alias" || o.type === "unalias") && !(typeof o.aliasSig === "string" && o.aliasSig && o.aliasSig !== o.sig)))
                events.push(o);
            else
                dropped++;
        }
        catch {
            dropped++;
        }
    }
    return { events, dropped };
}
// 전이 임계 — '이벤트 먼저, 정책 나중'(tg learning_events). L1 v2(2026-07-10 설계검증 반영):
// 확인 1건=승격(v1)은 '공동 인용≠결합 확인' 결함이라 폐기. 승격은 증거의 질로:
//  - user_confirm ≥1 → verified(사람 확인은 즉시 — 사람 결정 보존)
//  - claimed(명시 표기+cited+seen=ok)는 정확한 결합을 골라 확인한 강한 증거라 서로 다른 askId ≥1 → verified
//  - co-cited(비-echoed·seen=ok)는 우연 공동 인용 가능성이 있어 서로 다른 askId ≥2 → verified
//  - legacy(grade 없는 구형) ≥2 → verified(노출 여부 미상이라 안전한 증거로 단정하지 않되,
//    서로 다른 시각의 반복은 인정 — 기존 다회 확인 항목의 강등 최소화)
//  - co-cited·echoed / seen=unknown → 기록만(노출 관측 — 승격 재료 아님)
// 복권(rehab): 마지막 반박 '이후'의 확인만 — 사람 1회 즉시, 기계도 위 등급별 기준을 그대로 적용.
// machineAskIds는 외부 소비자 호환 별칭이며 coCitedAskIds와 같다.
exports.DERIVE_V2 = { disputeToDemote: 1, claimedAskIds: 1, coCitedAskIds: 2, machineAskIds: 2, legacyRepeats: 2, rehabUserConfirm: 1 };
// 이벤트 → 항목별 현재 상태(약한 전이). 우선순위(문서화된 결정, 위에서 아래로 먼저 매치):
//   banned > superseded > tombstone > disputed > verified > inferred. pinned은 상태가 아니라 차선 오버라이드.
// disputed가 verified보다 위인 이유: tg 정책 — 반박된 지식을 권위 차선에 두지 않는다(사람이 pin하면 예외).
// alias(L1-B): 사람 승인 병합만 — alias(sig=P, aliasSig=S) 순계(alias−unalias>0)면 S의 이벤트가 P 항목으로
// 합산된다(자동 canonical 병합 없음 — 다른 주장의 진릿값이 섞이는 결함[Codex]. 후보 제시는 computeAliasCandidates).
// 승격 가능한 기계 확인인가 — claimed는 '실제 인용 동반'(cited)일 때만(자기보고 단독 배제),
// co-cited는 비-echoed만. 둘 다 seen=unknown(취급 흔적 검사 불가)이면 기록만.
function promotableConfirm(e) {
    if (e.type !== "confirmed")
        return false;
    if (e.grade !== "claimed" && e.grade !== "co-cited")
        return false; // legacy는 별도 규칙(서로 다른 ts 2회)
    if (e.seen !== "ok" || !e.askId)
        return false; // 명시 요구 — 필드 누락 통과 금지(HANDOFF 4중 조건 정합 — Codex 2차 #7)
    if (e.grade === "claimed")
        return e.cited === true;
    return !e.echoed;
}
// 반박이 강등 재료인가 — 사람 기록(user_dispute)과 구형(grade 없음)은 그대로, 표식 반박(claimed)은
// 확인과 같은 명시 조건(cited && seen==="ok" && askId) — 자기보고의 '부정' 효과가 긍정보다 세므로
// 더 약한 조건을 줄 이유가 없다(부정문·예시 오인식·근거 없는 한 줄의 즉시 강등 차단 — Codex 2차 #7).
function promotableDispute(e) {
    if (e.type === "user_dispute")
        return true;
    if (e.type !== "refuted")
        return false;
    if (!e.grade)
        return true; // 구형/수동 경로
    return e.cited === true && e.seen === "ok" && !!e.askId;
}
function machineConfirmSatisfied(evs) {
    const claimed = new Set();
    const coCited = new Set();
    for (const e of evs) {
        if (!promotableConfirm(e))
            continue;
        const id = e.askId || e.ts || "";
        if (!id)
            continue;
        (e.grade === "claimed" ? claimed : coCited).add(id);
    }
    return claimed.size >= exports.DERIVE_V2.claimedAskIds || coCited.size >= exports.DERIVE_V2.coCitedAskIds;
}
function deriveLedger(events) {
    // 1패스: alias 순계(사람 승인 병합) — S→P. 체인은 따라가되 자기 자신/순환은 중단(사람 입력 방어).
    const aliasNet = new Map(); // S → (P → net)
    for (const e of events) {
        if ((e.type === "alias" || e.type === "unalias") && e.aliasSig) {
            let per = aliasNet.get(e.aliasSig);
            if (!per) {
                per = new Map();
                aliasNet.set(e.aliasSig, per);
            }
            per.set(e.sig, (per.get(e.sig) || 0) + (e.type === "alias" ? evWeight(e) : -evWeight(e))); // 가중 — 압축본(n)이 순계 크기 보존
        }
    }
    const parent = new Map(); // S → P (순계 양수인 마지막 우세 P — 복수면 net 큰 쪽·동률은 사전순)
    for (const [s, per] of aliasNet) {
        const best = [...per.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
        if (best)
            parent.set(s, best[0]);
    }
    // 방문 집합으로 순환·초장 체인을 명시 처리(고정 홉 상한은 11홉 체인을 조용히 두 항목으로 쪼갬 — Codex 실측):
    // 체인은 길이 무관하게 끝까지, 순환은 '순환 고리 안의 사전순 최소 sig'를 결정적 루트로(양쪽이 같은 루트 → 병합 유지).
    const rootOf = (sig) => {
        let cur = sig;
        const visited = new Set([cur]);
        for (;;) {
            const p = parent.get(cur);
            if (!p || p === cur)
                return cur;
            if (visited.has(p)) { // 순환 — 고리 구성원 중 최소 sig(결정적·병합 보존)
                let m = p, c2 = parent.get(p);
                while (c2 !== p) {
                    if (c2 < m)
                        m = c2;
                    c2 = parent.get(c2);
                }
                return m;
            }
            visited.add(p);
            cur = p;
        }
    };
    // 2패스: 루트 키로 집계
    const m = new Map();
    const perEvents = new Map(); // 루트별 confirmed 이벤트(등급 판정 재료)
    const afterDispute = new Map(); // 마지막 반박 이후의 confirmed(복권 재료)
    const afterDisputeUser = new Map();
    const disputeCount = new Map(); // 강등 재료가 되는 반박 수(promotableDispute만)
    const banW = new Map(); // 가중 순계(압축본 n 반영 — evWeight)
    const pinW = new Map();
    const textFromRoot = new Set(); // 대표 문구는 루트 자신의 첫 문구 우선(별칭 문구는 빈자리 채움만)
    for (const e of events) {
        if (e.type === "alias" || e.type === "unalias")
            continue; // 병합 지시 자체는 항목 이벤트가 아님
        const key = rootOf(e.sig);
        let it = m.get(key);
        if (!it) {
            it = { sig: key, text: "", firstTs: e.ts || "", lastTs: e.ts || "", counts: {}, status: "inferred", pinned: false, lane: "reference", from: "", autoEligible: false };
            m.set(key, it);
        }
        if (key !== e.sig) {
            if (!it.aliases)
                it.aliases = [];
            if (!it.aliases.includes(e.sig))
                it.aliases.push(e.sig);
        }
        it.counts[e.type] = (it.counts[e.type] || 0) + 1;
        if (e.type === "banned")
            banW.set(key, (banW.get(key) || 0) + evWeight(e));
        else if (e.type === "unbanned")
            banW.set(key, (banW.get(key) || 0) - evWeight(e));
        else if (e.type === "pinned")
            pinW.set(key, (pinW.get(key) || 0) + evWeight(e));
        else if (e.type === "unpinned")
            pinW.set(key, (pinW.get(key) || 0) - evWeight(e));
        // attached(꾸러미 재동봉)는 최신성 갱신에서 제외 — 선별(lastTs 최신순)이 자기 선별을 다시 최신으로 만들어
        // 같은 소수 항목이 상한을 영구 점유하던 자기고정(논리 점검 #7, 2026-07-10). 판정·제안·개입 이벤트만 최신성 기여.
        if (e.ts && e.type !== "attached")
            it.lastTs = e.ts;
        // 원문은 '루트 sig 자신의 첫 문구' 우선(별칭 문구가 대표 문구를 가로채지 않게) — 루트 문구가 없을 때만 별칭 문구로 채움.
        if (e.text) {
            if (e.sig === key && !textFromRoot.has(key)) {
                it.text = e.text;
                textFromRoot.add(key);
            }
            else if (!it.text)
                it.text = e.text;
        }
        if (e.from && !it.from)
            it.from = e.from;
        if (e.type === "superseded" && e.newSig)
            it.supersededBy = e.newSig;
        if (e.type === "confirmed") {
            let a = perEvents.get(key);
            if (!a) {
                a = [];
                perEvents.set(key, a);
            }
            a.push(e);
        }
        // 복권 카운터: '강등 재료가 되는' 반박(promotableDispute — 근거 없는 표식 반박 제외)이 오면 리셋.
        if (promotableDispute(e)) {
            afterDispute.set(key, []);
            afterDisputeUser.set(key, 0);
            disputeCount.set(key, (disputeCount.get(key) || 0) + 1);
        }
        else if (e.type === "confirmed" && afterDispute.has(key))
            afterDispute.get(key).push(e);
        else if (e.type === "user_confirm" && afterDisputeUser.has(key))
            afterDisputeUser.set(key, (afterDisputeUser.get(key) || 0) + 1);
    }
    for (const it of m.values()) {
        const c = it.counts;
        it.autoEligible = autoConfirmEligible(it.text);
        const pinNet = pinW.get(it.sig) || 0; // 가중 순계(압축본 n 반영) — 개수 계산은 +2 압축 뒤 역이벤트에 뒤집힘(Codex 반례)
        const banNet = banW.get(it.sig) || 0;
        it.pinned = pinNet > 0;
        const disputes = disputeCount.get(it.sig) || 0; // 근거 없는 표식 반박은 기록만(강등 재료 아님) — counts.refuted와 다를 수 있음
        const confs = perEvents.get(it.sig) || [];
        const legacyRepeats = new Set(confs.filter((e) => !e.grade).map((e) => e.ts || "")).size;
        const machineOk = machineConfirmSatisfied(confs) || legacyRepeats >= exports.DERIVE_V2.legacyRepeats;
        it.machineEvidence = confs.some((x) => promotableConfirm(x) || !x.grade);
        const userOk = (c.user_confirm || 0) >= 1;
        if (banNet > 0)
            it.status = "banned";
        else if (c.superseded)
            it.status = "superseded";
        else if (c.tombstone)
            it.status = "tombstone";
        else if (disputes >= exports.DERIVE_V2.disputeToDemote) {
            // 복권 판정 — 반박 '이후'의 확인만(사람 1회, 강한 claimed 1회 또는 약한 co-cited 2회). 차단·대체·소멸은 복권 대상 아님(선매치).
            const after = afterDispute.get(it.sig) || [];
            const afterLegacy = new Set(after.filter((e) => !e.grade).map((e) => e.ts || "")).size;
            if ((afterDisputeUser.get(it.sig) || 0) >= exports.DERIVE_V2.rehabUserConfirm
                || machineConfirmSatisfied(after) || afterLegacy >= exports.DERIVE_V2.legacyRepeats) {
                it.status = "verified";
                it.rehabilitated = true;
            }
            else
                it.status = "disputed";
        }
        else if (userOk || machineOk)
            it.status = "verified";
        else
            it.status = "inferred";
        // v1 규칙이면 verified였을 항목의 v2 강등 — 조용히 낮추지 않는다(고지 재료. 재해석은 의도된 동작: 상태는 유도).
        // '구형(grade 없음) 확인'이 있는 항목만 — 신규 등급 이벤트의 정상 미승격(예: co-cited 1회)은 강등이 아니라 v2의 기본 동작.
        if (it.status === "inferred" && confs.some((x) => !x.grade))
            it.reinterpreted = true;
        // 차선: 사람 고정 > 차단 > 상태. disputed는 excluded(단 '틀림 판명' 각주로는 노출 가능 — 선별기에서 결정).
        if (it.status === "banned")
            it.lane = "excluded";
        else if (it.pinned)
            it.lane = "trusted";
        else if (it.status === "verified")
            it.lane = "trusted";
        else if (it.status === "inferred")
            it.lane = "reference";
        else
            it.lane = "excluded";
    }
    return [...m.values()].sort((a, b) => (b.lastTs || "").localeCompare(a.lastTs || ""));
}
// 별칭 후보(자동 '제시'만 — 병합은 사람 승인 alias 이벤트 뒤에만): 같은 endpoint 집합(정렬 경로)+같은 방향 표기의
// 서로 다른 항목들. 방향: 텍스트에 →가 있고 ↔가 없으면 d(등장 순서 보존), 아니면 b(정렬). 경로<2는 후보 아님.
function endpointsKeyOf(text) {
    const paths = [...new Set(extractPathsFromText(text))];
    if (paths.length < 2)
        return null;
    const t = String(text || "");
    const directed = t.includes("→") && !t.includes("↔");
    return (directed ? "d|" + paths.join("|") : "b|" + paths.slice().sort().join("|"));
}
function computeAliasCandidates(entries) {
    const groups = new Map();
    for (const e of entries) {
        if (e.status === "banned" || e.status === "superseded" || e.status === "tombstone")
            continue;
        const k = endpointsKeyOf(e.text);
        if (!k)
            continue;
        let g = groups.get(k);
        if (!g) {
            g = [];
            groups.set(k, g);
        }
        g.push(e);
    }
    const out = [];
    for (const [key, g] of groups)
        if (g.length >= 2)
            out.push({ key, sigs: g.map((e) => e.sig), texts: g.map((e) => e.text) });
    return out.sort((a, b) => a.key.localeCompare(b.key));
}
exports.HEALTH_MIN_SAMPLE = 5; // 표본 게이트 — 미만이면 비율 표시 금지(범위 장부 sparse 철학·과신 방지). 지표별 분모에도 적용.
function computeScoutHealth(entries) {
    const h = { entries: entries.length, verified: 0, reusedDen: 0, reusedNum: 0, autoDen: 0, autoNum: 0, disputedEntries: 0, rehabilitated: 0, reinterpreted: 0 };
    for (const e of entries) {
        if (e.status === "verified")
            h.verified++;
        if ((e.counts.attached || 0) > 0) {
            h.reusedDen++;
            if ((e.counts.confirmed || 0) + (e.counts.user_confirm || 0) > 0)
                h.reusedNum++;
            if (e.autoEligible) {
                h.autoDen++;
                if (e.machineEvidence)
                    h.autoNum++; // '승격 가능 종류'만 — 기록만인 이벤트(echoed·unknown·무인용 표식)는 과대 표시 금지(Codex #7)
            }
        }
        if ((e.counts.user_dispute || 0) + (e.counts.refuted || 0) > 0)
            h.disputedEntries++;
        if (e.rehabilitated)
            h.rehabilitated++;
        if (e.reinterpreted)
            h.reinterpreted++;
    }
    return h;
}
// 항목 텍스트에서 경로꼴 토큰 추출(씨앗 교집합 판정용) — extractMapHighlights와 같은 보수 규칙의 축약판.
function extractPathsFromText(text) {
    const out = [];
    for (const tok of String(text || "").replace(/`/g, "").split(/[\s,;|"'<>{}()[\]—·↔]+/)) {
        const noLine = tok.replace(/:(\d+)(?:-\d+)?$/, ""); // 경로:라인 꼬리 제거(저장소 상대경로 계약) — contract-lib ledgerPathsFromText와 동형(논리 점검 #6)
        const t = noLine.replace(/^[^A-Za-z0-9_.\\/-]+|[^A-Za-z0-9_.\\/-]+$/g, "").replace(/[.,;:]+$/, "");
        if (!t || t.length > 200 || !/^[A-Za-z0-9_.\\/-]+$/.test(t))
            continue;
        const hasSep = /[\\/]/.test(t);
        if (!hasSep && !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(t))
            continue;
        if (hasSep && !/[A-Za-z]/.test(t.split(/[\\/]/).pop() || ""))
            continue;
        out.push(t.replace(/\\/g, "/").toLowerCase());
    }
    return out;
}
// 꾸러미 동봉용 선별 — 신뢰(씨앗 교집합 우선→최근순 채움)·미검증 참고·틀림 판명(재실수 방지 각주). 상한은 주입 비용 통제.
exports.PKG_LEDGER_CAPS = { trusted: 8, reference: 5, disputed: 3 };
function selectForPackage(entries, seeds) {
    const seedSet = new Set((seeds || []).map((s) => String(s).replace(/\\/g, "/").toLowerCase()));
    const touches = (e) => extractPathsFromText(e.text).some((p) => seedSet.has(p));
    const pick = (pool, cap) => {
        const hit = pool.filter(touches);
        const rest = pool.filter((e) => !hit.includes(e));
        return hit.concat(rest).slice(0, cap);
    };
    return {
        trusted: pick(entries.filter((e) => e.lane === "trusted"), exports.PKG_LEDGER_CAPS.trusted),
        reference: pick(entries.filter((e) => e.lane === "reference"), exports.PKG_LEDGER_CAPS.reference),
        disputed: pick(entries.filter((e) => e.status === "disputed" && !e.pinned), exports.PKG_LEDGER_CAPS.disputed),
    };
}
//# sourceMappingURL=ledger-events.js.map