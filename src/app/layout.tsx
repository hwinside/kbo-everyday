import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "@/styles/globals.css";
import { AuthProvider } from "@/lib/supabase/AuthContext";
import { ThemeProvider, themeScript } from "@/components/ThemeProvider";
import { AdAttributionMount } from "@/components/AdAttributionMount";
import { NativePushMount } from "@/components/NativePushMount";
import { PageViewTracker } from "@/components/PageViewTracker";
import { Analytics } from "@vercel/analytics/next";

const GA_ID = "G-C0TE4TFLZ4";
const GADS_ID = "AW-18082281693";
const META_PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID || "";

export const metadata: Metadata = {
  metadataBase: new URL("https://keubo.fan"),
  title: "크보팬 — 야구팬이 가장 오래 머무는 곳",
  description: "실시간 스코어, AI경기예측/분석, 라이브 채팅 배틀, 팀/선수별 커뮤니티",
  keywords: ["KBO", "야구", "커뮤니티", "실시간", "승부예측", "기록"],
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "크보팬",
  },
  openGraph: {
    title: "크보팬 — 야구팬이 가장 오래 머무는 곳",
    description: "실시간 스코어, AI경기예측/분석, 라이브 채팅 배틀, 팀/선수별 커뮤니티",
    type: "website",
    url: "https://keubo.fan",
    siteName: "크보팬",
    locale: "ko_KR",
    images: [
      {
        url: "https://keubo.fan/og-image.png",
        width: 1200,
        height: 630,
        alt: "야구팬이 가장 오래 머무는 곳, 크보팬",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "크보팬 — 야구팬이 가장 오래 머무는 곳",
    description: "실시간 스코어, AI경기예측/분석, 라이브 채팅 배틀, 팀/선수별 커뮤니티",
    images: ["https://keubo.fan/og-image.png"],
  },
  verification: {
    other: {
      "naver-site-verification": "25cb4d3f0ff7ada33807dc30d155c5c707e1ad5c",
    },
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F2F2F7" },
    { media: "(prefers-color-scheme: dark)", color: "#0A0A0B" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
        <Script id="gtag-init" strategy="afterInteractive">
          {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}');gtag('config','${GADS_ID}');`}
        </Script>
        <Script id="meta-pixel" strategy="afterInteractive">
          {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${META_PIXEL_ID}');fbq('track','PageView');`}
        </Script>
        <noscript>
          <img height="1" width="1" style={{ display: 'none' }} src={`https://www.facebook.com/tr?id=${META_PIXEL_ID}&ev=PageView&noscript=1`} />
        </noscript>
        <link
          rel="stylesheet"
          as="style"
          crossOrigin="anonymous"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&family=Noto+Sans+KR:wght@400;500;700&family=Gamja+Flower&display=swap"
        />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body className="font-sans antialiased bg-bg-primary text-text-primary">
        <AdAttributionMount />
        <NativePushMount />
        <ThemeProvider>
          <AuthProvider>
            <PageViewTracker />
            {children}
          </AuthProvider>
        </ThemeProvider>
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
        <script
          dangerouslySetInnerHTML={{
            __html: `
              /* iOS WKWebView 뒤로가기 빈화면 복구: bfcache 복원(persisted) 시
                 콘텐츠는 DOM에 있으나 컴포지터가 페인트를 안 해 검은화면이 된다
                 (사용자가 살짝 스크롤하면 바로 떠짐). DOM이 빈 게 아니라 *페인트 누락*이라
                 reload가 아니라 강제 리페인트로 해결: 스크롤 1px 넛지 + transform 토글.
                 정상 복원에는 사실상 무영향(1px 왕복 스크롤·즉시 원복되는 transform). */
              (function () {
                window.addEventListener('pageshow', function (e) {
                  if (!e.persisted) return;
                  requestAnimationFrame(function () {
                    var y = window.scrollY || window.pageYOffset || 0;
                    window.scrollTo(0, y + 1);
                    window.scrollTo(0, y);
                    var main = document.querySelector('main');
                    if (main) {
                      main.style.transform = 'translateZ(0)';
                      requestAnimationFrame(function () { main.style.transform = ''; });
                    }
                  });
                });
              })();
            `,
          }}
        />
        <Analytics />
      </body>
    </html>
  );
}
