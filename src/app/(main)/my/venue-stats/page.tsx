import AdminOnly from "@/components/admin/AdminOnly";
import VenueStatsDashboard from "@/components/my/VenueStatsDashboard";

export default function VenueStatsPage() {
  return (
    <AdminOnly>
      <VenueStatsDashboard />
    </AdminOnly>
  );
}
