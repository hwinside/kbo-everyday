// Gemini generateContent 호출 + 키 폴백.
//
// 단일 GEMINI_API_KEY를 모듈 로드 시점에 URL로 굳히면, 그 키가 무효화/쿼터초과되는
// 순간 모든 경기 분석이 502로 죽는다 (2026-06-25 prod GEMINI_API_KEY 무효화 → 전 경기
// "분석을 다시 확인하고 있어요"). 키를 여러 개 두고, 키 문제(인증/쿼터) 응답이 오면
// 다음 키로 자동 폴백해 단일 키 장애가 서비스 전체 장애로 번지지 않게 한다.

// 우선순위 순서대로. GEMINI_API_KEY = 주키, _2/_3 = 폴백.
export function getGeminiKeys(): string[] {
  const keys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
  ]
    .map((k) => k?.trim())
    .filter((k): k is string => !!k);
  return [...new Set(keys)]; // 같은 값 중복 제거 (실수로 같은 키 두 번 넣어도 무의미한 재시도 방지)
}

// 키 자체 문제로 보이는 상태코드 → 다음 키로 폴백.
// 400=API_KEY_INVALID, 401/403=인증/권한, 429=쿼터/레이트리밋.
// 5xx 등은 키를 바꿔도 동일하므로 폴백하지 않고 그대로 반환(불필요한 키 소모 방지).
const KEY_FAILURE_STATUS = new Set([400, 401, 403, 429]);

const GEMINI_ENDPOINT = (model: string, key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

/**
 * generateContent를 호출하되, 키 문제 응답이면 다음 폴백 키로 재시도한다.
 * 응답 body는 소비하지 않고 그대로 반환하므로 호출부가 .json()/.text()로 읽으면 된다.
 * 설정된 키가 하나도 없으면 throw.
 */
export async function geminiGenerateContent(
  model: string,
  payload: unknown,
  init?: { signal?: AbortSignal }
): Promise<Response> {
  const keys = getGeminiKeys();
  if (keys.length === 0) {
    throw new Error("No GEMINI_API_KEY configured");
  }

  let lastRes: Response | null = null;
  for (let i = 0; i < keys.length; i++) {
    const res = await fetch(GEMINI_ENDPOINT(model, keys[i]), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: init?.signal,
    });

    if (res.ok) return res;

    lastRes = res;
    // 키 문제가 아니면(5xx 등) 폴백해봐야 동일 → 그대로 반환.
    if (!KEY_FAILURE_STATUS.has(res.status)) return res;
    // 마지막 키였으면 더 시도할 게 없으니 그대로 반환.
    if (i < keys.length - 1) {
      console.warn(`Gemini key #${i + 1}/${keys.length} failed (${res.status}), falling back to next key`);
    }
  }
  return lastRes!; // 모든 키 소진 — 마지막 실패 응답 반환
}
