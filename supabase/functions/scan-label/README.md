# scan-label Edge Function

Reads a wine label photo (via Claude Sonnet vision) and returns the factual
fields printed on the label — vintage, name, producer, region, grape — plus
a drink-window/decant-time *estimate* (cellar form only) based on the
model's general wine knowledge once it's identified the bottle. Everything
else on the Tasting/Cellar forms stays manual — price, quantity, purchase
date, tasting notes, score, structure ratings.

There are three more functions alongside it, all opt-in (their own button,
not bundled into every scan), same secret, same deploy pattern, same
guardrail — everything below applies to all four:

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
   ```
   Your project ref is in the Supabase dashboard URL:
   `supabase.com/dashboard/project/<ref>`.

## Redeploying after edits to index.ts

```
npx supabase functions deploy scan-label
npx supabase functions deploy suggest-similar-wines
npx supabase functions deploy lookup-critic-ratings
npx supabase functions deploy vintage-chart
```
No need to re-set the secret unless the key itself changes — deploy just
whichever function you actually edited.

## Turning it off later

```
npx supabase secrets unset ANTHROPIC_API_KEY
```
All four functions then return a clear "not set up" error instead of the
buttons silently failing — nothing else in the app is affected.

## Cost guardrail

All four functions are only callable by users with at least one row in
`partners` or `connections` — i.e. someone you've actually approved a
relationship with in the app. A stranger who signs up cold can never
trigger a paid call.
