/**
 * 알림 종료 clear·이벤트 배너 그룹 계약 — 정책 스모크 (P0 인시던트 S1-a).
 * 실행: npm run qa:notif-terminal-group
 *
 * 계약(삼순 GO — 전달 수렴+자동 청소의 서버 payload 계약 절반):
 *  ① terminal(종료/취소 clear)은 live 스트림과 *별도* collapse key(kbo_widget_end)로 보내
 *     live tick의 collapse에 묻히지 않는다. live/terminal TTL 분리(90s / 24h) 유지.
 *  ② game_end는 WIDGET_CONTROL_KINDS라 fcm.ts가 w_ts(seq)를 자동 부여 → 옛 배달이 종료를 못 되살림.
 *  ③ 이벤트 배너(안타/홈런/득점·실점·이닝요약) data에 경기별 n_group + 안정 n_tag를 실어
 *     native가 그룹핑(S1b 소비)하고, game_end의 n_clear_group으로 일괄 cancel(20개 누적 정리)한다.
 *
 * 주의: 이 PR(S1-a)은 payload 계약만 싣는다. native 그룹 표시·일괄 취소 실행과 escalating
 * blind resend(migration+cron)는 각각 S2(앱)·S1-b(서버)로 스코프 아웃.
 *
 * fcm.ts는 top-level에서 supabaseAdmin을 임포트하므로 순수 상수만 검증해도 모듈 로드에 env가
 * 필요하다. 아래는 DB에 닿지 않는 더미 env를 세팅한 뒤 동적 import로 순수 export만 가져온다.
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
  const { WIDGET_STREAM, WIDGET_CONTROL_KINDS, eventBannerGroupData, endClearGroupFlag } =
    await import("../../src/lib/notifications/fcm");

  // ── ① terminal collapse key 분리 ────────────────────────────────────
  check("terminal collapse key = kbo_widget_end", WIDGET_STREAM.terminal.collapseKey, "kbo_widget_end");
  check("live collapse key = kbo_widget_stream", WIDGET_STREAM.live.collapseKey, "kbo_widget_stream");
  check("terminal ≠ live collapse key (묻힘 방지)",
    WIDGET_STREAM.terminal.collapseKey !== WIDGET_STREAM.live.collapseKey, true);
  check("live TTL 90s", WIDGET_STREAM.live.ttlSeconds, 90);
  check("terminal TTL 24h", WIDGET_STREAM.terminal.ttlSeconds, 24 * 60 * 60);

  // ── ② game_end seq 가드 유지 ────────────────────────────────────────
  check("game_end ∈ WIDGET_CONTROL_KINDS (w_ts seq 자동부여)", WIDGET_CONTROL_KINDS.has("game_end"), true);

  // ── ③ 이벤트 배너 그룹/태그 계약 ────────────────────────────────────
  const G = "20260726LGHH0";
  check("eventBannerGroupData 형태", eventBannerGroupData(G, `${G}-hit-3`), {
    n_group: `game:${G}`, n_tag: `${G}-hit-3`,
  });
  check("endClearGroupFlag 형태", endClearGroupFlag(G), { n_clear_group: `game:${G}` });

  // 같은 경기 = 같은 group (일괄 cancel이 그 경기 배너 전체를 잡게)
  check("동일 경기 group 일치",
    eventBannerGroupData(G, "a").n_group === eventBannerGroupData(G, "b").n_group, true);
  // 다른 경기 = 다른 group (경기 간 오취소 방지)
  check("다른 경기 group 분리",
    eventBannerGroupData(G, "a").n_group !== eventBannerGroupData("20260726KTSS0", "a").n_group, true);
  // n_clear_group ⟺ 배너 n_group (native가 매칭해 일괄 cancel)
  check("clear group ⟺ 배너 group 매칭",
    endClearGroupFlag(G).n_clear_group, eventBannerGroupData(G, "x").n_group);
  // 안정 tag: 같은 이벤트 id면 같은 n_tag (중복 교체·개별 취소 주소)
  check("동일 이벤트 tag 안정",
    eventBannerGroupData(G, "run-7").n_tag === eventBannerGroupData(G, "run-7").n_tag, true);

  console.log(`\n${fail === 0 ? "✅" : "❌"} notif-terminal-group: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
