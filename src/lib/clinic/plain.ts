import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "../auth/middleware.ts";
import type { Sql } from "../db.ts";

export type PlainResult = {
  available: boolean;
  text: string | null;
  note: string;
};

const SYSTEM = `You rewrite one stored clinical excerpt into plain language for the person it concerns.
Rules:
- Use only the excerpt and the structured fields in the user message.
- Do not diagnose a condition, name a treatment, recommend surgery, or infer cancer or malignancy.
- Do not add measurements, dates, anatomy, or findings that are not in the user message.
- If the excerpt is empty, reply with exactly SOURCE_INSUFFICIENT.
- At most 90 words.
- End with this sentence: This is not a diagnosis.`;

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
    const { getSql } = await import("../db.ts");
    const sql = await getSql();
    return executeExplainPlain(sql, context.userId, data);
  });

export async function executeExplainPlain(
  sql: Sql,
  userId: string,
  data: {
    structure: string;
    location: string;
    quote: string;
    measurement: string;
    basis: string;
    verified: boolean;
  },
): Promise<PlainResult> {
  const { requireVerifiedClinicianOrAdmin } = await import("./server.backend.ts");
  await requireVerifiedClinicianOrAdmin(sql, userId, "rewriting clinical excerpts");
  if (!data.quote) {
    return {
      available: true,
      text: null,
      note: "The stored report excerpt is empty, so no rewrite was requested.",
    };
  }
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return {
      available: false,
      text: null,
      note: "A language model is not configured here. The stored excerpt above is the explanation.",
    };
  }

  const userMessage = [
    `Structure: ${data.structure}`,
    `Location: ${data.location}`,
    `Measurement: ${data.measurement}`,
    `Basis: ${data.basis}`,
    `Verified by clinician: ${data.verified ? "yes" : "no"}`,
    `Original excerpt: "${data.quote}"`,
  ].join("\n");

  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-beta",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userMessage },
        ],
        temperature: 0.2,
        max_tokens: 180,
      }),
    });
    if (!res.ok) {
      return {
        available: false,
        text: null,
        note: `The rewrite request was rejected (${res.status}). The stored excerpt above is the explanation.`,
      };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text || text.includes("SOURCE_INSUFFICIENT")) {
      return {
        available: false,
        text: null,
        note: "The model found the stored excerpt insufficient to rewrite safely.",
      };
    }
    return {
      available: true,
      text,
      note: "Rewritten from the stored excerpt. This is not a diagnosis.",
    };
  } catch {
    return {
      available: false,
      text: null,
      note: "Could not reach the language model. The stored excerpt above is the explanation.",
    };
  }
}
