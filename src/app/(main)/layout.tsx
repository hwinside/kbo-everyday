import TabBar from "@/components/ui/TabBar";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-bg-primary">
      <main className="pb-tab-bar">{children}</main>
      <TabBar />
    </div>
  );
}
