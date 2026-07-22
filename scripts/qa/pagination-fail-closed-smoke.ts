/**
 * 전량조회 회귀: Supabase 1000행 경계 + page-2 오류 fail-closed.
 * 실행: npm run qa:pagination
 */
import "./_smoke-env";
import { fetchAllByKeyset } from "../../src/lib/db/paginate";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean) {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`✗ ${name}`);
  }
}

interface Row {
  id: number;
}

async function fetchFixture(size: number): Promise<Row[]> {
  const source = Array.from({ length: size }, (_, index) => ({ id: index + 1 }));
  return fetchAllByKeyset(async (cursor, limit) => ({
    data: source.filter((row) => cursor === null || row.id > cursor).slice(0, limit),
    error: null,
  }), (row) => row.id, { label: `fixture-${size}` });
}

async function main() {
  for (const size of [999, 1000, 1001, 2001]) {
    const rows = await fetchFixture(size);
    const ids = new Set(rows.map((row) => row.id));
    check(
      `${size}행 전량·중복0`,
      rows.length === size && ids.size === size && (size === 0 || rows.at(-1)?.id === size),
    );
  }

  let page = 0;
  let rejected = false;
  try {
    await fetchAllByKeyset(async (cursor, limit) => {
      page += 1;
      if (page === 2) return { data: null, error: { message: "page-2 fault" } };
      const start = cursor ?? 0;
      return {
        data: Array.from({ length: limit }, (_, index) => ({ id: start + index + 1 })),
        error: null,
      };
    }, (row) => row.id, { label: "fault-fixture" });
  } catch (error) {
    rejected = (error as Error).message.includes("page-2 fault");
  }
  check("page-2 오류는 partial rows 대신 reject", rejected && page === 2);

  let nonUniqueRejected = false;
  try {
    await fetchAllByKeyset(async () => ({
      data: [{ id: 1 }, { id: 1 }],
      error: null,
    }), (row) => row.id, { label: "non-unique-fixture" });
  } catch (error) {
    nonUniqueRejected = (error as Error).message.includes("unique and strictly ascending");
  }
  check("비유일 keyset은 fail-closed", nonUniqueRejected);

  console.log(`pagination fail-closed smoke: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
