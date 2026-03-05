import type { Metadata, Viewport } from "next";
import "@/styles/globals.css";
import { AuthProvider } from "@/lib/supabase/AuthContext";
import { Analytics } from "@vercel/analytics/next";

export const metadata: Metadata = {
  title: "크보팬 — KBO 전 구단 팬 커뮤니티",
  description:
    "KBO 전 구단 팬 커뮤니티. 실시간 경기 트래커, 승부예측, 구단/선수별 게시판, 스탯 인포그래픽.",
  keywords: ["KBO", "야구", "커뮤니티", "실시간", "승부예측", "스탯"],
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "크보팬",
  },
  openGraph: {
    title: "크보팬 — KBO 팬 커뮤니티",
    description: "실시간 스코어 · 683명 선수 프로필 · 승부예측 · 팬 커뮤니티 · 하이라이트 · 구장가이드",
    type: "website",
    url: "https://keubo.fan",
    siteName: "크보팬",
    locale: "ko_KR",
  },
  twitter: {
    card: "summary_large_image",
    title: "크보팬 — KBO 팬 커뮤니티",
    description: "실시간 스코어 · 683명 선수 프로필 · 승부예측 · 팬 커뮤니티 · 하이라이트 · 구장가이드",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0A0A0B",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="dark" style={{ colorScheme: "dark" }}>
      <head>
        <link
          rel="stylesheet"
          as="style"
          crossOrigin="anonymous"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body style={{ backgroundColor: "#0A0A0B", color: "#F5F5F7" }} className="font-pretendard antialiased">
        <AuthProvider>{children}</AuthProvider>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker.register('/sw.js');
                });
              }
            `,
          }}
        />
        <Analytics />
      </body>
    </html>
  );
}
