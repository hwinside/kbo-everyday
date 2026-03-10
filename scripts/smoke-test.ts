/**
 * 배포 후 자동 스모크 테스트
 * 주요 페이지 순회하며 에러/빈 화면 체크
 */

const BASE_URL = process.env.BASE_URL || "https://kbo-everyday.vercel.app";

interface TestResult {
  page: string;
  url: string;
  status: "✅ PASS" | "⚠️ WARN" | "❌ FAIL";
  detail: string;
  loadTime: number;
}

const PAGES = [
  { name: "홈", path: "/" },
  { name: "선수 목록", path: "/boards/players" },
  { name: "선수 상세 (김도영)", path: "/boards/players/52605" },
  { name: "선수 상세 (오스틴)", path: "/boards/players/53123" },
  { name: "경기", path: "/games" },
  { name: "순위", path: "/standings" },
  { name: "MY", path: "/my" },
  { name: "시즌예측", path: "/predict" },
  { name: "일일예측", path: "/predict/daily" },
  { name: "구장가이드", path: "/stadiums" },
  { name: "하이라이트", path: "/highlights" },
  { name: "커뮤니티", path: "/teams" },
  { name: "쪽지함", path: "/messages" },
  { name: "팀페이지 (LG)", path: "/teams/1" },
  { name: "팀페이지 (KIA)", path: "/teams/6" },
];

const API_ENDPOINTS = [
  { name: "API: 경기", path: "/api/games?date=20260328" },
  { name: "API: 순위", path: "/api/standings" },
  { name: "API: 뉴스", path: "/api/news" },
  { name: "API: 하이라이트", path: "/api/highlights" },
  { name: "API: 선수팀 (단건)", path: "/api/player-teams?name=오스틴" },
  { name: "API: 선수스탯", path: "/api/player-stats?id=53123&pos=내야수" },
];

async function testPage(name: string, path: string): Promise<TestResult> {
  const url = `${BASE_URL}${path}`;
  const start = Date.now();
  
  try {
    const res = await fetch(url, { 
      headers: { "User-Agent": "KBO-SmokeTest/1.0" },
      redirect: "follow",
    });
    const loadTime = Date.now() - start;
    const body = await res.text();
    
    if (!res.ok) {
      return { page: name, url, status: "❌ FAIL", detail: `HTTP ${res.status}`, loadTime };
    }
    
    // 빈 페이지 체크
    if (body.length < 100) {
      return { page: name, url, status: "❌ FAIL", detail: `빈 페이지 (${body.length} bytes)`, loadTime };
    }
    
    // 에러 텍스트 체크
    const errorPatterns = [
      "Application error", "Internal Server Error",
      "Unhandled Runtime Error", "NEXT_NOT_FOUND",
    ];
    for (const pattern of errorPatterns) {
      if (body.includes(pattern)) {
        return { page: name, url, status: "❌ FAIL", detail: `에러 감지: "${pattern}"`, loadTime };
      }
    }
    
    // 느린 응답 체크
    if (loadTime > 5000) {
      return { page: name, url, status: "⚠️ WARN", detail: `느린 응답 (${loadTime}ms)`, loadTime };
    }
    
    return { page: name, url, status: "✅ PASS", detail: `${(body.length / 1024).toFixed(1)}KB`, loadTime };
  } catch (e: unknown) {
    return { page: name, url, status: "❌ FAIL", detail: e instanceof Error ? e.message : String(e), loadTime: Date.now() - start };
  }
}

async function testApi(name: string, path: string): Promise<TestResult> {
  const url = `${BASE_URL}${path}`;
  const start = Date.now();
  
  try {
    const res = await fetch(url, { headers: { "User-Agent": "KBO-SmokeTest/1.0" } });
    const loadTime = Date.now() - start;
    const data = await res.json();
    
    if (!res.ok) {
      return { page: name, url, status: "❌ FAIL", detail: `HTTP ${res.status}: ${data.error || ""}`, loadTime };
    }
    
    // 빈 데이터 체크
    const hasData = Object.values(data).some(v => 
      Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined
    );
    
    if (!hasData) {
      return { page: name, url, status: "⚠️ WARN", detail: "빈 데이터", loadTime };
    }
    
    if (loadTime > 10000) {
      return { page: name, url, status: "⚠️ WARN", detail: `느린 응답 (${loadTime}ms)`, loadTime };
    }
    
    return { page: name, url, status: "✅ PASS", detail: `OK (${loadTime}ms)`, loadTime };
  } catch (e: unknown) {
    return { page: name, url, status: "❌ FAIL", detail: e instanceof Error ? e.message : String(e), loadTime: Date.now() - start };
  }
}

async function main() {
  console.log(`\n🔍 크보 에브리데이 스모크 테스트`);
  console.log(`📍 ${BASE_URL}`);
  console.log(`⏰ ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}\n`);
  
  const results: TestResult[] = [];
  
  // 페이지 테스트 (5개씩 병렬)
  console.log("📄 페이지 테스트...");
  for (let i = 0; i < PAGES.length; i += 5) {
    const batch = PAGES.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(p => testPage(p.name, p.path)));
    results.push(...batchResults);
  }
  
  // API 테스트
  console.log("🔌 API 테스트...");
  for (const api of API_ENDPOINTS) {
    results.push(await testApi(api.name, api.path));
  }
  
  // 결과 출력
  console.log("\n" + "=".repeat(60));
  const pass = results.filter(r => r.status === "✅ PASS").length;
  const warn = results.filter(r => r.status === "⚠️ WARN").length;
  const fail = results.filter(r => r.status === "❌ FAIL").length;
  
  console.log(`\n📊 결과: ${pass} PASS / ${warn} WARN / ${fail} FAIL (총 ${results.length})\n`);
  
  for (const r of results) {
    const time = `${r.loadTime}ms`.padStart(6);
    console.log(`${r.status} ${r.page.padEnd(20)} ${time}  ${r.detail}`);
  }
  
  // 요약 메시지 생성 (텔레그램용)
  let summary = `🔍 스모크 테스트 완료\n`;
  summary += `✅ ${pass} / ⚠️ ${warn} / ❌ ${fail}\n`;
  
  if (fail > 0) {
    summary += `\n❌ 실패:\n`;
    for (const r of results.filter(r => r.status === "❌ FAIL")) {
      summary += `• ${r.page}: ${r.detail}\n`;
    }
  }
  if (warn > 0) {
    summary += `\n⚠️ 경고:\n`;
    for (const r of results.filter(r => r.status === "⚠️ WARN")) {
      summary += `• ${r.page}: ${r.detail}\n`;
    }
  }
  
  const avgTime = Math.round(results.reduce((a, r) => a + r.loadTime, 0) / results.length);
  summary += `\n⏱️ 평균 응답: ${avgTime}ms`;
  
  // 요약을 파일로 저장 (삼식이가 읽어서 전송)
  const fs = require("fs");
  fs.writeFileSync("/tmp/smoke-test-result.txt", summary);
  
  console.log("\n" + summary);
  
  process.exit(fail > 0 ? 1 : 0);
}

main();
