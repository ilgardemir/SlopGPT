# VibeScore AI ✨

A deliberately generic, excessively gradient-heavy, emoji-filled AI startup validator.

## Run it

The app is now frontend-only. Open `public/index.html` directly in a browser, or serve the `public` folder with any basic static host.

A simple local server is usually more reliable than opening the file directly:

```bash
cd public
python -m http.server 3000
```

Then visit `http://localhost:3000`.

## Important: exposed demo API key

This version intentionally contains a temporary OpenRouter API key inside `public/app.js`. Every visitor can see and copy that key through the source code or browser developer tools.

Use only a disposable key with a tiny spending cap and expiration date. Revoke or delete it after the demo. Never replace it with a valuable or unrestricted key.

## Files

- `public/index.html` — the extremely AI-generated landing page and app UI
- `public/styles.css` — gradients, glass cards, floating pills, fake testimonials, pricing, and other SaaS slop
- `public/app.js` — direct browser-side OpenRouter request and result rendering
- `server.js` — optional zero-dependency static server configured to allow browser calls to OpenRouter
