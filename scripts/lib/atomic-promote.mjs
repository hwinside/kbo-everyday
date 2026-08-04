import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * 산출물 전체를 temp 에 쓴 뒤 한 번에 교체한다.
 *
 * 계약:
 *  - temp 쓰기 단계에서 실패하면 대상 파일은 **단 하나도** 손대지 않는다.
 *  - promote 도중 실패하면 이미 교체한 파일을 원본 백업으로 되돌린 뒤 던진다.
 *    (되돌리기까지 실패하는 경우는 백업 경로를 로그로 남겨 수동 복구가 가능하게 한다)
 */
export function promoteAtomically(artifacts, { fail } = {}) {
  const staging = mkdtempSync(join(tmpdir(), "kbo-stats-promote-"));
  const staged = [];
  const backups = [];
  const promoted = [];

  try {
    // 1) 전부 temp 에 쓴다 — 여기서 죽으면 대상 파일은 무손상.
    for (const artifact of artifacts) {
      const tempPath = join(staging, `${basename(artifact.path)}.staged`);
      writeFileSync(tempPath, artifact.body);
      staged.push({ ...artifact, tempPath });
    }
    if (fail === "afterStage") throw new Error("injected_failure:afterStage");

    // 2) 기존 파일 백업 — promote 실패 시 되돌릴 원본.
    for (const item of staged) {
      if (!existsSync(item.path)) continue;
      const backupPath = join(staging, `${basename(item.path)}.backup`);
      copyFileSync(item.path, backupPath);
      backups.push({ path: item.path, backupPath });
    }

    // 3) promote.
    for (const [index, item] of staged.entries()) {
      if (fail === "midPromote" && index === 2) {
        throw new Error("injected_failure:midPromote");
      }
      renameSync(item.tempPath, item.path);
      promoted.push(item.path);
    }
  } catch (error) {
    // 이미 교체한 것만 되돌린다.
    for (const target of promoted) {
      const backup = backups.find((b) => b.path === target);
      if (!backup) {
        // 원래 없던 파일을 새로 만든 경우 — 지워야 이전 상태가 된다.
        try { unlinkSync(target); } catch { /* 이미 없으면 무시 */ }
        continue;
      }
      try {
        copyFileSync(backup.backupPath, target);
      } catch (restoreError) {
        console.error(
          `❌ 롤백 실패: ${target} — 백업 위치 ${backup.backupPath} (수동 복구 필요)`,
        );
        throw restoreError;
      }
    }
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  rmSync(staging, { recursive: true, force: true });
}

