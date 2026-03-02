import TabBar from "@/components/ui/TabBar";
import ProfileSetupWrapper from "@/components/auth/ProfileSetupWrapper";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-bg-primary">
      <ProfileSetupWrapper />
      <main className="pb-tab-bar">{children}</main>
      <TabBar />
    </div>
  );
}
