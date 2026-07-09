// vintage-chart — returns a general vintage-quality rating (1-5) for
// every year in the last 25 for a given wine region, to help judge
// whether a given year from a given region is worth buying. Backed by
// a shared cache table (vintage_ratings) that is NOT scoped to a user
// — vintage quality by region is public reference knowledge, not
// personal data, so once anyone generates a region it's cached forever
// for everyone and this function never has to pay for it again.
//
// Deliberately no web_search here (unlike lookup-critic-ratings) —
// general vintage reputation by region is well within Claude's
// training knowledge and doesn't need real-time freshness, which
// keeps a cache-miss generation essentially free.
//
// Setup: see ../scan-label/README.md — same secret, same deploy pattern.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ANTHROPIC_MODEL = "claude-sonnet-5";
const YEARS_BACK = 24; // 25 years total including the current one

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

    const { region } = await req.json();
    const cleanRegion = (region || "").trim();
    if (!cleanRegion) return json({ error: "Missing region" }, 400);

    // Cache hit: any existing rows for this region (case-insensitive)
    // mean it's already been generated — return them, no Claude call.
    const { data: cached, error: cacheErr } = await supabase
      .from("vintage_ratings")
      .select("region, year, rating, note")
      .ilike("region", cleanRegion)
      .order("year", { ascending: true });
    if (cacheErr) {
      console.error("Cache lookup error", cacheErr);
      return json({ error: "Couldn't check the vintage cache." }, 500);
    }
    if (cached && cached.length > 0) {
      return json({ region: cleanRegion, years: cached }, 200);
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "Not set up yet — missing ANTHROPIC_API_KEY." }, 500);

    const currentYear = new Date().getFullYear();
    const startYear = currentYear - YEARS_BACK;

    const tool = {
      name: "record_vintage_ratings",
      description: "Record a general vintage-quality rating for each year in the requested range for this wine region.",
      input_schema: {
        type: "object",
        properties: {
          years: {
            type: "array",
            minItems: YEARS_BACK + 1,
            maxItems: YEARS_BACK + 1,
            items: {
              type: "object",
              properties: {
                year: { type: "integer" },
                rating: { type: "integer", enum: [1, 2, 3, 4, 5], description: "1 = poor/challenging vintage, 5 = outstanding vintage, based on this region's well-known/typical characterization of that year." },
                note: { type: "string", description: "One short phrase on why, e.g. 'Cool, wet growing season' or 'Ideal ripening conditions'." },
              },
              required: ["year", "rating", "note"],
            },
          },
        },
        required: ["years"],
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
        max_tokens: 1500,
        system: "You are a general wine-vintage reference. Given a wine region, provide a general-knowledge quality rating (1-5) for every year in the requested range, based on your knowledge of that region's climate patterns and well-documented vintage reputations. This is meant as a general guide for someone deciding whether a given year is worth buying, not a certainty — for less-documented regions or years, give a reasonable estimate based on the broader area's known climate trends and keep the note brief and appropriately hedged rather than refusing to answer. Call record_vintage_ratings exactly once with a rating for every year in the range, no gaps.",
        tools: [tool],
        tool_choice: { type: "tool", name: "record_vintage_ratings" },
        messages: [{
          role: "user",
          content: `Region: ${cleanRegion}\nYears: ${startYear}-${currentYear}`,
        }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error", anthropicRes.status, errText);
      return json({ error: "Couldn't generate a vintage chart for this region — try again in a moment." }, 502);
    }

    const result = await anthropicRes.json();
    const toolUse = (result.content || []).find((b: any) => b.type === "tool_use");

    let years: any = toolUse?.input?.years;
    for (let i = 0; i < 2 && typeof years === "string"; i++) {
      try {
        const parsed = JSON.parse(years);
        years = Array.isArray(parsed) ? parsed : parsed?.years;
      } catch {
        break;
      }
    }

    if (!Array.isArray(years) || years.length === 0) {
      console.error("Unexpected years shape", JSON.stringify(result));
      return json({ error: "Couldn't generate a vintage chart for this region — try again." }, 502);
    }

    const rows = years
      .filter((y: any) => Number.isInteger(y?.year) && Number.isInteger(y?.rating))
      .map((y: any) => ({ region: cleanRegion, year: y.year, rating: y.rating, note: y.note ?? null }));

    const { error: upsertErr } = await supabase.from("vintage_ratings").upsert(rows, { onConflict: "region,year" });
    if (upsertErr) {
      console.error("Upsert error", upsertErr);
      // Still return what we generated even if the cache write failed —
      // no reason to make the user wait/pay again for a display-only issue.
    }

    return json({ region: cleanRegion, years: rows }, 200);
  } catch (err) {
    console.error(err);
    return json({ error: "Unexpected error generating the vintage chart." }, 500);
  }
});
