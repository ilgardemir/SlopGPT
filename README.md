# SlopGPT ✨

An intentionally generic, excessively gradient-heavy, emoji-filled AI startup validator powered by OpenRouter.

## Run locally

1. Copy `.env.example` to `.env`.
2. Put your OpenRouter key in `.env`.
3. Run `npm start`.
4. Open `http://localhost:3000`.

```bash
cp .env.example .env
npm start
```

The API key stays server-side and `.env` is ignored by Git.

## Files

- `public/index.html` — the aggressively AI-generated landing page and validator UI
- `public/styles.css` — gradients, glass cards, glowing blobs, and responsive styling
- `public/app.js` — form behavior and result rendering
- `server.js` — static server and OpenRouter API proxy
- `.env.example` — environment-variable template

## Disclaimer

The scores are generated opinions, not investment or market research.
