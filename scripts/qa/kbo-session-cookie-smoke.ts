import assert from "node:assert/strict";
import {
  parseKboSessionCookie,
  withKboSessionCookie,
} from "../../src/lib/crawler/kbo-session";

assert.equal(
  parseKboSessionCookie(
    "ASP.NET_SessionId=session123; path=/; secure; HttpOnly; SameSite=Lax",
  ),
  "ASP.NET_SessionId=session123",
);
assert.equal(
  parseKboSessionCookie(
    "NCPVPCLBTG=lb123; path=/, ASP.NET_SessionId=session456; path=/; secure",
  ),
  "ASP.NET_SessionId=session456",
);
assert.equal(parseKboSessionCookie(null), null);

const headers = withKboSessionCookie(
  {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
  },
  "ASP.NET_SessionId=session123",
);
assert.equal(headers.Cookie, "ASP.NET_SessionId=session123");
assert.match(headers["User-Agent"], /Chrome\//);
assert.doesNotMatch(headers["User-Agent"], /KboEveryday/);

console.log("kbo session cookie smoke: PASS");
