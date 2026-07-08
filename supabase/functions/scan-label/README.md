# scan-label Edge Function

Reads a wine label photo (via Claude Sonnet vision) and returns just the
factual fields printed on the label: vintage, name, producer, region, grape.
Everything else on the Tasting/Cellar forms stays manual — price, quantity,
purchase date, tasting notes, score, structure ratings.

## One-time setup

1. Get an Anthropic API key: https://console.anthropic.com/settings/keys
2. From this repo's root:
   ```
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   npx supabase functions deploy scan-label
   ```
   Your project ref is in the Supabase dashboard URL:
   `supabase.com/dashboard/project/<ref>`.

## Redeploying after edits to index.ts

```
npx supabase functions deploy scan-label
```
No need to re-set the secret unless the key itself changes.

## Turning it off later

```
npx supabase secrets unset ANTHROPIC_API_KEY
```
The function then returns a clear "not set up" error instead of the button
silently failing — nothing else in the app is affected.

## Cost guardrail

Only callable by users with at least one row in `partners` or `connections`
— i.e. someone you've actually approved a relationship with in the app. A
stranger who signs up cold can never trigger a paid scan.
