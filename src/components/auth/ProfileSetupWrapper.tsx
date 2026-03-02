"use client";

import { useAuth } from "@/lib/supabase/AuthContext";
import ProfileSetupModal from "./ProfileSetupModal";

export default function ProfileSetupWrapper() {
  const { user, profile, loading } = useAuth();
  
  // 로그인 됐는데 프로필 없으면 모달 표시
  const needsProfile = !loading && user && !profile;
  
  return <ProfileSetupModal isOpen={!!needsProfile} />;
}
