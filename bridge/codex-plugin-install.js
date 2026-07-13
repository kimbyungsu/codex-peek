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
module.exports={buildCodexPluginSpawn,marketplaceRootMatches,marketplaceStepOk,codexPeekPluginState,codexPeekHookTrustState,installCodexPeekUserHooks,installCodexPeekOwnedUserHooks,installCodexPeekOwnedUserHooksUnlocked,removeCodexPeekUserHooks,removeCodexPeekOwnedUserHooks,removeCodexPeekOwnedUserHooksUnlocked,withCodexPeekHookOwnerLock,readCodexPeekHookOwner,detectCodexPeekUserHooks,codexPeekHookCommand,isCodexPeekHookCommand,CODEX_PEEK_HOOK_OWNER_SCHEMA,CODEX_PEEK_USER_HOOKS,CODEX_PEEK_HOOK_EVENTS,CODEX_PEEK_PLUGIN_IDS,isCodexPeekPluginId,normRoot,cmdQuote};
