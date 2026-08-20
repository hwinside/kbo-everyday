/**
 * 뉴스클리핑 payload 정규화(digest 참조) 계약 게이트.
 *
 * Why
 * ---
 * 2026-08-20 실측: dm_messages 2,110MB 중 TOAST 1,592MB. content 는 평균 60바이트인데
 * payload 가 평균 2,025바이트이고 96.7% 행에 있었다. 내용을 보니 같은 기사 묶음을
 * 수신자 수만큼 통째로 복제 저장 중이었다(8/18 KIA 6,102행 / distinct payload 120 = 중복률 98%).
 *
 * 이 PR 은 기사 묶음을 news_clipping_digests 1행으로 옮기고 쪽지에는 digest_id 만 남긴다.
 *
 * 여기서 고정하는 계약(깨지면 유저가 즉시 다친다):
 *  1) 과거 쪽지(legacy payload)는 그대로 렌더된다 — 수백만 건을 재작성하지 않으므로 필수.
 *  2) 신규 쪽지(ref payload)는 digest 를 붙이면 렌더된다.
 *  3) ref 인데 digest 가 없으면 **null 로 fail-close** — 빈 카드는 "오늘 기사 없음"이라는
 *     거짓 정보다. 카드 대신 텍스트 본문이 나가야 한다.
 *  4) intro(유저별 닉네임 치환)는 digest 가 아니라 쪽지 payload 에 남는다 — digest 는
 *     (clip_date, team_id) 공유 행이라 거기 넣으면 한 사람 닉네임이 팀 전체에 보인다.
 *  5) 식별 술어가 두 형태를 모두 인정한다 — 기존 isNewsClippingPayload 는 articles.length>0 을
 *     요구했고, 그대로 뒀으면 신규 쪽지가 전부 일반 텍스트로 렌더됐다.
 *  6) [삼순 blocker 2] push_preview 가 ref payload 에 실려 푸시가 digest 를 재조회하지 않는다.
 *
 * 실행: npx tsx scripts/qa/news-clipping-digest-smoke.ts  (npm run qa:news-clip-digest)
 */
import {
  NEWS_CLIPPING_PUSH_PREVIEW_FALLBACK,
  NEWS_CLIPPING_PUSH_PREVIEW_MAX,
  NEWS_CLIPPING_REF_VERSION,
  hasSelfContainedPushBody,
  isLegacyNewsClippingPayload,
  isLegacyRefPayload,
  isNewsClippingPayload,
  isRefNewsClippingPayload,
  shouldFetchDigestForPush,
  toNewsClippingView,
  toPushPreview,
  type NewsClippingArticle,
  type NewsClippingDigest,
  type NewsClippingLegacyPayload,
  type NewsClippingRefPayload,
} from "@/types/news-clipping";
import {
  DIGEST_MAX_ATTEMPTS,
  NewsClippingDigestLoader,
  digestRetryDelayMs,
  type DigestFetchResult,
} from "@/lib/news-clipping-digest-loader";

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}

const ARTICLES: NewsClippingArticle[] = [
  {
    title: "LG, 두산 꺾고 4연승",
    link: "https://n.news.naver.com/mnews/article/001/0001",
    original_link: "https://sports.example.com/1",
    thumbnail_url: "https://img.example.com/1.jpg",
    summary: ["무슨 일", "구체 내용", "팬 관점"],
  },
  {
    title: "오스틴 결승 2루타",
    link: "https://n.news.naver.com/mnews/article/001/0002",
    original_link: null as unknown as string | undefined,
    thumbnail_url: null,
    summary: ["a", "b", "c"],
  },
];

const LEGACY: NewsClippingLegacyPayload = {
  type: "news_clipping",
  team_id: 1,
  team_name: "LG 트윈스",
  date: "2026-08-19",
  overview: "4연승 질주",
  articles: ARTICLES,
};

const REF: NewsClippingRefPayload = {
  type: "news_clipping",
  team_id: 1,
  team_name: "LG 트윈스",
  date: "2026-08-19",
  digest_id: 42,
  v: NEWS_CLIPPING_REF_VERSION,
  push_preview: "4연승 질주",
};

const DIGEST: NewsClippingDigest = {
  id: 42,
  clip_date: "2026-08-19",
  team_id: 1,
  team_name: "LG 트윈스",
  overview: "4연승 질주",
  articles: ARTICLES,
};

// ── 1) 식별 술어 ─────────────────────────────────────────────────────────
ok("legacy 는 legacy 로 식별", isLegacyNewsClippingPayload(LEGACY));
ok("legacy 는 ref 가 아님", !isRefNewsClippingPayload(LEGACY));
ok("ref 는 ref 로 식별", isRefNewsClippingPayload(REF));
ok("ref 는 legacy 가 아님", !isLegacyNewsClippingPayload(REF));
// 이게 깨지면 신규 쪽지가 전부 일반 텍스트로 렌더된다(사용자가 즉시 본다).
ok("통합 술어가 legacy 인정", isNewsClippingPayload(LEGACY));
ok("통합 술어가 ref 인정", isNewsClippingPayload(REF));

// 비클리핑/위조 방어
ok("type 다르면 거부", !isNewsClippingPayload({ type: "urgent_notice", articles: ARTICLES }));
ok("null 거부", !isNewsClippingPayload(null));
ok("문자열 거부", !isNewsClippingPayload("news_clipping"));
ok("빈 articles 는 legacy 아님", !isLegacyNewsClippingPayload({ ...LEGACY, articles: [] }));
ok(
  "digest_id 가 0/음수/문자열이면 ref 아님",
  !isRefNewsClippingPayload({ ...REF, digest_id: 0 }) &&
    !isRefNewsClippingPayload({ ...REF, digest_id: -1 }) &&
    !isRefNewsClippingPayload({ ...REF, digest_id: "42" }),
);

// ── 2) 렌더 정규화 ────────────────────────────────────────────────────────
{
  const view = toNewsClippingView(LEGACY, null);
  ok("legacy 는 digest 없이도 렌더됨(과거 쪽지 보존)", view !== null);
  ok("legacy 기사 수 보존", view?.articles.length === 2);
  ok("legacy overview 보존", view?.overview === "4연승 질주");
}
{
  const view = toNewsClippingView(REF, DIGEST);
  ok("ref + digest 렌더됨", view !== null);
  ok("ref 기사 수는 digest 에서", view?.articles.length === 2);
  ok("ref overview 는 digest 에서", view?.overview === "4연승 질주");
}
{
  // ⚠️ 관측 가능성: payload 와 digest 의 team_name/date 가 같은 픽스처로는 "어느 쪽을 우선하는가"
  //    계약이 원리적으로 관측되지 않는다(훼손해도 결과가 같다). 값을 달리 부여해 무대를 만든다.
  //    왜 쪽지 payload 가 우선인가: digest 는 (clip_date, team_id) 단일 행이라 나중에 갱신될 수
  //    있고(현재는 insert-once 지만), 발송 당시 사실을 지키는 것은 쪽지 payload 쪽이다.
  const renamedDigest: NewsClippingDigest = {
    ...DIGEST,
    team_name: "서울 LG 트윈스(개명)",
    clip_date: "2026-01-01",
  };
  const view = toNewsClippingView(REF, renamedDigest);
  ok("ref team_name 은 쪽지 payload 우선(발송 당시 사실)", view?.team_name === "LG 트윈스");
  ok("ref date 도 쪽지 payload 우선", view?.date === "2026-08-19");
  // 반대로 payload 값이 비어있으면 digest 로 폴백한다(방어적 기본값).
  const empty = toNewsClippingView({ ...REF, team_name: "", date: "" }, renamedDigest);
  ok("payload team_name 공백이면 digest 폴백", empty?.team_name === "서울 LG 트윈스(개명)");
  ok("payload date 공백이면 digest 폴백", empty?.date === "2026-01-01");
}

// ── 3) fail-close ────────────────────────────────────────────────────────
// 빈 카드를 그리면 "오늘 기사가 없다"는 거짓말이 된다. null 이어야 텍스트 본문으로 떨어진다.
ok("ref + digest 없음 → null(fail-close)", toNewsClippingView(REF, null) === null);
ok("ref + digest undefined → null", toNewsClippingView(REF, undefined) === null);
ok(
  "ref + digest.articles 빈배열 → null",
  toNewsClippingView(REF, { ...DIGEST, articles: [] }) === null,
);
ok(
  "ref + digest.articles 비배열 → null",
  toNewsClippingView(REF, { ...DIGEST, articles: null as unknown as NewsClippingArticle[] }) === null,
);

// ── 4) intro 는 쪽지 payload 단에 남는다 ──────────────────────────────────
// digest 는 (clip_date, team_id) 공유 행이다. intro 가 거기 들어가면 한 사람의 닉네임이
// 그 팀 수신자 전원에게 보인다 — 개인정보 노출.
{
  const refWithIntro: NewsClippingRefPayload = { ...REF, intro: "민수님 반갑습니다" };
  const view = toNewsClippingView(refWithIntro, DIGEST);
  ok("ref intro 가 view 로 전달됨", view?.intro === "민수님 반갑습니다");
  ok(
    "digest 타입에 intro 필드가 없다(공유 행 오염 방지)",
    !Object.prototype.hasOwnProperty.call(DIGEST, "intro"),
  );
  // 같은 digest 를 공유하는 다른 유저의 view 에는 그 intro 가 없어야 한다.
  const other = toNewsClippingView(REF, DIGEST);
  ok("같은 digest 를 쓰는 다른 유저에게 intro 안 샘", other?.intro === undefined);
}
{
  const legacyWithIntro: NewsClippingLegacyPayload = { ...LEGACY, intro: "영희님 반갑습니다" };
  ok("legacy intro 도 보존", toNewsClippingView(legacyWithIntro, null)?.intro === "영희님 반갑습니다");
}

// ── 5) push_preview (삼순 blocker 2) ──────────────────────────────────────
// 1차는 ref payload 에 overview 가 없어 푸시 디스패처가 매번 digest 를 다시 SELECT 했다.
// 하루 27,208건 발송이면 DB 조회 27,208회 추가 — 디스크 줄이려다 읽기 부하를 만드는 교환.
{
  ok("toPushPreview 가 짧은 총평을 그대로 반환", toPushPreview("4연승 질주") === "4연승 질주");
  // ⚠️ 3차 변경: 빈 총평도 **기본 문구로 채운다**. undefined 를 돌려주면 신규 발송에서
  //    push_preview 가 사라져 per-DM digest 조회가 부활한다(삼순 blocker 2, 3차).
  ok(
    "빈 총평은 기본 문구(undefined 아님)",
    toPushPreview("") === NEWS_CLIPPING_PUSH_PREVIEW_FALLBACK &&
      toPushPreview(null) === NEWS_CLIPPING_PUSH_PREVIEW_FALLBACK,
  );
  const long = "가".repeat(NEWS_CLIPPING_PUSH_PREVIEW_MAX + 50);
  const clipped = toPushPreview(long);
  ok(
    `긴 총평은 ${NEWS_CLIPPING_PUSH_PREVIEW_MAX}자로 잘린다 (실측 ${clipped?.length})`,
    clipped !== undefined && clipped.length === NEWS_CLIPPING_PUSH_PREVIEW_MAX,
  );
  ok("잘린 미리보기는 말줄임표로 끝난다", clipped?.endsWith("…") === true);

  // 핵심 계약: ref payload 만으로 푸시 본문을 만들 수 있어야 한다(digest 조회 불필요).
  ok("ref payload 에 push_preview 가 실린다", typeof REF.push_preview === "string");
  ok("push_preview 만으로 푸시 본문 확보", (REF.overview ?? REF.push_preview) === "4연승 질주");

  // 그래도 전체 articles 는 payload 에 없다 — 용량 이득이 유지되는지 확인.
  ok("ref payload 에 articles 는 여전히 없다", REF.articles === undefined);
}

// ── 6) 정규화 효과(용량) — 이 PR 의 존재 이유를 수치로 고정 ───────────────
{
  const legacyBytes = JSON.stringify(LEGACY).length;
  const refBytes = JSON.stringify(REF).length;
  ok(`ref payload 가 legacy 보다 작다 (${refBytes}B < ${legacyBytes}B)`, refBytes < legacyBytes);
  // push_preview 를 실어도 이득이 유지되어야 한다. 실측 기준 legacy 평균 2,025B.
  ok(`ref 가 legacy 의 1/3 미만 (${(legacyBytes / refBytes).toFixed(1)}배 감소)`, refBytes * 3 < legacyBytes);
}

// ── 7) 푸시 조회 계약 (삼순 blocker 2, 3차) ────────────────────────────────
// "신규 발송은 어떤 입력에서도 per-DM digest 조회 0" 을 술어로 고정한다.
// preview 유무로 신구를 가르면 "신규인데 총평이 비어 preview 가 빈" 경우가 구형과
// 구분되지 않아 조회가 조용히 부활한다 — 그래서 버전 필드로 가른다.
{
  ok("신규 ref(v1, preview 있음) → 조회 안 함", !shouldFetchDigestForPush(REF));
  ok(
    "신규 ref 인데 preview 가 비어도 조회 안 함(버전으로 판정)",
    !shouldFetchDigestForPush({ ...REF, push_preview: "" }) &&
      !shouldFetchDigestForPush({ ...REF, push_preview: undefined }) &&
      !shouldFetchDigestForPush({ ...REF, push_preview: "   " }),
  );
  ok(
    "구형 ref(버전 없음) + 본문 없음 → 조회 함(유일한 폴백)",
    shouldFetchDigestForPush({ digest_id: 42 }),
  );
  ok(
    "구형 ref 라도 preview 있으면 조회 안 함",
    !shouldFetchDigestForPush({ digest_id: 42, push_preview: "4연승" }),
  );
  ok("legacy(overview 보유) → 조회 안 함", !shouldFetchDigestForPush({ overview: "4연승" }));
  ok("digest_id 도 본문도 없으면 조회 안 함", !shouldFetchDigestForPush({}));

  // 발송 파이프라인 불변식: 신규 ref 는 항상 자기 힘으로 푸시 본문을 만든다.
  ok("신규 ref 는 self-contained", hasSelfContainedPushBody(REF));
  ok("구형 ref 판정", isLegacyRefPayload({ ...REF, v: undefined } as NewsClippingRefPayload));
  ok("신규 ref 는 구형이 아님", !isLegacyRefPayload(REF));

  // 총평이 비어도 preview 는 절대 비지 않는다 → 신규 발송의 조회 0 이 구조적으로 보장된다.
  ok("빈 총평도 기본 문구로 채워짐", toPushPreview("") === NEWS_CLIPPING_PUSH_PREVIEW_FALLBACK);
  ok("null 총평도 기본 문구", toPushPreview(null) === NEWS_CLIPPING_PUSH_PREVIEW_FALLBACK);
  ok("공백만 있는 총평도 기본 문구", toPushPreview("   ") === NEWS_CLIPPING_PUSH_PREVIEW_FALLBACK);
}

async function runLoaderSuite(): Promise<void> {
  // ── 8) 로더 — 재시도·겹침·부분누락 (삼순 blocker 1, 3차) ───────────────────
  // 2차 구현은 실패 시 ref 만 갱신해 effect 가 다시 돌지 않았다 = **재시도가 한 번도
  // 일어나지 않았다**. 리렌더를 트리거로 쓰면 조용한 대화에서 영구 실패한다.
  // 여기서는 hook 을 렌더링하지 않고 로더의 스케줄링을 가짜 타이머로 직접 태운다.
  type Timer = { fn: () => void; ms: number; id: number };

  class FakeClock {
    private timers: Timer[] = [];
    private seq = 0;
    set = (fn: () => void, ms: number): unknown => {
      const id = ++this.seq;
      this.timers.push({ fn, ms, id });
      return id;
    };
    clear = (h: unknown): void => {
      this.timers = this.timers.filter((t) => t.id !== h);
    };
    pending(): number {
      return this.timers.length;
    }
    nextDelay(): number | null {
      return this.timers.length > 0 ? this.timers[0].ms : null;
    }
    /** 예약된 타이머 하나를 실행한다(실제 시간 경과 없이). */
    async tick(): Promise<void> {
      const t = this.timers.shift();
      if (!t) return;
      t.fn();
      // pump 는 async 라 마이크로태스크를 몇 번 흘려준다.
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
  }

  function makeDigest(id: number): NewsClippingDigest {
    return { ...DIGEST, id };
  }

  async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  // 8-1) 실패 → 타이머 재시도 → 성공. (리렌더 없이 회복되는가)
  {
    const clock = new FakeClock();
    let calls = 0;
    const fetcher = async (ids: number[]): Promise<DigestFetchResult> => {
      calls++;
      if (calls === 1) return { rows: [], error: "network down" };
      return { rows: ids.map(makeDigest) };
    };
    let changes = 0;
    const loader = new NewsClippingDigestLoader(fetcher, {
      onChange: () => { changes++; },
      setTimeoutFn: clock.set,
      clearTimeoutFn: clock.clear,
    });

    loader.request([7]);
    await flush();
    ok("8-1 1회 실패 후 digest 없음", loader.digests.size === 0);
    // 핵심: 리렌더(request 재호출) 없이도 재시도가 예약돼 있어야 한다.
    ok("8-1 실패 후 재시도 타이머가 예약된다(리렌더 불필요)", loader.hasPendingRetry());
    ok(`8-1 첫 backoff 는 ${digestRetryDelayMs(1)}ms`, clock.nextDelay() === digestRetryDelayMs(1));

    await clock.tick();
    ok("8-1 재시도로 회복", loader.digests.get(7)?.id === 7);
    ok("8-1 fetcher 2회 호출", calls === 2);
    ok("8-1 onChange 1회(성공 시에만)", changes === 1);
    ok("8-1 성공 후 재시도 타이머 없음", !loader.hasPendingRetry());
    loader.dispose();
  }

  // 8-2) 시도 상한 — 무한 재시도 금지, 상한 뒤에는 조용히 텍스트 렌더.
  {
    const clock = new FakeClock();
    let calls = 0;
    const loader = new NewsClippingDigestLoader(
      async () => { calls++; return { rows: [], error: "boom" }; },
      { onChange: () => {}, setTimeoutFn: clock.set, clearTimeoutFn: clock.clear },
    );
    loader.request([9]);
    await flush();
    for (let i = 0; i < DIGEST_MAX_ATTEMPTS + 2; i++) await clock.tick();
    ok(`8-2 시도는 ${DIGEST_MAX_ATTEMPTS}회에서 멈춘다 (실측 ${calls})`, calls === DIGEST_MAX_ATTEMPTS);
    ok("8-2 상한 후 타이머 없음(무한 재시도 아님)", !loader.hasPendingRetry());
    ok("8-2 backoff 는 지수", digestRetryDelayMs(2) === digestRetryDelayMs(1) * 2);
    loader.dispose();
  }

  // 8-3) 부분 누락 — 요청 3개 중 2개만 오면 나머지 1개만 재시도한다.
  {
    const clock = new FakeClock();
    const seen: number[][] = [];
    const loader = new NewsClippingDigestLoader(
      async (ids) => {
        seen.push([...ids]);
        return { rows: ids.filter((id) => id !== 3).map(makeDigest) };
      },
      { onChange: () => {}, setTimeoutFn: clock.set, clearTimeoutFn: clock.clear },
    );
    loader.request([1, 2, 3]);
    await flush();
    ok("8-3 받은 2건은 확정", loader.digests.has(1) && loader.digests.has(2));
    ok("8-3 못 받은 1건은 미확정", !loader.digests.has(3));
    await clock.tick();
    ok(
      `8-3 재시도는 누락분만 (실측 ${JSON.stringify(seen[1])})`,
      seen.length === 2 && seen[1].length === 1 && seen[1][0] === 3,
    );
    ok("8-3 성공분은 재요청 안 함", seen[1].includes(1) === false && seen[1].includes(2) === false);
    loader.dispose();
  }

  // 8-4) 요청 겹침 — 조회 중 새 메시지가 들어와도 진행 중 응답이 폐기되지 않는다.
  //      (1차 구현의 generation fence 가 정확히 이걸 깨뜨렸다: A 응답 폐기 + A 는 재조회 불가)
  {
    const clock = new FakeClock();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((res) => { release = res; });
    const seen: number[][] = [];
    const loader = new NewsClippingDigestLoader(
      async (ids) => {
        seen.push([...ids]);
        if (seen.length === 1) await gate;
        return { rows: ids.map(makeDigest) };
      },
      { onChange: () => {}, setTimeoutFn: clock.set, clearTimeoutFn: clock.clear },
    );
    loader.request([10]);
    await flush();
    ok("8-4 첫 요청 in-flight", loader.inFlightIds().join(",") === "10");
    // 조회 중 새 digest 요구가 들어온다(Realtime 새 쪽지).
    loader.request([11]);
    await flush();
    // 계약은 "동시 발사 금지"가 아니라 **같은 id 를 두 번 조회하지 않는다** 이다.
    // 새로 들어온 B 를 A 가 끝날 때까지 붙잡아둘 이유는 없다(카드가 늦게 뜬다).
    ok(
      `8-4 in-flight 인 A(10)를 다시 요청하지 않는다 (실측 ${JSON.stringify(seen)})`,
      seen.every((batch, i) => (i === 0 ? true : !batch.includes(10))),
    );
    release?.();
    await flush();
    ok("8-4 A 응답이 반영된다(폐기되지 않음)", loader.digests.has(10));
    // 남은 11 은 타이머 없이도 이어서 조회되거나, 재시도 타이머로 예약돼야 한다.
    if (!loader.digests.has(11)) await clock.tick();
    ok("8-4 겹쳐 들어온 B 도 결국 조회된다", loader.digests.has(11));
    ok("8-4 A 는 그대로 유지", loader.digests.has(10));
    loader.dispose();
  }

  // 8-5) 응답 오염 방어 — 요청하지 않은 행이 섞여 오면 버린다.
  {
    const clock = new FakeClock();
    const loader = new NewsClippingDigestLoader(
      async (ids) => ({ rows: [...ids.map(makeDigest), makeDigest(999)] }),
      { onChange: () => {}, setTimeoutFn: clock.set, clearTimeoutFn: clock.clear },
    );
    loader.request([5]);
    await flush();
    ok("8-5 요청한 행은 수용", loader.digests.has(5));
    ok("8-5 요청 안 한 행은 무시", !loader.digests.has(999));
    loader.dispose();
  }

  // 8-6) dispose 후에는 아무 일도 하지 않는다(언마운트 누수 방지).
  {
    const clock = new FakeClock();
    let calls = 0;
    const loader = new NewsClippingDigestLoader(
      async (ids) => { calls++; return { rows: ids.map(makeDigest) }; },
      { onChange: () => {}, setTimeoutFn: clock.set, clearTimeoutFn: clock.clear },
    );
    loader.dispose();
    loader.request([1]);
    await flush();
    ok("8-6 dispose 후 조회 안 함", calls === 0);
    ok("8-6 dispose 후 타이머 없음", clock.pending() === 0);
  }

  // 8-7) 재시도 대기 중 언마운트 — 예약된 타이머가 취소된다.
  //      대화 화면을 떠난 뒤에도 백오프 타이머가 살아 DB 를 두드리면 안 된다.
  //      (8-6 은 "dispose 후 새 요청"만 봐서 이 경로가 관측되지 않았다 — 무대를 따로 만든다.)
  {
    const clock = new FakeClock();
    let calls = 0;
    const loader = new NewsClippingDigestLoader(
      async () => { calls++; return { rows: [], error: "boom" }; },
      { onChange: () => {}, setTimeoutFn: clock.set, clearTimeoutFn: clock.clear },
    );
    loader.request([4]);
    await flush();
    ok("8-7 실패 후 재시도 타이머 예약됨(무대 성립)", clock.pending() === 1);
    const before = calls;
    loader.dispose();
    ok("8-7 dispose 가 예약 타이머를 취소한다", clock.pending() === 0);
    await clock.tick();
    ok("8-7 언마운트 후 추가 조회 없음", calls === before);
  }
}

// top-level await 는 이 스크립트의 cjs 트랜스폼에서 못 쓴다 — 명시적으로 태우고 종료 코드를 낸다.
void runLoaderSuite().then(() => {
  console.log(`\nnews-clipping digest: ${fail === 0 ? "PASS" : `${fail} FAILED`}`);
  if (fail > 0) process.exit(1);
});
