import { notFound } from "next/navigation";
import HookFixture from "./HookFixture";

export const metadata = { robots: "noindex,nofollow" };

export default function GameRelayHookQaPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <HookFixture />;
}
