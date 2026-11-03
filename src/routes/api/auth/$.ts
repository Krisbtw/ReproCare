import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { auth } = await import("@/lib/auth/server");
          return await auth.handler(request);
        } catch (err: any) {
          console.error("Auth GET error:", err);
          return new Response(
            JSON.stringify({ error: err?.message || String(err), stack: err?.stack }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }
      },
      POST: async ({ request }) => {
        try {
          const { auth } = await import("@/lib/auth/server");
          return await auth.handler(request);
        } catch (err: any) {
          console.error("Auth POST error:", err);
          return new Response(
            JSON.stringify({ error: err?.message || String(err), stack: err?.stack }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }
      },
    },
  },
});
