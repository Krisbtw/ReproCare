import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

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
  .handler(async ({ data }): Promise<PlainResult> => {
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
    const user = [
      `Structure: ${data.structure}`,
      `Location label on file: ${data.location}`,
      `Structured measurement: ${data.measurement || "none"}`,
      `Measurement basis: ${data.basis || "not recorded"}`,
      `Clinician verification on this version: ${data.verified ? "yes" : "no"}`,
      `Excerpt: ${data.quote}`,
    ].join("\n");
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-4.5",
        temperature: 0,
        max_tokens: 180,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      return { available: true, text: null, note: `The language model did not answer (${res.status}). The stored excerpt still stands.` };
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text || text.includes("SOURCE_INSUFFICIENT")) {
      return { available: true, text: null, note: "The model declined because the source text was not enough." };
    }
    return {
      available: true,
      text,
      note: "Rewrite from the stored excerpt only. Not a diagnosis, and not a substitute for the report.",
    };
  });
