const assert=require("assert"),path=require("path");
const {firstImplementerMetaSince,firstImplementerMetaFromHistory}=require(path.join(__dirname,"..","out","implementer-baseline.js"));
const norm=(p)=>String(p||"").replace(/[\\/]+$/," ").trim().replace(/\\/g,"/").toLowerCase();
const ws="D:\\Project";
const tc=(ts,effort,model="gpt-5.6",cwd=ws)=>JSON.stringify({timestamp:ts,type:"turn_context",payload:{cwd,model,effort}});
const linked=Date.parse("2026-07-12T10:00:00Z");
let n=0;const ok=(c,m)=>{assert.ok(c,m);n++;};

let r=firstImplementerMetaSince([
  tc("2026-07-12T09:00:00Z","medium","old"),
  tc("2026-07-12T10:00:01Z","high"),
  tc("2026-07-12T10:01:00Z","low"),
].join("\n"),ws,linked,norm);
ok(r.model==="gpt-5.6"&&r.effort==="high","첫 rollout high가 기준선 — 후속 low가 덮지 않음");
const hist=[
  {cwd:norm(ws),model:"gpt-5.6",effort:"high",ts:"2026-07-12T10:00:01.000Z"},
  {cwd:norm(ws),model:"gpt-5.6",effort:"low",ts:"2026-07-12T10:01:00.000Z"},
];
r=firstImplementerMetaFromHistory(hist,ws,linked,norm);
ok(r.effort==="high","확장이 쓰는 metaHistory 경로도 후속 low 대신 첫 high 고정");

r=firstImplementerMetaSince("잘린 tail 첫 줄\n"+tc("2026-07-12T10:00:02Z","xhigh"),ws,linked,norm);
ok(r.effort==="xhigh","tail 경계 손상 줄을 건너뛰고 첫 유효 turn_context 판독");
r=firstImplementerMetaSince(tc("2026-07-12T10:00:02Z","high","gpt", "D:\\Other"),ws,linked,norm);
ok(!r.model&&!r.effort,"다른 프로젝트 cwd는 기준선으로 쓰지 않음");
r=firstImplementerMetaSince(tc("2026-07-12T09:59:40Z","high"),ws,linked,norm);
ok(!r.effort,"자동 고정 5초 이전 기록은 배제");
r=firstImplementerMetaSince(tc("2026-07-12T09:59:58Z","high"),ws,linked,norm);
ok(r.effort==="high","훅/rollout 기록 순서의 5초 clock skew 허용");

console.log(`implementer-baseline: ${n} assertions passed`);
require("./codex-hook-health.test.js");
