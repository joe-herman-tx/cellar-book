// scan-label — reads a wine label photo, OR identifies a wine from a
// short typed description (e.g. copied off a restaurant wine list) when
// there's no label to photograph. Two different kinds of output either way:
//   - vintage/name/producer/region/grape: from a photo, STRICTLY what's
//     printed and legible — never guessed. From typed text, filled in
//     from context when confidently identifiable, since that's the
//     point of the text path. Never price, tasting notes, or anything
//     requiring personal judgment — those stay manual.
//   - drink_window/decant_time/color/description: the model's own
//     wine-expertise ESTIMATE for the identified bottle — still null
//     if the wine can't be confidently identified, but not limited to
//     text on the label the way the other five fields are.
//
// Setup: see README.md in this directory.

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

    // Client scoped to the caller's own session — RLS on partners/
    // connections below resolves auth.uid() from this same token.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) return json({ error: "Not signed in" }, 401);

    // Cost-abuse guardrail: only usable by people with at least one
    // household or connection relationship, so a stranger who just
    // signed up cold can never trigger a paid scan.
    const [{ count: partnerCount }, { count: connCount }] = await Promise.all([
      supabase.from("partners").select("*", { count: "exact", head: true }).eq("owner", user.id),
      supabase.from("connections").select("*", { count: "exact", head: true }).eq("owner", user.id),
    ]);
    if (!partnerCount && !connCount) {
      return json({ error: "Label scanning is only available once you're connected with someone in the app." }, 403);
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "Label scanning isn't set up yet — missing ANTHROPIC_API_KEY." }, 500);

    const { imageBase64, mimeType, textInput } = await req.json();
    if (!imageBase64 && !textInput) return json({ error: "Missing image or text" }, 400);

    const tool = {
      name: "record_wine_label",
      description: "Record the factual details printed on a wine label.",
      input_schema: {
        type: "object",
        properties: {
          vintage: { type: ["string", "null"], description: "The year printed on the label, or null if not visible." },
          name: { type: ["string", "null"], description: "The wine's name as printed, or null." },
          producer: { type: ["string", "null"], description: "The producer/winery name, or null." },
          region: { type: ["string", "null"], description: "The region/appellation printed on the label, or null." },
          grape: { type: ["string", "null"], description: "The grape variety or blend printed on the label, as a plain comma-separated list of grape names only — e.g. 'Merlot, Cabernet Sauvignon'. If the label prints percentages ('82% Merlot / 12% Cabernet Sauvignon'), strip the percentages and just list the grape names. Null if not visible." },
          drink_window: { type: ["string", "null"], description: "Estimated optimal drinking window for this specific wine, e.g. '2028-2035', based on your general knowledge of the producer/region/grape/vintage. Null if you can't identify the wine confidently enough to estimate." },
          decant_time: { type: ["string", "null"], description: "Estimated decanting recommendation, e.g. '60-90 min, longer if young'. Null if you can't identify the wine confidently enough to estimate." },
          color: { type: ["string", "null"], enum: ["Red", "White", "Rosé", "Sparkling", "Dessert", "Fortified", "Other", null], description: "The wine's color/style category, inferred from the grape/label/style even if not printed literally. Null only if genuinely undeterminable." },
          description: { type: ["string", "null"], description: "2-4 sentences on what this wine is generally like — style, typical tasting profile, notable characteristics — based on your general knowledge of the producer/region/grape/vintage. Null if you can't identify the wine confidently enough." },
        },
        required: ["vintage", "name", "producer", "region", "grape", "drink_window", "decant_time", "color", "description"],
      },
    };

    // Two entry points share this one function/schema: a photo of an
    // actual label (strict — only what's printed), or typed text (e.g.
    // copied off a restaurant wine list) where filling in unstated but
    // identifiable fields is the whole point of the feature.
    const factsRule = imageBase64
      ? "For vintage/name/producer/region/grape: extract ONLY what is actually printed and legible on the label in the photo — never guess or infer, use null if not visible."
      : "For vintage/name/producer/region/grape: you were given a short typed description (e.g. copied off a restaurant wine list), not a photo — use what's given, and fill in any of these fields you can confidently identify from context even if not explicitly stated (e.g. infer the producer or region if you recognize the wine by name). Null only if you genuinely can't determine a field either way — never invent a wine that doesn't match what was given.";
    const content = imageBase64
      ? [
          { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
          { type: "text", text: "Extract the factual label details." },
        ]
      : [
          { type: "text", text: `Identify this wine and fill in as many fields as you can:\n${textInput}` },
        ];

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 700,
        system: `You identify wines — from a label photo, or from typed text. ${factsRule} For grape specifically: list just the grape names, comma-separated, with no percentages even if given (e.g. '82% Merlot / 12% Cabernet Sauvignon' becomes 'Merlot, Cabernet Sauvignon') — this keeps the field consistent for filtering across bottles. For drink_window/decant_time/color/description: these are estimates, so you MAY use your general wine knowledge about this specific producer/region/grape/vintage to give a realistic answer (color is usually inferable from the grape/style even when not printed; description is 2-4 sentences on the wine's typical style/profile/character) — but still use null if you can't identify the wine confidently enough to venture a reasonable estimate; never a generic guess for a wine you don't recognize. Never include price or any other commentary beyond what's specified. Call the record_wine_label tool exactly once with your findings.`,
        tools: [tool],
        tool_choice: { type: "tool", name: "record_wine_label" },
        messages: [{ role: "user", content }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error", anthropicRes.status, errText);
      return json({ error: "Label scan failed — try again in a moment." }, 502);
    }

    const result = await anthropicRes.json();
    const toolUse = (result.content || []).find((b: any) => b.type === "tool_use");
    if (!toolUse) return json({ error: "Couldn't read the label — try a clearer photo." }, 502);

    return json(toolUse.input, 200);
  } catch (err) {
    console.error(err);
    return json({ error: "Unexpected error scanning the label." }, 500);
  }
});
