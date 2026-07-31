/**
 * 인벤토리 시드 → migration SQL 생성기 (삼순 재리뷰 #7 반영).
 *
 * 왜 필요한가: `buildInventorySeed()`가 코드에만 있으면 migration 적용 직후 DB는 0행이라
 * "900행 인벤토리"가 DB 사실이 아니다. 이 스크립트로 시드를 SQL로 고정해 migration에 넣고,
 * DB 회귀(PG17)에서 실제 행수·멱등성·pending/ambiguous 미승격을 검증한다.
 *
 * 실행: npx tsx scripts/baseball-qa/build-rag-inventory-seed.ts
 *   → supabase/migrations/20260731_genius_rag_inventory_seed.sql 재생성(결정론적).
 *
 * 재생성물은 커밋된 파일과 byte-exact여야 한다(스모크가 drift를 차단).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventorySeed } from "../../src/lib/baseball-qa/rag/source-inventory";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
export const SEED_MIGRATION_PATH = path.join(
  ROOT,
  "supabase/migrations/20260731_genius_rag_inventory_seed.sql",
);

function sqlLiteral(value: string | null): string {
  if (value === null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

export function renderSeedSql(): string {
  const rows = buildInventorySeed();

  const values = rows
    .map((row) =>
      [
        sqlLiteral(row.entityType),
        sqlLiteral(row.entityId),
        sqlLiteral(row.entityName),
        sqlLiteral(row.sourceKind),
        sqlLiteral(row.sourceGrade),
        sqlLiteral(row.canonicalUrl),
        sqlLiteral(row.status),
        sqlLiteral(row.statusReason),
      ].join(", "),
    )
    .map((tuple) => `  (${tuple})`)
    .join(",\n");

  return `-- 야잘알봇 v2 Hybrid RAG — S2a 소스 인벤토리 시드 (rev0.7 §12)
-- ⚠️ 자동 생성 파일. 직접 수정하지 말고 아래 스크립트를 다시 실행할 것:
--    npx tsx scripts/baseball-qa/build-rag-inventory-seed.ts
-- 소스: src/lib/baseball-qa/rag/source-inventory.ts (buildInventorySeed)
--
-- ⚠️ 운영 DB 직접 적용 금지 — 삼순 GO + 하린아빠 머지 승인 후 별도 적용.
--
-- 총 ${rows.length}행. 크롤 검증 전이라 resolved는 0이고 대부분 pending이다.
-- 멱등: ON CONFLICT (entity_type, entity_id, source_kind)에서 분류 상태를 갱신하되,
-- **이미 resolved로 승격된 행을 pending으로 되돌리지 않는다**(재실행이 검증 결과를 지우면 안 됨).

INSERT INTO public.genius_source_inventory (
  entity_type, entity_id, entity_name, source_kind, source_grade,
  canonical_url, status, status_reason
) VALUES
${values}
ON CONFLICT (entity_type, entity_id, source_kind) DO UPDATE
SET entity_name = EXCLUDED.entity_name,
    canonical_url = CASE
      WHEN public.genius_source_inventory.status = 'resolved'
        THEN public.genius_source_inventory.canonical_url
      ELSE EXCLUDED.canonical_url
    END,
    status = CASE
      WHEN public.genius_source_inventory.status = 'resolved' THEN 'resolved'
      ELSE EXCLUDED.status
    END,
    status_reason = CASE
      WHEN public.genius_source_inventory.status = 'resolved'
        THEN public.genius_source_inventory.status_reason
      ELSE EXCLUDED.status_reason
    END,
    updated_at = now();
`;
}

function main() {
  const sql = renderSeedSql();
  fs.writeFileSync(SEED_MIGRATION_PATH, sql, "utf8");
  console.log(`wrote ${SEED_MIGRATION_PATH} (${sql.length} bytes)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
