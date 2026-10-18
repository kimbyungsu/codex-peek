"use strict";
/*
 * [2026-10-18 사용자 결정 2건] ① DeepSeek 연결 점검을 '3트랙 켤 때'(담당 선택과 무관 — 3트랙 초기 'DeepSeek 비교 정찰(두 번째 정찰자)'
 * 개념의 흔적)에서 '탐색 담당에서 DeepSeek 을 새로 고를 때'로 옮김 ② 의미 보강 담당은 전용 모델 설정 없이 지금처럼 공유하되,
 * 고른 방식이 실제로 쓰는 모델(Codex=정찰 설정 공유 · DeepSeek=DeepSeek 설정 · Claude=지정 없음)을 화면·안내 새 탭에 표시.
 * 확장 산출물(out/extension.js)의 실제 함수·화면 조각을 대역으로 실행한다(문구 존재만 보는 단언은 반대로 동작하는 구현을 못 잡는다).
 * 격리: 실제 VS Code·DeepSeek·사용자 설정 무접촉(전송 0 — 자식 프로세스도 대역).
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const ROOT = path.join(__dirname, "..");
const OUT = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
const SRC = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
const between = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, "조각 " + a.slice(0, 40)); return s.slice(i, j); };

let n = 0;
const pending = [];
const t = (name, fn) => pending.push([name, fn]);

// ── 탐색 담당 선택 + 연결 점검(실제 함수 실행 · vscode·자식 프로세스 대역) ──
const pickSrc = between(OUT, "async function setScoutArmFromUi(", "\nasync function setScoutTargetFromUi(");
function harness(o) {
  const log = { warn: [], info: [], progress: [], spawned: [], saved: [], refresh: 0 };
  const vscode = {
    ProgressLocation: { Notification: 15 },
    window: {
      showWarningMessage: (msg, ...rest) => { log.warn.push(String(msg)); const modal = rest[0] && rest[0].modal; return Promise.resolve(modal ? o.modalPick : undefined); },
      showInformationMessage: (msg) => { log.info.push(String(msg)); return Promise.resolve(undefined); },
      withProgress: (opt, task) => { log.progress.push(opt.title); return task(); },
    },
    commands: { executeCommand: () => { log.refresh++; } },
  };
  const child_process_1 = {
    spawn: (cmd) => {
      log.spawned.push(String(cmd));
      if (o.spawnMode === "throw") throw new Error("spawn EPERM");
      const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
      setImmediate(() => {
        if (o.spawnMode === "ok") { p.stdout.emit("data", "ok\n"); p.emit("close", 0); }
        else if (o.spawnMode === "fail") { p.stderr.emit("data", "401 unauthorized"); p.emit("close", 1); }
        else if (o.spawnMode === "error-then-close") { p.emit("error", new Error("x")); p.emit("close", 1); }
      });
      return p;
    },
  };
  const fn = new Function("vscode", "tE", "loadLangExt", "readDeepseekView", "scoutNameExt", "patchContractRetryExt", "offerLockRecoveryExt", "scoutArmViewExt", "hookSetup", "nodeTokenCandidates", "child_process_1", "path", "BRIDGE_DIR",
    pickSrc + "\nreturn { setScoutArmFromUi, runDeepseekConnectionCheck };");
  const api = fn(vscode, (ko) => ko, () => "ko", () => ({ hasKey: !!o.hasKey }), () => "기본 정찰(Claude)",
    async (ws, lang, patch) => { log.saved.push(patch); return { ok: o.saveOk !== false }; }, () => {},
    () => ({ raw: o.prevArm === undefined ? null : o.prevArm }), { resolveNodeToken: () => (o.noNode ? null : { token: "node" }) }, () => [],
    child_process_1, path, "/tmp/bridge-home");
  return { api, log };
}

t("DeepSeek 을 새로 고르고 키가 있으면: 저장 뒤 연결 점검 1회(ping) · 성공 알림", async () => {
  const { api, log } = harness({ hasKey: true, prevArm: null, spawnMode: "ok" });
  await api.setScoutArmFromUi("D:/w", "deepseek");
  assert.deepStrictEqual(log.saved, [{ scoutArm: "deepseek" }]);
  assert.strictEqual(log.spawned.length, 1); assert.ok(/deepseek-bridge\.js" ping$/.test(log.spawned[0]), log.spawned[0]);
  assert.strictEqual(log.progress.length, 1);
  assert.ok(log.info.some((m) => /DeepSeek 연결이 확인됐어요/.test(m)), log.info.join("|"));
});
t("이미 DeepSeek 이던 선택을 다시 누르면 점검하지 않음(불필요한 전송 없음)", async () => {
  const { api, log } = harness({ hasKey: true, prevArm: "deepseek", spawnMode: "ok" });
  await api.setScoutArmFromUi("D:/w", "deepseek");
  assert.strictEqual(log.saved.length, 1); assert.strictEqual(log.spawned.length, 0);
});
t("Claude·Codex 를 고르면 키가 있어도 점검하지 않음", async () => {
  for (const arm of ["self", "codex"]) {
    const { api, log } = harness({ hasKey: true, prevArm: "deepseek", spawnMode: "ok" });
    await api.setScoutArmFromUi("D:/w", arm);
    assert.strictEqual(log.spawned.length, 0, arm); assert.deepStrictEqual(log.saved, [{ scoutArm: arm }]);
  }
});
t("키가 없으면 종전대로 확인 창만 — 취소=저장 안 함 · '그래도 저장'=저장(어느 쪽도 점검·전송 없음)", async () => {
  let h = harness({ hasKey: false, modalPick: undefined });
  await h.api.setScoutArmFromUi("D:/w", "deepseek");
  assert.strictEqual(h.log.saved.length, 0); assert.strictEqual(h.log.spawned.length, 0); assert.ok(/키가 아직 없어요/.test(h.log.warn[0]));
  h = harness({ hasKey: false, modalPick: "그래도 저장" });
  await h.api.setScoutArmFromUi("D:/w", "deepseek");
  assert.deepStrictEqual(h.log.saved, [{ scoutArm: "deepseek" }]); assert.strictEqual(h.log.spawned.length, 0);
});
t("저장이 실패하면 점검하지 않음", async () => {
  const { api, log } = harness({ hasKey: true, prevArm: null, saveOk: false, spawnMode: "ok" });
  await api.setScoutArmFromUi("D:/w", "deepseek");
  assert.strictEqual(log.spawned.length, 0); assert.strictEqual(log.refresh, 0);
});
t("연결 실패=실패 알림(사유 포함) · node 없음=실행 없이 안내 · 오류 뒤 닫힘이 와도 알림은 한 번", async () => {
  let h = harness({ spawnMode: "fail" });
  assert.strictEqual(await h.api.runDeepseekConnectionCheck(), "failed");
  assert.ok(h.log.warn.some((m) => /연결 점검에 실패했어요\(401 unauthorized\)/.test(m)), h.log.warn.join("|"));
  h = harness({ noNode: true });
  assert.strictEqual(await h.api.runDeepseekConnectionCheck(), "no-node"); assert.strictEqual(h.log.spawned.length, 0);
  assert.ok(/node를 찾지 못했어요/.test(h.log.warn[0]));
  h = harness({ spawnMode: "error-then-close" });
  assert.strictEqual(await h.api.runDeepseekConnectionCheck(), "error");
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(h.log.warn.length, 1, h.log.warn.join("|"));
});

t("실행 직후 예외(프로세스를 띄우지 못함)도 실패 알림 한 번 · 선택 저장은 유지(1회차 구현 검증 blocker)", async () => {
  let h = harness({ spawnMode: "throw" });
  assert.strictEqual(await h.api.runDeepseekConnectionCheck(), "error");
  assert.strictEqual(h.log.warn.length, 1); assert.ok(/연결 점검 실행 실패\. 키는 등록돼 있고 선택은 저장됐어요/.test(h.log.warn[0]), h.log.warn.join("|"));
  h = harness({ hasKey: true, prevArm: null, spawnMode: "throw" });
  await h.api.setScoutArmFromUi("D:/w", "deepseek");
  assert.deepStrictEqual(h.log.saved, [{ scoutArm: "deepseek" }]); assert.strictEqual(h.log.progress.length, 1); assert.strictEqual(h.log.warn.length, 1);
});
t("문서·화면 어디에도 '3트랙을 켤 때 연결 점검' 옛 시점이 없음(PRIVACY·README 한/영·화면 문자열 — 1회차 구현 검증 blocker)", () => {
  const OLD_KO = /3트랙(을)? 켤 때(의)? (\*\*)?(<b>)?연결 점검/, OLD_EN = /connection check(<\/b>)? when (you switch on 3-track|3-track is switched on)/i;
  for (const f of ["PRIVACY.md", "README.md", "docs/README.en.md"]) {
    const s = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!OLD_KO.test(s) && !OLD_EN.test(s), f);
  }
  const code = SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!OLD_KO.test(code) && !OLD_EN.test(code), "src 화면 문자열");
  const pv = fs.readFileSync(path.join(ROOT, "PRIVACY.md"), "utf8");
  assert.ok(/탐색 담당을 DeepSeek 으로 새로 고를 때 연결 점검 요청 1회/.test(pv) && /탐색 담당을 DeepSeek 으로 새로 고를 때의 연결 점검\(ping\) 1회/.test(pv), "PRIVACY 요약·deepseek.json 행");
  assert.ok(/은 탐색 담당을 DeepSeek 으로 새로 고를 때만 보내요/.test(code) && /is sent only when you newly pick DeepSeek as the scout/.test(code), "고급설정 키 칸 본문(한/영)");
});

// ── 3트랙 켤 때: DeepSeek 호출 없음 · 담당·준비 안내만 ──
t("3트랙 저장 처리(켤 때 포함)에 DeepSeek 연결 점검·ping 호출이 없음 · 안내 문구는 정찰 담당 기준", () => {
  const blk = between(OUT, 'if (m?.type === "saveContract") {', "// reqId 결속(2026-07-15)"); // 저장 처리의 끝(앞쪽 조기 응답 지점이 아니라 정상 흐름의 마지막 응답 직전까지)
  assert.ok(!/deepseek-bridge\.js/.test(blk) && !/runDeepseekConnectionCheck\(/.test(blk) && !/" ping"/.test(blk), "켤 때 DeepSeek 호출 없음");
  assert.ok(/3트랙\(정찰\)이 켜졌어요 — 정찰은 /.test(blk) && /scoutArmTextExt\(wsK, effK, "ko"\)/.test(blk), "정찰 담당 안내");
  assert.ok(/armK\.raw === "deepseek" && !armK\.hasKey/.test(blk) && /\.\.\.\(dsNoKey \? \[goK\] : \[\]\)/.test(blk), "DeepSeek 을 골라 뒀는데 키가 없을 때만 [등록하러 가기]");
  // 연결 점검은 탐색 담당 선택 함수에서만 부른다
  assert.strictEqual((OUT.match(/await runDeepseekConnectionCheck\(\)/g) || []).length, 1);
  assert.ok(/prevArm !== "deepseek" && readDeepseekView\(\)\.hasKey\)\s*await runDeepseekConnectionCheck\(\)/.test(pickSrc));
});
t("옛 '비교 정찰(두 번째 정찰자)' 문구가 화면 문자열에 남지 않음(경위 주석만 허용)", () => {
  const code = SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  for (const re of [/비교 정찰/, /두 번째 정찰/, /comparison scout/i, /second scout/i, /정찰만 분업/]) assert.ok(!re.test(code), String(re));
  assert.ok(/탐색 담당·의미 보강 담당에서 DeepSeek 을 고를 때만 필요/.test(code));
});

// ── 의미 보강 담당 줄: 고른 방식이 쓰는 모델 표시(실제 화면 조각 실행 · DOM 대역) ──
const lineSrc = between(SRC, '          safe(function(){\n            const mdl=document.createElement("div")', "\n          // degraded 배지") ;
function renderLine(mode, d, en) {
  const row = { kids: [], appendChild(x) { this.kids.push(x); } };
  const document = { createElement: () => ({ className: "", id: "", style: {}, textContent: "" }) };
  const T = (ko, enT) => (en ? enT : ko);
  new Function("document", "T", "d", "mm", "row", "safe", lineSrc)(document, T, d, { mode, raw: mode }, row, (f) => f());
  assert.strictEqual(row.kids.length, 1); assert.strictEqual(row.kids[0].id, "mapModelLine");
  return row.kids[0].textContent;
}
t("의미 보강 줄 '쓰는 모델' — Claude=지정 없음 · DeepSeek=설정 모델 · Codex=정찰 설정 공유 · 자동=둘 다", () => {
  const d = { scoutCodex: { model: "gpt-x", reasoning: "high" }, deepseek: { hasKey: true, model: "deepseek-v9" } };
  assert.ok(/Claude Code 기본 모델 — 따로 지정하지 않음/.test(renderLine("self", d)));
  assert.ok(/DeepSeek deepseek-v9/.test(renderLine("economy", d)) && !/Codex gpt-x/.test(renderLine("economy", d)));
  const p = renderLine("precision", d);
  assert.ok(/Codex gpt-x · 추론 강도 high/.test(p) && /'Codex 정찰 모델·추론 강도'를 정찰과 함께 씀/.test(p), p);
  const a = renderLine("auto", d);
  assert.ok(/DeepSeek deepseek-v9/.test(a) && /정밀이 필요하면 Codex gpt-x/.test(a), a);
  const e = renderLine("precision", { scoutCodex: { model: "", reasoning: "" }, deepseek: null });
  assert.ok(/Codex codex 기본 모델 · 추론 강도 codex 기본값/.test(e), e);
  assert.ok(/DeepSeek deepseek-v4-flash/.test(renderLine("economy", {})), "DeepSeek 모델 기본값");
  assert.ok(/^Model used — Codex gpt-x · effort high — shares/.test(renderLine("precision", d, true)), "영문");
});

// ── 의미 보강 안내 새 탭: 모델 출처 문단 · 점검 시점 정정(실제 함수 실행) ──
const guideSrc = between(OUT, "function openMapModeGuide() {", "\nfunction ");
function guideHtml(en, sc, dsModel) {
  let html = "";
  const vscode = { ViewColumn: { Beside: 2 }, window: { createWebviewPanel: () => ({ webview: { set html(v) { html = v; }, get html() { return html; } } }) } };
  new Function("vscode", "tE", "loadLangExt", "require", "path", "BRIDGE_DIR", "readScoutCodexPrefsExt", "readDeepseekView", guideSrc + "\nopenMapModeGuide();")(
    vscode, (ko, enT) => (en ? enT : ko), () => (en ? "en" : "ko"), require, path, path.join(__dirname, "no-such-bridge-home"), () => sc, () => ({ hasKey: true, masked: "", model: dsModel }));
  return html;
}
t("안내 새 탭 — 지금 설정 값으로 모델 출처를 보여 주고(이름은 안전 표시) 점검 시점을 실제대로 설명", () => {
  const h = guideHtml(false, { model: "gpt-<x>", reasoning: "low" }, "ds-1");
  assert.ok(/어떤 모델로 도나 —/.test(h) && /지금 gpt-&lt;x&gt; · low/.test(h) && /지금 ds-1/.test(h) && !/gpt-<x>/.test(h), "모델 출처·이름 안전 표시");
  assert.ok(/의미 보강 전용 모델 설정은 따로 없어요/.test(h));
  assert.ok(/모드를 고를 때\(확인 창 뒤/.test(h) && !/버튼을 눌렀을 때만/.test(h), "점검 시점 정정");
  const he = guideHtml(true, { model: "", reasoning: "" }, "deepseek-v4-flash");
  assert.ok(/Which model runs —/.test(he) && /now codex default model · codex default effort/.test(he) && /Checks run when you pick a mode/.test(he) && !/Only pressing the button/.test(he));
});
t("Codex 정찰 설정 칸이 실제 적용 범위(정찰·의미 보강·정리 담당)를 말함 · 저장 알림도", () => {
  assert.ok(/Codex 가 맡는 정찰\(탐색 담당=Codex\)·의미 보강\(정밀형·자동형의 Codex 쪽/.test(SRC) && !/탐색 담당을 Codex로 선택했을 때의 정찰 실행에만 적용/.test(SRC));
  assert.ok(/저장됨 ✓ \(다음 Codex 정찰·의미 보강부터 적용\)/.test(SRC));
});

(async () => {
  for (const [name, fn] of pending) {
    try { await fn(); n++; console.log("  ✅ " + name); } catch (e) { console.log("  ❌ " + name + "\n     " + (e && e.stack || e)); process.exitCode = 1; }
  }
  console.log("\ndeepseek-pick-check 결과: " + n + "/" + pending.length + " 통과");
})();
