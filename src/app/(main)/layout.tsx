import Link from "next/link";
import TeamAccent from "@/components/ui/TeamAccent";
import TabBar from "@/components/ui/TabBar";

import ProfileSetupWrapper from "@/components/auth/ProfileSetupWrapper";
import MyTeamCookieSync from "@/components/auth/MyTeamCookieSync";
import HashSessionRestore from "@/components/auth/HashSessionRestore";
import PostLoginRedirect from "@/components/auth/PostLoginRedirect";
import AppReviewTrigger from "@/components/app/AppReviewTrigger";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-bg-primary">
      <HashSessionRestore />
      <PostLoginRedirect />
      <AppReviewTrigger />
      <ProfileSetupWrapper />
      <MyTeamCookieSync />
      <TeamAccent />
      <main className="pb-tab-bar pt-safe">
        {children}
        <footer className="mx-auto max-w-lg px-5 pb-8 pt-6 text-center text-xs leading-6 text-text-tertiary">
          <Link href="/terms" className="underline-offset-2 hover:text-text-secondary hover:underline">
            이용약관
          </Link>
          <span className="mx-2 text-border">|</span>
          <Link href="/privacy" className="underline-offset-2 hover:text-text-secondary hover:underline">
            개인정보처리방침
          </Link>
        </footer>
      </main>
      <TabBar />
    </div>
  );
}
