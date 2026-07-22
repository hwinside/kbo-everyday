"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getExistingConversation } from "@/lib/supabase/useDM";
import LoginSheet from "@/components/auth/LoginSheet";

interface DMButtonProps {
  targetUserId: string;
  label?: string;
  className?: string;
  size?: "sm" | "md";
}

export default function DMButton({ targetUserId, label = "쪽지", className = "", size = "sm" }: DMButtonProps) {
  const router = useRouter();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [showLogin, setShowLogin] = useState(false);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (!user) {
      setShowLogin(true);
      return;
    }

    if (user.id === targetUserId) return; // 자기 자신한테 못 보냄

    setLoading(true);
    const convId = await getExistingConversation(user.id, targetUserId);
    setLoading(false);

    router.push(convId ? `/messages/${convId}` : `/messages/new-${targetUserId}`);
  };

  return (
    <>
      <button
        onClick={handleClick}
        disabled={loading}
        className={`flex items-center gap-1 ${
          size === "sm"
            ? "px-2.5 py-1 text-xs"
            : "px-3.5 py-1.5 text-sm"
        } rounded-full bg-accent/20 text-accent font-semibold transition-colors hover:bg-accent/30 disabled:opacity-50 ${className}`}
      >
        <MessageCircle size={size === "sm" ? 12 : 14} />
        {loading ? "..." : label}
      </button>
      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </>
  );
}
