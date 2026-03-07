import TeamAccent from "@/components/ui/TeamAccent";
import TabBar from "@/components/ui/TabBar";

import ProfileSetupWrapper from "@/components/auth/ProfileSetupWrapper";
import MyTeamCookieSync from "@/components/auth/MyTeamCookieSync";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-bg-primary">
      <ProfileSetupWrapper />
      <MyTeamCookieSync />
      <TeamAccent />
      <main className="pb-tab-bar pt-[env(safe-area-inset-top,0px)]">{children}</main>
      <TabBar />
    </div>
  );
}
