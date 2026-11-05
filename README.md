# Vedabase Companion — Chrome extension (backend-connected)

Records the audio of a YouTube lecture tab in 8-second clips and sends each clip to **your backend**:

1. `offscreen.js` → `POST {backend}/api/transcribe`  (Engine 1: audio → text; the Whisper API key lives on the server)
2. `content.js` keeps a rolling text buffer → `background.js` → `POST {backend}/api/public/detect`  (Engine 2: text → verse)
3. A matched verse shows the overlay; Save / History still use `chrome.storage.local`.

## Setup
1. Run the backend (see `../backend`, `uvicorn app.main:app --port 8000`).
2. `chrome://extensions` → Developer mode → Load unpacked → this folder.
3. Popup → Listen tab → set **Backend URL** (default `http://localhost:8000`), language (`hi` or `sa`), Save.
4. Open a lecture on YouTube → Start listening.

Deploying the backend elsewhere? Add its origin (e.g. `"https://api.example.com/*"`) to `host_permissions` in `manifest.json` and reload the extension.
