# SlopGPT / VibeScore AI

An intentionally vibecoded AI startup-idea validator. Node's built-in `http` server
(`server.js`) serves static files from `public/` and proxies `/api/analyze` and
`/api/followup` to OpenRouter.
No build step, no framework, no test runner — plain ESM on the server and a classic script
in the browser.

- `npm start` — run the server (`PORT`, default 3000)
- `npm run dev` — same, with `--watch` and `.env`
- `npm run probe` — diagnose OpenRouter latency/provider routing (needs a real key)

The OpenRouter key lives server-side only; the browser never sees it.

## Design intent

**The generic-AI-startup aesthetic is the point, not an accident.** Gradient purple, orbs,
emoji headings, glass cards, fake testimonials from people who do not exist, a "12,847+
founders" counter, a pricing table whose buttons only produce a toast — all deliberate. It
is a parody of the exact kind of thin AI wrapper it is built to detect, so match that
register when adding anything: buzzword-dense chrome (unlock, supercharge, next-generation,
neural, synergy), copy that oversells, and at least one gradient.

The joke only works because the site keeps admitting it. The FAQ says outright that this
guarantees nothing and is not market validation; the free tier is "100% Free*"; the
Slop Risk score exists to tell founders their idea reads as generic AI slop — which the
site itself scores badly on. Keep that self-awareness. **The satire lives in the chrome;
the analysis underneath must stay genuinely useful and honest.** Never let the bit push the
product into lying to the user: no invented statistics, no fake guarantees, no dark
patterns, and real accessibility (the score bars, the help panel, and the follow-up
thread all carry proper labels and live regions).

## Git workflow

**Commit and push all changes when you finish a piece of work.** Commit directly to `main`
and `git push` — do not open a branch or a PR unless asked.

This repo deploys to Railway from `main`, and pushing is how a change actually gets
verified. The deployment is not public and is under active development, so a broken
intermediate state is acceptable — the owner confirms issues directly against the live
site. Prefer several small commits over one large one, and write a real commit message
describing the change rather than batching unrelated work together.

Normal caution still applies to genuinely destructive operations: no `push --force`,
no history rewriting, no `reset --hard` over uncommitted work without asking.
