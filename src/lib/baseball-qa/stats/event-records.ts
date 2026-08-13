import { createHash } from "node:crypto";

const EVENT_SOURCE_URL =
  "https://www.koreabaseball.com/kbo/board/ebook/ebookpublication.aspx";
const EVENT_SNAPSHOT_SHA256 =
  "041e31fba2f1ec9fb75bc6c2c2050e200b8eb89be0a76de0d185b56808ce10f5";

export interface NoHitNoRunEvent {
  readonly ordinal: number;
  readonly player: string;
  readonly team: string;
  readonly date: string;
  readonly opponent: string;
  readonly ballpark: string;
  readonly catchers: readonly string[];
  readonly score: string;
  readonly note: string;
}

interface EventSnapshot {
  readonly schemaVersion: number;
  readonly throughSeason: number;
  readonly source: {
    readonly title: string;
    readonly section: string;
    readonly printedPage: number;
    readonly canonicalUrl: string;
  };
  readonly events: readonly NoHitNoRunEvent[];
  readonly excluded: readonly { player: string; date: string; reason: string }[];
  readonly sha256: string;
}

export type EventRecordQuery =
  | { readonly kind: "count" }
  | { readonly kind: "list" }
  | { readonly kind: "first" | "latest" }
  | { readonly kind: "ordinal"; readonly ordinal: number }
  | { readonly kind: "player"; readonly player: string };

export interface EventRecordAnswer {
  readonly query: EventRecordQuery;
  readonly events: readonly NoHitNoRunEvent[];
  readonly total: number;
  readonly throughSeason: number;
  readonly sourceUrl: string;
}

function compact(question: string): string {
  return question.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/** KBO 레코드북의 닫힌 섹션명만 결속한다. 다른 사건명을 추정해 바꾸지 않는다. */
export function isNoHitNoRunQuestion(question: string): boolean {
  return /노[\s-]?히트[\s-]?노[\s-]?런/i.test(question.normalize("NFKC"));
}

export function resolveEventRecordQuery(
  question: string,
  playerNames: readonly string[],
): EventRecordQuery | null {
  if (!isNoHitNoRunQuestion(question)) return null;
  const normalized = compact(question);
  const named = playerNames.filter((name) => normalized.includes(compact(name)));
  if (named.length > 1) return null;

  const ordinals = [...normalized.matchAll(/(?:역대)?(\d{1,2})(?:번째|호)/g)];
  if (ordinals.length > 1) return null;
  const ordinal = ordinals[0];
  const hasFirst = /(?:최초|처음|첫번째)/.test(normalized);
  const hasLatest = /(?:최근|마지막|최신)/.test(normalized);
  const hasCount = /(?:몇번|몇차례|몇명|총몇|개수|횟수)/.test(normalized);
  const hasList = /(?:전체목록|달성선수|목록|전부|모두)/.test(normalized);
  const intentCount = Number(named.length === 1) + Number(Boolean(ordinal)) +
    Number(hasFirst) + Number(hasLatest) + Number(hasCount) + Number(hasList);
  if (intentCount > 1) return null;

  const query: EventRecordQuery = named.length === 1
    ? { kind: "player", player: named[0] }
    : ordinal
      ? { kind: "ordinal", ordinal: Number(ordinal[1]) }
      : hasFirst
        ? { kind: "first" }
        : hasLatest
          ? { kind: "latest" }
          : hasCount
            ? { kind: "count" }
            : { kind: "list" };

  // Query kind를 먼저 반환하면 미지원 한정어가 버려져 정규시즌 전체 기록으로 오결속된다.
  // 닫힌 문법을 전부 소비한 질문만 구조화 조회로 보낸다.
  let residue = normalized.replace(/노-?히트-?노-?런/g, "");
  if (named.length === 1) residue = residue.replace(compact(named[0]), "");
  residue = residue
    .replace(/(?:역대)?\d{1,2}(?:번째|호)/g, "")
    .replace(/(?:kbo|역대|정규시즌|공식|기록|전체목록|달성선수|목록|전부|모두|최초|처음|첫번째|가장|최근|마지막|최신|총몇번|총몇차례|총몇명|몇번|몇차례|몇명|총몇|개수|횟수|나왔어|나왔나요|알려줘|알려주세요|누구야|누가|있어|있나요|해줘)/g, "")
    .replace(/[?!？！.,。]/g, "");
  return residue.length === 0 ? query : null;
}

function validSnapshot(value: unknown): value is EventSnapshot {
  const snapshot = value as Partial<EventSnapshot>;
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.throughSeason !== 2025 ||
    snapshot.source?.title !== "2026 KBO 레코드북" ||
    snapshot.source?.section !== "노히트노런" ||
    snapshot.source?.printedPage !== 104 ||
    snapshot.source?.canonicalUrl !== EVENT_SOURCE_URL ||
    snapshot.sha256 !== EVENT_SNAPSHOT_SHA256 ||
    !Array.isArray(snapshot.events) ||
    snapshot.events.length !== 14 ||
    !Array.isArray(snapshot.excluded) ||
    snapshot.excluded.length !== 2
  ) return false;

  const { sha256, ...unsigned } = snapshot as EventSnapshot;
  if (createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") !== sha256) return false;

  const ordinals = new Set<number>();
  for (const event of snapshot.events) {
    if (
      !Number.isInteger(event.ordinal) || event.ordinal < 1 || !event.player || !event.team ||
      !/^\d{4}-\d{2}-\d{2}$/.test(event.date) || !event.opponent || !event.ballpark ||
      !Array.isArray(event.catchers) || event.catchers.length < 1 ||
      event.catchers.some((name: string) => !name) || !/^\d+-\d+$/.test(event.score) ||
      !event.note || ordinals.has(event.ordinal)
    ) return false;
    ordinals.add(event.ordinal);
  }
  return snapshot.events.every((event, index) => event.ordinal === index + 1);
}

export function resolveEventRecord(
  snapshot: unknown,
  query: EventRecordQuery,
): EventRecordAnswer | null {
  if (!validSnapshot(snapshot)) return null;
  let events: readonly NoHitNoRunEvent[];
  switch (query.kind) {
    case "count":
    case "list": events = snapshot.events; break;
    case "first": events = snapshot.events.slice(0, 1); break;
    case "latest": events = snapshot.events.slice(-1); break;
    case "ordinal": events = snapshot.events.filter((event) => event.ordinal === query.ordinal); break;
    case "player": events = snapshot.events.filter((event) => event.player === query.player); break;
  }
  if (events.length === 0) return null;
  return {
    query, events, total: snapshot.events.length, throughSeason: snapshot.throughSeason,
    sourceUrl: snapshot.source.canonicalUrl,
  };
}

function formatDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${year}년 ${month}월 ${day}일`;
}

function eventDetail(event: NoHitNoRunEvent): string {
  return `${event.ordinal}번째는 ${formatDate(event.date)} ${event.player}(${event.team})의 ` +
    `${event.opponent}전 ${event.score} 기록입니다. 포수 ${event.catchers.join("·")}, ${event.note}.`;
}

export function composeEventRecordAnswer(result: EventRecordAnswer): string {
  const source = `\n📄 출처: ${result.throughSeason + 1} KBO 레코드북 p.104`;
  switch (result.query.kind) {
    case "count":
      return `${result.throughSeason}시즌까지 KBO 정규시즌 공식 노히트노런은 ${result.total}번입니다.${source}`;
    case "list": {
      const names = result.events.map((event) => `${event.ordinal}. ${event.player}(${event.team})`).join(" · ");
      return `${result.throughSeason}시즌까지 KBO 정규시즌 공식 노히트노런은 ${result.total}번입니다.\n${names}${source}`;
    }
    case "first":
      return `KBO 정규시즌 최초 노히트노런은 ${eventDetail(result.events[0])}${source}`;
    case "latest":
      return `${result.throughSeason}시즌까지 가장 최근 KBO 정규시즌 노히트노런은 ${eventDetail(result.events[0])}${source}`;
    case "ordinal":
    case "player":
      return `KBO 정규시즌 노히트노런 ${eventDetail(result.events[0])}${source}`;
  }
}

export function resolveEventRecordQuestion(
  snapshot: unknown,
  question: string,
): EventRecordAnswer | null {
  if (!validSnapshot(snapshot)) return null;
  const query = resolveEventRecordQuery(question, snapshot.events.map((event) => event.player));
  return query ? resolveEventRecord(snapshot, query) : null;
}

export function createEventRecordFetcher(loadSnapshot: () => unknown) {
  return async (question: string): Promise<EventRecordAnswer | null> =>
    resolveEventRecordQuestion(loadSnapshot(), question);
}
