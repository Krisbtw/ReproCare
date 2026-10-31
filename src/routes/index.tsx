import { createFileRoute } from "@tanstack/react-router";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { ClinicApp } from "@/components/clinic-app";
import { LoginPanel } from "./login";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) {
    return (
      <main className="mx-auto max-w-3xl space-y-3 p-8">
        <p className="text-sm font-medium text-pine">AnatomyBridge</p>
        <h1 className="text-3xl">Checking your session</h1>
        <p className="text-muted">The synthetic clinic opens once the session is known.</p>
      </main>
    );
  }
  if (!user) return <LoginPanel />;
  return <ClinicApp />;
}
