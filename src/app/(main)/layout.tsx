import TeamAccent from "@/components/ui/TeamAccent";
import TabBar from "@/components/ui/TabBar";

import ProfileSetupWrapper from "@/components/auth/ProfileSetupWrapper";
import MyTeamCookieSync from "@/components/auth/MyTeamCookieSync";
import HashSessionRestore from "@/components/auth/HashSessionRestore";
import PostLoginRedirect from "@/components/auth/PostLoginRedirect";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-bg-primary">
      <HashSessionRestore />
      <PostLoginRedirect />
      <ProfileSetupWrapper />
      <MyTeamCookieSync />
      <TeamAccent />
      <main className="pb-tab-bar pt-safe">{children}</main>
      <TabBar />
    </div>
  );
}
