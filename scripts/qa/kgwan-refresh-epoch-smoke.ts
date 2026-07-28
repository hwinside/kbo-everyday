/**
 * 경기 상세 당겨서 새로고침 → 종료 요약 GET 재조회 배선 회귀(소스 검증).
 * handleRefresh 가 refetchLive/refetchDetail 만 호출해 KgwanTab 오류 카드(llmError)가
 * pull-refresh 후에도 stuck 되던 문제: refreshEpoch 를 KgwanTab→FinalView→fetch effect deps 로
 * 전달해 재조회하되, 채팅 등 다른 client state 는 리셋하지 않는 최소 범위인지 검증.
 * 실행: npm run qa:kgwan-refresh-epoch
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const kgwan = readFileSync(resolve(root, "src/components/game/KgwanTab.tsx"), "utf8");
const page = readFileSync(resolve(root, "src/app/(main)/games/[gameId]/page.tsx"), "utf8");

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  ✗ " + name);
  }
}

// ── KgwanTab 배선 ──
ok("KgwanTabProps 에 refreshEpoch", /interface KgwanTabProps \{[\s\S]*refreshEpoch\?: number;/.test(kgwan));
ok("KgwanTab 구조분해에 refreshEpoch", /outs,\s*\n\s*refreshEpoch,\s*\n\}: KgwanTabProps/.test(kgwan));
ok("FinalView 가 refreshEpoch 수신", /function FinalView\(\{[^}]*refreshEpoch[^}]*\}/.test(kgwan));
ok("FinalView 렌더에 refreshEpoch 전달", /<FinalView[^>]*refreshEpoch=\{refreshEpoch\}/.test(kgwan));
ok("fetch effect deps 에 refreshEpoch", /llmSummary, awayTeam, homeTeam, linescore, retryNonce, refreshEpoch\]/.test(kgwan));

// ── page 배선 ──
ok("page: summaryRefreshEpoch state", /const \[summaryRefreshEpoch, setSummaryRefreshEpoch\] = useState\(0\)/.test(page));
ok("page: handleRefresh 에서 epoch bump", /handleRefresh[\s\S]{0,220}setSummaryRefreshEpoch\(\(e\) => e \+ 1\)/.test(page));
ok("page: KgwanTab 에 refreshEpoch 전달", /refreshEpoch=\{summaryRefreshEpoch\}/.test(page));

// ── 최소 범위: handleRefresh 가 채팅/메시지 state 를 리셋하지 않음 ──
const handleRefreshBody = (page.match(/const handleRefresh = useCallback\(async \(\) => \{[\s\S]*?\}, \[refetchLive, refetchDetail\]\);/) || [""])[0];
ok("handleRefresh 는 refetch 2종 + epoch bump 만(채팅 리셋 없음)", !!handleRefreshBody && !/setMessages|setChat|setComments|clearChat/.test(handleRefreshBody));
ok("handleRefresh 가 refetchLive/refetchDetail 유지", /refetchLive\(\), refetchDetail\(\)/.test(handleRefreshBody));

console.log(`\nkgwan refresh-epoch wiring: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
