// Claude↔Codex / Codex↔Codex 이원화 핵심 불변조건: 프로젝트·언어 슬롯, 역할 세션, 훅 주입/Stop 증명.
const assert=require("assert"),fs=require("fs"),os=require("os"),path=require("path"),cp=require("child_process");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"hmode_"));process.env.CODEX_BRIDGE_HOME=tmp;
const codexHome=path.join(tmp,"codex-home"),sessions=path.join(codexHome,"sessions");process.env.CODEX_HOME=codexHome;fs.mkdirSync(sessions,{recursive:true});
function writeSessionMeta(id,source="vscode",threadSource="user"){const f=path.join(sessions,"rollout-test-"+id+".jsonl");fs.writeFileSync(f,JSON.stringify({type:"session_meta",payload:{id,source,thread_source:threadSource,cwd:ws,originator:"codex_vscode"}})+"\n");return f;}
const lib=require("../bridge/contract-lib.js");
const ws=path.join(tmp,"프로젝트"),other=path.join(tmp,"actual-work");fs.mkdirSync(ws,{recursive:true});fs.mkdirSync(other,{recursive:true});

assert.strictEqual(lib.loadContract(ws,"ko").harnessMode,"claude-codex","기본 모드는 기존 Claude↔Codex");
const koFile=lib.contractFileFor(ws,"ko"),enFile=lib.contractFileFor(ws,"en");
fs.mkdirSync(path.dirname(koFile),{recursive:true});
fs.writeFileSync(koFile,JSON.stringify({harnessMode:"codex-codex",codexImplementer:["구현 규칙"],codexVerifier:["검증 규칙"],verifyMode:"always",scoutMode:"off",scoutRepo:other}));
fs.writeFileSync(enFile,JSON.stringify({harnessMode:"codex-codex",codexImplementer:["implement rule"],codexVerifier:["verify rule"],verifyMode:"code",scoutMode:"off"}));
assert.deepStrictEqual(lib.loadContract(ws,"ko").codexImplementer,["구현 규칙"]);
assert.deepStrictEqual(lib.loadContract(ws,"en").codexImplementer,["implement rule"],"한/영 규칙 슬롯 분리");

const sid="11111111-1111-1111-1111-111111111111",sid2="22222222-2222-2222-2222-222222222222",ver="33333333-3333-3333-3333-333333333333";
fs.writeFileSync(path.join(tmp,"links.json"),JSON.stringify({byWorkspace:{[lib.normWs(ws)]:{workspace:ws,codexSession:ver}},bySession:{},modelPrefs:{[lib.normWs(ws)]:{model:"gpt-base",reasoning:"high"}},settings:{verifyTimeoutMin:7}}));
let reg=lib.registerCodexImplementer(ws,sid,"gpt-5.4","high");assert.ok(reg.ok);reg=lib.registerCodexImplementer(ws,sid2,"gpt-5.4","medium");assert.strictEqual(reg.reason,"relinked","프롬프트를 보낸 현재 대화가 기존 구현 연결을 자동 교체");assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp,"links.json"),"utf8")).byWorkspace[lib.normWs(ws)].implementerSession,sid2);reg=lib.registerCodexImplementer(ws,sid,"gpt-5.4","high");assert.strictEqual(reg.reason,"relinked","다시 대화한 세션으로 구현 역할 복귀");
reg=lib.registerCodexImplementer(ws,ver,"gpt-5.4");assert.strictEqual(reg.reason,"verifier-conflict","구현·검증 동일 세션 금지");
// 먼저 시작한 느린 훅이 신원을 읽는 동안 더 최신 대화가 역할을 가져가면, 오래된 snapshot의 CAS는 실패해야 한다.
const raceClock=JSON.parse(fs.readFileSync(path.join(tmp,"links.json"),"utf8")).byWorkspace[lib.normWs(ws)].implementerEventAt,raceExpected=lib.codexImplementerSnapshot(ws,lib.codexRoleRevision(),raceClock+0.1),raceNew="88888888-8888-8888-8888-888888888888",raceOld="99999999-9999-9999-9999-999999999999";assert.strictEqual(raceExpected.session,sid);
const newerExpected=lib.codexImplementerSnapshot(ws,lib.codexRoleRevision(),raceClock+0.2);reg=lib.registerCodexImplementer(ws,raceNew,"gpt-new","high",newerExpected);assert.ok(reg.ok,"newer prompt wins with its event-start timestamp");
const staleSnapshotTakenLate=lib.codexImplementerSnapshot(ws,lib.codexRoleRevision(),raceClock+0.1);reg=lib.registerCodexImplementer(ws,raceOld,"gpt-old","low",staleSnapshotTakenLate);assert.strictEqual(reg.reason,"implementer-raced","old process start loses even if its snapshot was captured after the newer prompt");assert.strictEqual(lib.codexImplementerSession(ws),raceNew);
reg=lib.registerCodexImplementer(ws,sid,"gpt-5.4","high");assert.ok(reg.ok,"newer activity may return to the original session (ABA)");
reg=lib.registerCodexImplementer(ws,raceOld,"gpt-old","low",raceExpected);assert.strictEqual(reg.reason,"implementer-raced","late old SessionStart cannot overwrite a newer ABA generation");assert.strictEqual(lib.codexImplementerSession(ws),sid);
// C↔C verifier 기본값은 Claude verifier 실시간 상속, 명시 교체만 전용 override. 구현 필드는 보존한다.
process.env.CLAUDE_PROJECT_DIR=ws;const bridge=require("../bridge/codex-bridge.js");const ver2="44444444-4444-4444-4444-444444444444";assert.ok(bridge.recordLink(ver2));
let linked=JSON.parse(fs.readFileSync(path.join(tmp,"links.json"),"utf8")).byWorkspace[lib.normWs(ws)];assert.strictEqual(linked.codexSession,ver,"Claude verifier 원본 보존");assert.strictEqual(linked.codexCodexSession,ver2,"C↔C 전용 verifier만 override");assert.strictEqual(linked.implementerSession,sid);assert.strictEqual(linked.implementerModel,"gpt-5.4");assert.strictEqual(linked.implementerEffort,"high");
reg=lib.registerCodexImplementer(ws,ver2,"gpt-5.6","low");assert.strictEqual(reg.reason,"verifier-conflict","C↔C 전용 verifier도 구현자로 역등록 금지");
assert.strictEqual(bridge.resolveLink(bridge.loadLinks(),ws,"codex-codex").verifierSource,"dedicated");
const latest=bridge.clearStaleVerifier(ver2,ws);assert.strictEqual(latest.codexSession,ver,"전용 verifier 제거 시 Claude verifier로 즉시 복귀");assert.strictEqual(latest.verifierSource,"shared");
const prefs=bridge.loadLinks();assert.strictEqual(bridge.modelPrefFor(prefs,ws,"codex-codex").model,"gpt-base","C↔C pref 없으면 Claude pref 상속");prefs.codexCodexModelPrefs={[lib.normWs(ws)]:{model:"gpt-dedicated",reasoning:"xhigh"}};assert.strictEqual(bridge.modelPrefFor(prefs,ws,"codex-codex").model,"gpt-dedicated","C↔C 전용 pref 우선");delete process.env.CLAUDE_PROJECT_DIR;
assert.strictEqual(bridge.threadIdFromJsonLine(JSON.stringify({type:"thread.started",thread_id:ver2})),ver2,"새 세션 JSON 이벤트에서 즉시 verifier ID 확보");
// 최초 훅 effort가 비었던 경우 후속 훅 값이 기준선을 차지하면 안 된다. rollout 첫 실제값만 확장이 보충한다.
linked=JSON.parse(fs.readFileSync(path.join(tmp,"links.json"),"utf8")).byWorkspace[lib.normWs(ws)];delete linked.implementerEffort;const allLinks=JSON.parse(fs.readFileSync(path.join(tmp,"links.json"),"utf8"));allLinks.byWorkspace[lib.normWs(ws)]=linked;fs.writeFileSync(path.join(tmp,"links.json"),JSON.stringify(allLinks));
reg=lib.registerCodexImplementer(ws,sid,"gpt-5.4","low");assert.ok(reg.ok);assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp,"links.json"),"utf8")).byWorkspace[lib.normWs(ws)].implementerEffort,"","후속 훅 low가 빈 최초 기준선을 덮지 않음");
process.env.CODEX_THREAD_ID=sid;assert.strictEqual(lib.normWs(lib.configWs({cwd:other})),lib.normWs(ws),"active 파일이 없어도 기존 구현 연결로 원래 프로젝트 복구");delete process.env.CODEX_THREAD_ID;
lib.writeCodexActive(sid,ws,{model:"gpt-5.4"});process.env.CODEX_THREAD_ID=sid;assert.strictEqual(lib.normWs(lib.configWs({cwd:other})),lib.normWs(ws),"실제 작업 cwd가 달라도 세션별 프로젝트 앵커 유지");delete process.env.CODEX_THREAD_ID;
const sid3="55555555-5555-5555-5555-555555555555",nested=path.join(other,"nested");fs.mkdirSync(nested,{recursive:true});assert.strictEqual(lib.normWs(lib.configWs({codexSessionId:sid3,cwd:nested})),lib.normWs(ws),"새 대화 첫 훅도 scoutRepo 실제 작업 폴더에서 논리 프로젝트를 역추적");
const freshWs=path.join(tmp,"연결전-프로젝트"),freshRepo=path.join(tmp,"연결전-실작업"),freshNested=path.join(freshRepo,"src");fs.mkdirSync(freshWs,{recursive:true});fs.mkdirSync(freshNested,{recursive:true});fs.writeFileSync(lib.contractFileFor(freshWs,"ko"),JSON.stringify({workspace:freshWs,harnessMode:"codex-codex",scoutRepo:freshRepo,codexImplementer:["fresh rule"]}));assert.strictEqual(lib.normWs(lib.configWs({codexSessionId:"66666666-6666-6666-6666-666666666666",cwd:freshNested})),lib.normWs(freshWs),"verifier/implementer 링크가 전혀 없어도 계약 workspace+scoutRepo로 최초 프롬프트 역추적");

// 훅: 실제 프롬프트를 보낸 현재 세션이 규칙/전달·재판단 원칙과 구현 역할을 함께 넘겨받는다.
const hook=path.join(__dirname,"..","bridge","codex-hook.js");
const hookSrc=fs.readFileSync(hook,"utf8");assert.match(hookSrc,/HOOK_STARTED_AT = require\("perf_hooks"\)\.performance\.timeOrigin/,"process time origin records hook event order before module I/O");assert.match(hookSrc,/const sid=[^\n]+if\(!sid\)return;[\s\S]{0,300}roleRevision=codexRoleRevision\(\);[\s\S]{0,160}maybeCleanupState\(\)[\s\S]{0,900}onSessionStart\(j,ws,sid,c,roleRevision\)/,"hook captures the global role revision before cleanup and workspace discovery");assert.match(hookSrc,/expectedSession = codexImplementerSnapshot\(ws, roleRevision, HOOK_STARTED_AT\)[\s\S]{0,500}isVscodeUserSession\(j, sid\)[\s\S]{0,300}pinImplementer\(j, ws, sid, expectedSession\)/,"hook CAS snapshot includes process-start order before rollout identity I/O");
const env={...process.env,CODEX_BRIDGE_HOME:tmp,CODEX_INTERNAL_ORIGINATOR_OVERRIDE:"codex_vscode"};
function run(input){return cp.spawnSync(process.execPath,[hook],{input:JSON.stringify(input),encoding:"utf8",env,timeout:10000});}
writeSessionMeta(sid,"vscode","user");writeSessionMeta(sid2,"exec","user");
let r=run({hook_event_name:"SessionStart",source:"resume",session_id:sid,cwd:ws,model:"gpt-5.4",reasoning_effort:"high",permission_mode:"default"});assert.strictEqual(r.status,0);assert.match(r.stdout,/구현 규칙/);assert.match(r.stdout,/"hookEventName":"SessionStart"/);let entered=JSON.parse(fs.readFileSync(path.join(tmp,"codex-active",sid+".json"),"utf8"));assert.strictEqual(entered.hookEvent,"SessionStart","resume event pins before a prompt");
const cliStart=cp.spawnSync(process.execPath,[hook],{input:JSON.stringify({hook_event_name:"SessionStart",source:"startup",originator:"codex_vscode",session_id:sid2,cwd:ws,model:"gpt-5.4",permission_mode:"default"}),encoding:"utf8",env:{...env,CODEX_INTERNAL_ORIGINATOR_OVERRIDE:"codex_vscode"},timeout:10000});assert.strictEqual(cliStart.stdout,"","source=exec SessionStart cannot take the implementer role even with inherited codex_vscode origin");assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp,"links.json"),"utf8")).byWorkspace[lib.normWs(ws)].implementerSession,sid,"VS Code implementer remains pinned");
const cliSid="77777777-7777-7777-7777-777777777777";writeSessionMeta(cliSid,"exec","user");const cliPrompt=cp.spawnSync(process.execPath,[hook],{input:JSON.stringify({hook_event_name:"UserPromptSubmit",session_id:cliSid,turn_id:"cli-turn",cwd:ws,model:"gpt-5.4",permission_mode:"default"}),encoding:"utf8",env:{...env,CODEX_INTERNAL_ORIGINATOR_OVERRIDE:"codex_exec"},timeout:10000});assert.strictEqual(cliPrompt.stdout,"","CLI UserPromptSubmit cannot take the implementer role");assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp,"links.json"),"utf8")).byWorkspace[lib.normWs(ws)].implementerSession,sid,"CLI prompt leaves VS Code implementer pinned");
r=run({hook_event_name:"UserPromptSubmit",session_id:sid,turn_id:"t1",cwd:ws,model:"gpt-5.4",reasoning_effort:"high",permission_mode:"default"});assert.strictEqual(r.status,0);assert.match(r.stdout,/구현 규칙/);assert.match(r.stdout,/ask-start/);
// 첫 턴이 기록한 세션 앵커를 따라 실제 작업 폴더가 달라져도 원래 프로젝트/언어 계약을 유지한다.
r=run({hook_event_name:"UserPromptSubmit",session_id:sid,turn_id:"t1b",cwd:other,model:"gpt-5.4",permission_mode:"default"});assert.match(r.stdout,/구현 규칙/);assert.doesNotMatch(r.stdout,/implement rule/);
r=run({hook_event_name:"UserPromptSubmit",session_id:sid,turn_id:"t1c",cwd:other,model:"gpt-6",reasoning_effort:"low",permission_mode:"default"});assert.match(r.stdout,/구현 규칙/);
let active=JSON.parse(fs.readFileSync(path.join(tmp,"codex-active",sid+".json"),"utf8"));assert.strictEqual(active.model,"gpt-6","모델 교체는 응답 전 UserPromptSubmit 현재값으로 기록");assert.strictEqual(active.effort,"low","추론강도 교체도 응답 전 현재값으로 기록");
assert.strictEqual(active.source,"codex-hook","실제 Codex 훅 출처를 기록");assert.strictEqual(active.hookEvent,"UserPromptSubmit","현재 구현 턴의 생존 이벤트를 기록");assert.strictEqual(active.turnId,"t1c","현재 구현 턴과 heartbeat를 대조할 수 있어야 함");
linked=JSON.parse(fs.readFileSync(path.join(tmp,"links.json"),"utf8")).byWorkspace[lib.normWs(ws)];assert.strictEqual(linked.implementerModel,"gpt-5.4","현재 선택값이 최초 모델 기준선을 덮지 않음");assert.strictEqual(linked.implementerEffort,"","최초 훅에 없던 effort 기준선도 후속 선택값으로 오염하지 않음");
r=run({hook_event_name:"PostToolUse",session_id:sid,turn_id:"t1b",cwd:other,tool_name:"Bash",permission_mode:"default"});assert.strictEqual(r.status,0);assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp,"codex-turns",sid+".json"),"utf8")).modified,true,"Bash/commit·비-git 쓰기도 변경 가능 신호로 보존");
active=JSON.parse(fs.readFileSync(path.join(tmp,"codex-active",sid+".json"),"utf8"));assert.strictEqual(active.hookEvent,"PostToolUse","PostToolUse refreshes the signed liveness event");assert.strictEqual(active.turnId,"t1b");assert.strictEqual(active.model,"gpt-6","later hooks preserve model metadata");assert.strictEqual(active.effort,"low","later hooks preserve effort metadata");
writeSessionMeta(sid2,"vscode","user");r=run({hook_event_name:"UserPromptSubmit",session_id:sid2,turn_id:"t2",cwd:ws,model:"gpt-5.4",permission_mode:"default"});assert.match(r.stdout,/구현 규칙/);assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp,"links.json"),"utf8")).byWorkspace[lib.normWs(ws)].implementerSession,sid2,"새 대화의 실제 프롬프트로 구현 연결 자동 이동");
r=run({hook_event_name:"Stop",session_id:sid,turn_id:"t1",cwd:ws,permission_mode:"default"});assert.strictEqual(r.stdout,"","이전 구현 세션의 뒤늦은 Stop은 새 현재 대화를 막지 않음");
r=run({hook_event_name:"Stop",session_id:sid2,turn_id:"t2",cwd:ws,permission_mode:"default"});assert.match(r.stdout,/"decision":"block"/);assert.match(r.stdout,/ask-start/);
// P-6(설계 v5.1): 구계약(v1) proof는 C-C Stop에서 더 이상 인정되지 않는다 — 결속 체인(proof v2+영수증) 필수.
const turn=JSON.parse(fs.readFileSync(path.join(tmp,"codex-turns",sid2+".json"),"utf8"));fs.mkdirSync(path.join(tmp,"proofs"),{recursive:true});fs.writeFileSync(path.join(tmp,"proofs",sid2+".json"),JSON.stringify({status:"success",exit:0,answerChars:10,ts:new Date(turn.startedAt+1000).toISOString()}));
r=run({hook_event_name:"Stop",session_id:sid2,turn_id:"t2",cwd:ws,permission_mode:"default"});assert.match(r.stdout,/"decision":"block"/,"구계약 v1 proof만으로는 C-C Stop 통과 불가(자기무효화 수정 후 결속 체인 필수)");
// 공식 경로 전체(job 동결 스냅샷 → proof v2 → 회수 영수증)를 구성하면 Stop이 통과한다.
const recNow=JSON.parse(fs.readFileSync(path.join(tmp,"links.json"),"utf8")).byWorkspace[lib.normWs(ws)];
const chainJob={schema:"ask-job-v1",id:"ask-hmode1-0123456789",workspace:ws,harnessMode:"codex-codex",implementerSession:sid2,implementerTurnId:"t2",implementerRevision:recNow.implementerRevision,state:"succeeded",exitCode:0,finishedAt:null};
const pw=lib.writeDurableProofV2(ws,chainJob,"검증 답변 본문",ver);assert.ok(pw.ok,"proof v2 기록: "+(pw.reason||""));
chainJob.finishedAt=new Date(Date.now()+1500).toISOString();
const rw=lib.writeRecoveryReceipt(chainJob);assert.ok(rw.ok,"회수 영수증 기록: "+(rw.reason||""));
r=run({hook_event_name:"Stop",session_id:sid2,turn_id:"t2",cwd:ws,permission_mode:"default"});assert.strictEqual(r.stdout,"","결속 체인(proof v2+영수증)이 성립하면 현재 구현 세션 Stop 통과");
// 회수(ask-wait) 이후 다른 도구 호출이 있어도 — lastActionAt 갱신 — proof가 무효화되지 않는다(P-6 핵심).
r=run({hook_event_name:"PostToolUse",session_id:sid2,turn_id:"t2",cwd:ws,tool_name:"Bash",permission_mode:"default"});assert.strictEqual(r.status,0);
r=run({hook_event_name:"Stop",session_id:sid2,turn_id:"t2",cwd:ws,permission_mode:"default"});assert.strictEqual(r.stdout,"","회수 도구 호출의 lastActionAt 갱신이 proof를 자기무효화하지 않음");
assert.match(fs.readFileSync(path.join(__dirname,"..","bridge","verify-guard.js"),"utf8"),/harnessMode === "codex-codex"/,"C-C 모드에서 Claude Stop 훅 무동작");
assert.match(fs.readFileSync(path.join(__dirname,"..","bridge","scout-gate.js"),"utf8"),/harnessMode === "codex-codex"/,"C-C 모드에서 Claude 플랜 훅 무동작");
// 현재 대화가 바뀌면 이전 구현자의 모델 기준선도 함께 넘어오지 않는다.
reg=lib.registerCodexImplementer(ws,sid,"gpt-6","xhigh");assert.strictEqual(reg.reason,"relinked");linked=JSON.parse(fs.readFileSync(path.join(tmp,"links.json"),"utf8")).byWorkspace[lib.normWs(ws)];assert.strictEqual(linked.implementerModel,"gpt-6","새 현재 대화는 자기 모델로 기준선 재설정");assert.strictEqual(linked.implementerEffort,"xhigh","새 현재 대화의 추론강도도 자기 관측값");
const extSrc=fs.readFileSync(path.join(__dirname,"..","src","extension.ts"),"utf8");assert.match(extSrc,/id="planConfirmHelp"/);assert.doesNotMatch(extSrc,/sendText\(`codex plugin marketplace add[^\n]*;/,"Codex 플러그인 설치는 shell 구분자에 의존하지 않음");
assert.doesNotMatch(extSrc,/data-role","implementer|구현 연결","Link implementer/,"수동 구현 연결 UI 없음 — 현재 대화 훅만 자동 고정");
assert.match(extSrc,/Claude Code↔Codex와 동일한 검증 세션을 공유 중/);assert.match(extSrc,/ci-effort:/,"구현 Codex 추론강도 drift 경고 배선");
assert.match(extSrc,/maybeOfferCodexHookSetup\(context\.extensionUri\.fsPath\)/,"확장 활성화 시 Codex 플러그인 설치 동의를 자동 제안");
assert.match(extSrc,/m\.mode==="codex-codex"[\s\S]{0,700}maybeOfferCodexHookSetup/,"C-C 모드 최초 선택 시에도 설치 동의를 제안");
assert.match(extSrc,/registerCommand\("codexBridge\.installCodexHooks"[\s\S]{0,180}await codexHomeReady[\s\S]{0,120}runCodexHookInstallFlow/,"수동 Codex 훅 설치도 실제 CODEX_HOME 동기화를 기다림");
assert.match(extSrc,/syncCodexHome\(\(changed\) => \{[\s\S]{0,900}ready\?\.\(\)[\s\S]{0,900}maybeOfferCodexHookSetup/,"활성화 설치 제안은 codex doctor 홈 확정 뒤 시작");
assert.match(extSrc,/async function runCodexHookInstallFlow[\s\S]{0,100}await codexHomeReady/,"대시보드 포함 모든 설치 입구의 중앙 함수가 CODEX_HOME 장벽을 기다림");
assert.match(extSrc,/if\(codexHomeIsReady\)\{const beforeTrust[\s\S]{0,260}refreshCodexPeekHookTrust/,"doctor 준비 전 render는 hooks\/list 조회를 시작하지 않음");
assert.match(extSrc,/function syncCodexHookHealth\(ws:[^)]*\)[\s\S]{0,100}!codexHomeIsReady[\s\S]{0,30}return/,"computeState·render의 건강 경보도 CODEX_HOME 준비 전 생성 금지");
assert.match(extSrc,/codexHomeIsReady=true;codexHookTrustCache\.reset\(\)[\s\S]{0,500}refreshCodexPeekHookTrust\([^\n]+true\)/,"doctor 완료 시 pre-ready 캐시를 폐기하고 현재 홈으로 강제 조회");
assert.match(extSrc,/if\(codexHookOfferShown\)return;[\s\S]{0,180}codexHookOfferShown=true;[\s\S]{0,220}await codexPeekPluginState/,"활성화와 C-C 선택의 비동기 경합 전에 설치 제안 선점");
assert.match(extSrc,/\["app-server","--stdio"\][\s\S]{0,2400}"hooks\/list"/,"설치 목록이 아니라 app-server hooks/list로 실제 훅 신뢰 상태 조회");
assert.match(extSrc,/state\.present&&state\.enabled[\s\S]{0,250}refreshCodexPeekHookTrust[\s\S]{0,150}showCodexHookTrustWarning/,"설치·활성 상태여도 미신뢰면 자동 경고");
assert.match(extSrc,/if\(state\.present&&!state\.enabled\)[\s\S]{0,900}활성화한 뒤 Hook에서 네 훅을 검토·신뢰[\s\S]{0,300}구현 연결이 자동 이동/,"비활성 자동 경고도 활성화·네 훅 신뢰→현재 대화 자동 이동을 안내");
assert.doesNotMatch(extSrc,/기존 구현 세션을 숨겨 연결을 (?:명시적으로 )?해제|hide the old implementer session/,"구현 자동귀속 전에 수동 unlink가 필요하다는 오안내 제거");
const healthSrc=fs.readFileSync(path.join(__dirname,"..","src","codex-hook-health.ts"),"utf8"),pkg=JSON.parse(fs.readFileSync(path.join(__dirname,"..","package.json"),"utf8"));assert.match(healthSrc,/snapshot\.queried !== true[\s\S]{0,120}hooks-unverified/,"hooks/list 조회 전·실패도 fail-closed");assert.match(pkg.scripts.test,/tests\/codex-hook-health\.test\.js/,"훅 생존·신뢰 테스트가 전체 npm test 체인에 포함");
assert.match(extSrc,/new CodexHookTrustCache[\s\S]{0,500}codexHookTrustCwd/,"훅 신뢰 캐시는 실제 조회 CWD별로 분리");assert.match(extSrc,/refreshCodexPeekHookTrust\(context\.extensionUri\.fsPath, codexHookTrustCwd\(ws\)\)/,"주기 조회도 논리 폴더가 아닌 명시 scoutRepo를 우선");
assert.match(extSrc,/codexHookReady: hookHealth\.ready/,"대시보드 준비 상태에 실제 훅 heartbeat 판정을 배선");
assert.match(extSrc,/e\.kind!=="session-missing"&&e\.kind!=="codex-hook-missing"/,"훅 미작동 차단 경보는 확인 버튼으로 숨길 수 없음");

console.log("harness-mode: all assertions passed");
