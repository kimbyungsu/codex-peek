"use strict";
/*
 * P4-2 freshness 재료 저장소(mfresh-1) — 설계 동결 v8(docs/MAP-V2-DESIGN.md 'P4 상세 설계').
 *
 * BRIDGE_DIR/map-freshness/<wsKey>.json  { schema:"mfresh-1", mapId, entries:{ key: entry }, auditSeq }
 *   auditSeq=잠금 안 단조 논리 순번 counter(11차) — a: entry 기록마다 저장소가 entry.seq로 스탬프.
 * key 합타입(역할 분리 — 5차 [보완]):
 *   "a:<nodeUUID>|<anchorRelPath>"  = 검증 전이(P2 apply·v3 WAL 복구)에서만 생성되는 로컬 '기준선'
 *                                     (anchor축 fresh 판정의 권위 재료 — basisDecisionId 필수)
 *   "e:<entityUUID>|<evidenceRelPath>" = 비권위 캐시(fresh 증명 사용 금지 — basisDecisionId 금지)
 * entry: { fp(sha1 40hex), seenAt(ISO — 순수 기록 시각), size?, mtimeMs?, basisDecisionId?(a:만), seq?(a:만 —
 *   저장소가 스탬프하는 감사 LRU 순번·시계 비의존) }
 *
 * 계약:
 * - 이 모듈은 파일 내용을 해시하지 않는다(기준선 fp는 호출자가 CAS 검증 지문을 '복사'해서 넘긴다 —
 *   'CAS 직후 외부 편집'을 사후 실해시로 흡수하는 반례 차단, 5차 blocker).
 * - 캐시(e:)는 fresh 증명에 절대 사용 금지(2차 blocker①) — 저장소는 재료만 보관, 판정은 P4-3 판정기 소관.
 * - 모든 쓰기는 <wsKey>.json.lock 전용 잠금 아래 read-merge-write(5차 [주의] — lost-update 차단).
 *   잠금 실패=쓰기 포기(기준선은 다음 apply 전이에 재시도·캐시는 무해 skip·판정 정확성 불변).
 * - 손상=삭제 재생성(fail-open — 캐시) / mapId·schema 불일치=전체 폐기 / 상한 2,000(seenAt 오래된 순 축출).
 */
const fs = require("fs");
const path = require("path");
const CL = require("./contract-lib.js");
const PMv = require("./project-map.js"); // decision 전체 스키마 검증+ADP 지문(자가 수리의 신뢰 경계)

const SCHEMA = "mfresh-1";
const NUL = String.fromCharCode(0); // 소스에 NUL 바이트를 넣지 않기 위한 조립(2차 [보완]① 교훈)
const ENTRY_CAP = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FP_RE = /^[0-9a-f]{40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/; // toISOString 정확 형태만(밀리초 필수)

function freshnessDir() { return path.join(CL.BRIDGE_DIR, "map-freshness"); } // BRIDGE_DIR은 CL require 시점 env로 고정 — 같은 값을 참조(격리 규칙 통일)
function freshnessFileFor(ws) { return path.join(freshnessDir(), CL.wsKeyFor(ws) + ".json"); }

// key: "a:<uuid>|<rel>" | "e:<uuid>|<rel>" — rel은 비어있지 않고 NUL 금지(경계 실검증은 판정기 소관)
function parseEntryKey(k) {
  if (typeof k !== "string" || k.includes(NUL)) return null;
  const m = /^([ae]):([^|]+)\|(.+)$/.exec(k);
  if (!m || !UUID_RE.test(m[2])) return null;
  return { kind: m[1], entityId: m[2], rel: m[3] };
}
function validEntry(k, v) {
  const pk = parseEntryKey(k);
  if (!pk || !v || typeof v !== "object" || Array.isArray(v)) return false;
  if (!FP_RE.test(String(v.fp))) return false;
  // 2차·3차 [보완]: toISOString 왕복 동등까지 강제 — 2026-02-31 같은 비존재 달력 날짜(파서가 굴려서 수용) 차단.
  if (typeof v.seenAt !== "string" || !ISO_RE.test(v.seenAt)) return false;
  try { if (new Date(v.seenAt).toISOString() !== v.seenAt) return false; } catch { return false; }
  if (v.size !== undefined && !(typeof v.size === "number" && Number.isFinite(v.size) && v.size >= 0)) return false;
  if (v.mtimeMs !== undefined && !(typeof v.mtimeMs === "number" && Number.isFinite(v.mtimeMs))) return false;
  const known = ["fp", "seenAt", "size", "mtimeMs", "basisDecisionId", "seq"]; // seq=저장소가 잠금 안에서 스탬프하는 LRU 논리 순번(11차 — 시각 비의존)
  if (v.seq !== undefined && !(Number.isSafeInteger(v.seq) && v.seq >= 0)) return false;
  if (pk.kind === "e" && v.seq !== undefined) return false; // 12차 [보완]: seq는 권위 a: 전용(감사 순번) — e:는 금지
  if (Object.keys(v).some((x) => !known.includes(x))) return false;
  if (pk.kind === "a") { if (!UUID_RE.test(String(v.basisDecisionId))) return false; } // 기준선=결속 필수(전역 결속 금지 — 4차 blocker①)
  else if (v.basisDecisionId !== undefined) return false; // 캐시=결속 금지(합타입)
  return true;
}

// 잠금(withFileLockStrict와 동일 의미 — ESRCH 사망 감지·토큰 소유 해제) — tries만 매개변수화:
// 정본(map) 잠금 안에서 호출되는 기준선 기록은 짧은 재시도(3회×15ms)로 정본 잠금 점유 시간을 상한(3차 blocker③ —
// 40회×15ms 대기가 map 잠금을 점유해 경쟁 정본 작업을 timeout시키는 전파 차단). 실패분은 retry 사이드카가 흡수.
function withStoreLock(lockPath, tries, fn) {
  const token = process.pid + "-" + Math.random().toString(36).slice(2, 8);
  let locked = false;
  for (let i = 0; i < tries && !locked; i++) {
    try { fs.writeFileSync(lockPath, token, { flag: "wx" }); locked = true; }
    catch {
      try { const pid = parseInt(String(fs.readFileSync(lockPath, "utf8")).split("-")[0], 10); if (pid) { try { process.kill(pid, 0); } catch (ke) { if (ke && ke.code === "ESRCH") return { ok: false, error: "dead-lock-holder" }; } } } catch { /* 재시도 */ }
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); } catch { /* 즉시 재시도 */ }
    }
  }
  if (!locked) return { ok: false, error: "lock-timeout" };
  try { return { ok: true, result: fn() }; }
  finally { try { if (fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath); } catch { /* 무해 */ } }
}

// 판독(무파괴 — 2차 blocker①) — st: ok | absent | corrupt(파싱 불가) | discarded(schema/mapId 불일치) | unreadable.
// 어떤 상태에서도 파일을 삭제·수정하지 않는다: 잠금 밖 판독자의 늦은 삭제가 신세대 파일을 지우는 경합 차단.
// '손상=삭제 재생성·불일치=전체 폐기'의 실현은 mergeWrite(전용 잠금 안)의 재작성이 담당(fail-open은 유지 —
// corrupt/discarded는 빈 entries로 보고되므로 소비자 관점 폐기와 동일, 물리 파일은 다음 쓰기가 교체).
// 유효 파일이라도 개별 무효 entry는 조용히 드랍(fail-open 캐시 — 판정 정확성은 실해시가 담보).
function readFreshnessFor(ws, mapId) {
  const f = freshnessFileFor(ws);
  let raw;
  try { raw = fs.readFileSync(f, "utf8"); }
  catch (e) { return { st: e && e.code === "ENOENT" ? "absent" : "unreadable", entries: {} }; }
  let data;
  try { data = JSON.parse(raw); } catch { return { st: "corrupt", entries: {} }; }
  if (!data || typeof data !== "object" || data.schema !== SCHEMA || data.mapId !== mapId || !data.entries || typeof data.entries !== "object") {
    return { st: "discarded", entries: {} };
  }
  const entries = {};
  for (const [k, v] of Object.entries(data.entries)) if (validEntry(k, v)) entries[k] = v;
  const auditSeq = Number.isSafeInteger(data.auditSeq) && data.auditSeq >= 0 ? data.auditSeq : 0;
  return { st: "ok", entries, auditSeq };
}

// 병합 쓰기 — 전용 잠금 read-merge-write. updates의 무효 entry는 기록하지 않고 skipped로 보고.
// 반환: { ok, wrote, skipped, stale, reason? } — 잠금 실패=ok:false·쓰기 포기(호출자는 apply 성공을 유지).
// unreadable(EISDIR·권한 등)=쓰기 포기(2차 blocker① — 기존 기준선을 빈 상태로 교체해 전량 소실하는 경로 차단).
// corrupt/discarded/absent=빈 상태에서 재생성(잠금 안이므로 경합 안전 — '삭제 재생성·전체 폐기'의 실현 지점).
function mergeWrite(ws, mapId, updates, opts) {
  const o = opts || {};
  const tries = o.tries || 40;
  const f = freshnessFileFor(ws);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const lk = withStoreLock(f + ".lock", tries, () => {
    const cur = readFreshnessFor(ws, mapId); // 잠금 안 재판독(read-merge-write)
    if (cur.st === "unreadable") return { ok: false, wrote: 0, skipped: 0, stale: 0, reason: "unreadable" };
    let auditSeq = cur.auditSeq || 0; // LRU 논리 순번(11차) — 잠금 안 단조 증가·시계와 무관
    const entries = cur.entries;
    // 13차 blocker②: counter-엔트리 불일치 복구 — top-level이 유실/축소돼도 기존 최대 seq 위에서 이어간다
    // (새 기록이 선두로 되감겨 높은 seq 대상이 기아하는 경로 차단).
    for (const v9 of Object.values(entries)) if (Number.isSafeInteger(v9.seq) && v9.seq > auditSeq) auditSeq = v9.seq;
    // 13차 blocker①: 포화 방어는 '증가 시마다' 경계 보장 — 고정 여유폭은 큰 단일 배치에 뚫린다.
    // 스탬프 직전 포화면 잠금 안에서 상대 순서 보존 재번호화(이미 스탬프된 이번 배치분도 entries에 있어
    // 함께 재번호 — 순서 불변·엔트리<=상한이라 저렴) 후 이어간다.
    const nextSeq = () => {
      if (auditSeq >= Number.MAX_SAFE_INTEGER - 1) {
        const seqKeys = Object.keys(entries).filter((k) => Number.isSafeInteger(entries[k].seq)).sort((a, b) => entries[a].seq - entries[b].seq);
        let n2 = 0;
        for (const k of seqKeys) entries[k] = { ...entries[k], seq: ++n2 };
        auditSeq = n2;
      }
      return ++auditSeq;
    };
    // 세대 안전 불변식(3차 blocker① — 늦은 구세대 writer의 세대 되돌림 차단): 기존 파일이 '유효한 다른
    // 세대'(discarded)면, 세대 교체 권위(swap — 정본 잠금 안의 기준선 기록자만)가 없는 한 쓰기 거부.
    // corrupt/absent는 어느 쪽이든 재생성 허용(내용 없음 — 되돌릴 세대가 없다).
    if (cur.st === "discarded" && !o.swap) return { ok: false, wrote: 0, skipped: 0, stale: 0, reason: "generation" };
    let wrote = 0, skipped = 0, stale = 0;
    const wroteKeys = [];
    for (const [k, v] of Object.entries(updates || {})) {
      if (!validEntry(k, v)) { skipped++; continue; }
      const pk = parseEntryKey(k);
      // a:=권위 전용(6차 강화): 기준선은 정본 잠금 안의 swap 호출자(recordBaselines)만 기록 가능 —
      // 잠금 밖 캐시 writer가 기준선을 위조·간섭하는 경로 차단.
      if (pk.kind === "a" && !o.swap) { skipped++; continue; }
      // 시간 단조 가드는 비권위 e: 캐시만(5차 blocker② — a:의 세대 순서는 정본 잠금 직렬화가 보장:
      // 시계 역행·미래 seenAt 잔존이 최신 결정의 권위 기준선을 영구 차단하던 경로 제거·권위가 항상 이긴다).
      if (pk.kind === "e" && entries[k] && v.seenAt < entries[k].seenAt) { stale++; continue; }
      // a: entry는 기록 순간 저장소가 seq를 스탬프(호출자 무관) — 감사 LRU가 이 순번만 본다:
      // 벽시계 역행·미래 seenAt·ISO 상한 산술이 순서에 끼어들 통로 자체를 제거(11차 blocker①②).
      entries[k] = pk.kind === "a" ? { ...v, seq: nextSeq() } : v;
      wroteKeys.push(k); wrote++;
    }
    // 상한 축출(12차 blocker② 정책): 비권위 e: 캐시를 먼저 축출 — 권위 a: 기준선이 캐시에 밀려 사라지지
    // 않는다. 같은 종류 안에서는 seenAt 오래된 순(동률=키 사전순 — 결정론).
    const keys = Object.keys(entries);
    if (keys.length > ENTRY_CAP) {
      const rank = (k) => (parseEntryKey(k).kind === "e" ? "0" : "1") + entries[k].seenAt + "|" + k;
      keys.sort((a, b) => (rank(a) < rank(b) ? -1 : 1));
      for (const k of keys.slice(0, keys.length - ENTRY_CAP)) delete entries[k];
    }
    if (!CL.atomicWrite(f, JSON.stringify({ schema: SCHEMA, mapId, entries, auditSeq }))) return { ok: false, wrote: 0, skipped, stale, reason: "write" };
    // 12차 blocker②: 영수증은 '축출 후 실존' 기준 — 축출로 사라진 키가 실기록으로 보고되지 않는다.
    return { ok: true, wrote, skipped, stale, wroteKeys: wroteKeys.filter((k) => k in entries) };
  });
  if (!lk.ok) return { ok: false, wrote: 0, skipped: 0, stale: 0, reason: "lock" };
  return lk.result;
}

// 경로 경계(1차 blocker⑦ — P4-3 판정기가 anchor/evidence 판독 전 사용): repo 내부 상대경로만 허용.
// 거부: 비문자열·빈 값·NUL·절대경로(드라이브/UNC 포함)·`..` 이탈·symlink로 repo 밖 실경로.
// 반환: { ok:true, abs } | { ok:false, reason } — ok:false면 저장소 밖 stat/hash 0회 보장(호출자 계약).
function safeRepoPathFor(repoRoot, rel) {
  if (typeof rel !== "string" || !rel || rel.includes(NUL)) return { ok: false, reason: "invalid" };
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith("\\\\") || rel.startsWith("//")) return { ok: false, reason: "absolute" };
  const parts = rel.split(/[\\/]+/);
  if (parts.some((p) => p === "..")) return { ok: false, reason: "traversal" };
  const abs = path.resolve(repoRoot, rel);
  let rootReal;
  try { rootReal = fs.realpathSync(repoRoot); } catch { return { ok: false, reason: "root-unreadable" }; }
  // 실경로 검증: 존재하는 가장 깊은 조상까지 realpath — symlink가 repo 밖을 가리키면 거부.
  // (파일 자체가 아직 없으면 부모 디렉터리 기준 — 미존재 파일 stat은 어차피 unknown이지만 경계는 선검증)
  let probe = abs;
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
      if (real !== rootReal && !real.startsWith(rootWithSep)) return { ok: false, reason: "escape" };
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return { ok: false, reason: "escape" }; // 루트까지 미존재 — repo 밖
      probe = parent;
    }
  }
  return { ok: true, abs };
}

// 안전 파일 판독(2차 [주의] 봉합 — 경로 검사 후 symlink 교체 창): P4-3 판정기는 anchor/evidence를 반드시
// 이 함수로 읽는다. lstat 심링크 거부(정책: anchor/evidence=실파일만) + O_NOFOLLOW open(최종 컴포넌트 교체
// 창 봉합 — 미지원 플랫폼은 lstat 선검사만 남고 잔여 창은 플랫폼 한계로 문서화) + fstat regular file 확인.
// 반환: { ok:true, buf, size, mtimeMs } | { ok:false, reason: invalid|absolute|traversal|escape|symlink|not-file|absent|unreadable|root-unreadable }.
function readRepoFileSafe(repoRoot, rel) {
  const s = safeRepoPathFor(repoRoot, rel);
  if (!s.ok) return { ok: false, reason: s.reason };
  try {
    const st = fs.lstatSync(s.abs);
    if (st.isSymbolicLink()) return { ok: false, reason: "symlink" };
    if (!st.isFile()) return { ok: false, reason: "not-file" };
  } catch (e) { return { ok: false, reason: e && e.code === "ENOENT" ? "absent" : "unreadable" }; }
  const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try { fd = fs.openSync(s.abs, fs.constants.O_RDONLY | NOFOLLOW); }
  catch (e) { return { ok: false, reason: e && e.code === "ELOOP" ? "symlink" : e && e.code === "ENOENT" ? "absent" : "unreadable" }; }
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) return { ok: false, reason: "not-file" };
    // open 후 경계 재검증(3차 [주의] 축소): 부모 디렉터리 symlink 교체 경합을 open 이후 재확인으로 좁힌다.
    // openat 부재(Node 이식성)로 창의 '완전' 제거는 불가 — 잔여 창은 보관함 등재(피해 상한: 판정기는 fp 계산만
    // 하고 내용을 외부로 내보내지 않음). O_NOFOLLOW 미지원 플랫폼의 최종 요소 창도 같은 등재에 포함.
    try {
      const real2 = fs.realpathSync(s.abs);
      const rootReal2 = fs.realpathSync(repoRoot);
      const rootWithSep2 = rootReal2.endsWith(path.sep) ? rootReal2 : rootReal2 + path.sep;
      if (real2 !== rootReal2 && !real2.startsWith(rootWithSep2)) return { ok: false, reason: "escape" };
    } catch { return { ok: false, reason: "escape" }; }
    return { ok: true, buf: fs.readFileSync(fd), size: fst.size, mtimeMs: fst.mtimeMs };
  } catch { return { ok: false, reason: "unreadable" }; }
  finally { try { fs.closeSync(fd); } catch { /* 무해 */ } }
}

// ── 기준선 재시도 사이드카(3차 blocker② — '다음 apply 전이에 재시도'의 실현) ──────────────────────────
// 기준선 기록이 실패(잠금 충돌 등)하면 updates를 <wsKey>.json.retry.json에 보관하고, 다음 전이의
// recordBaselines가 회수·합류한다. seenAt 단조 가드가 오래된 재시도의 최신 덮음을 막는다. 상한 500.
const RETRY_CAP = ENTRY_CAP; // 4차 blocker②: 정본 상한과 동일 — 단일 합법 배치(<=2,000)는 절단되지 않는다
function retryFileFor(ws) { return freshnessFileFor(ws) + ".retry.json"; }
function peekRetry(ws, mapId) {
  let cur = null;
  try { cur = JSON.parse(fs.readFileSync(retryFileFor(ws), "utf8")); } catch { return {}; }
  if (!cur || cur.mapId !== mapId || !cur.entries || typeof cur.entries !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(cur.entries)) if (validEntry(k, v)) out[k] = v;
  return out;
}
function stashRetry(ws, mapId, updates) { // 반환 {ok, dropped} — 절단은 조용히 하지 않는다(4차 blocker②)
  const f = retryFileFor(ws);
  const lk = withStoreLock(f + ".lock", 3, () => {
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch { cur = null; }
    const entries = (cur && cur.mapId === mapId && cur.entries && typeof cur.entries === "object") ? cur.entries : {};
    for (const [k, v] of Object.entries(updates || {})) {
      if (!validEntry(k, v)) continue;
      // 6차 blocker①: 시간 가드는 e:만 — a: 기준선은 정본 잠금 직렬화 순서가 곧 세대 순서(미래 seenAt의
      // 구세대 잔존이 신세대 stash를 거부하던 사이드카 변형 차단).
      if (parseEntryKey(k).kind === "e" && entries[k] && v.seenAt < entries[k].seenAt) continue;
      entries[k] = v;
    }
    const keys = Object.keys(entries);
    let dropped = 0;
    if (keys.length > RETRY_CAP) {
      keys.sort((a, b) => (entries[a].seenAt === entries[b].seenAt ? (a < b ? -1 : 1) : (entries[a].seenAt < entries[b].seenAt ? -1 : 1)));
      const evict = keys.slice(0, keys.length - RETRY_CAP);
      dropped = evict.length;
      for (const k of evict) delete entries[k];
    }
    if (!CL.atomicWrite(f, JSON.stringify({ mapId, entries }))) return { ok: false, dropped };
    return { ok: true, dropped };
  });
  if (!lk.ok) return { ok: false, dropped: 0 };
  return lk.result;
}
function clearRetryCovered(ws, mapId, taken) { // 회수분만 제거(회수~병합 사이 새 stash 보존) — 빈 파일은 삭제
  if (!Object.keys(taken || {}).length) return;
  const f = retryFileFor(ws);
  withStoreLock(f + ".lock", 3, () => {
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch { return; }
    if (!cur || cur.mapId !== mapId || !cur.entries) { try { fs.unlinkSync(f); } catch { /* 무해 */ } return; }
    const entryEq = (a, b) => a && b && a.fp === b.fp && a.seenAt === b.seenAt && a.basisDecisionId === b.basisDecisionId && a.size === b.size && a.mtimeMs === b.mtimeMs;
    for (const [k, v] of Object.entries(taken)) {
      if (entryEq(cur.entries[k], v)) delete cur.entries[k]; // canonical 전체 비교(4차 [보완]① — 동률 신항목 오삭제 차단)
    }
    if (!Object.keys(cur.entries).length) { try { fs.unlinkSync(f); } catch { /* 무해 */ } }
    else CL.atomicWrite(f, JSON.stringify(cur));
  });
}

// ── 자가 수리(4·5차 blocker 계열의 구조 해소 — 마커 없는 상시 탐지) ─────────────────────────────────
// 근거는 '상태'가 아니라 매 topology 전이마다 재유도되는 저장소 vs provenance의 차이(6차 [보완]: policy
// 전이는 recordBaselines 미호출 — '다음 topology 전이'가 정확한 한정). 수리 원본='영구 정본'
// decisions/<D>.json(GC 비대상). 승인 경계(5차 blocker③): validateDecisionAny 전체 통과+파일명=decisionId+
// mapId+affectedIds 소속+ADP 지문이 호출자 전달 권위 색인 스냅샷과 일치. 같은 D라도 fp가 decision readSet과
// 다르면 수리 대상(5차 blocker①).
// 순서·기아 방지(9차 blocker — 인덱스 회전은 삽입으로 상대 위치가 고착됨): 감사(fp 대조) 대상은
// **LRU(논리 순번 seq — 11차: 시계 비의존)** — 결속 entry의 최소 seq 순으로 방문하고, '방문 시도'한 노드의
// 결속 entry는 재기록(저장소가 seq 재스탬프)으로 뒤로 보낸다(검증 불능 노드 포함 — 앞자리 독점 차단).
// 새 기준선도 기록 순간 seq 후미 스탬프라 삽입·시계 역행·ISO 상한이 앞 순번을 밀 수 없다:
// #감사 노드 / 회당 감사 슬롯 번의 전이 안 방문이 보장된다.
// 명백 후보(entry 부재/결속 불일치)는 언제나 최우선(missing-first)·id 정렬 순회. 예산: 후보는
// budget-감사 예약분까지, 감사는 남은 예산 전부(예약 하한 max(1, budget/5) — 8차 blocker).
function repairUpdatesFor(ws, mapId, topo, decisionsDir, opts) {
  const o = opts || {};
  const idxMap = o.indexByDecision || null;
  if (!idxMap) return { updates: {}, touches: {}, reads: 0, budgetHit: false }; // 권위 스냅샷 없이는 수리하지 않음(결속 필수)
  const budget = o.budget === undefined ? 25 : o.budget;
  const store = readFreshnessFor(ws, mapId).entries;
  const seenAt = new Date().toISOString(); // 순수 기록 시각(11차 — 순서는 seq가 담당·시각 산술 없음)
  const decCache = new Map();
  const out = {}, touches = {};
  let reads = 0, budgetHit = false;
  const cands = [], audits = [];
  for (const nd0 of (topo && topo.nodes) || []) {
    const did0 = nd0 && nd0.provenance && nd0.provenance.decisionId;
    if (!did0 || !UUID_RE.test(String(did0))) continue;
    const as0 = (nd0.anchors || []).filter((a) => a && a.path);
    if (!as0.length) continue;
    const bound = as0.map((a) => store["a:" + nd0.id + "|" + a.path]).filter((c0) => c0 && c0.basisDecisionId === did0);
    if (bound.length < as0.length) cands.push(nd0); // 어떤 anchor든 부재/결속 불일치=명백 후보
    else audits.push({ nd: nd0, lru: Math.min(...bound.map((c0) => (Number.isSafeInteger(c0.seq) ? c0.seq : 0))) }); // 감사 LRU 키=최소 seq(11차 — 시각 비의존·seq 부재[구 파일]=0 최우선)
  }
  // 후보는 id 정렬+revision 순환 offset(수리 불능 후보 잔존 시 공정 순회 — 새 정상 노드는 후보가 아니라
  // 목록을 밀지 못함: 7차). 감사는 LRU(위 주석 — 9차).
  cands.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
  const rev = (topo && topo.revision) || 0;
  const candsRot = cands.length ? cands.map((_, i) => cands[((rev % cands.length) + i) % cands.length]) : cands;
  audits.sort((a, b) => (a.lru === b.lru ? (String(a.nd.id) < String(b.nd.id) ? -1 : 1) : (a.lru - b.lru < 0 ? -1 : 1)));
  const audReserve = audits.length ? Math.min(audits.length, Math.max(1, Math.floor(budget / 5))) : 0;
  const phases = [[candsRot, Math.max(0, budget - audReserve), false], [audits.map((x) => x.nd), Infinity, true]];
  for (const [list, cap, isAudit] of phases) for (const nd of list) {
    const did = nd.provenance.decisionId;
    const anchors = (nd.anchors || []).filter((a) => a && a.path);
    if (!decCache.has(did)) {
      if (reads >= Math.min(cap, budget)) { budgetHit = true; break; } // 같은 단계 잔여도 전부 예산 초과 — 중단
      reads++;
      let d = null;
      try { d = JSON.parse(fs.readFileSync(path.join(decisionsDir, did + ".json"), "utf8")); } catch { d = null; }
      const okDec = d && d.schema === "map-decision-v3" && d.decisionId === did && d.mapId === mapId
        && Array.isArray(d.affectedIds) && PMv.validateDecisionAny(d).length === 0
        && idxMap[did] && PMv.adpHashOf(PMv.adpOf(d)) === idxMap[did]; // 권위 스냅샷 결속(5차 blocker③)
      decCache.set(did, okDec ? d : null);
    }
    const d = decCache.get(did);
    if (isAudit) {
      // 방문 시도 자체를 touch(검증 불능 포함) — LRU 후미로 보내 앞자리 독점을 차단(유한 방문의 핵심)
      for (const a of anchors) {
        const key = "a:" + nd.id + "|" + a.path;
        const cur = store[key];
        if (cur && cur.basisDecisionId === did) { const t9 = { ...cur }; delete t9.seq; touches[key] = t9; } // 재기록=저장소가 seq 재스탬프(후미 이동)·payload 불변
      }
    }
    if (!d || !d.affectedIds.includes(nd.id)) continue; // 결속 불일치·검증 실패=수리 거부(위조 provenance 방어)
    const files = (((d.patch || {}).readSet || {}).files || []);
    for (const a of anchors) {
      const fe = files.find((x) => x && x.ref === a.path);
      if (!fe || !FP_RE.test(String(fe.contentHash))) continue; // read-set에 없던 anchor=기준선 미생성 유지(④)
      const key = "a:" + nd.id + "|" + a.path;
      const cur = store[key];
      if (cur && cur.basisDecisionId === did && cur.fp === fe.contentHash) continue; // 완전 일치=수리 불요(touch만)
      delete touches[key];
      out[key] = { fp: fe.contentHash, seenAt, basisDecisionId: did };
    }
  }
  return { updates: out, touches, reads, budgetHit };
}

// P4-3ⓐ 기준선 기록 진입점(파이프라인 전용 — 정본 잠금 안 호출 전제):
// ①상시 자가 수리 합류(누락=저장소 vs provenance 차이로 재유도 — 내구 마커 불요·5차 blocker① 해소)
// ②이전 실패분(retry) 회수 합류 ③짧은 잠금(tries=3) — 점유는 '전체 경로' 합산(merge≈45ms+실패 시
//   stash≈45ms — 실측 ~130ms대·기본 40회 600ms+보다 낮음) ④실패=사이드카 보관(빠른 회수용 최적화일 뿐
//   유일 영수증이 아님 — 사이드카까지 실패해도 ①이 다음 전이에서 재유도) ⑤swap=권위 호출자만.
function recordBaselines(ws, mapId, updates, opts) {
  const o = opts || {};
  const retry = peekRetry(ws, mapId);
  let repair = {}, touches = {}, repairReads = 0, repairBudgetHit = false;
  if (o.topo && o.decisionsDir && o.indexByDecision) {
    try {
      const rp = repairUpdatesFor(ws, mapId, o.topo, o.decisionsDir, { indexByDecision: o.indexByDecision, budget: o.repairBudget });
      repair = rp.updates; touches = rp.touches || {}; repairReads = rp.reads; repairBudgetHit = rp.budgetHit;
    } catch { repair = {}; touches = {}; }
  }
  for (const k of Object.keys(updates || {})) { delete repair[k]; delete touches[k]; } // 이번 전이 자신의 기록분은 '수리'가 아님(집계 정밀성)
  const merged = { ...touches, ...retry, ...repair, ...(updates || {}) }; // 우선순위 touch<retry<repair<updates(10차 blocker②: seenAt만 미는 touch가 내구 retry의 검증된 수리값을 덮지 못하게)
  if (!Object.keys(merged).length) return { ok: true, wrote: 0, skipped: 0, stale: 0, retried: 0, repaired: 0, repairReads, repairBudgetHit };
  const r = mergeWrite(ws, mapId, merged, { swap: true, tries: 3 });
  if (r.ok) {
    clearRetryCovered(ws, mapId, retry);
    // 영수증 정직성(11차 blocker② 후단): repaired=수리 후보 중 '실제 기록된' 키만(무효 skip이 성공으로 위장 불가)
    const wroteSet = new Set(r.wroteKeys || []);
    return { ...r, retried: Object.keys(retry).length, repaired: Object.keys(repair).filter((k) => wroteSet.has(k)).length, repairReads, repairBudgetHit };
  }
  const st = stashRetry(ws, mapId, merged);
  return { ...r, retried: Object.keys(retry).length, repaired: Object.keys(repair).length, repairReads, repairBudgetHit, stashed: st.ok, dropped: st.dropped };
}

module.exports = { SCHEMA, ENTRY_CAP, RETRY_CAP, freshnessFileFor, retryFileFor, parseEntryKey, validEntry, readFreshnessFor, mergeWrite, recordBaselines, peekRetry, stashRetry, clearRetryCovered, repairUpdatesFor, safeRepoPathFor, readRepoFileSafe };
