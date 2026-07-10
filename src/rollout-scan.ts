/*
 * 증분 rollout 판독(P1-①, 2026-07-10 교차 감사) — 대용량 JSONL(라이브 실측 181MB·후보 합 296MB)을
 * 소비자(검증 대화·모델 메타·주제 스니펫)마다 '전량' 재파싱해 확장 호스트를 동기 블로킹하던 구조의 해법.
 * 전략은 brain-intent 증분 스캐너와 동형: 파일별 상태 {offset+carry(불완전 꼬리 바이트)}를 들고
 * 자란 부분만 병합한다. vscode/fs 의존 없음(입출력은 주입) — 테스트 가능.
 *
 * 전제(정식): rollout은 append-only 로그다. 아래 정체성 검사는 그 전제가 '깨진 것을 눈치채기 위한'
 * best-effort 방어이지 증명이 아니다(Codex 반례 왕복 2회로 주장 하향 확정 — 표본 지문으로는 기존
 * prefix 전체의 동일성을 증명할 수 없다: 머리·경계 표본을 둘 다 보존한 '중간 본문만' 재작성은 원리상 불가시):
 *  ① 축소(size<offset) → 재구축  ② 같은 크기 재작성/터치(mtime 변화) → 재구축(구식 mtime 키 재파싱과 동일)
 *  ③ 커진 재작성 → 머리 표본(anchor ≤256B)+offset 직전 경계 지문(tail ≤64B) 불일치면 재구축
 *    — 머리만 보면 session_meta를 보존한 본문 재작성을 놓친다(Codex 반례 실측).
 */

export type TailState<S> = {
  offset: number;   // 파싱을 마친 바이트 수(다음 읽기 시작점)
  carry: Buffer;    // 마지막 불완전 줄의 '원시 바이트'(다음 조각과 이어 붙임) — 문자열로 들면 여러 바이트
                    // 문자가 조각마다 따로 디코딩돼 부패한다(테스트 조각 7B가 실측한 함정).
  anchor: string;   // 파일 머리 표본(최대 256B, latin1) — '같은 파일'의 1차 증거
  tail: string;     // offset 직전 바이트의 롤링 지문(최대 64B, latin1) — '이어 자란 것'의 2차 증거
  mtimeMs: number;  // 마지막으로 본 mtime — 같은 크기 재작성 감지(크기·offset 비교로는 불가시)
  acc: S;           // 누적 상태(소비자별 — 병합 규칙은 mergeLine이 정의)
};

const ANCHOR_MAX = 256;
const TAIL_MAX = 64;

export type ReadSlice = (file: string, start: number, end: number) => Buffer; // [start, end) 바이트 원본(버퍼)
export type StatInfo = (file: string) => { size: number; mtimeMs: number }; // 실패 시 throw

// 증분 한 스텝: 이전 상태를 받아 '자란 부분만' 병합한 새 상태를 돌려준다(acc는 제자리 병합).
// 완성된 줄(마지막 줄바꿈까지)만 디코딩·파싱하고 불완전 꼬리는 '원시 바이트'로 이월 — 조각 경계가
// 문자·JSON을 반토막 내는 부패가 원리적으로 없음. 단 파일 끝의 '줄바꿈 없는 완결 JSON 줄'은 구식
// 전량 파서가 표시하던 것이라, EOF에서 완결 객체로 파싱되면 소비한다(쓰다 만 줄은 파싱 실패라 대기).
// 실패는 호출자가 잡는다(파일 소멸 등 — 소비자별 기본값 처리).
export function advanceTail<S>(
  file: string,
  prev: TailState<S> | undefined,
  initAcc: () => S,
  mergeLine: (acc: S, line: string) => void,
  statInfo: StatInfo,
  readSlice: ReadSlice,
  maxChunk = 64 * 1024 * 1024, // 한 스텝 상한(64MB) — 메모리 상한(시간 분할 아님: catchUp은 동기로 끝까지 읽음)
): TailState<S> {
  const { size, mtimeMs } = statInfo(file);
  const fresh = (): TailState<S> => ({ offset: 0, carry: Buffer.alloc(0), anchor: "", tail: "", mtimeMs, acc: initAcc() });
  let st: TailState<S> = prev && size >= prev.offset ? prev : fresh();
  if (size === st.offset) {
    if (mtimeMs === st.mtimeMs) return st; // 무변화 — 읽기 0바이트
    st = fresh(); // 같은 크기의 재작성(또는 터치) — 내용이 같다는 보장이 없으므로 전체 재구축(구식과 동일 비용·빈도)
  }
  if (st.offset > 0) {
    // 정체성 확인(자람을 소비하기 직전) — 커진 재작성은 size 비교로 못 잡고 옛 offset부터 쓰레기를 병합하게 된다.
    const head = st.anchor ? readSlice(file, 0, Math.min(st.anchor.length, size)).toString("latin1") : "";
    const mark = st.tail ? readSlice(file, Math.max(0, st.offset - st.tail.length), st.offset).toString("latin1") : "";
    if (head !== st.anchor || mark !== st.tail) st = fresh();
  }
  const hardEnd = Math.min(size, st.offset + maxChunk);
  const buf = readSlice(file, st.offset, hardEnd);
  if (st.offset === 0) st.anchor = buf.subarray(0, Math.min(ANCHOR_MAX, buf.length)).toString("latin1");
  let text: string;
  let carry: Buffer;
  const lastNl = buf.lastIndexOf(10); // 0x0A
  if (lastNl >= 0) {
    // 마지막 줄바꿈까지 소비 — 이월분(carry)과 '바이트로' 이어 붙여 한 번에 디코딩(경계 무부패). 꼬리는 이월.
    text = Buffer.concat([st.carry, buf.subarray(0, lastNl + 1)]).toString("utf8");
    carry = Buffer.from(buf.subarray(lastNl + 1)); // 복사 — readSlice 버퍼 재사용 구현과의 alias 방지
  } else {
    // 조각 전체에 줄바꿈 없음(조각보다 긴 줄) — 전부 carry로 이월(바이트 보존이라 무손실).
    // 한계: 줄 하나가 maxChunk를 계속 초과하면 carry가 그만큼 자란다(메모리) — 유실은 아님(라이브 최장 줄 ~3.7MB).
    text = "";
    carry = Buffer.concat([st.carry, buf]);
  }
  for (const raw of text.split("\n")) {
    const s = raw.trim();
    if (!s || s[0] !== "{") continue;
    mergeLine(st.acc, s);
  }
  if (hardEnd === size && carry.length) {
    // EOF의 줄바꿈 없는 꼬리 — 완결 JSON 객체면 구식 파서와 동일하게 표시(소비). 파싱 실패=쓰는 중 → 대기.
    // 한계(정직): 완결 객체를 쓴 '뒤' 같은 줄을 이어 쓰는 작성자라면 이 선소비가 어긋나지만, 그 완성줄은
    // 어차피 JSON 파싱 불가(객체 뒤 잉여)라 구식 파서도 버리던 줄이다.
    const s = carry.toString("utf8").trim();
    if (s[0] === "{" && s[s.length - 1] === "}") {
      try { JSON.parse(s); mergeLine(st.acc, s); carry = Buffer.alloc(0); } catch { /* 미완성 — 대기 */ }
    }
  }
  const tail = (st.tail + buf.toString("latin1")).slice(-TAIL_MAX); // offset 직전 경계 지문(롤링)
  return { offset: hardEnd, carry, anchor: st.anchor, tail, mtimeMs, acc: st.acc };
}

// 따라잡기: 첫 구축(또는 재구축)이 maxChunk보다 큰 파일에서 여러 조각이 되므로, '호출 시점 크기'까지
// 스텝을 반복해 완전한 상태를 돌려준다. 이후 호출은 자란 부분만이라 사실상 1스텝.
// 종료 조건은 '전진 없음'(무한 루프 방지) — 고정 횟수 상한은 두지 않는다: 상한을 두면 미완 상태를
// 조용히 반환해 소비자가 '중간까지의 지식'을 진실로 믿는 유실이 됨(테스트 조각 7B가 실측).
export function catchUp<S>(
  file: string,
  prev: TailState<S> | undefined,
  initAcc: () => S,
  mergeLine: (acc: S, line: string) => void,
  statInfo: StatInfo,
  readSlice: ReadSlice,
  maxChunk?: number,
): TailState<S> {
  let st = advanceTail(file, prev, initAcc, mergeLine, statInfo, readSlice, maxChunk);
  for (;;) {
    const { size } = statInfo(file);
    if (st.offset >= size) break;
    const before = st.offset;
    st = advanceTail(file, st, initAcc, mergeLine, statInfo, readSlice, maxChunk);
    if (st.offset <= before) break;
  }
  return st;
}

// ── 통합 누적기: 검증 대화 + 모델 메타를 '한 번의 스캔'으로 ─────────────────
// 소비자별 tail을 따로 들면 같은 파일을 소비자 수만큼 전량 판독한다(Codex 실측: 190MB에서 904+877ms).
// cwd별 마지막 값(byCwd)을 모두 들고 있으므로 어떤 wsFilter 질의도 추가 스캔 없이 답한다.
export type Msg = { role: "user" | "assistant"; text: string };
export type MetaVal = { model: string; effort: string; ts: string };
export type RolloutAcc = {
  msgs: Msg[];
  userTurns: number;                 // msgs 안의 사용자 메시지 수(턴 경계 절삭용 — msgs와 항상 동기)
  firstUser: string | null;          // 파일 '첫' 비주입 사용자 메시지 — 절삭과 무관하게 보존(스니펫 폴백용).
                                     // readMessages 폴백은 절삭된 시야라 '전량 동일 시야' 주장이 거짓이었음(Codex 반례).
  turnsDropped: boolean;             // 오래된 턴 '통째' 제거가 발생 — '요청 창 미달' 고지의 입력
  firstTurnInnerDropped: boolean;    // '현재 선두 턴' 내부의 오래된 assistant가 생략됨 — 그 턴이 화면에 있는 동안만
                                     // 의미(선두 턴이 통째로 제거되면 리셋). 단일 표지로 합치면 원인을 틀리게
                                     // 고지하거나(턴 제거로 오인) 창이 찼을 때 침묵한다(Codex 반례: 1턴+assistant 4,050)
  models: Set<string>;               // 세션이 써본 전체 모델(필터 무관 — knownModels 표시용)
  byCwd: Map<string, MetaVal>;       // 폴더(cwd)별 마지막 turn_context 값 — wsFilter 질의의 답
  last: MetaVal;                     // 필터 없는 마지막 값
};
// 대화 보존은 '완전한 사용자 턴' 경계로 상한 — 메시지 개수 절삭은 recentTurns 계약을 깨뜨린다
// (Codex 실측: 400메시지=사용자 턴 57개뿐 + 잘린 턴의 assistant가 user:null 합성 턴으로 표시).
// recentTurns 최댓값(package.json maximum)은 이 상한 이하로 잠근다.
export const TURN_CAP = 200;
export const HARD_MSG_CAP = 4000; // assistant 폭주 턴의 메모리 방어 — 이것도 '턴 단위'로 지운다(아래).
// 앞에서 '한 턴 통째로' 제거(선두가 user면 그 턴, 아니면 첫 user 전까지의 잔재) — userTurns를 함께 동기.
// 원시 메시지 개수 절삭은 userTurns가 어긋나 user:null 합성 턴이 재발한다(Codex 반례: 200턴×assistant 25개).
function dropOldestTurn(acc: RolloutAcc): void {
  if (!acc.msgs.length) return;
  let i = 0;
  if (acc.msgs[0].role === "user") { i = 1; acc.userTurns--; }
  while (i < acc.msgs.length && acc.msgs[i].role !== "user") i++;
  acc.msgs.splice(0, i);
  acc.turnsDropped = true;
  acc.firstTurnInnerDropped = false; // 내부 생략됐던 선두 턴이 통째로 사라짐 — 새 선두 턴엔 해당 없음(낡은 고지 방지)
}
export function makeRolloutAcc(isInjected: (t: string) => boolean, normWs: (p: string) => string): { init: () => RolloutAcc; merge: (acc: RolloutAcc, line: string) => void } {
  return {
    init: () => ({ msgs: [], userTurns: 0, firstUser: null, turnsDropped: false, firstTurnInnerDropped: false, models: new Set(), byCwd: new Map(), last: { model: "", effort: "", ts: "" } }),
    merge: (acc, line) => {
      let o: any;
      try { o = JSON.parse(line); } catch { return; }
      if (o.type === "response_item" && o.payload?.type === "message") {
        const role = o.payload.role;
        if (role !== "user" && role !== "assistant") return;
        const text = (o.payload.content || []).map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("").trim();
        if (!text) return;
        if (role === "user" && isInjected(text)) return;
        if (role === "user" && acc.firstUser === null) acc.firstUser = text;
        acc.msgs.push({ role, text });
        if (role === "user") acc.userTurns++;
        // 상한 이내 파일은 절삭 자체가 없어 구식 파서와 완전 동일.
        while (acc.userTurns > TURN_CAP) dropOldestTurn(acc);
        while (acc.msgs.length > HARD_MSG_CAP && acc.userTurns > 1) dropOldestTurn(acc);
        if (acc.msgs.length > HARD_MSG_CAP) {
          // 남은 게 한 턴뿐(또는 사용자 0)인데도 하드 상한 초과 — 턴을 통째로 버리면 대화 전체가 사라지므로
          // 턴 '내부'의 가장 오래된 assistant부터 덜어낸다(사용자 메시지 보존 → user:null 합성 턴 없음).
          // 한계(정직): 상한은 메시지 개수 기준이라 단일 초대형 메시지의 바이트는 못 막는다 — 구식(전량 보존)보다는 항상 작음.
          const keepUser = acc.msgs[0].role === "user" ? 1 : 0;
          acc.msgs.splice(keepUser, acc.msgs.length - HARD_MSG_CAP);
          acc.firstTurnInnerDropped = true;
        }
        return;
      }
      if ((o.type || o.payload?.type) === "turn_context") {
        const p = o.payload || o;
        if (p.model) acc.models.add(p.model);
        // 기존 파서와 동일한 last-wins: 있는 필드만 덮는다(model 없이 effort만 오는 turn 등).
        const model = p.model ? String(p.model) : "";
        const effort = p.effort || p.reasoning_effort ? String(p.effort || p.reasoning_effort) : "";
        const ts = o.timestamp ? String(o.timestamp) : "";
        const upd = (v: MetaVal): MetaVal => ({ model: model || v.model, effort: effort || v.effort, ts: ts || v.ts });
        acc.last = upd(acc.last);
        const key = normWs(p.cwd || "");
        acc.byCwd.set(key, upd(acc.byCwd.get(key) || { model: "", effort: "", ts: "" }));
      }
    },
  };
}

// ── 주제 스니펫: 첫 사용자 메시지는 파일 '머리'에 있고 불변 — 전량 파싱이 후보 목록(수백 MB 합산)을
// 잡아먹던 최대 비용 지점. 머리 조각만 읽고, 찾으면 영구 메모 가능(호출자 몫).
export function headFirstUserMessage(
  file: string,
  isInjected: (t: string) => boolean,
  readSlice: ReadSlice,
  statInfo: StatInfo,
  headBytes = 512 * 1024,
): string | null {
  let size: number;
  try { size = statInfo(file).size; } catch { return null; }
  const end = Math.min(size, headBytes);
  let text: string;
  try { text = readSlice(file, 0, end).toString("utf8"); } catch { return null; }
  const lines = text.split("\n");
  if (end < size) lines.pop(); // 경계의 불완전 줄 폐기(머리 안에서만 판단)
  for (const raw of lines) {
    const s = raw.trim();
    if (!s || s[0] !== "{") continue;
    let o: any;
    try { o = JSON.parse(s); } catch { continue; }
    if (o.type !== "response_item" || o.payload?.type !== "message" || o.payload.role !== "user") continue;
    const t = (o.payload.content || []).map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("").trim();
    if (!t || isInjected(t)) continue;
    return t;
  }
  return end < size ? null : ""; // null=머리에서 못 찾았고 뒤가 더 있음(호출자가 폴백 판단) / ""=파일 전체에 없음(확정)
}
