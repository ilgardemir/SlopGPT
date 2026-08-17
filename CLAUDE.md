# SlopGPT / VibeScore AI

An intentionally vibecoded AI startup-idea validator. Node's built-in `http` server
(`server.js`) serves static files from `public/` and proxies `/api/analyze` to OpenRouter.
No build step, no framework, no test runner — plain ESM on the server and a classic script
in the browser.

- `npm start` — run the server (`PORT`, default 3000)
- `npm run dev` — same, with `--watch` and `.env`
- `npm run probe` — diagnose OpenRouter latency/provider routing (needs a real key)

The OpenRouter key lives server-side only; the browser never sees it.

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
