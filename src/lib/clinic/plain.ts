import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "../auth/middleware.ts";

export type PlainResult = {
  available: boolean;
  text: string | null;
  note: string;
};

export const explainPlain = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      structure: string;
      location: string;
      quote: string;
      measurement: string;
      basis: string;
      verified: boolean;
    }) => ({
      structure: input.structure.slice(0, 80),
      location: input.location.slice(0, 160),
      quote: input.quote.trim().slice(0, 800),
      measurement: input.measurement.slice(0, 80),
      basis: input.basis.slice(0, 80),
      verified: Boolean(input.verified),
    }),
  )
  .handler(async ({ data, context }): Promise<PlainResult> => {
    const { getSql, executeExplainPlain } = await import("./server.backend.ts");
    const sql = await getSql();
    return executeExplainPlain(sql, context.userId, data);
  });
