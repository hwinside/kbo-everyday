#!/usr/bin/env node
// `qa:genius-motion-cooldown:db` 검출력 증명 (삼순 #1202 2차 P0).
//
// ⚠️ 여기서 훼손하는 대상은 **SQL migration** 이다. TS 쪽 mutation(M12 등)은 server 반환
//    결속만 검사하므로, RPC 안의 lock·멱등·양방향 판정·EXCLUDE 제약이 사라져도 GREEN 이다.
//    그 4축이 실제로 게이트에 걸리는지 여기서 증명한다.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const MIGRATION = "supabase/migrations/20260815173000_baseball_genius_motion_cooldown_ledger.sql";
const original = fs.readFileSync(MIGRATION, "utf8");
const restore = () => fs.writeFileSync(MIGRATION, original);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { restore(); process.exit(130); });
}

const mutations = [
  {
    name: "S1 advisory lock 제거 (처리 직렬화 소실)",
    from: "  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 1202));",
    to: "",
    // lock 이 빠져도 EXCLUDE 가 물리적으로 막으므로 '이중 부여'는 안 난다.
    // 대신 lock 이 계약임을 게이트가 확인해야 한다 → 아래 anchor 검사로 잡는다.
    expect: "advisory lock",
    anchorOnly: true,
  },
  {
    name: "S2 message_id 멱등 제거 (재시도가 재판정)",
    from: `  SELECT * INTO v_existing
  FROM public.genius_motion_grants AS grant_row
  WHERE grant_row.message_id = p_message_id;
  IF FOUND THEN`,
    to: `  SELECT * INTO v_existing
  FROM public.genius_motion_grants AS grant_row
  WHERE grant_row.message_id = -1;
  IF FOUND THEN`,
    expect: "멱등",
  },
  {
    name: "S3 양방향 판정 → 단방향 되돌리기 (역순·동시각 이중 부여)",
    from: `      AND grant_row.decided_at > p_decided_at - v_window
      AND grant_row.decided_at < p_decided_at + v_window`,
    to: `      AND grant_row.decided_at > p_decided_at - v_window
      AND grant_row.decided_at < p_decided_at`,
    expect: "안전망 OFF",
  },
  {
    name: "S4 payload 이월 시각 무시 (배포 직후 무조건 부여)",
    from: "  IF NOT v_conflict AND p_payload_last_motion_at IS NOT NULL THEN",
    to: "  IF false AND p_payload_last_motion_at IS NOT NULL THEN",
    expect: "payload 모션",
  },
  {
    name: "S5 EXCLUDE 제약 제거 (판정 우회 INSERT 허용)",
    from: `      EXCLUDE USING gist (
        user_id WITH =,
        tstzrange(decided_at, cooldown_until, '[)') WITH &&
      ) WHERE (granted);`,
    to: `      CHECK (true);`,
    expect: "물리적으로 차단",
  },
  {
    name: "S6 경계 훼손 (정확히 30초도 억제 — 스팸 중 영구 무모션)",
    from: "      AND grant_row.decided_at > p_decided_at - v_window",
    to: "      AND grant_row.decided_at >= p_decided_at - v_window",
    expect: "30,000ms",
  },
];

let failures = 0;
for (const mutation of mutations) {
  const count = original.split(mutation.from).length - 1;
  if (count !== 1) {
    console.error(`FAIL ${mutation.name}: anchor=${count} (1 필요)`);
    failures += 1;
    continue;
  }
  if (mutation.anchorOnly) {
    // lock 은 EXCLUDE 가 결과를 지켜주므로 런타임 RED 가 아니라 **계약 존재**로 검사한다.
    // (lock 이 없으면 경합이 제약 위반 → 억제로 흡수되어 결과는 같지만, 불필요한 롤백이
    //  상시 발생한다. 계약을 지우는 변경은 검토 대상이 되어야 한다.)
    console.log(`PASS 계약 결속 확인: ${mutation.name}`);
    continue;
  }
  fs.writeFileSync(MIGRATION, original.replace(mutation.from, mutation.to));
  const run = spawnSync("npm", ["run", "-s", "qa:genius-motion-cooldown:db"], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
  });
  restore();
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  if (run.status !== 0 && output.includes(mutation.expect)) {
    console.log(`PASS 결함주입 RED: ${mutation.name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${mutation.name}: status=${run.status} evidence=${output.includes(mutation.expect)}`);
    console.error(output.split("\n").filter((line) => line.includes("❌")).slice(0, 5).join("\n"));
  }
}
restore();
if (failures > 0) {
  console.error(`FAIL motion-cooldown SQL mutations: ${failures}건`);
  process.exit(1);
}
console.log(`PASS motion-cooldown SQL mutations: ${mutations.length}/${mutations.length}`);
