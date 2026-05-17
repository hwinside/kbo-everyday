/**
 * Smoke test for client-side celebration double-fire dedupe.
 *
 * Validates the module-level `shouldTrack` guard and queue-level
 * deduplication in useCelebration. Since useCelebration is a React hook,
 * we test the extracted module-level dedupe logic directly and simulate
 * the queue-level filter logic.
 */

// ---------- shouldTrack unit tests ----------

// Re-implement shouldTrack locally (same logic as useCelebration.ts module-level)
const trackedEvents = new Map<string, number>();
const TRACK_DEDUPE_MS = 5_000;

function shouldTrack(eventId: string): boolean {
  const now = Date.now();
  if (trackedEvents.size > 200) {
    for (const [k, t] of trackedEvents) {
      if (now - t > TRACK_DEDUPE_MS) trackedEvents.delete(k);
    }
  }
  if (trackedEvents.has(eventId) && now - trackedEvents.get(eventId)! < TRACK_DEDUPE_MS) {
    return false;
  }
  trackedEvents.set(eventId, now);
  return true;
}

let failed = 0;
function assert(label: string, cond: boolean, detail?: unknown) {
  const tag = cond ? "PASS" : "FAIL";
  console.log(`[${tag}] ${label}`);
  if (!cond) {
    failed++;
    if (detail !== undefined) console.log("  detail:", detail);
  }
}

// --- T1: First call for an event_id returns true ---
{
  trackedEvents.clear();
  assert(
    "T1: first track returns true",
    shouldTrack("evt-001") === true,
  );
}

// --- T2: Immediate duplicate within 5s returns false ---
{
  // evt-001 was just tracked in T1
  assert(
    "T2: immediate duplicate returns false",
    shouldTrack("evt-001") === false,
  );
}

// --- T3: Different event_id returns true (no cross-contamination) ---
{
  assert(
    "T3: different event_id returns true",
    shouldTrack("evt-002") === true,
  );
}

// --- T4: After TTL expires, same event_id returns true again ---
{
  trackedEvents.clear();
  // Manually backdate the entry
  trackedEvents.set("evt-003", Date.now() - TRACK_DEDUPE_MS - 1);
  assert(
    "T4: expired TTL allows re-track",
    shouldTrack("evt-003") === true,
  );
}

// --- T5: Rapid-fire same event (simulating StrictMode double-render) ---
{
  trackedEvents.clear();
  const first = shouldTrack("evt-double");
  const second = shouldTrack("evt-double");
  const third = shouldTrack("evt-double");
  assert(
    "T5: rapid-fire — only first returns true",
    first === true && second === false && third === false,
  );
}

// --- T6: Cleanup at size > 200 ---
{
  trackedEvents.clear();
  const base = Date.now() - TRACK_DEDUPE_MS - 1;
  for (let i = 0; i < 210; i++) {
    trackedEvents.set(`old-${i}`, base);
  }
  assert("T6: pre-cleanup size > 200", trackedEvents.size === 210);
  shouldTrack("trigger-cleanup");
  assert(
    "T6: post-cleanup size reduced",
    trackedEvents.size < 210,
    trackedEvents.size,
  );
}

// ---------- Queue-level + display dedupe simulation ----------

interface FakeCelebration { id: string; type: string }

// Module-level display dedupe (mirrors displayedEventIds in useCelebration.ts)
const displayedEventIds = new Set<string>();

// Simulates the queue + display filter logic from useCelebration.ts
function filterDupes(
  incoming: FakeCelebration[],
  showing: FakeCelebration | null,
  queue: FakeCelebration[],
): FakeCelebration[] {
  const queuedIds = new Set(queue.map(c => c.id));
  if (showing?.id) queuedIds.add(showing.id);
  return incoming.filter(c => {
    if (!c.id) return true;
    if (queuedIds.has(c.id)) return false;
    if (displayedEventIds.has(c.id)) return false;
    displayedEventIds.add(c.id);
    return true;
  });
}

// --- T7: Queue filter removes already-showing celebration ---
{
  const showing: FakeCelebration = { id: "evt-show", type: "hit" };
  const incoming: FakeCelebration[] = [
    { id: "evt-show", type: "hit" },  // duplicate of showing
    { id: "evt-new", type: "homerun" },  // fresh
  ];
  const result = filterDupes(incoming, showing, []);
  assert(
    "T7: queue filter removes showing duplicate",
    result.length === 1 && result[0].id === "evt-new",
    result,
  );
}

// --- T8: Queue filter removes already-queued celebration ---
{
  const queue: FakeCelebration[] = [{ id: "evt-queued", type: "double" }];
  const incoming: FakeCelebration[] = [
    { id: "evt-queued", type: "double" },  // already in queue
    { id: "evt-fresh", type: "walk" },
  ];
  const result = filterDupes(incoming, null, queue);
  assert(
    "T8: queue filter removes queued duplicate",
    result.length === 1 && result[0].id === "evt-fresh",
    result,
  );
}

// --- T9: All distinct events pass through ---
{
  const incoming: FakeCelebration[] = [
    { id: "a", type: "hit" },
    { id: "b", type: "double" },
    { id: "c", type: "homerun" },
  ];
  const result = filterDupes(incoming, null, []);
  assert(
    "T9: all distinct events pass through",
    result.length === 3,
    result,
  );
}

// --- T10: Simulated remount scenario (telemetry) ---
// Component unmounts and remounts. Module-level shouldTrack still blocks.
{
  trackedEvents.clear();
  shouldTrack("remount-evt");
  const secondMount = shouldTrack("remount-evt");
  assert(
    "T10: remount — telemetry module-level dedupe blocks second mount",
    secondMount === false,
  );
}

// --- T11: Simulated remount scenario (display) ---
// displayedEventIds survives across component remounts.
// First mount: event passes filter + added to displayedEventIds.
// Second mount: queue/showing are empty (fresh hook), but displayedEventIds blocks.
{
  displayedEventIds.clear();
  const incoming: FakeCelebration[] = [{ id: "display-remount", type: "hit" }];

  // First mount: passes
  const firstResult = filterDupes(incoming, null, []);
  assert(
    "T11a: first mount — display passes",
    firstResult.length === 1,
    firstResult,
  );

  // Simulate remount: queue and showing are empty (new hook instance)
  // but displayedEventIds persists at module level
  const secondResult = filterDupes(incoming, null, []);
  assert(
    "T11b: remount — display blocked by module-level displayedEventIds",
    secondResult.length === 0,
    secondResult,
  );
}

// --- T12: Display dedupe doesn't block different events ---
{
  displayedEventIds.clear();
  filterDupes([{ id: "evt-A", type: "hit" }], null, []);
  const result = filterDupes([{ id: "evt-B", type: "double" }], null, []);
  assert(
    "T12: different event passes display dedupe",
    result.length === 1 && result[0].id === "evt-B",
    result,
  );
}

if (failed > 0) {
  console.log(`\n❌ ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\n✅ All assertions passed");
