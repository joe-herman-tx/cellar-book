# scan-label Edge Function

Reads a wine label photo (via Claude Sonnet vision) — or identifies a wine
from typed text when there's no label to photograph (e.g. copied off a
restaurant wine list, via the Lookup tab's "Or type what's on a wine list…"
box) — and returns the factual fields: vintage, name, producer, region,
grape. From a photo these are strictly what's printed; from typed text,
unstated-but-identifiable fields get filled in (that's the point of the
text path). Either way it also returns a drink-window/decant-time
*estimate* based on the model's general wine knowledge once it's
identified the bottle. Everything else on the Tasting/Cellar forms stays
manual — price, quantity, purchase date, tasting notes, score, structure
ratings.

There are five more functions alongside it, all opt-in (their own button,
not bundled into every scan), same secret, same deploy pattern, same
guardrail — everything below applies to all six:

- `suggest-similar-wines` — "suggest 3-5 comparable bottles", text-only.
- `lookup-critic-ratings` — searches the web (via the `web_search` tool)
  for published critic scores from a fixed list (James Suckling, Wine
  Advocate, Vinous, Jancis Robinson, Neal Martin). Most of these are
  subscription-paywalled, so it only reports a score when a search result
  actually surfaced one — never a guess from memory. This one costs more
  per click than the others (real web searches, not just tokens).
- `vintage-chart` — general vintage-quality rating (1-5) per year for a
  wine region, backed by a shared cache table (`vintage_ratings`) so any
  given region is only ever generated once, for everyone, ever.
- `explore-vintage-cell` — click a cell on the vintage chart (a region +
  year) to see 3-5 real, findable wines at a range of price points, via
  `web_search`. Deliberately NOT cached like `vintage-chart` is — pricing
  and availability drift, so every click is a fresh search. Similar cost
  profile to `lookup-critic-ratings`.
- `grape-profile` — general reference profile for a grape variety
  (description, body/tannin/acidity/finish, nose/palate, best regions,
  notable vintages), backed by a shared cache table (`grape_profiles`),
  same "generated once, cached for everyone" pattern as `vintage-chart`.
  No `web_search` — grape character doesn't need real-time freshness.

## One-time setup

1. Get an Anthropic API key: https://console.anthropic.com/settings/keys
2. From this repo's root:
   ```
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   npx supabase functions deploy scan-label
   npx supabase functions deploy suggest-similar-wines
   npx supabase functions deploy lookup-critic-ratings
   npx supabase functions deploy vintage-chart
   npx supabase functions deploy explore-vintage-cell
   npx supabase functions deploy grape-profile
   ```
   Your project ref is in the Supabase dashboard URL:
   `supabase.com/dashboard/project/<ref>`.

## Redeploying after edits to index.ts

```
npx supabase functions deploy scan-label
npx supabase functions deploy suggest-similar-wines
npx supabase functions deploy lookup-critic-ratings
npx supabase functions deploy vintage-chart
npx supabase functions deploy explore-vintage-cell
npx supabase functions deploy grape-profile
```
No need to re-set the secret unless the key itself changes — deploy just
whichever function you actually edited.

## Turning it off later

```
npx supabase secrets unset ANTHROPIC_API_KEY
```
All six functions then return a clear "not set up" error instead of the
buttons silently failing — nothing else in the app is affected.

## Cost guardrail

All six functions are only callable by users with at least one row in
`partners` or `connections` — i.e. someone you've actually approved a
relationship with in the app. A stranger who signs up cold can never
trigger a paid call.
