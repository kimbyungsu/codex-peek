/*
 * 관측 장부 발화 기록기(로드맵 ④) — 사용자의 자연 발화("그 파일은 상관없어" / "맞아, 그 결합 확실해")가
 * 장부 지식의 정정·확인 근거가 되도록, 구현 AI(Claude)가 그 발화를 이벤트로 적재하는 CLI.
 * ⚠ 보수적 사용 원칙(HANDOFF §3): 발화가 특정 항목과 명확히 매칭되고 어조가 확정적일 때만 기록.
 *   농담·가정법·"맞나? 헷갈리네" 같은 흔들림(wavering)은 기록하지 않는다(tg 정책 — hold).
 * 매칭은 항목 텍스트의 '유일한' 부분 문자열만 허용 — 0개/2개 이상이면 후보를 보여주고 중단(조용한 오기록 방지).
 *
 * 사용: node scripts/scope-ledger-note.js <repo> list
 *       node scripts/scope-ledger-note.js <repo> <dispute|confirm|pin|ban|unpin|unban> "<항목 텍스트 조각>" [--why "<발화 요지>"]
 */
const path = require("path");
const { appendLedgerEvent, readLedgerEventsText, ledgerSig, loadLang } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const tB = (ko, en) => (loadLang() === "en" ? en : ko); // CLI output is ko/en paired (2026-07-09)
const { parseEventsJsonl, deriveLedger } = require(path.join(__dirname, "..", "out", "ledger-events.js"));

const TYPE_MAP = { dispute: "user_dispute", confirm: "user_confirm", pin: "pinned", ban: "banned", unpin: "unpinned", unban: "unbanned" };
const repoArg = process.argv[2];
const cmd = process.argv[3];
const frag = process.argv[4];
const whyIdx = process.argv.indexOf("--why");
const why = whyIdx > 0 ? String(process.argv[whyIdx + 1] || "") : "";
if (!repoArg || !cmd || (cmd !== "list" && !TYPE_MAP[cmd])) {
  console.error(tB('사용: node scripts/scope-ledger-note.js <repo> <list|dispute|confirm|pin|ban|unpin|unban> "<항목 텍스트 조각>" [--why "<발화 요지>"]','Usage: node scripts/scope-ledger-note.js <repo> <list|dispute|confirm|pin|ban|unpin|unban> "<entry text fragment>" [--why "<utterance gist>"]'));
  process.exit(2);
}
const repo = path.resolve(repoArg);
const entries = deriveLedger(parseEventsJsonl(readLedgerEventsText(repo)).events);
if (cmd === "list") {
  if (!entries.length) { console.log(tB("장부 비어 있음 — 정찰 지도가 ⑥ 제안을 내면 쌓입니다.","Journal empty — it fills once scout maps produce section-⑥ proposals.")); process.exit(0); }
  for (const e of entries) console.log("[" + e.status + (e.pinned ? tB("·고정", "·pinned") : "") + "] " + (e.text || e.sig));
  process.exit(0);
}
if (!frag || !String(frag).trim()) { console.error(tB("항목 텍스트 조각을 지정하라 — 먼저 list로 확인","Provide an entry text fragment — check with list first")); process.exit(2); }
const needle = String(frag).toLowerCase();
const hits = entries.filter((e) => (e.text || e.sig).toLowerCase().includes(needle));
if (hits.length === 0) {
  console.error(tB(`일치 항목 없음: "${frag}" — 현재 장부(${entries.length}건):`,`No matching entry: "${frag}" — current journal (${entries.length} entries):`));
  for (const e of entries.slice(0, 15)) console.error(`  [${e.status}] ${(e.text || e.sig).slice(0, 100)}`);
  process.exit(1);
}
if (hits.length > 1) {
  console.error(tB(`조각이 ${hits.length}개 항목과 일치 — 더 좁혀라(조용한 오기록 방지):`,`Fragment matches ${hits.length} entries — narrow it down (prevents silent mis-recording):`));
  for (const e of hits.slice(0, 10)) console.error(`  [${e.status}] ${(e.text || e.sig).slice(0, 100)}`);
  process.exit(1);
}
const target = hits[0];
const ev = { ts: new Date().toISOString(), type: TYPE_MAP[cmd], sig: target.sig, text: target.text, from: why ? tB(`사용자 발화: ${why.slice(0, 160)}`,`user utterance: ${why.slice(0, 160)}`) : tB("사용자 발화 기록(요지 미기재)","user utterance (gist not given)") };
if (!appendLedgerEvent(repo, ev)) { console.error(tB("기록 실패(권한/디스크?) — 아무것도 반영되지 않음","Write failed (permission/disk?) — nothing was applied")); process.exit(1); }
const after = deriveLedger(parseEventsJsonl(readLedgerEventsText(repo)).events).find((e) => e.sig === target.sig);
console.log(tB(`기록됨: ${ev.type} → `,`Recorded: ${ev.type} → `) + `"${(target.text || target.sig).slice(0, 80)}"`);
console.log(tB("현재 신분: ","Current state: ") + (after ? after.status + (after.pinned ? tB("·고정","·pinned") : "") + tB(" · 차선 "," · lane ") + after.lane : "?"));
