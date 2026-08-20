/**
 * 실제 `useNewsClippingDigests` 를 <StrictMode> 로 mount 해서 배선을 검증한다.
 *
 * Why (삼순 blocker, 2026-08-20 4차)
 * ----------------------------------
 * 3차 구현은 로더를 **render 에서** 만들고 cleanup 에서 `loaderRef.current = null` 로 지웠다.
 * Next 16 App Router 는 StrictMode 가 기본이라 dev 의 effect 가 `setup → cleanup → setup` 으로
 * 두 번 도는데, **두 번째 setup 앞에는 render 가 없다.** 그래서 두 번째 setup 에서
 * `loaderRef.current` 가 null 이고 `wantedKey` effect 가 아무것도 안 하고 끝난다 —
 * 실제 화면에서는 digest 조회가 안 되고 카드가 영영 안 뜬다.
 *
 * 순수 로더 테스트(news-clipping-digest-smoke 8-1~8-7)는 이 배선을 안 태우므로 못 봤다.
 * 여기서는 **훅 자체**를 진짜 React 트리에 올려 요청 → cleanup → 재setup 뒤에도 데이터가
 * 들어오는지 본다.
 *
 * 실행: npx tsx scripts/qa/news-clipping-digest-hook-strict.ts  (npm run qa:news-clip-digest:hook)
 */
import { JSDOM } from "jsdom";

// ── DOM 부트스트랩 (React DOM 이 import 되기 전에 끝나야 한다) ─────────────
const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "http://localhost/",
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
// React 의 act() 환경 플래그. 없으면 경고와 함께 effect flush 가 보장되지 않는다.
g.IS_REACT_ACT_ENVIRONMENT = true;

// 훅이 import 하는 supabase 브라우저 클라이언트는 env 가 있어야 생성된다.
// 조회기는 주입하므로 실제 네트워크는 타지 않는다.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "qa-anon-key";

import React, { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DigestFetchResult } from "@/lib/news-clipping-digest-loader";
import type { NewsClippingArticle, NewsClippingDigest } from "@/types/news-clipping";

/**
 * ⚠️ 훅은 **정적 import 하지 않는다.** esbuild 의 cjs 트랜스폼은 import 를 최상단으로 끌어올리므로,
 *    위의 env/DOM 부트스트랩보다 먼저 `src/lib/supabase/client.ts` 가 평가돼 클라이언트 생성이
 *    터진다("URL and API key are required"). 부트스트랩이 끝난 뒤 동적으로 가져온다.
 *    (테스트 하네스의 로딩 순서 문제이지 프로덕션 코드의 문제가 아니다.)
 */
type UseNewsClippingDigests = (
  payloads: unknown[],
  fetcher?: (ids: number[]) => Promise<DigestFetchResult>,
) => Map<number, NewsClippingDigest>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useNewsClippingDigests } = require("@/hooks/useNewsClippingDigests") as {
  useNewsClippingDigests: UseNewsClippingDigests;
};

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}

const ARTICLES: NewsClippingArticle[] = [
  {
    title: "LG, 두산 꺾고 4연승",
    link: "https://n.news.naver.com/mnews/article/001/0001",
    thumbnail_url: null,
    summary: ["a", "b", "c"],
  },
];

function digestRow(id: number): NewsClippingDigest {
  return {
    id,
    clip_date: "2026-08-19",
    team_id: 1,
    team_name: "LG 트윈스",
    overview: "4연승 질주",
    articles: ARTICLES,
  };
}

function refPayload(digestId: number) {
  return {
    type: "news_clipping",
    team_id: 1,
    team_name: "LG 트윈스",
    date: "2026-08-19",
    digest_id: digestId,
    v: 1,
    push_preview: "4연승 질주",
  };
}

/** 훅 결과를 밖으로 흘려보내는 얇은 하네스 컴포넌트. */
function Harness(props: {
  payloads: unknown[];
  fetcher: (ids: number[]) => Promise<DigestFetchResult>;
  onRender: (m: Map<number, NewsClippingDigest>) => void;
}) {
  const digests = useNewsClippingDigests(props.payloads, props.fetcher);
  props.onRender(digests);
  return React.createElement("div", null, `digests:${digests.size}`);
}

async function flushAsync(times = 30) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function mountStrict(
  payloads: unknown[],
  fetcher: (ids: number[]) => Promise<DigestFetchResult>,
): Promise<{ root: Root; latest: () => Map<number, NewsClippingDigest>; container: HTMLElement }> {
  const container = dom.window.document.getElementById("root") as unknown as HTMLElement;
  let latest = new Map<number, NewsClippingDigest>();
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        StrictMode,
        null,
        React.createElement(Harness, {
          payloads,
          fetcher,
          onRender: (m) => {
            latest = m;
          },
        }),
      ),
    );
    await flushAsync();
  });
  await act(async () => {
    await flushAsync();
  });
  return { root, latest: () => latest, container };
}

async function main(): Promise<void> {
  // ── S-1) StrictMode 이중 setup 뒤에도 digest 가 들어온다 ─────────────────
  // 이게 이번 blocker 의 본체다. 3차 구현은 여기서 0건이었다.
  {
    const seen: number[][] = [];
    const fetcher = async (ids: number[]): Promise<DigestFetchResult> => {
      seen.push([...ids]);
      return { rows: ids.map(digestRow) };
    };
    const { root, latest } = await mountStrict([refPayload(42)], fetcher);
    const m = latest();
    ok(`S-1 StrictMode mount 후 digest 가 들어온다 (실측 ${m.size}건)`, m.size === 1);
    ok("S-1 올바른 digest", m.get(42)?.overview === "4연승 질주");
    ok(`S-1 조회는 최소 1회 발생 (실측 ${seen.length}회)`, seen.length >= 1);
    await act(async () => {
      root.unmount();
      await flushAsync();
    });
  }

  // ── S-2) 실패 → 타이머 재시도가 실제 훅에서도 돈다 ───────────────────────
  // 로더 단위로는 8-1 에서 봤지만, StrictMode 재-setup 으로 로더가 교체된 뒤에도
  // 재시도가 살아있는지는 훅을 태워야만 관측된다.
  {
    let calls = 0;
    const fetcher = async (ids: number[]): Promise<DigestFetchResult> => {
      calls++;
      if (calls === 1) return { rows: [], error: "network down" };
      return { rows: ids.map(digestRow) };
    };
    const { root, latest } = await mountStrict([refPayload(7)], fetcher);
    // ⚠️ 실측으로 기대값을 고쳤다: StrictMode 는 setup 을 두 번 돌리므로 mount 직후 이미
    //    2회차 호출이 성공해 있을 수 있다. "실패 직후 비어있다"는 하네스의 가정이었지
    //    계약이 아니다. 계약은 **첫 조회가 실패해도 결국 회복된다**이다.
    ok(`S-2 첫 조회는 실제로 실패했다 (calls ${calls})`, calls >= 1);
    // 실제 setTimeout 을 쓰므로 backoff(500ms) 를 기다린다.
    await act(async () => {
      await new Promise((r) => dom.window.setTimeout(r, 900));
      await flushAsync();
    });
    ok(`S-2 실패 후에도 최종적으로 회복 (실측 ${latest().size}건, calls ${calls})`, latest().size === 1);
    ok("S-2 회복된 digest 내용 확인", latest().get(7)?.overview === "4연승 질주");
    await act(async () => {
      root.unmount();
      await flushAsync();
    });
  }

  // ── S-2b) 반대 순서 race: 폐기 로더 A 성공 → 현재 로더 B 실패 ────────────
  // ⚠️ 삼순 blocker (5차): 공유 캐시를 도입하자 생긴 구멍이다.
  //    A 가 성공해 캐시만 채우고(dispose 돼 onChange 못 함), B 가 실패하면
  //    B 는 받은 행이 없어 changed=false → onChange 안 부름,
  //    그리고 eligible() 은 캐시 존재로 재시도를 멈춘다.
  //    결과: 캐시엔 있는데 state 는 0 = **카드가 영원히 안 뜨고 텍스트로 남는다.**
  //    (S-2 는 A 실패 → B 성공만 봐서 이 방향을 못 봤다.)
  {
    let calls = 0;
    const fetcher = async (ids: number[]): Promise<DigestFetchResult> => {
      calls++;
      // 1번째(폐기될 A)만 성공, 2번째(살아남는 B)는 실패시킨다.
      if (calls === 1) return { rows: ids.map(digestRow) };
      return { rows: [], error: "B failed" };
    };
    const { root, latest } = await mountStrict([refPayload(21)], fetcher);
    ok(`S-2b 무대 성립: 조회가 2회 일어났다 (실측 ${calls})`, calls >= 2);
    ok(
      `S-2b A 성공 → B 실패여도 카드 데이터가 화면에 도달한다 (실측 ${latest().size}건)`,
      latest().size === 1,
    );
    ok("S-2b 도달한 digest 내용 확인", latest().get(21)?.overview === "4연승 질주");
    await act(async () => {
      root.unmount();
      await flushAsync();
    });
  }

  // ── S-2c) 두 로더 응답이 역순으로 도착해도 도달한다 ──────────────────────
  // A(폐기될 쪽)의 응답이 B 보다 **늦게** 오는 경우. B 는 이미 실패로 끝나 있고
  // A 는 dispose 상태라 onChange 를 못 부른다 — 그래도 최종적으로 화면에 떠야 한다.
  {
    let calls = 0;
    let releaseA: (() => void) | null = null;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    const fetcher = async (ids: number[]): Promise<DigestFetchResult> => {
      calls++;
      if (calls === 1) {
        await gateA; // A 를 붙잡아 둔다 → B 가 먼저 끝난다
        return { rows: ids.map(digestRow) };
      }
      return { rows: [], error: "B failed first" };
    };
    const { root, latest } = await mountStrict([refPayload(22)], fetcher);
    ok(`S-2c 무대 성립: B 가 먼저 실패로 끝났다 (실측 ${calls}회, digests ${latest().size})`, calls >= 2);
    await act(async () => {
      releaseA?.();
      await flushAsync();
      // 남은 backoff 재시도까지 흘려준다.
      await new Promise((r) => dom.window.setTimeout(r, 900));
      await flushAsync();
    });
    ok(
      `S-2c 늦게 온 A 의 성공이 화면에 반영된다 (실측 ${latest().size}건)`,
      latest().size === 1,
    );
    await act(async () => {
      root.unmount();
      await flushAsync();
    });
  }

  // ── S-3) 조회는 유한하고, 리렌더가 조회를 늘리지 않는다 ──────────────────
  // ⚠️ 실측으로 기대값을 고쳤다: StrictMode 의 setup→cleanup→setup 은 **dev 전용**이고,
  //    두 번째 setup 시점엔 첫 요청이 아직 in-flight 라 같은 id 를 한 번 더 조회한다.
  //    이걸 없애려고 in-flight 를 로더끼리 공유하면, 폐기된 로더의 실패가 아무에게도
  //    재시도되지 않는 구멍이 생긴다(더 나쁜 교환) — 그래서 dev 중복 1회는 받아들인다.
  //    계약은 "조회가 유한하고, 리렌더로 늘어나지 않는다"이다.
  {
    let calls = 0;
    const fetcher = async (ids: number[]): Promise<DigestFetchResult> => {
      calls++;
      return { rows: ids.map(digestRow) };
    };
    const { root, latest } = await mountStrict([refPayload(11)], fetcher);
    const afterMount = calls;
    ok(`S-3 조회는 유한하다 (실측 ${afterMount}회, StrictMode 이중 setup 상한 2)`, afterMount <= 2);
    ok("S-3 digest 는 확보됐다", latest().size === 1);

    // 같은 payload 로 리렌더를 반복해도 추가 조회가 없어야 한다(캐시·wantedKey 안정성).
    await act(async () => {
      for (let i = 0; i < 3; i++) {
        root.render(
          React.createElement(
            StrictMode,
            null,
            React.createElement(Harness, {
              payloads: [refPayload(11)],
              fetcher,
              onRender: () => {},
            }),
          ),
        );
        await flushAsync();
      }
    });
    ok(`S-3 리렌더 3회에도 추가 조회 0 (실측 ${calls}회)`, calls === afterMount);
    await act(async () => {
      root.unmount();
      await flushAsync();
    });
  }

  // ── S-4) 언마운트 후에는 조회가 멈춘다(누수 방지) ────────────────────────
  {
    let calls = 0;
    const fetcher = async (): Promise<DigestFetchResult> => {
      calls++;
      return { rows: [], error: "boom" };
    };
    const { root } = await mountStrict([refPayload(13)], fetcher);
    const before = calls;
    await act(async () => {
      root.unmount();
      await flushAsync();
    });
    await new Promise((r) => dom.window.setTimeout(r, 900));
    await flushAsync();
    ok(`S-4 언마운트 후 추가 조회 없음 (before ${before}, after ${calls})`, calls === before);
  }

  // ── S-5) legacy payload 만 있으면 조회 자체가 없다 ───────────────────────
  {
    let calls = 0;
    const fetcher = async (): Promise<DigestFetchResult> => {
      calls++;
      return { rows: [] };
    };
    const legacy = {
      type: "news_clipping",
      team_id: 1,
      team_name: "LG 트윈스",
      date: "2026-08-19",
      overview: "4연승 질주",
      articles: ARTICLES,
    };
    const { root } = await mountStrict([legacy], fetcher);
    ok("S-5 legacy 전용 대화는 digest 조회 0회", calls === 0);
    await act(async () => {
      root.unmount();
      await flushAsync();
    });
  }

  console.log(`\nnews-clipping digest hook(StrictMode): ${fail === 0 ? "PASS" : `${fail} FAILED`}`);
  // ⚠️ jsdom 창과 남은 backoff 타이머가 이벤트 루프를 잡아 프로세스가 안 끝난다.
  //    CI 에서 게이트가 hang 하면 게이트가 게이트를 죽인다(2026-08-20 실측: 90초 넘게 미종료).
  //    판정이 끝났으므로 명시적으로 닫고 종료한다.
  dom.window.close();
  process.exit(fail > 0 ? 1 : 0);
}

void main().catch((e) => {
  console.error("hook strict gate crashed:", e);
  process.exit(1);
});

// 최후 방어: 어떤 이유로든 90초를 넘기면 실패로 끝낸다(무한 대기 금지).
const watchdog = setTimeout(() => {
  console.error("❌ hook strict gate timeout (90s)");
  process.exit(1);
}, 90_000);
watchdog.unref?.();
