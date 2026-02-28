import type { Metadata, Viewport } from "next";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "크보 에브리데이 — KBO 전 구단 팬 커뮤니티",
  description:
    "KBO 전 구단 팬 커뮤니티. 실시간 경기 트래커, 승부예측, 구단/선수별 게시판, 스탯 인포그래픽.",
  keywords: ["KBO", "야구", "커뮤니티", "실시간", "승부예측", "스탯"],
  openGraph: {
    title: "크보 에브리데이",
    description: "KBO 전 구단 팬 커뮤니티",
    type: "website",
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
      </head>
      <body style={{ backgroundColor: "#0A0A0B", color: "#F5F5F7" }} className="font-pretendard antialiased">
        {children}
      </body>
    </html>
  );
}
