import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["http://192.168.219.109:3003"],
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
