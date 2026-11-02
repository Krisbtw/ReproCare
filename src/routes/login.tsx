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
    try {
      const result =
        mode === "up"
          ? await authClient.signUp.email({ email: email.trim(), password, name: name.trim() || email.trim() })
          : await authClient.signIn.email({ email: email.trim(), password });
      setPending(false);
      if (result?.error) {
        const rawMsg = result.error.message || "Authentication failed.";
        if (/invalid origin/i.test(rawMsg)) {
          setMessage("Origin validation failed. Please refresh the page or ensure you are on the secure domain.");
        } else if (/user already exists/i.test(rawMsg)) {
          setMessage("An account with this email already exists. Please sign in.");
          setMode("in");
        } else {
          setMessage(rawMsg);
        }
        return;
      }
      window.location.assign("/");
    } catch (err: any) {
      setPending(false);
      setMessage(err?.message || "An unexpected error occurred. Please try again.");
    }
  }

  function switchMode(newMode: "in" | "up") {
    setMode(newMode);
    setMessage(null);
  }

  return (
    <main className="grid min-h-screen place-items-center bg-paper p-6">
      <div className="w-full max-w-md space-y-5 rounded-lg border border-line bg-card p-6 shadow-sm">
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
                  className="min-h-11 rounded-md border border-line bg-paper px-3 text-sm font-medium hover:bg-line/20 transition-colors"
                >
                  Continue with {provider.label}
                </button>
              ))}
            </div>
            <form className="grid gap-2" onSubmit={(event) => void onSubmit(event)}>
              {mode === "up" && (
                <input
                  className="min-h-11 rounded-md border border-line bg-paper px-3 text-ink"
                  placeholder="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
              <input
                className="min-h-11 rounded-md border border-line bg-paper px-3 text-ink"
                type="email"
                required
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <input
                className="min-h-11 rounded-md border border-line bg-paper px-3 text-ink"
                type="password"
                required
                minLength={8}
                placeholder="Password (minimum 8 characters)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {message && (
                <div className="rounded-md border border-clay/30 bg-clay/10 p-3 text-sm text-clay">
                  {message}
                </div>
              )}
              <button
                type="submit"
                disabled={pending}
                className="min-h-11 rounded-md bg-pine px-3 text-sm font-medium text-white hover:bg-pine/90 transition-colors disabled:opacity-50"
              >
                {pending ? "Working…" : mode === "up" ? "Create account" : "Sign in with email"}
              </button>
            </form>
            <button
              type="button"
              className="text-sm text-pine hover:underline"
              onClick={() => switchMode(mode === "up" ? "in" : "up")}
            >
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
