import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["http://192.168.219.109:3003"],
  // 직관 라이브 영상 즉시 검증(B+①): @ffprobe-installer 정적 바이너리를 해당 함수 번들에 포함.
  // Vercel 빌드(linux-x64)에서 optionalDependencies 로 설치되는 플랫폼 바이너리만 트레이싱.
  outputFileTracingIncludes: {
    "/api/venue-stories": ["./node_modules/@ffprobe-installer/linux-x64/**"],
    "/api/cron/venue-stories-validate": ["./node_modules/@ffprobe-installer/linux-x64/**"],
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lbmbdjgsnenqjwjotoei.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
  async redirects() {
    return [
      {
        source: "/boards/players/:playerId",
        destination: "/community/players/:playerId",
        permanent: true,
      },
      {
        source: "/boards/players/:playerId/posts/:postId",
        destination: "/community/players/:playerId/posts/:postId",
        permanent: true,
      },
      {
        source: "/stadiums",
        destination: "/community/stadiums",
        permanent: true,
      },
      {
        source: "/stadiums/:stadiumId",
        destination: "/community/stadiums/:stadiumId",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
