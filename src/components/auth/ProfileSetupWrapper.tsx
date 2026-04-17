"use client";

import { useEffect } from "react";
import { useAuth } from "@/lib/supabase/AuthContext";
import ProfileSetupModal from "./ProfileSetupModal";

export default function ProfileSetupWrapper() {
  const { user, profile, loading } = useAuth();
  
  // 로그인 됐는데 프로필 없거나, 프로필은 있지만 필수 필드(닉네임/팀) 미설정이면 모달 표시
  const needsProfile = !loading && user && (!profile || !profile.nickname || !profile.team_id);

  useEffect(() => {
    console.log("[ProfileSetupWrapper]", {
      loading,
      hasUser: !!user,
      userId: user?.id?.slice(0, 8),
      hasProfile: !!profile,
      nickname: profile?.nickname,
      teamId: profile?.team_id,
      needsProfile: !!needsProfile,
    });
  }, [loading, user, profile, needsProfile]);
  
  return <ProfileSetupModal isOpen={!!needsProfile} />;
}
