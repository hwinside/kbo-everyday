/**
 * admin_job_logs 마감 (워크플로 최종 결과 반영) — 삼순 NO-GO #1 반영.
 *
 * run-batch 는 CI 에서 job log 를 *열어만* 두고(startJob), 이후 PR 생성/자동머지/
 * post-deploy QA/롤백까지 끝난 뒤 이 스크립트가 `if: always()` 로 실행돼 *진짜 최종
 * 상태*로 닫는다. 그래야 배치 자체는 성공했지만 머지/QA 단계가 실패한 경우에도
 * `/admin/jobs` 에 success 로 잘못 남지 않는다.
 *
 * 입력:
 *   - /tmp/hero-batch/job-log-id.txt  (startJob 직후 기록한 로그 id)
 *   - /tmp/hero-batch/report.json     (배치 단계 집계)
 *   - env: 워크플로 각 step 의 outcome / 출력
 *       BATCH_OUTCOME, MERGE_OUTCOME, MERGE_PR_URL, QA_OUTCOME,
 *       ROLLED_BACK_COUNT, ROLLED_BACK_IDS, GENERATED_COUNT, SKIPPED_COUNT
 *
 * env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (preflight 에서 필수 보장)
 */
import fs from "fs";
import { finishJob } from "./admin-job-log.mjs";

const LOG_ID_FILE = "/tmp/hero-batch/job-log-id.txt";
const REPORT_FILE = "/tmp/hero-batch/report.json";

function readLogId() {
  try {
    const v = fs.readFileSync(LOG_ID_FILE, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

function readReport() {
  try {
    return JSON.parse(fs.readFileSync(REPORT_FILE, "utf8"));
  } catch {
    return null;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const logId = readLogId();
  if (!logId) {
    // startJob 이 null (secret 누락/REST 실패) — preflight 가 secret 은 막으므로
    // 여기 도달하면 전송 자체 실패. 닫을 로그가 없으니 종료.
    console.error("[finalize] job-log-id 없음 — admin 로그 마감 skip");
    return;
  }
  const rep = readReport();

  const batchOutcome = process.env.BATCH_OUTCOME || "";
  const mergeOutcome = process.env.MERGE_OUTCOME || "";
  const qaOutcome = process.env.QA_OUTCOME || "";
  const prUrl = process.env.MERGE_PR_URL || "";
  const rolledBack = num(process.env.ROLLED_BACK_COUNT);
  const rolledBackIds = process.env.ROLLED_BACK_IDS || "";

  const detected = rep ? num(rep.detected ?? (rep.passedGate?.length ?? 0) + (rep.skipped?.length ?? 0)) : 0;
  const passed = rep ? num(rep.passedGate?.length) : 0;
  const generated = rep ? num(rep.generated?.length) : num(process.env.GENERATED_COUNT);
  const skipped = rep ? num(rep.skipped?.length) : num(process.env.SKIPPED_COUNT);

  // 최종 상태: 어느 단계든 실패면 error. 롤백/보류만 있으면 warning. 전부 깔끔하면 success.
  let status = "success";
  let errorMessage = null;
  if (batchOutcome === "failure") {
    status = "error";
    errorMessage = rep?.batchError || "배치 단계 실패";
  } else if (mergeOutcome === "failure") {
    status = "error";
    errorMessage = "PR 생성/자동머지 단계 실패";
  } else if (qaOutcome === "failure") {
    status = "error";
    errorMessage = "post-deploy QA 단계 실패";
  } else if (rolledBack > 0 || skipped > 0) {
    status = "warning";
  }

  const parts = [
    `탐지 ${detected}`,
    `검증통과 ${passed}`,
    `생성·반영 ${generated}`,
    `보류·플래그 ${skipped}`,
  ];
  if (prUrl) parts.push(`PR ${prUrl}`);
  if (rolledBack > 0) parts.push(`롤백 ${rolledBack}(${rolledBackIds})`);
  const summary = parts.join(" · ");

  await finishJob(logId, status, summary, errorMessage);
  console.log(`[finalize] admin 로그 마감: ${status} — ${summary}`);
}

main().catch((e) => {
  console.error("[finalize] FATAL:", e);
  // 마감 실패가 워크플로 전체를 죽이지 않게 (best-effort).
  process.exit(0);
});
