import TeamAccent from "@/components/ui/TeamAccent";
import TabBar from "@/components/ui/TabBar";
import PWAInstallBanner from "@/components/ui/PWAInstallBanner";
import ProfileSetupWrapper from "@/components/auth/ProfileSetupWrapper";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-bg-primary">
      <ProfileSetupWrapper />
      <TeamAccent />
      <main className="pb-tab-bar pt-[env(safe-area-inset-top,0px)]">{children}</main>
      <TabBar />
      <PWAInstallBanner />
    </div>
  );
}
