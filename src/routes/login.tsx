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
  const [accountRole, setAccountRole] = useState<"clinician" | "patient">("clinician");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function quickSignIn(demoEmail: string, demoPassword: string, demoName: string) {
    setEmail(demoEmail);
    setPassword(demoPassword);
    setPending(true);
    setMessage(null);
    try {
      let res = await authClient.signIn.email({ email: demoEmail, password: demoPassword });
      if (res?.error) {
        const upRes = await authClient.signUp.email({
          email: demoEmail,
          password: demoPassword,
          name: demoName,
        });
        if (upRes?.error) {
          res = await authClient.signIn.email({ email: demoEmail, password: demoPassword });
        } else {
          window.location.assign("/");
          return;
        }
      }
      if (res?.error) {
        setMessage(res.error.message || "Sign in failed.");
        setPending(false);
        return;
      }
      window.location.assign("/");
    } catch (err: any) {
      setPending(false);
      setMessage(err?.message || "Sign in failed.");
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      const displayName =
        mode === "up" && accountRole === "clinician"
          ? (name.trim().startsWith("Dr.") ? name.trim() : `[Clinician] ${name.trim() || email.trim()}`)
          : (name.trim() || email.trim());

      const result =
        mode === "up"
          ? await authClient.signUp.email({ email: email.trim(), password, name: displayName })
          : await authClient.signIn.email({ email: email.trim(), password });
      setPending(false);
      if (result?.error) {
        const rawMsg =
          result.error.message ||
          (result.error as any).statusText ||
          ((result.error as any).status ? `Authentication failed (${(result.error as any).status})` : "Authentication failed.");
        if (/invalid origin/i.test(rawMsg)) {
          setMessage("Origin validation failed. Please refresh the page or ensure you are on the secure domain.");
        } else if (/user already exists/i.test(rawMsg) || (result.error as any).code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
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
            <div className="rounded-md border border-line bg-paper p-3 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Demo Credentials · 1-Click Sign-In</p>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void quickSignIn("dr.chen@reprocare.health", "Clinician123!", "Dr. Sarah Chen, MD")}
                  className="flex flex-col items-center justify-center rounded border border-line bg-card p-2 text-center hover:border-pine hover:bg-pine/5 transition-colors disabled:opacity-50"
                >
                  <span className="text-xs font-bold text-pine">Clinician</span>
                  <span className="text-[10px] text-ink-soft">Dr. Sarah Chen</span>
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void quickSignIn("patient@reprocare.health", "Patient123!", "Kavya Patel")}
                  className="flex flex-col items-center justify-center rounded border border-line bg-card p-2 text-center hover:border-pine hover:bg-pine/5 transition-colors disabled:opacity-50"
                >
                  <span className="text-xs font-bold text-ink">Patient</span>
                  <span className="text-[10px] text-ink-soft">Kavya Patel</span>
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void quickSignIn("admin@reprocare.health", "Admin123!", "Clinic Administrator")}
                  className="flex flex-col items-center justify-center rounded border border-line bg-card p-2 text-center hover:border-pine hover:bg-pine/5 transition-colors disabled:opacity-50"
                >
                  <span className="text-xs font-bold text-ink">Admin</span>
                  <span className="text-[10px] text-ink-soft">Administrator</span>
                </button>
              </div>
            </div>

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
                <>
                  <div className="grid gap-1">
                    <label className="text-xs font-medium text-ink-soft">Account Role</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setAccountRole("clinician")}
                        className={`min-h-10 rounded-md border text-sm font-medium transition-colors ${
                          accountRole === "clinician"
                            ? "border-pine bg-pine text-white"
                            : "border-line bg-paper text-ink hover:bg-line/20"
                        }`}
                      >
                        Clinician (Volume Lab)
                      </button>
                      <button
                        type="button"
                        onClick={() => setAccountRole("patient")}
                        className={`min-h-10 rounded-md border text-sm font-medium transition-colors ${
                          accountRole === "patient"
                            ? "border-pine bg-pine text-white"
                            : "border-line bg-paper text-ink hover:bg-line/20"
                        }`}
                      >
                        Patient
                      </button>
                    </div>
                  </div>
                  <input
                    className="min-h-11 rounded-md border border-line bg-paper px-3 text-ink"
                    placeholder={accountRole === "clinician" ? "Name (e.g. Dr. Sarah Chen, MD)" : "Name"}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </>
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
