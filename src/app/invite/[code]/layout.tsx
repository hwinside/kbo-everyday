import type { Metadata } from "next";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

interface Props {
  params: Promise<{ code: string }>;
  children: React.ReactNode;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;

  let inviterNickname: string | null = null;
  try {
    const supabase = getSupabaseAdmin();
    const { data: invitation } = await supabase
      .from("invitations")
      .select("inviter_id")
      .eq("code", code)
      .single();

    if (invitation?.inviter_id) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("nickname")
        .eq("id", invitation.inviter_id)
        .single();
      inviterNickname = profile?.nickname || null;
    }
  } catch {
    // fallback
  }

  const title = inviterNickname
    ? `${inviterNickname}님이 크보팬에 초대했어요 ⚾`
    : "크보팬에 초대받았어요 ⚾";
  const description = "내 팀 경기, 오늘 할 얘기는 여기서 끝. 실시간 스코어 · 승부예측 · 팬 커뮤니티";
  const url = `https://keubo.fan/invite/${code}`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      url,
      siteName: "크보팬",
      locale: "ko_KR",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default function InviteLayout({ children }: Props) {
  return children;
}
