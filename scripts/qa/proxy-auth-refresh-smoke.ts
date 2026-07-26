import { readFileSync } from "node:fs";

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

const proxySource = readFileSync("src/proxy.ts", "utf8");
check(
  "proxy가 Supabase server client를 생성하지 않음",
  !proxySource.includes("createServerClient"),
);
check(
  "proxy가 auth API를 호출하지 않음",
  !proxySource.includes(".auth."),
);
check(
  "브라우저가 auth refresh를 소유한다는 계약을 명시",
  proxySource.includes("Auth session refresh is owned by the browser client"),
);

function main() {
  console.log(`\nProxy auth refresh smoke: ${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main();
