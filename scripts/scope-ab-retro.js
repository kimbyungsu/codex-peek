/*
 * D5 A/B 소급 실측 — 완료된 실제 커밋에 3레벨(통계 S0 / 결정론 꾸러미 L12 / LLM 지도 L3)을 소급 적용해 예측력을 비교한다.
 * (HANDOFF §4·§6-1: 사전 등록 — 두 팔 차이가 오차 수준이면 self 채택. 이 러너는 self 팔 기준. DeepSeek 팔은 --arm deepseek.)
 *
 * 방법(커밋별): ① git worktree로 부모 시점 나무 복원 ② 그 커밋의 '씨앗 파일 1개'(변경량 최대) diff만 작업트리에 적용
 *   = "그 파일을 막 고친 순간" 재현 ③ 각 레벨이 예측한 파일들 vs 그 커밋의 '나머지 실제 변경 파일'(정답) 대조.
 * 지표: hit(정답 중 예측에 든 비율) · missed(놓친 정답 — 치명 후보) · noiseProxy(예측했지만 이번에 안 바뀐 수 — 보수적 근사:
 *   안 바뀌었어도 확인 가치가 있을 수 있음). 미래 누출 없음 — worktree의 git 이력·grep은 부모 시점까지만.
 * 사용: node scripts/scope-ab-retro.js <repo> [--n 6] [--no-llm] [--arm self|deepseek] [--json <out>]
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const repoArg = process.argv[2];
const argN = process.argv.indexOf("--n");
const N = argN > 0 ? Number(process.argv[argN + 1]) : 6;
const NO_LLM = process.argv.includes("--no-llm");
const NO_LEDGER = process.argv.includes("--no-ledger"); // 대조 실측(ablation) — 기억 주입만 끄고 동일 조건 측정(기억 효과 분리)
const argArm = process.argv.indexOf("--arm");
const ARM = argArm > 0 ? process.argv[argArm + 1] : "self";
const argJson = process.argv.indexOf("--json");
const JSON_OUT = argJson > 0 ? process.argv[argJson + 1] : null;
if (!repoArg) { console.error("사용: node scripts/scope-ab-retro.js <repo> [--n 6] [--no-llm] [--arm self|deepseek] [--json <out>]"); process.exit(2); }
const repo = path.resolve(repoArg);

// worktree 경로를 먼저 확정 — safe.directory에 repo와 wt 둘 다 넣는다(wt 쪽 git 호출이 dubious ownership으로 조용히 실패하지 않게).
const wt = path.join(os.tmpdir(), "ab-retro-wt-" + process.pid);
const safeArgs = ["-c", "safe.directory=" + repo.replace(/\\/g, "/"), "-c", "safe.directory=" + wt.replace(/\\/g, "/")];
const git = (cwd, args, input) => {
  const r = spawnSync("git", [...safeArgs, "-C", cwd, ...args], { encoding: "utf8", timeout: 60000, windowsHide: true, input });
  return { ok: r.status === 0 && !r.error, out: String(r.stdout || ""), err: String(r.stderr || "") };
};
const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();
const CODE_RE = /\.(ts|js|mjs|cjs|py|go|rs|java|c|cpp|h|css|html)$/i;

// ── 평가 커밋 선정: non-merge · 변경 3~20파일 · 정답(코드 파일) 2개 이상 · 최근 순 N개 ──
const logR = git(repo, ["log", "--no-merges", "--first-parent", "--pretty=format:%H|%s", "--name-only", "-n", "120"]);
if (!logR.ok) { console.error("git log 실패"); process.exit(1); }
const commits = [];
{
  let cur = null;
  for (const ln of logR.out.split(/\r?\n/)) {
    if (ln.includes("|")) { if (cur) commits.push(cur); const [h, ...s] = ln.split("|"); cur = { hash: h, subject: s.join("|"), files: [] }; }
    else if (ln.trim() && cur) cur.files.push(ln.trim());
  }
  if (cur) commits.push(cur);
}
const picked = [];
for (const c of commits) {
  if (picked.length >= N) break;
  const files = c.files.filter((f) => !/^docs\/.*\.(png|svg|html)$/i.test(f));
  if (files.length < 3 || files.length > 20) continue;
  if (files.filter((f) => CODE_RE.test(f)).length < 2) continue; // 코드 정답이 있어야 평가 의미
  picked.push({ ...c, files });
}
if (!picked.length) { console.error("평가 가능한 커밋 없음"); process.exit(1); }

// ── worktree 재사용(커밋마다 detach checkout + clean) ──
git(repo, ["worktree", "remove", "--force", wt]); // 잔재 정리(있다면)
const addR = git(repo, ["worktree", "add", "--detach", wt, picked[0].hash + "~1"]);
if (!addR.ok) { console.error("worktree 생성 실패:", addR.err.slice(0, 300)); process.exit(1); }

// 지도 텍스트에서 '정답 파일이 언급됐나' — 경로 포함(슬래시 정규화) 또는 basename 단독 언급(보조)
function mentioned(mapText, relPath) {
  const t = norm(mapText);
  const p = norm(relPath);
  if (t.includes(p)) return "path";
  const base = p.split("/").pop();
  if (base && base.length >= 8 && t.includes(base)) return "base"; // 짧은 basename은 우연 일치 위험 → 8자 이상만
  return null;
}

const rows = [];
try {
  for (const c of picked) {
    const parent = c.hash + "~1";
    // ⚠ 본 저장소(repo)에 checkout 금지 — worktree(wt)만 움직인다. 복원 실패는 즉시 skip(이전 커밋 상태로 잘못 채점하는
    // '조용한 오염'이 실측에서 최악). clean은 -fdx — 씨앗 patch가 만든 파일이 ignore 대상이어도 잔재 없이 지운다.
    const co = git(wt, ["checkout", "--force", "--detach", parent]);
    const cl = git(wt, ["clean", "-fdx"]);
    if (!co.ok || !cl.ok) { console.error(`skip ${c.hash.slice(0, 7)}: worktree 복원 실패 — ${(co.err || cl.err).slice(0, 150)}`); continue; }

    // 씨앗 = 변경량(numstat 합) 최대 코드 파일 1개
    const ns = git(repo, ["diff", "--numstat", parent, c.hash]).out.split(/\r?\n/).filter(Boolean)
      .map((l) => { const [a, d, f] = l.split(/\t/); return { churn: (Number(a) || 0) + (Number(d) || 0), f }; })
      .filter((x) => x.f && CODE_RE.test(x.f)).sort((a, b) => b.churn - a.churn);
    if (!ns.length) continue;
    const seed = ns[0].f;
    // 정답 = 씨앗 제외 '그 커밋의 실제 변경 파일 전체'(코드+문서+설정) — "코드 영향만"이 아니라 "함께 손대야 했던 모든 것"을
    // 예측하는 능력을 잰다(문서·package.json 갱신 누락도 실무에선 똑같이 사고). 해석 시 이 기준을 전제할 것.
    const targets = c.files.filter((f) => norm(f) !== norm(seed));
    if (!targets.length) continue;

    // 씨앗 diff만 적용(작업 중 재현). 실패(바이너리 등) 시 skip
    const patch = git(repo, ["diff", parent, c.hash, "--", seed]).out;
    if (!patch.trim()) continue;
    const ap = git(wt, ["apply", "--whitespace=nowarn"], patch);
    if (!ap.ok) { console.error(`skip ${c.hash.slice(0, 7)}: patch 적용 실패`); continue; }

    // L12: 결정론 꾸러미(부모 시점 git grep·이력) — collectPackage를 worktree에 그대로
    delete require.cache[require.resolve("./scope-package.js")];
    const { collectPackage } = require("./scope-package.js");
    const pkg = collectPackage(wt);
    // 관측 장부 주입(2026-07-09 재실측 개보수): worktree는 서랍 키(경로 해시)가 본 레포와 달라 일지가 '구조적으로
    // 빈' 채 측정돼 왔다 — 실사용 꾸러미(§7.5)에는 본 레포 일지가 들어가므로 실측이 실사용보다 불리한 조건이었음.
    // 본 레포 일지를 주입하되 '그 커밋 시각 이전' 이벤트만(시간 절단 — 그 커밋에서 파생된 확인 지식으로 그 커밋을
    // 맞히는 순환·미래 누출 방지). attached 재적재는 안 함(실측이 실장부를 오염시키지 않게 — ledgerForPackage 미사용).
    try {
      if (NO_LEDGER) throw new Error("ablation"); // --no-ledger: 주입 생략(catch가 pkg.ledger=null — 기존 무기억 조건 재현)
      const CLlib = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
      const LE = require(path.join(__dirname, "..", "out", "ledger-events.js"));
      const commitMs = Date.parse(git(repo, ["show", "-s", "--format=%cI", c.hash]).out.trim());
      const evts = LE.parseEventsJsonl(CLlib.readLedgerEventsText(repo)).events.filter((e) => {
        const t = Date.parse(e.ts || "");
        return Number.isFinite(t) && Number.isFinite(commitMs) && t < commitMs;
      });
      pkg.ledger = evts.length ? LE.selectForPackage(LE.deriveLedger(evts), pkg.seeds || []) : null;
      console.error(`  장부 주입: 커밋 시점 이전 이벤트 ${evts.length}건(시간 절단 — 순환 방지)`);
    } catch { pkg.ledger = null; }
    const l12Files = [...new Set((pkg.tokenHits || []).flatMap((h) => h.files))];
    const s0Files = (pkg.coChange && !pkg.coChange.sparse ? pkg.coChange.candidates.map((i) => i.file) : []).filter(Boolean); // suggest()의 실제 형태: {candidates:[{file,..}], sparse}

    // L3: LLM 지도(self 팔 기본) — 같은 꾸러미를 탐색자에게
    let mapText = "";
    if (!NO_LLM) {
      const { renderPackageMarkdown } = require(path.join(__dirname, "..", "out", "scope-package.js"));
      const md = renderPackageMarkdown(pkg);
      if (ARM === "deepseek") {
        // SCOUT_PREFACE_FIXED=1 — 실측은 사용자 프롬프트 수정·언어를 타지 않는다(self 팔 고정 문구와 대칭 · §6-11 P4)
        const r = spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "deepseek-bridge.js"), "map"], { input: md, encoding: "utf8", timeout: 5 * 60 * 1000, windowsHide: true, env: { ...process.env, SCOUT_PREFACE_FIXED: "1" } });
        mapText = r.status === 0 ? String(r.stdout || "") : "";
      } else {
        const DENY = "Bash,Read,Grep,Glob,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent,TodoWrite,KillShell,TaskOutput";
        // ⚠ 의도적 고정(§6-11): 실측 러너는 사전등록 결과(48.1%)와의 비교 안정성을 위해 '기본 프롬프트 원문'을
        // 하드코딩 유지 — 사용자 편집(scout-baseline 슬롯)·언어 전환을 반영하지 않는다(반영하면 실측군이 오염됨).
        const preface = "너는 '탐색자'다. 아래 꾸러미가 유일한 근거다 — 도구는 차단되어 있고, 꾸러미 밖 추측으로 파일을 지어내지 마라. 꾸러미 끝의 [탐색자 지시] 형식을 정확히 따르라.\n\n";
        const r = spawnSync("claude", ["-p", "--output-format", "text", "--disallowedTools", DENY], { input: preface + md, encoding: "utf8", timeout: 8 * 60 * 1000, windowsHide: true, shell: process.platform === "win32" });
        mapText = r.status === 0 ? String(r.stdout || "") : "";
      }
    }

    // 채점
    const score = (predListOrText, isText) => {
      let hit = 0; const missed = [];
      for (const t of targets) {
        const found = isText ? mentioned(predListOrText, t) : predListOrText.some((p) => norm(p) === norm(t));
        if (found) hit++; else missed.push(t);
      }
      return { hit, total: targets.length, missed };
    };
    const l12 = score(l12Files, false);
    const s0 = score(s0Files, false);
    const l3 = mapText ? score(mapText, true) : null;
    // 소음 근사: 예측(언급)됐지만 이번 정답이 아닌 '실존 파일' 수
    const lsAll = git(wt, ["ls-files"]).out.split(/\r?\n/).filter(Boolean);
    const targetSet = new Set(targets.map(norm).concat([norm(seed)]));
    const noiseOf = (files) => files.filter((f) => !targetSet.has(norm(f))).length;
    const l3Mentions = mapText ? lsAll.filter((f) => mentioned(mapText, f)) : [];

    rows.push({
      hash: c.hash.slice(0, 7), subject: c.subject.slice(0, 60), seed, targets: targets.length,
      s0: { hit: s0.hit, missed: s0.missed, noise: noiseOf(s0Files), predicted: s0Files.length },
      l12: { hit: l12.hit, missed: l12.missed, noise: noiseOf(l12Files), predicted: l12Files.length },
      l3: l3 ? { hit: l3.hit, missed: l3.missed, noise: noiseOf(l3Mentions), predicted: l3Mentions.length } : null,
    });
    console.error(`[${c.hash.slice(0, 7)}] seed=${seed} targets=${targets.length} | S0 ${s0.hit}/${s0.total} · L12 ${l12.hit}/${l12.total} · L3 ${l3 ? l3.hit + "/" + l3.total : "-"}`);
  }
} finally {
  git(repo, ["worktree", "remove", "--force", wt]);
}

// ── 집계 ──
const agg = (k) => {
  const rs = rows.filter((r) => r[k]);
  const hit = rs.reduce((s, r) => s + r[k].hit, 0);
  const noise = rs.reduce((s, r) => s + r[k].noise, 0);
  return { evals: rs.length, hit, total: rs.reduce((s, r) => s + r.targets, 0), rate: rs.length ? hit / rs.reduce((s, r) => s + r.targets, 0) : 0, noiseAvg: rs.length ? noise / rs.length : 0 };
};
const pct = (x) => (x * 100).toFixed(1) + "%";
console.log(`\n=== D5 소급 실측(${ARM} 팔) — 커밋 ${rows.length}건 ===`);
for (const k of ["s0", "l12", "l3"]) {
  const a = agg(k);
  if (!a.evals) { console.log(`${k.toUpperCase()}: (평가 없음)`); continue; }
  console.log(`${k.toUpperCase()}: 명중 ${a.hit}/${a.total} = ${pct(a.rate)} · 커밋당 소음근사 ${a.noiseAvg.toFixed(1)}`);
}
console.log(`\n놓친 정답(치명 후보) 상세:`);
for (const r of rows) {
  const miss = (k) => r[k] && r[k].missed.length ? `${k.toUpperCase()}놓침[${r[k].missed.join(", ")}]` : "";
  const m = ["s0", "l12", "l3"].map(miss).filter(Boolean).join(" · ");
  if (m) console.log(`  ${r.hash} ${m}`);
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2));
