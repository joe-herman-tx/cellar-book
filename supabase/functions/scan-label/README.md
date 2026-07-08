# scan-label Edge Function

Reads a wine label photo (via Claude Sonnet vision) and returns the factual
fields printed on the label — vintage, name, producer, region, grape — plus
a drink-window/decant-time *estimate* (cellar form only) based on the
model's general wine knowledge once it's identified the bottle. Everything
else on the Tasting/Cellar forms stays manual — price, quantity, purchase
date, tasting notes, score, structure ratings.

There's a second function alongside it, `suggest-similar-wines` — an
opt-in "suggest 3-5 comparable bottles" action, text-only (no image),
triggered by its own button rather than bundled into every scan. Same
secret, same deploy pattern, same guardrail — everything below applies to
both.

## One-time setup

1. Get an Anthropic API key: https://console.anthropic.com/settings/keys
2. From this repo's root:
   ```
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   npx supabase functions deploy scan-label
   npx supabase functions deploy suggest-similar-wines
   ```
   Your project ref is in the Supabase dashboard URL:
   `supabase.com/dashboard/project/<ref>`.

## Redeploying after edits to index.ts

```
npx supabase functions deploy scan-label
npx supabase functions deploy suggest-similar-wines
```
No need to re-set the secret unless the key itself changes — deploy just
whichever function you actually edited.

## Turning it off later

```
npx supabase secrets unset ANTHROPIC_API_KEY
```
Both functions then return a clear "not set up" error instead of the
buttons silently failing — nothing else in the app is affected.

## Cost guardrail

Both functions are only callable by users with at least one row in
`partners` or `connections` — i.e. someone you've actually approved a
relationship with in the app. A stranger who signs up cold can never
trigger a paid call.
