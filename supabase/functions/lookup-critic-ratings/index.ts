// lookup-critic-ratings — given a wine's identifying details, searches
// the web for published critic scores from a fixed list of well-known
// critics (James Suckling, Wine Advocate, Vinous, Jancis Robinson,
// Neal Martin). Deliberately opt-in (separate button, not bundled into
// every scan) since most of these publications are subscription-
// paywalled: a plain memory-recall answer risks confidently stating a
// wrong score, so this uses the web_search tool and only reports a
// score when a search result actually surfaced one — null otherwise.
//
// Setup: see ../scan-label/README.md — same secret, same deploy pattern.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ANTHROPIC_MODEL = "claude-sonnet-5";
const CRITICS = ["James Suckling", "Wine Advocate", "Vinous", "Jancis Robinson", "Neal Martin"];

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

    // Same cost-abuse guardrail as scan-label/suggest-similar-wines —
    // only usable by people with at least one household or connection
    // relationship. Extra important here since every click also spends
    // real web_search fees, not just tokens.
    const [{ count: partnerCount }, { count: connCount }] = await Promise.all([
      supabase.from("partners").select("*", { count: "exact", head: true }).eq("owner", user.id),
      supabase.from("connections").select("*", { count: "exact", head: true }).eq("owner", user.id),
    ]);
    if (!partnerCount && !connCount) {
      return json({ error: "This is only available once you're connected with someone in the app." }, 403);
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "Not set up yet — missing ANTHROPIC_API_KEY." }, 500);

    const { name, producer, region, vintage } = await req.json();
    if (!name && !producer) return json({ error: "Need at least a wine name or producer to search for." }, 400);

    const wineDescription = [
      vintage && `Vintage: ${vintage}`,
      name && `Name: ${name}`,
      producer && `Producer: ${producer}`,
      region && `Region: ${region}`,
    ].filter(Boolean).join("\n");

    const recordTool = {
      name: "record_critic_ratings",
      description: "Record whatever critic ratings you were able to find via web search for this wine.",
      input_schema: {
        type: "object",
        properties: {
          ratings: {
            type: "array",
            minItems: CRITICS.length,
            maxItems: CRITICS.length,
            items: {
              type: "object",
              properties: {
                critic: { type: "string", enum: CRITICS },
                score: { type: ["string", "null"], description: "The exact score as reported by a search result you can point to, e.g. '96', '17.5/20', '4 stars'. Null if you could not find a specific, attributable score from this critic for this exact wine/vintage." },
                source_note: { type: ["string", "null"], description: "Short note on where the score came from, e.g. the publication or site name. Null whenever score is null." },
              },
              required: ["critic", "score", "source_note"],
            },
          },
        },
        required: ["ratings"],
      },
    };

    const webSearchTool = { type: "web_search_20260209", name: "web_search", max_uses: 4 };

    // tool_choice is deliberately NOT forced here (unlike scan-label /
    // suggest-similar-wines) — forcing record_critic_ratings would make
    // Claude call it immediately, before it's had a chance to actually
    // search. Auto lets it run web_search first and call the recording
    // tool once it's done, all within this one request.
    //
    // max_uses is capped at 4 (not one search per critic) and the system
    // prompt explicitly pushes toward broader, combined queries — each
    // web_search round trip adds real latency inside this one request,
    // and letting Claude fire off up to 8 sequential searches risked
    // outrunning the Edge Function's execution timeout, which surfaces
    // to the browser as a generic "Failed to send a request" network
    // error rather than a clean error response.
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
        system: `You look up published critic ratings for wines. For each of these five critics — ${CRITICS.join(", ")} — try to find a specific, attributable score for the given wine and vintage. Search efficiently: combine critics into broader queries where you can (e.g. one search for "<wine> <vintage> Wine Advocate Vinous score") rather than one search per critic — aim for 2-4 searches total, not five. Only fill in a score if a search result actually surfaced one for this specific wine/vintage — never estimate, guess, or state a score from general reputation or memory. If a critic's rating can't be confidently pinned down once you've searched enough, leave both score and source_note null for that critic rather than searching indefinitely. Call record_critic_ratings exactly once with your findings, always including all five critics in the given order.`,
        tools: [webSearchTool, recordTool],
        messages: [{
          role: "user",
          content: `Find critic ratings for this wine:\n${wineDescription}`,
        }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error", anthropicRes.status, errText);
      return json({ error: "Couldn't look up ratings — try again in a moment." }, 502);
    }

    const result = await anthropicRes.json();
    const toolUse = (result.content || []).find((b: any) => b.type === "tool_use" && b.name === "record_critic_ratings");

    let ratings: any = toolUse?.input?.ratings;
    for (let i = 0; i < 2 && typeof ratings === "string"; i++) {
      try {
        const parsed = JSON.parse(ratings);
        ratings = Array.isArray(parsed) ? parsed : parsed?.ratings;
      } catch {
        break;
      }
    }

    if (!Array.isArray(ratings) || ratings.length === 0) {
      console.error("Unexpected ratings shape", JSON.stringify(result));
      return json({ error: "Couldn't compile ratings for this wine — try again." }, 502);
    }

    return json({ ratings }, 200);
  } catch (err) {
    console.error(err);
    return json({ error: "Unexpected error looking up ratings." }, 500);
  }
});
