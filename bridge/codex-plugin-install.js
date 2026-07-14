"use strict";
const fs=require("fs");
const path=require("path");

function cmdQuote(s){return '"'+String(s).replace(/"/g,'""')+'"';}
function buildCodexPluginSpawn(raw,args,platform=process.platform,nodeBin=process.execPath,comspec=process.env.ComSpec||"cmd.exe"){
  const target=String(raw||"codex").trim()||"codex",ext=path.extname(target).toLowerCase(),bare=!/[\\/]/.test(target),rest=Array.isArray(args)?args.map(String):[];
  if(ext===".js")return{file:nodeBin,args:[target,...rest],shell:false,windowsVerbatimArguments:false,env:{ELECTRON_RUN_AS_NODE:"1"}};
  if(platform==="win32"&&(ext===".cmd"||ext===".bat"||bare)){
    // /s /c의 바깥 따옴표 + 각 토큰 따옴표. 실행파일/프로젝트 경로의 공백·&를 cmd가 분리하지 못하게 한다.
    // bare PATH 이름은 인용하면 확장자 없는 POSIX shim을 먼저 집을 수 있어 PATHEXT(.cmd/.exe) 해석이 깨진다.
    const command=bare?[target,...rest.map(cmdQuote)].join(" "):'"'+[target,...rest].map(cmdQuote).join(" ")+'"';
    return{file:comspec,args:["/d","/s","/c",command],shell:false,windowsVerbatimArguments:true,env:{}};
  }
  return{file:target,args:rest,shell:false,windowsVerbatimArguments:false,env:{}};
}
function normRoot(p,platform=process.platform){let s=path.normalize(String(p||"")).replace(/[\\/]+$/,"").normalize("NFC");return platform==="win32"?s.toLowerCase():s;}
function marketplaceRootMatches(stdout,name,root,platform=process.platform){
  try{const o=JSON.parse(String(stdout||"")),a=Array.isArray(o.marketplaces)?o.marketplaces:[];return a.some(x=>x&&x.name===name&&normRoot(x.root,platform)===normRoot(root,platform));}catch{return false;}
}
function marketplaceStepOk(addCode,listCode,listStdout,name,root,platform=process.platform){return addCode===0||(listCode===0&&marketplaceRootMatches(listStdout,name,root,platform));}
const CODEX_PEEK_PLUGIN_IDS=new Set(["codex-peek@personal","codex-peek@codex-peek-local"]);
function isCodexPeekPluginId(id){return CODEX_PEEK_PLUGIN_IDS.has(String(id||"").toLowerCase());}
function codexPeekPluginState(stdout){
  try{
    const o=JSON.parse(String(stdout||"")),a=Array.isArray(o.installed)?o.installed:[],p=a.find(x=>x&&x.name==="codex-peek"&&isCodexPeekPluginId(x.pluginId)&&x.installed!==false);
    return p?{present:true,enabled:p.enabled!==false,pluginId:String(p.pluginId||"")}:{present:false,enabled:false,pluginId:""};
  }catch{return{present:false,enabled:false,pluginId:""};}
}
const CODEX_PEEK_HOOK_EVENTS=["sessionStart","userPromptSubmit","postToolUse","stop"];
const CODEX_PEEK_USER_HOOKS=[
  {event:"SessionStart",eventName:"sessionStart",matcher:"startup|resume",statusMessage:"Pinning the active Codex implementer session"},
  {event:"UserPromptSubmit",eventName:"userPromptSubmit",statusMessage:"Loading Codex Peek project rules"},
  {event:"PostToolUse",eventName:"postToolUse",matcher:"Bash|apply_patch|Edit|Write|MultiEdit|NotebookEdit|mcp__.*",statusMessage:"Recording Codex Peek work signals"},
  {event:"Stop",eventName:"stop",statusMessage:"Checking Codex Peek verification gate"},
];
function fwd(p){return String(p||"").replace(/\\/g,"/");}
function shellQuote(p){return '"'+String(p||"").replace(/"/g,'\\"')+'"';}
function codexPeekHookCommand(nodeToken,bridgeDir){return String(nodeToken||"node")+" "+shellQuote(fwd(path.join(bridgeDir,"codex-hook.js")));}
// ── P-5 확정 원인 ②: Codex는 Windows에서 훅을 '감지된 기본 셸(대개 PowerShell) -NoProfile -Command'로 실행한다.
// `"C:\...\node.exe" "script"`처럼 따옴표 경로로 시작하는 명령은 PS에선 문자열 나열(ParserError 즉사·무로그)이라
// bare `node`만이 PS·cmd 양쪽 유효 — 설치 전 양쪽 셸에서 실제 실행해 검증한다(가정 금지·실검증).
function nodeTokenRunsInShell(nodeToken,shellKind){
  const probe=String(nodeToken)+' -e "process.stdout.write(String(6*7))"';
  const {spawnSync}=require("child_process");
  try{
    const r=shellKind==="powershell"
      ?spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",probe],{encoding:"utf8",timeout:20000,windowsHide:true})
      :shellKind==="cmd"
      ?spawnSync(probe,{shell:process.env.ComSpec||"cmd.exe",encoding:"utf8",timeout:20000,windowsHide:true})
      :spawnSync(probe,{shell:true,encoding:"utf8",timeout:20000,windowsHide:true});
    return r.status===0&&String(r.stdout||"").trim()==="42";
  }catch{return false;}
}
// Codex 훅용 node 토큰 판정 — win32는 PS와 cmd 둘 다 통과해야 유효(둘 중 무엇이 기본 셸이어도 훅이 산다).
function nodeTokenDualShellOk(nodeToken,platform=process.platform){
  if(platform!=="win32")return nodeTokenRunsInShell(nodeToken,"posix");
  return nodeTokenRunsInShell(nodeToken,"powershell")&&nodeTokenRunsInShell(nodeToken,"cmd");
}
// 기존 설치본 마이그레이션 감지(P-5 ⓓ): 우리 훅인데 node 토큰이 따옴표 경로로 시작하면 PS 기본 셸에서 즉사하는 옛 형식.
function codexPeekHookCommandNeedsMigration(command,bridgeDir){
  if(!isCodexPeekHookCommand(command,bridgeDir))return false;
  return /^\s*"/.test(String(command||""));
}
// ── P-5 순수 상태기 2종 — vscode 무의존(확장이 require해 쓰고, 테스트가 같은 팩토리를 직접 실행해
// 순서 계약을 잠근다 — 정규식 잠금만으로는 경합 의미 변화를 못 잡는다는 Codex 지적 반영).
// ①설치 제안 게이트: auto(활성화)는 창당 1회, 명시 진입(사용자 클릭)은 항상 처리하되 실행 중이면
//   큐에 보존해 종료 후 정확히 1회 재실행(유실·중복 소비 금지).
function createCodexHookOfferGate(){
  let running=false,queued=false,shown=false;
  return{
    // 진입 판정: run=본문 실행 / queued=명시 요청 보존(종료 후 재실행 예약) / skip=아무것도 안 함
    enter(auto){
      if(running){if(!auto)queued=true;return{act:auto?"skip":"queued"};}
      if(auto&&shown)return{act:"skip"};
      running=true;shown=true;return{act:"run"};
    },
    // 본문 종료: rerun이면 호출측이 명시 진입으로 정확히 1회 재실행(큐는 여기서 소비)
    finish(){running=false;const q=queued;queued=false;return{act:q?"rerun":"idle"};},
    // auto 조회 실패의 조용 종료 — 팝업을 안 보여줬으므로 auto 재시도 여지를 되돌린다
    silentAutoFail(){shown=false;},
    state(){return{running,queued,shown};},
  };
}
// ②리로드 세대 추적: 훅 파일 해시·신뢰 전이(미준비→준비, 재신뢰 포함)를 세대로 묶어
//   '바뀐 세대의 ready'에서만 1회 권고. 조회 실패(queried=false)는 사실이 아니므로 무시.
function createCodexHookReloadTracker(){
  let firstReady=null,lastReady=null,transitions=0,promptedGen="";
  return{
    observe(queried,ready,fileHashNow,fileHashAtLoad,trusted,untrusted){
      if(!queried)return{prompt:false,gen:""};
      if(firstReady===null)firstReady=ready;
      if(lastReady===false&&ready)transitions++; // ready→unready→ready 재전이도 각각 새 세대(Codex 반례)
      lastReady=ready;
      if(!ready)return{prompt:false,gen:""};
      const gen=String(fileHashNow)+":"+trusted+"/"+untrusted+":"+transitions;
      const changed=fileHashNow!==fileHashAtLoad||firstReady===false||transitions>0;
      if(!changed||gen===promptedGen)return{prompt:false,gen};
      promptedGen=gen;
      return{prompt:true,gen};
    },
  };
}
function detectCodexPeekHookMigration(file,bridgeDir){
  const r=readHookRoot(file);if(!r.ok||r.raw===null)return{needed:false,count:0};
  let count=0;
  for(const h of CODEX_PEEK_USER_HOOKS){
    const groups=r.root.hooks&&Array.isArray(r.root.hooks[h.event])?r.root.hooks[h.event]:[];
    for(const g of groups)for(const x of(g&&Array.isArray(g.hooks)?g.hooks:[]))
      if(x&&(codexPeekHookCommandNeedsMigration(x.commandWindows,bridgeDir)||codexPeekHookCommandNeedsMigration(x.command,bridgeDir)))count++;
  }
  return{needed:count>0,count};
}
function exactNodeHookTarget(command){
  const m=/^\s*(?:"([^"\r\n]+)"|([^\s"'`;&|<>]+))\s+"([^"\r\n]+)"\s*$/.exec(String(command||""));
  if(!m)return"";
  const exe=fwd(m[1]||m[2]),base=exe.slice(exe.lastIndexOf("/")+1).toLowerCase();
  return base==="node"||base==="node.exe"?m[3]:"";
}
function isCodexPeekHookCommand(command,bridgeDir){
  const actual=exactNodeHookTarget(command);if(!actual)return false;
  if(!bridgeDir)return path.basename(actual).toLowerCase()==="codex-hook.js";
  return normRoot(actual)===normRoot(path.join(bridgeDir,"codex-hook.js"));
}
function atomicWrite(file,data){
  const tmp=file+"."+process.pid+"."+Math.random().toString(36).slice(2)+".tmp";
  try{
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(tmp,data,"utf8");
    for(let i=0;i<12;i++)try{fs.renameSync(tmp,file);return true;}catch{try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15);}catch{}}
  }catch{}
  try{fs.unlinkSync(tmp);}catch{}return false;
}
function readHookRoot(file){
  let raw=null;try{raw=fs.readFileSync(file,"utf8");}catch{}
  if(raw===null)return{ok:true,raw:null,root:{}};
  try{const root=JSON.parse(raw);if(!root||typeof root!=="object"||Array.isArray(root))return{ok:false,reason:"hooks.json root must be an object"};return{ok:true,raw,root};}
  catch{return{ok:false,reason:"hooks.json is not valid JSON"};}
}
function hookShapeProblem(root){
  if(root.hooks!==undefined&&(!root.hooks||typeof root.hooks!=="object"||Array.isArray(root.hooks)))return"hooks must be an object";
  for(const h of CODEX_PEEK_USER_HOOKS)if(root.hooks&&root.hooks[h.event]!==undefined&&!Array.isArray(root.hooks[h.event]))return"hooks."+h.event+" must be an array";
  return"";
}
function stripCodexPeekHooks(root,bridgeDir){
  let removed=0;const hooks=root.hooks&&typeof root.hooks==="object"&&!Array.isArray(root.hooks)?root.hooks:{};
  for(const h of CODEX_PEEK_USER_HOOKS){
    const groups=Array.isArray(hooks[h.event])?hooks[h.event]:[],cleaned=[];
    for(const group of groups){
      if(group&&Array.isArray(group.hooks)){
        const kept=group.hooks.filter(x=>!(x&&isCodexPeekHookCommand(x.commandWindows||x.command,bridgeDir)));
        removed+=group.hooks.length-kept.length;
        if(kept.length)cleaned.push({...group,hooks:kept});
        else if(kept.length===group.hooks.length)cleaned.push(group);
      }else if(group)cleaned.push(group);
    }
    if(cleaned.length)hooks[h.event]=cleaned;else delete hooks[h.event];
  }
  root.hooks=hooks;return removed;
}
function installCodexPeekUserHooks(file,bridgeDir,nodeToken="node"){
  // writer 불변조건(P-5): 따옴표로 시작하는 토큰("<절대경로>")은 Windows 기본 셸이 PowerShell일 때 즉사하는
  // 형식이라 어떤 호출자도 기입 불가(구조 거부). 실셸 dual 검증은 해석기(resolveNodeTokenDual)의 몫이고,
  // 이 관문은 검증을 우회한 직접 호출로 옛 결함이 재발하는 경로를 결정적으로 막는다.
  const tokenStr=String(nodeToken||"").trim();
  if(!tokenStr||/^"/.test(tokenStr))return{ok:false,reason:"node token must not be empty or a quoted path (quoted paths fail under a PowerShell default shell)"};
  const r=readHookRoot(file);if(!r.ok)return{ok:false,reason:r.reason};
  const problem=hookShapeProblem(r.root);if(problem)return{ok:false,reason:problem};
  let backup="";
  if(r.raw!==null){backup=file+".bak."+new Date().toISOString().replace(/[:.]/g,"-");try{fs.writeFileSync(backup,r.raw,"utf8");}catch{return{ok:false,reason:"could not back up hooks.json"};}}
  const root=r.root;stripCodexPeekHooks(root,bridgeDir);root.hooks=root.hooks||{};
  const command=codexPeekHookCommand(nodeToken,bridgeDir);
  for(const h of CODEX_PEEK_USER_HOOKS){
    const entry={type:"command",command,commandWindows:command,timeout:30,statusMessage:h.statusMessage};
    const group={hooks:[entry]};if(h.matcher)group.matcher=h.matcher;
    const arr=Array.isArray(root.hooks[h.event])?root.hooks[h.event]:[];arr.push(group);root.hooks[h.event]=arr;
  }
  if(!atomicWrite(file,JSON.stringify(root,null,2)+"\n"))return{ok:false,reason:"could not write hooks.json",backup};
  return{ok:true,backup};
}
const CODEX_PEEK_HOOK_OWNER_SCHEMA="codex-peek-user-hooks-v1";
function readCodexPeekHookOwner(markerFile,expectedBridgeDir=""){
  let raw;try{raw=fs.readFileSync(markerFile,"utf8");}catch(e){return e&&e.code==="ENOENT"?{ok:true,present:false,hookFiles:[],bridgeDir:""}:{ok:false,present:false,hookFiles:[],bridgeDir:"",reason:"could not read hook ownership marker"};}
  try{
    const o=JSON.parse(raw),files=o&&Array.isArray(o.hookFiles)?o.hookFiles:[];
    if(!o||o.schema!==CODEX_PEEK_HOOK_OWNER_SCHEMA||typeof o.bridgeDir!=="string"||!o.bridgeDir||!files.length||files.some(x=>typeof x!=="string"||!path.isAbsolute(x)||path.basename(x).toLowerCase()!=="hooks.json"))return{ok:false,present:true,hookFiles:[],bridgeDir:"",reason:"invalid hook ownership marker"};
    if(expectedBridgeDir&&normRoot(o.bridgeDir)!==normRoot(expectedBridgeDir))return{ok:false,present:true,hookFiles:[],bridgeDir:o.bridgeDir,reason:"hook ownership marker belongs to another bridge directory"};
    const unique=[];for(const file of files)if(!unique.some(x=>normRoot(x)===normRoot(file)))unique.push(file);
    return{ok:true,present:true,hookFiles:unique,bridgeDir:o.bridgeDir,installedAt:String(o.installedAt||"")};
  }catch{return{ok:false,present:true,hookFiles:[],bridgeDir:"",reason:"invalid hook ownership marker"};}
}
function restoreFileSnapshot(file,raw){
  if(raw===null){try{fs.unlinkSync(file);}catch(e){if(!e||e.code!=="ENOENT")return false;}return true;}
  return atomicWrite(file,raw);
}
function withCodexPeekHookOwnerLock(bridgeDir,fn){
  const lockFile=path.join(bridgeDir,"codex-hooks-installed-by-extension.lock"),token=process.pid+"-"+Math.random().toString(36).slice(2);let locked=false;
  try{fs.mkdirSync(bridgeDir,{recursive:true});}catch{return{ok:false,reason:"could not create hook ownership lock directory"};}
  for(let i=0;i<200&&!locked;i++){
    try{fs.writeFileSync(lockFile,token,{encoding:"utf8",flag:"wx"});locked=true;}
    catch{try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15);}catch{}}
  }
  if(!locked)return{ok:false,reason:"hook ownership lock is busy"};
  try{return fn();}
  catch(e){return{ok:false,reason:String(e&&e.message||e||"hook ownership operation failed")};}
  finally{try{if(fs.readFileSync(lockFile,"utf8")===token)fs.unlinkSync(lockFile);}catch{}}
}
function installCodexPeekOwnedUserHooksUnlocked(file,bridgeDir,nodeToken="node",markerFile=path.join(bridgeDir,"codex-hooks-installed-by-extension")){
  if(!fs.existsSync(path.join(bridgeDir,"codex-hook.js")))return{ok:false,reason:"Codex hook runtime is missing"};
  const owner=readCodexPeekHookOwner(markerFile,bridgeDir);if(!owner.ok)return{ok:false,reason:owner.reason};
  let before=null;try{before=fs.readFileSync(file,"utf8");}catch(e){if(!e||e.code!=="ENOENT")return{ok:false,reason:"could not snapshot hooks.json"};}
  const installed=installCodexPeekUserHooks(file,bridgeDir,nodeToken);if(!installed.ok)return installed;
  const hookFiles=owner.present?owner.hookFiles.slice():[];if(!hookFiles.some(x=>normRoot(x)===normRoot(file)))hookFiles.push(path.resolve(file));
  const marker={schema:CODEX_PEEK_HOOK_OWNER_SCHEMA,bridgeDir:path.resolve(bridgeDir),hookFiles,installedAt:new Date().toISOString()};
  if(!atomicWrite(markerFile,JSON.stringify(marker,null,2)+"\n")){
    const restored=restoreFileSnapshot(file,before);
    return{ok:false,reason:restored?"could not write hook ownership marker; hooks.json was restored":"could not write hook ownership marker and could not restore hooks.json",backup:installed.backup};
  }
  return{...installed,markerFile,hookFiles};
}
function installCodexPeekOwnedUserHooks(file,bridgeDir,nodeToken="node",markerFile=path.join(bridgeDir,"codex-hooks-installed-by-extension")){
  return withCodexPeekHookOwnerLock(bridgeDir,()=>installCodexPeekOwnedUserHooksUnlocked(file,bridgeDir,nodeToken,markerFile));
}
function removeCodexPeekUserHooks(file,bridgeDir){
  const r=readHookRoot(file);if(!r.ok)return{ok:false,reason:r.reason};if(r.raw===null)return{ok:true,removed:0};
  const problem=hookShapeProblem(r.root);if(problem)return{ok:false,reason:problem};
  const removed=stripCodexPeekHooks(r.root,bridgeDir);if(!removed)return{ok:true,removed:0};
  if(r.root.hooks&&!Object.keys(r.root.hooks).length)delete r.root.hooks;
  const backup=file+".bak."+new Date().toISOString().replace(/[:.]/g,"-");try{fs.writeFileSync(backup,r.raw,"utf8");}catch{return{ok:false,reason:"could not back up hooks.json"};}
  if(!atomicWrite(file,JSON.stringify(r.root,null,2)+"\n"))return{ok:false,reason:"could not write hooks.json",backup};
  return{ok:true,removed,backup};
}
function detectCodexPeekUserHooks(file,bridgeDir){
  const r=readHookRoot(file);if(!r.ok)return{installed:false,missing:CODEX_PEEK_HOOK_EVENTS.slice(),unreadable:r.reason};
  const missing=[];
  for(const h of CODEX_PEEK_USER_HOOKS){
    const groups=r.root.hooks&&Array.isArray(r.root.hooks[h.event])?r.root.hooks[h.event]:[];
    if(!groups.some(g=>g&&Array.isArray(g.hooks)&&g.hooks.some(x=>x&&isCodexPeekHookCommand(x.commandWindows||x.command,bridgeDir))))missing.push(h.eventName);
  }
  return{installed:missing.length===0,missing,unreadable:null};
}
function removeCodexPeekOwnedUserHooksUnlocked(markerFile,bridgeDir){
  const owner=readCodexPeekHookOwner(markerFile,bridgeDir);if(!owner.ok)return{ok:false,removed:0,reason:owner.reason};
  if(!owner.present)return{ok:true,removed:0,hookFiles:[]};
  let removed=0;
  for(const file of owner.hookFiles){
    const r=removeCodexPeekUserHooks(file,bridgeDir);if(!r.ok)return{ok:false,removed,reason:r.reason,hookFiles:owner.hookFiles};
    removed+=Number(r.removed||0);
    const after=detectCodexPeekUserHooks(file,bridgeDir);
    if(after.unreadable||after.missing.length!==CODEX_PEEK_HOOK_EVENTS.length)return{ok:false,removed,reason:"Codex Peek hooks remain after cleanup",hookFiles:owner.hookFiles};
  }
  try{fs.unlinkSync(markerFile);}catch{return{ok:false,removed,reason:"could not remove hook ownership marker",hookFiles:owner.hookFiles};}
  return{ok:true,removed,hookFiles:owner.hookFiles};
}
function removeCodexPeekOwnedUserHooks(markerFile,bridgeDir){return withCodexPeekHookOwnerLock(bridgeDir,()=>removeCodexPeekOwnedUserHooksUnlocked(markerFile,bridgeDir));}
function codexPeekHookTrustState(input,expectedHooksFile="",bridgeDir=""){
  let o=input;
  try{if(typeof o==="string")o=JSON.parse(o);}catch{o=null;}
  if(o&&o.result)o=o.result;
  const entries=o&&Array.isArray(o.data)?o.data:[];
  const hooks=entries.flatMap(x=>x&&Array.isArray(x.hooks)?x.hooks:[])
    .filter(h=>h&&h.source!=="plugin"&&(!expectedHooksFile||normRoot(h.sourcePath)===normRoot(expectedHooksFile))&&isCodexPeekHookCommand(h.command,bridgeDir));
  const enabled=hooks.filter(h=>h.enabled!==false);
  const missingEvents=CODEX_PEEK_HOOK_EVENTS.filter(ev=>!enabled.some(h=>h.eventName===ev));
  const untrusted=enabled.filter(h=>!["trusted","managed"].includes(String(h.trustStatus||"")));
  const trusted=enabled.filter(h=>["trusted","managed"].includes(String(h.trustStatus||"")));
  return{
    found:hooks.length>0,
    ready:missingEvents.length===0&&untrusted.length===0,
    required:CODEX_PEEK_HOOK_EVENTS.length,
    trusted:trusted.length,
    untrusted:untrusted.length,
    disabled:hooks.length-enabled.length,
    missingEvents,
    statuses:[...new Set(untrusted.map(h=>String(h.trustStatus||"unknown")))],
    pluginIds:[...new Set(hooks.map(h=>String(h.pluginId||"")).filter(Boolean))],
  };
}
module.exports={buildCodexPluginSpawn,nodeTokenRunsInShell,nodeTokenDualShellOk,codexPeekHookCommandNeedsMigration,detectCodexPeekHookMigration,createCodexHookOfferGate,createCodexHookReloadTracker,marketplaceRootMatches,marketplaceStepOk,codexPeekPluginState,codexPeekHookTrustState,installCodexPeekUserHooks,installCodexPeekOwnedUserHooks,installCodexPeekOwnedUserHooksUnlocked,removeCodexPeekUserHooks,removeCodexPeekOwnedUserHooks,removeCodexPeekOwnedUserHooksUnlocked,withCodexPeekHookOwnerLock,readCodexPeekHookOwner,detectCodexPeekUserHooks,codexPeekHookCommand,isCodexPeekHookCommand,CODEX_PEEK_HOOK_OWNER_SCHEMA,CODEX_PEEK_USER_HOOKS,CODEX_PEEK_HOOK_EVENTS,CODEX_PEEK_PLUGIN_IDS,isCodexPeekPluginId,normRoot,cmdQuote};
