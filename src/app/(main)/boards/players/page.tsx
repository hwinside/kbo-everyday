import { permanentRedirect } from "next/navigation";

export default function LegacyPlayersPage() {
  permanentRedirect("/community/players");
}
