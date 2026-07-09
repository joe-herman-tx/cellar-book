// explore-vintage-cell — given a region and a specific vintage year (a
// clicked cell on the Vintage Chart), searches the web for 3-5 real,
// findable wines from that region/vintage spanning a range of price
// points, so you have something to actually go source. Deliberately
// NOT cached (unlike vintage-chart's region ratings) — "wines to buy"
// implies current availability and pricing, which drift over time in
// a way general vintage-quality reputation doesn't, so every click
// runs a fresh search.
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

    // Same cost-abuse guardrail as the other AI-backed functions — every
    // click here spends real web_search fees, not just tokens.
    const [{ count: partnerCount }, { count: connCount }] = await Promise.all([
      supabase.from("partners").select("*", { count: "exact", head: true }).eq("owner", user.id),
      supabase.from("connections").select("*", { count: "exact", head: true }).eq("owner", user.id),
    ]);
    if (!partnerCount && !connCount) {
      return json({ error: "This is only available once you're connected with someone in the app." }, 403);
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "Not set up yet — missing ANTHROPIC_API_KEY." }, 500);

    const { region, year } = await req.json();
    const cleanRegion = (region || "").trim();
    if (!cleanRegion || !year) return json({ error: "Missing region or year" }, 400);

    const recordTool = {
      name: "record_vintage_wines",
      description: "Record 3-5 real, findable wines from this region and vintage, spanning a range of price points.",
      input_schema: {
        type: "object",
        properties: {
          wines: {
            type: "array",
            minItems: 3,
            maxItems: 5,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                producer: { type: "string" },
                price: { type: ["string", "null"], description: "Estimated or found retail price, e.g. '$35' or '$80-120'. Null if you don't have a reasonable basis." },
                rating: { type: ["string", "null"], description: "A critic score or rating actually surfaced by a search result, with its source if possible, e.g. '92 (Wine Spectator)'. Null if search didn't surface an attributable rating — never a guess." },
                description: { type: "string", description: "1-2 sentence summary of the wine — style, tasting profile, or notable characteristics — drawn from what you found." },
              },
              required: ["name", "producer", "price", "rating", "description"],
            },
          },
        },
        required: ["wines"],
      },
    };

    const webSearchTool = { type: "web_search_20260209", name: "web_search", max_uses: 3 };

    // tool_choice deliberately not forced — same reasoning as
    // lookup-critic-ratings: Claude needs room to search first.
    //
    // The real latency driver isn't search COUNT, it's SEQUENTIAL turns:
    // each time Claude searches, waits for results, then decides to
    // search again, that's a full extra model round trip. The system
    // prompt below explicitly pushes Claude to issue all its searches
    // together as parallel tool calls in one turn (which Anthropic
    // executes concurrently server-side) instead of one-at-a-time —
    // that's what actually bounds the request to ~2 model turns instead
    // of up to `max_uses` sequential ones. max_uses is now just a hard
    // ceiling, not the primary lever. An unbounded/sequential search
    // chain risked outrunning the Edge Function's execution timeout,
    // which surfaces to the browser as a generic failure or non-2xx
    // status instead of a clean error response.
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1800,
        system: "You help someone source real wine to buy. Given a wine region and a specific vintage year, use the web_search tool to find 3-5 real, currently findable wines from that exact region and vintage, spanning a range of price points from budget to splurge. Speed matters: issue your searches (2-3 of them, covering different price tiers) as PARALLEL tool calls in a single turn — do not search once, read the results, and then decide to search again; decide all your queries up front and fire them together. Real producers only — never invent a wine. Include a rating only if a search result actually surfaced an attributable score for that wine (with its source where possible) — never estimate or guess one. Write a short 1-2 sentence description of each wine based on what you found. As soon as your parallel searches come back, call record_vintage_wines immediately with your best 3-5 entries — do not search again after that first batch.",
        tools: [webSearchTool, recordTool],
        messages: [{
          role: "user",
          content: `Find wines to buy from this region and vintage:\nRegion: ${cleanRegion}\nVintage: ${year}`,
        }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error", anthropicRes.status, errText);
      return json({ error: "Couldn't find wines for this cell — try again in a moment." }, 502);
    }

    const result = await anthropicRes.json();
    const toolUse = (result.content || []).find((b: any) => b.type === "tool_use" && b.name === "record_vintage_wines");

    let wines: any = toolUse?.input?.wines;
    for (let i = 0; i < 2 && typeof wines === "string"; i++) {
      try {
        const parsed = JSON.parse(wines);
        wines = Array.isArray(parsed) ? parsed : parsed?.wines;
      } catch {
        break;
      }
    }

    if (!Array.isArray(wines) || wines.length === 0) {
      console.error("Unexpected wines shape", JSON.stringify(result));
      return json({ error: "Couldn't find wines for this region and vintage — try again." }, 502);
    }

    return json({ wines }, 200);
  } catch (err) {
    console.error(err);
    return json({ error: "Unexpected error exploring this vintage." }, 500);
  }
});
