// 내구 검증 job 회귀: 외부 호출창과 독립된 worker가 dashboard timeout 스냅샷을 유지하고 결과를 job에 남긴다.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ask_job_"));
const jobDir = path.join(tmp, "ask-jobs"); fs.mkdirSync(jobDir, { recursive: true });
const fake = path.join(tmp, "fake-bridge.js");
fs.writeFileSync(fake, [
  'const fs=require("fs");',
  'const j=JSON.parse(fs.readFileSync(process.env.CODEX_BRIDGE_JOB_PROMPT_FILE,"utf8"));',
  'if(j.prompt.includes("concurrent"))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);',
  'process.stdout.write("answer:"+j.prompt+":timeout="+process.env.CODEX_BRIDGE_VERIFY_TIMEOUT_MIN+":deadline="+(process.env.CODEX_BRIDGE_VERIFY_DEADLINE_AT||""));',
].join("\n"));
const id = "ask-test-1", file = path.join(jobDir, id + ".json");
const deadlineAt=new Date(Date.now()+7*60*1000).toISOString();
fs.writeFileSync(file, JSON.stringify({ schema:"ask-job-v1", id, state:"queued", workspace:tmp, execCwd:tmp, flags:["--allow-new"], prompt:"seven-minute-check", timeoutMin:7, deadlineAt }));
const worker = path.join(__dirname, "..", "bridge", "ask-job-worker.js");
const r = cp.spawnSync(process.execPath, [worker, file], { encoding:"utf8", env:{...process.env, CODEX_BRIDGE_WORKER_BRIDGE:fake, CODEX_BRIDGE_VERIFY_TIMEOUT_MIN:"7"}, timeout:10000 });
assert.strictEqual(r.status, 0, r.stderr);
const done = JSON.parse(fs.readFileSync(file, "utf8"));
assert.strictEqual(done.state, "succeeded");
assert.strictEqual(done.exitCode, 0);
assert.match(fs.readFileSync(path.join(jobDir, id + ".out"), "utf8"), /answer:seven-minute-check:timeout=7/);
assert.match(fs.readFileSync(path.join(jobDir, id + ".out"), "utf8"), new RegExp("deadline="+deadlineAt.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")),"worker가 저장된 절대 deadline을 내부 bridge에 전달");
assert.ok(!fs.readFileSync(path.join(jobDir, id + ".out"), "utf8").includes("--job-prompt"), "프롬프트는 명령줄 토큰이 아니라 job 파일에서 전달");

// 완료 job은 ask-wait가 즉시 원문을 회수한다(긴 외부 timeout 불필요).
const wait = cp.spawnSync(process.execPath, [path.join(__dirname,"..","bridge","codex-bridge.js"), "ask-wait", id], {
  encoding:"utf8", env:{...process.env, CODEX_BRIDGE_HOME:tmp, CODEX_BRIDGE_JOB_WAIT_SLICE_MS:"0"}, timeout:10000,
});
assert.strictEqual(wait.status, 0, wait.stderr);
assert.match(wait.stdout, /seven-minute-check/);

const pastId="ask-pidless-past",pastFile=path.join(jobDir,pastId+".json");
fs.writeFileSync(pastFile,JSON.stringify({schema:"ask-job-v1",id:pastId,state:"queued",workspace:tmp,execCwd:tmp,timeoutMin:7,deadlineAt:new Date(Date.now()-1000).toISOString(),workerPid:null}));
const past=cp.spawnSync(process.execPath,[path.join(__dirname,"..","bridge","codex-bridge.js"),"ask-wait",pastId],{encoding:"utf8",env:{...process.env,CODEX_BRIDGE_HOME:tmp,CODEX_BRIDGE_JOB_WAIT_SLICE_MS:"0"},timeout:10000});
assert.notStrictEqual(past.status,0,"PID 없는 queued job도 deadline 경과 시 실패");assert.strictEqual(JSON.parse(fs.readFileSync(pastFile,"utf8")).state,"failed");fs.unlinkSync(pastFile);

// 두 ask-start를 거의 동시에 시작해도 원자 예약 아래 job/worker는 정확히 하나만 생긴다.
const cli=path.join(__dirname,"..","bridge","codex-bridge.js");
const env={...process.env,CODEX_BRIDGE_HOME:tmp,CODEX_BRIDGE_WORKER_BRIDGE:fake,CODEX_BRIDGE_VERIFY_TIMEOUT_MIN:"7"};
const runStart=()=>new Promise((resolve)=>{const c=cp.spawn(process.execPath,[cli,"ask-start","--allow-new","concurrent-check"],{cwd:tmp,env,windowsHide:true});let out="",err="";c.stdout.on("data",d=>out+=d);c.stderr.on("data",d=>err+=d);c.on("close",code=>resolve({code,out,err}));});
Promise.all([runStart(),runStart()]).then(async results=>{
  assert.deepStrictEqual(results.map(x=>x.code).sort(),[0,3],"동시 ask-start 중 한 요청만 예약 성공");
  const jobs=fs.readdirSync(jobDir).filter(n=>n.endsWith(".json"));
  assert.strictEqual(jobs.length,2,"기존 완료 job + 동시 시작에서 생성된 job 하나만 존재");
  const many=fs.mkdtempSync(path.join(os.tmpdir(),"ask_many_")),manyDir=path.join(many,"ask-jobs");fs.mkdirSync(manyDir,{recursive:true});
  fs.writeFileSync(path.join(manyDir,"000-active.json"),JSON.stringify({schema:"ask-job-v1",id:"000-active",state:"running",workspace:many,workerPid:process.pid}));
  for(let i=0;i<250;i++)fs.writeFileSync(path.join(manyDir,`zzz-${String(i).padStart(3,"0")}.json`),JSON.stringify({schema:"ask-job-v1",id:`done-${i}`,state:"succeeded",workspace:many}));
  process.env.CODEX_BRIDGE_HOME=many;const scan=require("../bridge/codex-bridge.js");assert.strictEqual(scan.activeAskJob(many).id,"000-active","완료 job 200개 초과 뒤에도 오래 실행 중인 job을 전수 발견");
  const locked=fs.mkdtempSync(path.join(os.tmpdir(),"ask_lock_")),lockedJobs=path.join(locked,"ask-jobs");fs.mkdirSync(lockedJobs,{recursive:true});
  const norm=path.normalize(locked).replace(/[\\/]+$/,"").toLowerCase().normalize("NFC"),hash=require("crypto").createHash("sha1").update(norm).digest("hex").slice(0,16),lockFile=path.join(lockedJobs,".lock-"+hash);fs.writeFileSync(lockFile,"999999-dead");
  const blocked=cp.spawnSync(process.execPath,[cli,"ask-start","--allow-new","stale-lock-check"],{cwd:locked,encoding:"utf8",env:{...process.env,CODEX_BRIDGE_HOME:locked,CODEX_BRIDGE_WORKER_BRIDGE:fake},timeout:10000});
  assert.notStrictEqual(blocked.status,0,"죽은 job lock도 자동 삭제 없이 fail-closed");assert.strictEqual(fs.readFileSync(lockFile,"utf8"),"999999-dead","stale 관측자가 새 잠금을 지울 ABA 경로 없음");assert.strictEqual(fs.readdirSync(lockedJobs).filter(n=>n.endsWith(".json")).length,0,"잠금 실패 시 job 생성 0");
  console.log("ask-job: 16 assertions passed");
}).catch(e=>{console.error(e);process.exitCode=1;});
