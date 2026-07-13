// ── vscode:uninstall 훅 — 확장이 '완전 제거'된 뒤(다음 VS Code 재시작 시점) VS Code가 이 스크립트를 실행한다 ──
// vscode API 없음(순수 node·UI 불가). 원칙: '확장이 설치한 것만' 정리한다(표식 기반) —
//  · hooks-installed-by-extension 표식이 있으면: settings.json에서 우리 훅 4개만 제거(타인 훅 보존·백업 생성).
//  · .bridge-deployed-by.json(확장 자동배치 stamp)이 있으면: 브릿지 스크립트 5개+stamp 삭제.
//  · 표식이 없으면(레포 install.js 설치) 아무것도 안 건드림 — CLI 하네스는 install.js uninstall이 담당.
//  · 사용자 데이터(links.json·contracts/·stats/·proofs/ 등)는 항상 보존 — 완전 삭제는 PRIVACY 안내대로 폴더 삭제.
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { removeHooks, BRIDGE_SCRIPTS } from "./hook-setup";

type UninstallTestHooks = { onCodexOwnerLock?: () => void };
export function doUninstall(bridgeDir: string, claudeDir: string, _codexHome?: string, testHooks?: UninstallTestHooks): { hooksRemoved: boolean; codexHooksRemoved: boolean; bridgeRemoved: boolean } {
  let hooksRemoved = false, codexHooksRemoved = false, bridgeRemoved = false;
  let hookFlagExists = false, codexHookFlagExists = false, hookCleanupOk = true, codexHookCleanupOk = true;
  try {
    const flag = path.join(bridgeDir, "hooks-installed-by-extension");
    hookFlagExists = fs.existsSync(flag);
    if (hookFlagExists) {
      const r = removeHooks(path.join(claudeDir, "settings.json"));
      hookCleanupOk = r.ok;
      if (r.ok) { hooksRemoved = true; try { fs.unlinkSync(flag); } catch { /* ignore */ } }
      // 실패(깨진 JSON 등)면 표식을 남겨 둔다 — 재설치 시 다시 관리 가능, 파일은 안 건드림(손상 방지)
    }
  } catch { hookCleanupOk = false; /* best-effort — 실패로 취급해 브릿지도 보존 */ }
  try {
    const flag = path.join(bridgeDir, "codex-hooks-installed-by-extension");
    const setup = require("../bridge/codex-plugin-install.js") as {
      withCodexPeekHookOwnerLock:(b:string,fn:()=>any)=>{ok?:boolean;reason?:string};
      removeCodexPeekOwnedUserHooksUnlocked:(m:string,b:string)=>{ok:boolean};
    };
    // Codex 표식 읽기→모든 실제 hooks.json 정리→잔존 확인→브릿지 삭제를 설치와 같은 프로세스 간 잠금 안에서 끝낸다.
    // 여러 VS Code 창의 설치가 중간에 끼어 옛 홈 훅만 남기는 lost-update/dangling 경로를 막는다.
    const locked = setup.withCodexPeekHookOwnerLock(bridgeDir,() => {
      testHooks?.onCodexOwnerLock?.(); // 동시성 회귀 테스트 관찰점. 일반 제거 경로에서는 undefined라 무동작.
      codexHookFlagExists = fs.existsSync(flag);
      if (codexHookFlagExists) {
        const r=setup.removeCodexPeekOwnedUserHooksUnlocked(flag,bridgeDir);
        codexHookCleanupOk=r.ok;if(r.ok)codexHooksRemoved=true;
      }
      const stamp=path.join(bridgeDir,".bridge-deployed-by.json");
      if(fs.existsSync(stamp)&&(!hookFlagExists||hookCleanupOk)&&(!codexHookFlagExists||codexHookCleanupOk)){
        for(const f of BRIDGE_SCRIPTS){try{fs.unlinkSync(path.join(bridgeDir,f));}catch{/* ignore */}}
        try{fs.unlinkSync(stamp);}catch{/* ignore */}
        try{fs.unlinkSync(path.join(bridgeDir,"hooks-prompt-dismissed"));}catch{/* 알림 플래그도 확장 소유물 */}
        bridgeRemoved=true;
      }
      return{ok:true};
    });
    if(!locked||locked.ok===false)codexHookCleanupOk=false;
  } catch { codexHookCleanupOk = false; }
  return { hooksRemoved, codexHooksRemoved, bridgeRemoved };
}

if (require.main === module) {
  const HOME = os.homedir();
  doUninstall(
    process.env.CODEX_BRIDGE_HOME || path.join(HOME, ".codex-bridge"),
    process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"),
  );
}
