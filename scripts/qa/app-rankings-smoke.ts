// Smoke: admin app-rankings chart parsing — fail-close + timeout contracts.
// Run: npm run qa:app-rankings
import {
  rankFromItunesFeed,
  rankFromPlayList,
  withTimeout,
} from "../../src/lib/admin/app-rankings";

let pass = 0;
let fail = 0;

function check(name: string, fn: () => boolean | Promise<boolean>) {
  return Promise.resolve()
    .then(fn)
    .then((ok) => {
      if (ok) {
        pass++;
        console.log(`  ✅ ${name}`);
      } else {
        fail++;
        console.log(`  ❌ ${name}`);
      }
    })
    .catch((e) => {
      fail++;
      console.log(`  ❌ ${name} — threw unexpectedly: ${(e as Error).message}`);
    });
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const APP = "6765719087";
const entry = (id: string) => ({ id: { attributes: { "im:id": id } } });

async function main() {
  console.log("[itunes feed]");
  await check("rank found (2nd of 3)", () => {
    const r = rankFromItunesFeed({ feed: { entry: [entry("1"), entry(APP), entry("3")] } }, APP);
    return r.rank === 2 && r.chartSize === 3;
  });
  await check("app absent → rank null, chartSize kept (권외)", () => {
    const r = rankFromItunesFeed({ feed: { entry: [entry("1"), entry("2")] } }, APP);
    return r.rank === null && r.chartSize === 2;
  });
  await check("single-entry object form still parses", () => {
    const r = rankFromItunesFeed({ feed: { entry: entry(APP) } }, APP);
    return r.rank === 1 && r.chartSize === 1;
  });
  await check("empty entry array → throws (fail-close, not 0위 밖)", () =>
    throws(() => rankFromItunesFeed({ feed: { entry: [] } }, APP)),
  );
  await check("missing feed → throws", () => throws(() => rankFromItunesFeed({}, APP)));
  await check("null payload → throws", () => throws(() => rankFromItunesFeed(null, APP)));
  await check("schema reshape (entries without im:id) → throws", () =>
    throws(() =>
      rankFromItunesFeed({ feed: { entry: [{ id: {} }, { name: "x" }] } }, APP),
    ),
  );
  await check("partial schema: id-less entries excluded from chartSize", () => {
    const r = rankFromItunesFeed(
      { feed: { entry: [{ name: "junk" }, entry(APP), entry("2")] } },
      APP,
    );
    return r.rank === 1 && r.chartSize === 2;
  });

  console.log("[play list]");
  await check("rank found", () => {
    const r = rankFromPlayList(
      [{ appId: "a" }, { appId: "fan.keubo.app" }, { appId: "c" }],
      "fan.keubo.app",
    );
    return r.rank === 2 && r.chartSize === 3;
  });
  await check("app absent → rank null, chartSize kept (권외)", () => {
    const r = rankFromPlayList([{ appId: "a" }, { appId: "b" }], "fan.keubo.app");
    return r.rank === null && r.chartSize === 2;
  });
  await check("empty array → throws (fail-close)", () =>
    throws(() => rankFromPlayList([], "fan.keubo.app")),
  );
  await check("non-array payload → throws", () =>
    throws(() => rankFromPlayList({ items: [] }, "fan.keubo.app")),
  );
  await check("schema reshape (no appId fields) → throws", () =>
    throws(() => rankFromPlayList([{ id: "a" }, { id: "b" }], "fan.keubo.app")),
  );

  console.log("[withTimeout]");
  await check("resolves before deadline", async () => {
    const v = await withTimeout(Promise.resolve(42), 1000, "t");
    return v === 42;
  });
  await check("rejects after deadline (slow source bounded)", async () => {
    try {
      await withTimeout(new Promise((r) => setTimeout(r, 200)), 20, "slow");
      return false;
    } catch (e) {
      return (e as Error).message.includes("timeout");
    }
  });
  await check("propagates source rejection", async () => {
    try {
      await withTimeout(Promise.reject(new Error("boom")), 1000, "t");
      return false;
    } catch (e) {
      return (e as Error).message === "boom";
    }
  });

  console.log(`\n${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main();
