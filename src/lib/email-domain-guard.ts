export const COMMON_EMAIL_DOMAINS = [
  "hanmail.net",
  "naver.com",
  "gmail.com",
  "daum.net",
  "nate.com",
  "kakao.com",
] as const;

// 2026-07-30 DNS 실측: 두 도메인은 MX가 없다. lycos.co.kr은 A/AAAA도 없고,
// freechal.com의 A는 외부 수신이 불가능한 loopback(127.0.0.1)이다.
// MX가 살아 있는 hanmir.com/paran.com/dreamwiz.com/netian.com/empal.com은
// 서비스 종료 추측만으로 차단하지 않는다.
export const EMAIL_DOMAIN_DENYLIST = new Set([
  "lycos.co.kr",
  "freechal.com",
]);

export type EmailDomainGuardResult =
  | { allowed: true; email: string; domain: string }
  | {
      allowed: false;
      email: string;
      domain: string | null;
      reason: "invalid_email" | "blocked_domain" | "qa_recipient" | "possible_typo";
      suggestion?: string;
    };

export type MxLookup = (
  domain: string,
) => Promise<readonly { exchange: string; priority: number }[]>;

export type MxGuardResult =
  | { allowed: true; reason: "mx_found" | "lookup_failed" | "lookup_timeout" }
  | { allowed: false; reason: "mx_missing" };

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function findDomainSuggestion(domain: string): string | undefined {
  let closest: { domain: string; distance: number } | undefined;

  for (const candidate of COMMON_EMAIL_DOMAINS) {
    const distance = editDistance(domain, candidate);
    if (distance < 1 || distance > 2) continue;
    if (!closest || distance < closest.distance) {
      closest = { domain: candidate, distance };
    }
  }

  return closest?.domain;
}

export function guardEmailRecipient(rawEmail: string): EmailDomainGuardResult {
  const email = rawEmail.trim().toLowerCase();
  const separator = email.lastIndexOf("@");
  if (
    separator <= 0 ||
    separator === email.length - 1 ||
    email.indexOf("@") !== separator
  ) {
    return { allowed: false, email, domain: null, reason: "invalid_email" };
  }

  const localPart = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  if (
    !/^[^\s@]+$/.test(localPart) ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) ||
    !domain.includes(".") ||
    domain.includes("..")
  ) {
    return { allowed: false, email, domain, reason: "invalid_email" };
  }

  if (/^qa-[^@]+$/i.test(localPart) && domain === "keubo.fan") {
    return { allowed: false, email, domain, reason: "qa_recipient" };
  }

  if (EMAIL_DOMAIN_DENYLIST.has(domain)) {
    return { allowed: false, email, domain, reason: "blocked_domain" };
  }

  // 정상 주요 도메인은 edit-distance 검사 전에 확정 통과시켜 오탐을 막는다.
  if ((COMMON_EMAIL_DOMAINS as readonly string[]).includes(domain)) {
    return { allowed: true, email, domain };
  }

  const suggestion = findDomainSuggestion(domain);
  if (suggestion) {
    return {
      allowed: false,
      email,
      domain,
      reason: "possible_typo",
      suggestion,
    };
  }

  return { allowed: true, email, domain };
}

export async function guardMxRecipient(
  domain: string,
  lookup: MxLookup,
  timeoutMs = 2_000,
): Promise<MxGuardResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("mx-timeout");

  try {
    const result = await Promise.race([
      lookup(domain),
      new Promise<typeof timedOut>((resolve) => {
        timeout = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);

    if (result === timedOut) {
      // DNS 지연으로 정상 사용자를 막지 않는다.
      return { allowed: true, reason: "lookup_timeout" };
    }
    return result.length > 0
      ? { allowed: true, reason: "mx_found" }
      : { allowed: false, reason: "mx_missing" };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    // resolveMx는 MX 부재/NXDOMAIN을 빈 배열이 아니라 에러로도 반환한다.
    if (code === "ENODATA" || code === "ENOTFOUND") {
      return { allowed: false, reason: "mx_missing" };
    }
    // SERVFAIL/EAI_AGAIN 같은 일시 DNS 오류는 정상 사용자를 막지 않도록 fail-open.
    return { allowed: true, reason: "lookup_failed" };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
