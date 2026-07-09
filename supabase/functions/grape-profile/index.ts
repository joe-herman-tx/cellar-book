// grape-profile — general reference profile for a grape variety: a
// short description, a body/tannin/acidity/finish structure profile
// (1-5, same scale as the tasting log's own gauges), nose/palate, and
// the regions/vintages it's best known for. Backed by a shared cache
// table (grape_profiles) — NOT scoped to a user, same reasoning as
// vintage-chart: this is public reference knowledge, so once anyone
// generates a grape it's cached forever for everyone.
//
// Deliberately no web_search — grape character is well within Claude's
// general training knowledge and doesn't need real-time freshness,
// which keeps a cache-miss generation essentially free.
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

    const [{ count: partnerCount }, { count: connCount }] = await Promise.all([
      supabase.from("partners").select("*", { count: "exact", head: true }).eq("owner", user.id),
      supabase.from("connections").select("*", { count: "exact", head: true }).eq("owner", user.id),
    ]);
    if (!partnerCount && !connCount) {
      return json({ error: "This is only available once you're connected with someone in the app." }, 403);
    }

    const { grape } = await req.json();
    const cleanGrape = (grape || "").trim();
    if (!cleanGrape) return json({ error: "Missing grape" }, 400);

    // Cache hit: an existing row (case-insensitive) means it's already
    // been generated — return it, no Claude call.
    const { data: cached, error: cacheErr } = await supabase
      .from("grape_profiles")
      .select("grape, description, body, tannin, acidity, finish, nose, palate, best_regions, notable_vintages")
      .ilike("grape", cleanGrape)
      .maybeSingle();
    if (cacheErr) {
      console.error("Cache lookup error", cacheErr);
      return json({ error: "Couldn't check the grape cache." }, 500);
    }
    if (cached) {
      return json({ profile: cached }, 200);
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "Not set up yet — missing ANTHROPIC_API_KEY." }, 500);

    const tool = {
      name: "record_grape_profile",
      description: "Record a general reference profile for this grape variety.",
      input_schema: {
        type: "object",
        properties: {
          description: { type: "string", description: "2-4 sentences of high-level talking points — the grape's general character and reputation." },
          body: { type: "integer", enum: [1, 2, 3, 4, 5], description: "Typical body, 1 = light to 5 = full." },
          tannin: { type: "integer", enum: [1, 2, 3, 4, 5], description: "Typical tannin level, 1 = low/none (most whites) to 5 = high." },
          acidity: { type: "integer", enum: [1, 2, 3, 4, 5], description: "Typical acidity, 1 = low to 5 = high." },
          finish: { type: "integer", enum: [1, 2, 3, 4, 5], description: "Typical finish length, 1 = short to 5 = long." },
          nose: { type: "string", description: "Short phrase on typical aromatic characteristics, e.g. 'Blackcurrant, cedar, graphite'." },
          palate: { type: "string", description: "Short phrase on typical palate/flavor profile." },
          best_regions: { type: "string", description: "3-5 regions this grape is best known for, as a short comma-separated or prose list." },
          notable_vintages: { type: "string", description: "A few historically well-regarded vintages/years for this grape across its best regions, as short prose." },
        },
        required: ["description", "body", "tannin", "acidity", "finish", "nose", "palate", "best_regions", "notable_vintages"],
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
        max_tokens: 800,
        system: "You are a wine-education reference. Given a grape variety, provide a general-knowledge profile a wine enthusiast would find useful — its typical structure (body/tannin/acidity/finish on a 1-5 scale), aromatic and flavor character, and the regions and vintages it's best known for. This is a general guide, not a description of any specific bottle. Call record_grape_profile exactly once.",
        tools: [tool],
        tool_choice: { type: "tool", name: "record_grape_profile" },
        messages: [{ role: "user", content: `Grape: ${cleanGrape}` }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error", anthropicRes.status, errText);
      return json({ error: "Couldn't generate a profile for this grape — try again in a moment." }, 502);
    }

    const result = await anthropicRes.json();
    const toolUse = (result.content || []).find((b: any) => b.type === "tool_use");
    const input = toolUse?.input;

    if (!input || typeof input.description !== "string") {
      console.error("Unexpected profile shape", JSON.stringify(result));
      return json({ error: "Couldn't generate a profile for this grape — try again." }, 502);
    }

    const row = {
      grape: cleanGrape,
      description: input.description ?? null,
      body: input.body ?? null,
      tannin: input.tannin ?? null,
      acidity: input.acidity ?? null,
      finish: input.finish ?? null,
      nose: input.nose ?? null,
      palate: input.palate ?? null,
      best_regions: input.best_regions ?? null,
      notable_vintages: input.notable_vintages ?? null,
    };

    const { error: upsertErr } = await supabase.from("grape_profiles").upsert(row, { onConflict: "grape" });
    if (upsertErr) {
      console.error("Upsert error", upsertErr);
      // Still return what we generated even if the cache write failed.
    }

    return json({ profile: row }, 200);
  } catch (err) {
    console.error(err);
    return json({ error: "Unexpected error generating this grape's profile." }, 500);
  }
});
