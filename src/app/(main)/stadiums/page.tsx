import { permanentRedirect } from "next/navigation";

export default function LegacyStadiumsPage() {
  permanentRedirect("/community/stadiums");
}
