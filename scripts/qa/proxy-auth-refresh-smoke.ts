import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { hasSupabaseAuthCookie } from "@/proxy";

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean) {
  if (condition) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.error("  ✗", name);
  }
}

const SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function verifyLocalClaimsContract() {
  const now = Math.floor(Date.now() / 1000);
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", publicKey);
  Object.assign(publicJwk, { alg: "ES256", kid: "qa-key", use: "sig" });

  const header = base64Url(JSON.stringify({ alg: "ES256", kid: "qa-key", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    sub: "00000000-0000-0000-0000-000000000001",
    role: "authenticated",
    iss: `${SUPABASE_URL}/auth/v1`,
    iat: now,
    exp: now + 3600,
  }));
  const unsignedToken = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      new TextEncoder().encode(unsignedToken),
    ),
  );
  const accessToken = `${unsignedToken}.${base64Url(signature)}`;

  const session = JSON.stringify({
    access_token: accessToken,
    refresh_token: "qa-refresh-token",
    expires_in: 3600,
    expires_at: now + 3600,
    token_type: "bearer",
    user: { id: "00000000-0000-0000-0000-000000000001" },
  });
  const fetchedUrls: string[] = [];
  const fetchMock: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchedUrls.push(url);
    if (url.endsWith("/.well-known/jwks.json")) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected auth network call: ${url}`);
  };
  const storage = {
    getItem: async () => session,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  };
  const client = createClient(SUPABASE_URL, "qa-anon-key", {
    global: { fetch: fetchMock },
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
      storage,
    },
  });

  const { data, error } = await client.auth.getClaims();
  check("ES256 claims 로컬 검증 성공", !error && data?.claims.sub === "00000000-0000-0000-0000-000000000001");
  check(
    "claims 검증은 JWKS만 조회하고 /auth/v1/user를 호출하지 않음",
    fetchedUrls.length === 1 &&
      fetchedUrls[0].endsWith("/.well-known/jwks.json") &&
      !fetchedUrls.some((url) => url.endsWith("/user")),
  );
}

check(
  "프로젝트 auth cookie 감지",
  hasSupabaseAuthCookie(
    ["sb-abcdefghijklmnopqrst-auth-token"],
    SUPABASE_URL,
  ),
);
check(
  "분할 auth cookie 감지",
  hasSupabaseAuthCookie(
    ["sb-abcdefghijklmnopqrst-auth-token.0"],
    SUPABASE_URL,
  ),
);
check(
  "다른 프로젝트 cookie는 무시",
  !hasSupabaseAuthCookie(["sb-otherproject-auth-token"], SUPABASE_URL),
);
check("cookie 없는 공개 요청은 우회", !hasSupabaseAuthCookie([], SUPABASE_URL));
check("잘못된 Supabase URL은 우회", !hasSupabaseAuthCookie(["sb-x-auth-token"], "not-a-url"));

const proxySource = readFileSync("src/proxy.ts", "utf8");
check(
  "proxy가 /auth/v1/user 호출 경로를 사용하지 않음",
  !proxySource.includes("supabase.auth.getUser()"),
);
check(
  "proxy가 로컬 JWT claims 검증을 사용",
  proxySource.includes("await supabase.auth.getClaims()"),
);

async function main() {
  await verifyLocalClaimsContract();
  console.log(`\nProxy auth refresh smoke: ${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
