"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function CommunityPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/community/teams");
  }, [router]);

  return null;
}
