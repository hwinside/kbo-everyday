import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * 산출물 전체를 temp 에 쓴 뒤 한 번에 교체한다.
 *
 * ⚠︎ JS `catch` rollback 만으로는 부족하다. 첫 `renameSync` 직후 프로세스가
 * `process.exit()`/SIGKILL/전원 장애로 죽으면 catch 가 아예 실행되지 않아
 * `new-0 / old-1 / old-2 ...` 혼합 snapshot 이 디스크에 남는다(삼순 P0-3 실증).
 *
 * 그래서 **commit journal + startup recovery** 를 쓴다.
 *  1) 전부 temp 에 쓰고, 기존 파일을 백업한다.
 *  2) "이제부터 교체한다"는 저널을 *먼저* 디스크에 남긴다(fsync 대신 rename 으로 원자 배치).
 *  3) rename 을 순차 수행한다.
 *  4) 전부 끝나면 저널을 지운다.
 *
 * 어느 지점에서 죽든 저널이 남아 있으면 다음 실행의 `recoverPendingPromotion()` 이
 * 백업으로 전부 되돌린다 → 디스크는 항상 **old generation 전체** 또는
 * **new generation 전체** 중 하나다.
 */

const JOURNAL_DIRNAME = ".stats-promote-journal";
const JOURNAL_FILENAME = "journal.json";

function journalRoot(targetDir) {
  return join(targetDir, JOURNAL_DIRNAME);
}

/**
 * 미완료 promote 가 남아 있으면 백업으로 되돌린다.
 * 크롤/검증 시작 전에 부르면 혼합 snapshot 상태에서 출발하는 일이 없다.
 *
 * @returns {{recovered: boolean, restored: string[]}}
 */
export function recoverPendingPromotion(targetDir) {
  const root = journalRoot(targetDir);
  const journalPath = join(root, JOURNAL_FILENAME);
  if (!existsSync(journalPath)) return { recovered: false, restored: [] };

  let journal;
  try {
    journal = JSON.parse(readFileSync(journalPath, "utf8"));
  } catch {
    // 저널 자체가 깨졌으면 임의 복구는 위험하다 — 사람이 봐야 한다.
    throw new Error(
      `promote_journal_corrupt: ${journalPath} 를 읽을 수 없다 — 수동 확인 필요`,
    );
  }

  const restored = [];
  for (const entry of journal.entries ?? []) {
    if (entry.backupPath && existsSync(entry.backupPath)) {
      copyFileSync(entry.backupPath, entry.path);
      restored.push(entry.path);
    } else if (!entry.hadPrevious && existsSync(entry.path)) {
      // 원래 없던 파일이 생성된 상태 — 지워야 이전 세대가 된다.
      unlinkSync(entry.path);
      restored.push(entry.path);
    }
  }

  rmSync(root, { recursive: true, force: true });
  return { recovered: true, restored };
}

/**
 * @param {{path: string, body: string}[]} artifacts
 * @param {{fail?: "afterStage"|"midPromote"|"afterJournal", onBeforeRename?: (index: number) => void}} [options]
 */
export function promoteAtomically(artifacts, { fail, onBeforeRename } = {}) {
  if (artifacts.length === 0) return;

  const targetDir = dirname(artifacts[0].path);
  // ⚠︎ 여기서 복구하면 이미 늦다 — 크롤·read·검증이 혼합 세대 위에서 끝난 뒤다.
  // startup recovery 는 crawl-stats.mjs 의 main() 시작부(어떤 read 보다 먼저)가 담당한다.
  // 여기서는 저널이 남아 있으면 계약 위반이므로 fail-close 한다.
  if (hasPendingPromotion(targetDir)) {
    throw new Error(
      "promote_journal_pending: 미완료 promote 저널이 남아 있다 — "
        + "startup recovery(recoverPendingPromotion)를 실행 시작부에서 먼저 호출해야 한다",
    );
  }

  const staging = mkdtempSync(join(tmpdir(), "kbo-stats-promote-"));
  const root = journalRoot(targetDir);
  const journalPath = join(root, JOURNAL_FILENAME);
  const staged = [];
  const entries = [];
  const promoted = [];
  let journalCommitted = false;

  try {
    // 1) 전부 temp 에 쓴다 — 여기서 죽으면 대상 파일은 무손상.
    for (const artifact of artifacts) {
      const tempPath = join(staging, `${basename(artifact.path)}.staged`);
      writeFileSync(tempPath, artifact.body);
      staged.push({ ...artifact, tempPath });
    }
    if (fail === "afterStage") throw new Error("injected_failure:afterStage");

    // 2) 백업 — 저널과 같은 디렉터리에 둬야 다음 실행이 찾을 수 있다.
    //    (temp 는 재부팅/정리로 사라질 수 있으므로 복구 자산은 대상 옆에 둔다)
    mkdirSync(root, { recursive: true });
    for (const item of staged) {
      const hadPrevious = existsSync(item.path);
      const backupPath = hadPrevious
        ? join(root, `${basename(item.path)}.backup`)
        : null;
      if (backupPath) copyFileSync(item.path, backupPath);
      entries.push({ path: item.path, backupPath, hadPrevious });
    }

    // 3) 저널을 원자적으로 배치한다 — 이 시점 이후 죽으면 다음 실행이 되돌린다.
    const journalTmp = join(root, `${JOURNAL_FILENAME}.tmp`);
    writeFileSync(journalTmp, JSON.stringify({ createdAt: new Date().toISOString(), entries }, null, 2));
    renameSync(journalTmp, journalPath);
    journalCommitted = true;
    if (fail === "afterJournal") throw new Error("injected_failure:afterJournal");

    // 4) promote.
    for (const [index, item] of staged.entries()) {
      if (onBeforeRename) onBeforeRename(index);
      if (fail === "midPromote" && index === 2) {
        throw new Error("injected_failure:midPromote");
      }
      renameSync(item.tempPath, item.path);
      promoted.push(item.path);
    }

    // 5) 전부 성공 — 저널·백업 제거.
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    // 같은 프로세스에서 잡힌 경우엔 즉시 되돌린다.
    for (const target of promoted) {
      const entry = entries.find((e) => e.path === target);
      if (!entry) continue;
      try {
        if (entry.backupPath && existsSync(entry.backupPath)) {
          copyFileSync(entry.backupPath, target);
        } else if (!entry.hadPrevious) {
          unlinkSync(target);
        }
      } catch (restoreError) {
        console.error(
          `❌ 롤백 실패: ${target} — 저널 ${journalPath} 를 남겨둔다(다음 실행이 복구)`,
        );
        rmSync(staging, { recursive: true, force: true });
        throw restoreError;
      }
    }
    if (journalCommitted) rmSync(root, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  rmSync(staging, { recursive: true, force: true });
}

/** 저널이 남아 있는지(= 미완료 promote 흔적) 조회. 테스트·진단용. */
export function hasPendingPromotion(targetDir) {
  return existsSync(join(journalRoot(targetDir), JOURNAL_FILENAME));
}

/** 저널 디렉터리 내용 목록. 테스트·진단용. */
export function listJournalArtifacts(targetDir) {
  const root = journalRoot(targetDir);
  if (!existsSync(root)) return [];
  return readdirSync(root).sort();
}
