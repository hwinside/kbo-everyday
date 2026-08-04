#!/usr/bin/env node
/**
 * 직관 라이브 워커 **CLI 관제 종료코드** 계약 (삼순 R6 ③)
 *
 * 왜 필요한가:
 *   `venueRunHasFailure()` 헬퍼와 sentinel 전파는 in-process 로 검증했지만,
 *   **actual main IIFE 가 그 결과로 실제 exit 1 을 내는지**는 아무 게이트도 안 봤다.
 *   그래서 `if (venueRunHasFailure(venueRes))` → `if (false && venueRunHasFailure(venueRes))`
 *   1-line mutation 이 worker 146/0 GREEN 이었다(삼순 독립 재현 2026-08-04).
 *   cron 이 실패를 삼키고 거짓 성공으로 끝나는 회귀가 그대로 남는다.
 *
 * 어떻게 검증하나:
 *   mock Supabase REST 서버를 띄우고 `scripts/transcode-videos.mjs --apply` 를
 *   **진짜 subprocess 로 실행**해 종료코드를 읽는다. 제품 코드에 테스트 훅을 넣지 않는다
 *   (optional flag = 우회 스위치라 넣는 순간 게이트가 무력화된다).
 *
 *   FAIL 케이스: venue_stories 가 다운로드 불가 행 1건을 반환 → failed=1 → **exit 1**
 *   PASS 케이스: venue_stories 가 0건 → failed=0 → **exit 0**
 *   두 케이스를 같이 봐야 "항상 1" 이나 "항상 0" 인 고장난 게이트를 걸러낸다.
 */
import { createServer } from "http";
import { spawn } from "child_process";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const WORKER = join(REPO, "scripts", "transcode-videos.mjs");

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

/** 실패 유발 행 — media_url 이 즉시 끊기는 포트라 downloadToFile 이 throw 한다. */
const FAILING_ROW = {
  id: 9001,
  status: "active",
  media_url: "http://127.0.0.1:1/never.mp4",
  media_bucket: "venue-media",
  media_path: "venue-stories/9001.mp4",
  transcode_attempts: 0,
  attendance_source: "gps",
};

/**
 * supabase-js v2 는 `${url}/rest/v1/<table>` 로 REST, `${url}/storage/v1/object/...` 로
 * 스토리지를 호출한다. 테이블별 fixture 만 돌려준다.
 *
 * ⚠️ PATCH 응답이 중요하다. 워커는 실패 기록 PATCH 의 `select("id")` 결과가
 *   0행이면 "처리 중 removed/선점" 으로 보고 `claimedElsewhere`(=정상 skip) 로 분류한다.
 *   즉 PATCH 에 `[]` 를 돌려주면 진짜 실패가 skip 으로 흡수돼 failed=0 이 된다
 *   (첫 구현에서 실제로 그래서 exit 0 이 나왔다 — fixture 결함).
 *   CAS 가 맞은 것처럼 1행을 돌려줘야 `failed` 로 집계된다.
 */
function startMockSupabase(venueRows) {
  return new Promise((resolveFn) => {
    const server = createServer((req, res) => {
      const path = (req.url || "").split("?")[0];
      const table = path.replace(/^\/rest\/v1\//, "");
      const send = (body) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      // 본문은 읽어서 버린다(PATCH/POST 가 멈추지 않도록)
      req.resume();
      req.on("end", () => {
        // 스토리지 다운로드: 영상이 아닌 바이트 → 이후 ffprobe/ffmpeg 가 실패한다(의도된 실패 유발)
        if (path.startsWith("/storage/v1/object")) {
          res.writeHead(200, { "content-type": "video/mp4" });
          return res.end(Buffer.from("not-a-video"));
        }
        if (req.method === "GET" && table === "venue_stories") return send(venueRows);
        if (req.method === "GET") return send([]); // posts / video_transcode_jobs 등
        // PATCH(실패 기록) — CAS 일치 1행. 여기서 [] 를 주면 실패가 skip 으로 흡수된다.
        if (req.method === "PATCH" && table === "venue_stories") {
          return send(venueRows.map((r) => ({ id: r.id })));
        }
        return send([]);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolveFn({ server, port: server.address().port });
    });
  });
}

function runWorker(port) {
  return new Promise((resolveFn) => {
    const child = spawn(process.execPath, [WORKER, "--apply", "--limit", "5"], {
      cwd: REPO,
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}`,
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolveFn({ code, out }));
  });
}

async function withMock(rows, fn) {
  const { server, port } = await startMockSupabase(rows);
  try {
    return await fn(port);
  } finally {
    await new Promise((r) => server.close(() => r()));
  }
}

async function run() {
  console.log("[CLI] 워커 subprocess 관제 종료코드 — main IIFE 가 실패를 실제로 exit 1 로 올리는가");

  // 이 계약의 전제. 부재면 skip 이 아니라 FAIL (검증 불가를 통과로 취급하지 않는다).
  let hasFfmpeg = true;
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
  } catch {
    hasFfmpeg = false;
  }
  ok("CLI: ffmpeg/ffprobe 존재(전제 — 부재면 skip 아니라 FAIL)", hasFfmpeg);
  if (!hasFfmpeg) {
    console.log(`\n결과: ${pass} pass / ${fail} fail`);
    process.exit(1);
  }

  // ① 실패가 있으면 non-zero — `if (false && ...)` 로 무력화하면 여기가 RED
  const failCase = await withMock([FAILING_ROW], runWorker);
  ok(
    `CLI: 직관 라이브 실패 1건 → 종료코드 non-zero (실제 ${failCase.code})`,
    failCase.code !== 0,
  );
  ok(
    "CLI: 실패 사유를 관제 로그로 남김(조용한 실패 금지)",
    /직관 라이브 처리 이상/.test(failCase.out),
  );
  ok(
    "CLI: 관제 메시지에 실패 건수 포함",
    /실패 1/.test(failCase.out),
  );

  // ② 대조군 — 실패가 없으면 0. "항상 1" 인 고장난 게이트를 걸러낸다.
  const okCase = await withMock([], runWorker);
  ok(
    `CLI: 처리 대상 0건 → 종료코드 0 (실제 ${okCase.code}) — 대조군`,
    okCase.code === 0,
  );
  ok(
    "CLI: 대조군에는 관제 오류 메시지가 없다",
    !/직관 라이브 처리 이상/.test(okCase.out),
  );

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  console.error("❌ 테스트 런타임 오류:", e);
  process.exit(1);
});
