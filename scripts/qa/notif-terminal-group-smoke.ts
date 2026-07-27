/**
 * 위젯 종료 clear 축 — 정책 스모크 (P0 인시던트 S1-a, 삼순 리뷰 반영 B안).
 * 실행: npm run qa:notif-terminal-group
 *
 * 계약(위젯 "종료 후 잔류·얼어붙음" 서버 축 — native 없이 서버만으로 닫히는 절반):
 *  ① terminal(종료/취소 clear)은 live 스트림(kbo_widget_stream)과 *별도* collapse key
 *     (kbo_widget_end)로 보내 live tick의 collapse에 game_end가 묻혀 위젯이 9회로 얼어붙는
 *     경로를 차단한다. live/terminal TTL 분리(90s / 24h).
 *  ② game_end ∈ WIDGET_CONTROL_KINDS → fcm.ts가 w_ts(seq)를 자동 부여.
 *  ③ 정상 종료·취소 clear는 단일 빌더 buildTerminalClearPayload를 공유(삼순 Blocker 1) — 두
 *     production 경로가 모두 이 빌더를 호출하므로, 아래 검사는 실제 발송 payload를 고정한다.
 *     w_final="1" tombstone(FINAL 뒤 늦은 LIVE 거부 신호, native 준수 S2)이 두 경로 모두에.
 *
 * 스코프 아웃: 이벤트 배너 "20개 누적 + 그룹 + 한번에 지우기 + 지나간 알림 보존"(B안)은
 * background에서 native 렌더가 본체라 S2(앱 빌드)로 이관. escalating blind resend는 S1-b(서버).
 *
 * game-status/fcm는 top-level에서 supabaseAdmin을 임포트하므로, DB에 닿지 않는 더미 env를
 * 세팅한 뒤 동적 import로 순수 export만 가져온다.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "smoke-dummy-key";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "smoke-dummy-anon";

let pass = 0;
let fail = 0;
function check(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.error(`✗ ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
}

async function main() {
  const { WIDGET_STREAM, WIDGET_CONTROL_KINDS } = await import("../../src/lib/notifications/fcm");
  const { buildTerminalClearPayload } = await import("../../src/lib/notifications/game-status");

  // ── ① terminal collapse key 분리 ────────────────────────────────────
  check("terminal collapse key = kbo_widget_end", WIDGET_STREAM.terminal.collapseKey, "kbo_widget_end");
  check("live collapse key = kbo_widget_stream", WIDGET_STREAM.live.collapseKey, "kbo_widget_stream");
  check("terminal ≠ live collapse key (묻힘 방지)",
    WIDGET_STREAM.terminal.collapseKey !== WIDGET_STREAM.live.collapseKey, true);
  check("live TTL 90s", WIDGET_STREAM.live.ttlSeconds, 90);
  check("terminal TTL 24h", WIDGET_STREAM.terminal.ttlSeconds, 24 * 60 * 60);

  // ── ② game_end seq 가드 유지 ────────────────────────────────────────
  check("game_end ∈ WIDGET_CONTROL_KINDS (w_ts seq 자동부여)", WIDGET_CONTROL_KINDS.has("game_end"), true);

  // ── ③ 정상 종료 clear (production 빌더, scores 포함) ─────────────────
  const G = "20260726LGHH0";
  const final = buildTerminalClearPayload(G, { awayScore: 4, homeScore: 14 });
  check("FINAL dataOnly", final.dataOnly, true);
  check("FINAL apnsBackground", final.apnsBackground, true);
  check("FINAL terminal collapse key", final.collapseKey, "kbo_widget_end");
  check("FINAL kind=game_end", final.data?.kind, "game_end");
  check("FINAL w_final tombstone", final.data?.w_final, "1");
  check("FINAL 스코어 동봉", { as: final.data?.w_as, hs: final.data?.w_hs }, { as: "4", hs: "14" });

  // ── ③ 취소 clear (production 빌더, scores 없음) ─────────────────────
  const cancel = buildTerminalClearPayload(G);
  check("CANCEL terminal collapse key", cancel.collapseKey, "kbo_widget_end");
  check("CANCEL kind=game_end", cancel.data?.kind, "game_end");
  check("CANCEL w_final tombstone", cancel.data?.w_final, "1");
  check("CANCEL 스코어 미동봉", { as: cancel.data?.w_as, hs: cancel.data?.w_hs }, { as: undefined, hs: undefined });

  console.log(`\n${fail === 0 ? "✅" : "❌"} notif-terminal-group: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
