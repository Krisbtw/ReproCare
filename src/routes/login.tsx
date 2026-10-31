import { useState, type FormEvent } from "react";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { authClient, authEnabled, GROK_PROVIDERS, signIn } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/login")({ component: LoginRoute });

function LoginRoute() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) {
    return (
      <main className="grid min-h-screen place-items-center p-6">
        <p className="text-muted">Checking session…</p>
      </main>
    );
  }
  if (user) return <Navigate to="/" />;
  return <LoginPanel />;
}

export function LoginPanel() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const result =
      mode === "up"
        ? await authClient.signUp.email({ email, password, name: name || email })
        : await authClient.signIn.email({ email, password });
    setPending(false);
    if (result.error) {
      setMessage(result.error.message ?? "Sign-in failed.");
      return;
    }
    window.location.assign("/");
  }

  return (
    <main className="grid min-h-screen place-items-center bg-paper p-6">
      <div className="w-full max-w-md space-y-5 rounded-lg border border-line bg-card p-6">
        <div>
          <p className="text-sm font-medium text-pine">AnatomyBridge</p>
          <h1 className="text-3xl">Sign in to the synthetic clinic</h1>
          <p className="mt-2 text-sm text-ink-soft">
            Accounts are real. The health records inside are fabricated and labeled synthetic. This is not a medical device.
          </p>
        </div>
        {authEnabled ? (
          <>
            <div className="grid gap-2">
              {GROK_PROVIDERS.map((provider) => (
                <button
                  key={provider.providerId}
                  type="button"
                  onClick={() => signIn(provider.providerId, { callbackURL: "/" })}
                  className="min-h-11 rounded-md border border-line bg-paper px-3 text-sm font-medium"
                >
                  Continue with {provider.label}
                </button>
              ))}
            </div>
            <form className="grid gap-2" onSubmit={(event) => void onSubmit(event)}>
              {mode === "up" && (
                <input className="min-h-11 rounded-md border border-line bg-paper px-3" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
              )}
              <input className="min-h-11 rounded-md border border-line bg-paper px-3" type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <input className="min-h-11 rounded-md border border-line bg-paper px-3" type="password" required minLength={8} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
              {message && <p className="text-sm text-clay">{message}</p>}
              <button type="submit" disabled={pending} className="min-h-11 rounded-md bg-pine px-3 text-sm font-medium text-card disabled:opacity-50">
                {pending ? "Working…" : mode === "up" ? "Create account" : "Sign in with email"}
              </button>
            </form>
            <button type="button" className="text-sm text-pine" onClick={() => setMode(mode === "up" ? "in" : "up")}>
              {mode === "up" ? "Already have an account? Sign in" : "Need an account? Register"}
            </button>
          </>
        ) : (
          <p className="text-sm text-muted">Sign-in is disabled.</p>
        )}
      </div>
    </main>
  );
}
