// scan-label — reads a wine label photo and returns ONLY the factual
// fields printed on it (vintage, name, producer, region, grape). Never
// price, tasting notes, or anything requiring personal judgment — those
// stay manual on the Tasting/Cellar forms.
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

    const { imageBase64, mimeType } = await req.json();
    if (!imageBase64 || !mimeType) return json({ error: "Missing image" }, 400);

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
          grape: { type: ["string", "null"], description: "The grape variety or blend printed on the label, or null." },
        },
        required: ["vintage", "name", "producer", "region", "grape"],
      },
    };

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 400,
        system: "You read wine labels. Extract ONLY what is actually printed and legible on the label in the photo. Never guess, infer, or fill in a field you can't actually read — use null instead. Never include price, tasting notes, or any commentary. Call the record_wine_label tool exactly once with your findings.",
        tools: [tool],
        tool_choice: { type: "tool", name: "record_wine_label" },
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
            { type: "text", text: "Extract the factual label details." },
          ],
        }],
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
