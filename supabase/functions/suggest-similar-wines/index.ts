// suggest-similar-wines — given a wine's identifying details (however
// they got filled in — scanned or typed), suggests 3-5 comparable
// bottles with a short reason each. Text-only, no image, general
// similarity only (not personalized to the caller's tasting history —
// that's a possible future add-on once there's more tasting data to
// work with). Opt-in action, separate from scan-label, so the base
// label scan stays on the cheaper path.
//
// Setup: see ../scan-label/README.md — same secret, same deploy pattern.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ANTHROPIC_MODEL = "claude-sonnet-5";

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization" }, 401);
    const token = authHeader.replace("Bearer ", "");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) return json({ error: "Not signed in" }, 401);

    // Same cost-abuse guardrail as scan-label — only usable by people
    // with at least one household or connection relationship.
    const [{ count: partnerCount }, { count: connCount }] = await Promise.all([
      supabase.from("partners").select("*", { count: "exact", head: true }).eq("owner", user.id),
      supabase.from("connections").select("*", { count: "exact", head: true }).eq("owner", user.id),
    ]);
    if (!partnerCount && !connCount) {
      return json({ error: "This is only available once you're connected with someone in the app." }, 403);
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "Not set up yet — missing ANTHROPIC_API_KEY." }, 500);

    const { name, producer, region, grape, vintage } = await req.json();
    if (!name && !producer) return json({ error: "Need at least a wine name or producer to suggest from." }, 400);

    const tool = {
      name: "record_suggestions",
      description: "Record 3-5 wines similar to the given one.",
      input_schema: {
        type: "object",
        properties: {
          suggestions: {
            type: "array",
            minItems: 3,
            maxItems: 5,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                producer: { type: "string" },
                region: { type: "string" },
                vintage: { type: ["string", "null"], description: "A specific vintage year to look for if you have a good one in mind, else null for a non-vintage-specific suggestion." },
                price: { type: ["string", "null"], description: "Estimated retail price, e.g. '$40-60' or '$45', based on general market knowledge. Null if you don't have a reasonable basis to estimate." },
                reason: { type: "string", description: "One short sentence on why it's similar." },
              },
              required: ["name", "producer", "region", "vintage", "price", "reason"],
            },
          },
        },
        required: ["suggestions"],
      },
    };

    const description = [
      name && `Name: ${name}`,
      producer && `Producer: ${producer}`,
      region && `Region: ${region}`,
      grape && `Grape: ${grape}`,
      vintage && `Vintage: ${vintage}`,
    ].filter(Boolean).join("\n");

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: "You're a knowledgeable wine recommender. Given a wine's details, suggest 3-5 genuinely comparable bottles based on style, region, grape, and quality tier — general similarity, not personalized to any individual's taste. Real, findable wines only, no invented producers. Include a rough estimated retail price for each based on general market knowledge — null if you don't have a reasonable basis. Keep each reason to one short sentence so you stay well within your output budget. Call the record_suggestions tool exactly once.",
        tools: [tool],
        tool_choice: { type: "tool", name: "record_suggestions" },
        messages: [{
          role: "user",
          content: `Suggest wines similar to this one:\n${description}`,
        }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error", anthropicRes.status, errText);
      return json({ error: "Couldn't get suggestions — try again in a moment." }, 502);
    }

    const result = await anthropicRes.json();
    if (result.stop_reason === "max_tokens") {
      console.error("Anthropic response truncated at max_tokens", JSON.stringify(result));
      return json({ error: "Response got cut off — try again." }, 502);
    }

    const toolUse = (result.content || []).find((b: any) => b.type === "tool_use");

    // Claude sometimes double-encodes a nested array as a JSON string
    // instead of emitting it natively — unwrap up to two levels of that
    // before giving up, rather than trusting the shape blindly.
    let suggestions: any = toolUse?.input?.suggestions;
    for (let i = 0; i < 2 && typeof suggestions === "string"; i++) {
      try {
        const parsed = JSON.parse(suggestions);
        suggestions = Array.isArray(parsed) ? parsed : parsed?.suggestions;
      } catch {
        break;
      }
    }

    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      console.error("Unexpected suggestions shape", JSON.stringify(result));
      return json({ error: "Couldn't come up with suggestions for this wine — try again." }, 502);
    }

    return json({ suggestions }, 200);
  } catch (err) {
    console.error(err);
    return json({ error: "Unexpected error getting suggestions." }, 500);
  }
});
