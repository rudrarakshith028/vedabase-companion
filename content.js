// Vedabase Companion — content script
// Runs on youtube.com. Receives speech-recognition transcripts of the tab's audio
// from the background worker, keeps a rolling text buffer, asks the backend to
// detect a verse, and shows a non-blocking overlay when one is matched.

(() => {
  const DEBUG = true; // set to false to hide the status badge and console logs

  function dlog(...args) {
    if (DEBUG) console.log("[Vedabase Companion]", ...args);
  }

  const CONFIDENCE_THRESHOLD = 0.7;
  const BUFFER_MAX_CHARS = 400;
  const SEND_DEBOUNCE_MS = 600;
  const VERSE_COOLDOWN_MS = 90 * 1000;
  const MIN_USABLE_CHARS = 12;
  const MAX_SAVED = 500;
  const MAX_LOG = 500;

  let textBuffer = "";
  let sendTimer = null;
  let lastVerseShownAt = {};
  let overlayRoot = null;
  let extensionInvalidated = false;

  function getVideoId() {
    try {
      return new URLSearchParams(window.location.search).get("v") || "";
    } catch (_) {
      return "";
    }
  }

  function isExtensionContextValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  // ---------- Incoming messages from the background worker ----------

  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === "TRANSCRIPT") {
      dlog("heard:", JSON.stringify(message.text));
      setDebugBadge(`Heard: "${message.text.slice(0, 70)}"`);
      appendToBuffer(message.text);
    } else if (message.type === "LISTEN_STATUS") {
      const labels = {
        listening: "🎙 Listening to the lecture…",
        transcribing: "🎙 Recognising speech…",
        stopped: "Voice recognition stopped",
        error: `Voice error: ${message.error || "unknown"}`
      };
      setDebugBadge(labels[message.status] || message.status);
    }
  });

  function appendToBuffer(newText) {
    const cleaned = newText.replace(/\s+/g, " ").trim();
    if (!cleaned) return;
    textBuffer = `${textBuffer} ${cleaned}`.trim();
    if (textBuffer.length > BUFFER_MAX_CHARS) {
      textBuffer = textBuffer.slice(textBuffer.length - BUFFER_MAX_CHARS);
    }
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = setTimeout(runDetection, SEND_DEBOUNCE_MS);
  }

  function runDetection() {
    if (extensionInvalidated) return;
    if (!isExtensionContextValid()) {
      extensionInvalidated = true;
      console.warn("[Vedabase Companion] Extension was reloaded — refresh this YouTube tab to reconnect.");
      return;
    }

    const text = textBuffer.trim();
    if (text.length < MIN_USABLE_CHARS) return;

    setDebugBadge(`Checking: "${text.slice(-60)}"`);

    try {
      chrome.runtime.sendMessage({ type: "DETECT_VERSE", text }, (response) => {
        if (chrome.runtime.lastError) {
          setDebugBadge(`Error: ${chrome.runtime.lastError.message} (refresh tab)`);
          return;
        }
        if (!response || !response.ok) {
          setDebugBadge(`Backend error: ${(response && response.error) || "unknown"}`);
          return;
        }

        const data = response.data;
        dlog("detection response:", data);
        logDetection(data, text);

        if (data.matched && data.confidence >= CONFIDENCE_THRESHOLD) {
          setDebugBadge(`✓ Matched ${data.scripture} ${data.chapter}.${data.verse} (${data.confidence})`);
          textBuffer = ""; // verse found — start fresh so it isn't re-matched from old text
          maybeShowVerse(data);
        } else if (data.matched) {
          setDebugBadge(`Below threshold: ${data.scripture} ${data.chapter}.${data.verse} (${data.confidence})`);
        } else {
          setDebugBadge(`No match (confidence ${data.confidence})`);
        }
      });
    } catch (err) {
      extensionInvalidated = true;
      console.warn("[Vedabase Companion] Lost connection to the extension — refresh this tab.", err.message);
    }
  }

  // ---------- Storage (saved verses + detection history) ----------

  function logDetection(data, inputText) {
    chrome.storage.local.get({ detections: [] }, ({ detections }) => {
      detections.push({
        video_id: getVideoId(),
        input_text: inputText,
        matched: !!data.matched,
        confidence: data.confidence,
        verse_id: data.verse_id || null,
        scripture: data.scripture || null,
        chapter: data.chapter || null,
        verse: data.verse || null,
        translation: data.translation || null,
        vedabase_url: data.vedabase_url || null,
        timestamp: Date.now()
      });
      if (detections.length > MAX_LOG) detections = detections.slice(detections.length - MAX_LOG);
      chrome.storage.local.set({ detections });
    });
  }

  function saveVerse(data) {
    chrome.storage.local.get({ saved: [] }, ({ saved }) => {
      const videoId = getVideoId();
      if (saved.some((v) => v.verse_id === data.verse_id && v.video_id === videoId)) return;
      saved.push({
        verse_id: data.verse_id,
        scripture: data.scripture,
        chapter: data.chapter,
        verse: data.verse,
        sanskrit_text: data.sanskrit_text,
        transliteration: data.transliteration,
        translation: data.translation,
        vedabase_url: data.vedabase_url,
        video_id: videoId,
        video_timestamp: Math.floor(getCurrentPlayerTime()),
        created_at: Date.now()
      });
      if (saved.length > MAX_SAVED) saved = saved.slice(saved.length - MAX_SAVED);
      chrome.storage.local.set({ saved });
    });
  }

  function getCurrentPlayerTime() {
    const video = document.querySelector("video");
    return video ? video.currentTime : 0;
  }

  // ---------- Overlay UI ----------

  function maybeShowVerse(data) {
    const lastShown = lastVerseShownAt[data.verse_id] || 0;
    if (Date.now() - lastShown < VERSE_COOLDOWN_MS) {
      setDebugBadge("✓ Matched (notification suppressed — shown recently)");
      return;
    }
    lastVerseShownAt[data.verse_id] = Date.now();
    showNotification(data);
  }

  function getPlayerContainer() {
    return document.querySelector("#movie_player") || document.querySelector(".html5-video-player");
  }

  function ensureDebugBadge() {
    if (!DEBUG) return null;
    let badge = document.querySelector(".vc-debug-badge");
    if (badge) return badge;
    const player = getPlayerContainer();
    if (!player) return null;
    badge = document.createElement("div");
    badge.className = "vc-debug-badge";
    badge.textContent = "Vedabase Companion: click the toolbar icon → Listen → Start";
    player.appendChild(badge);
    return badge;
  }

  function setDebugBadge(text) {
    if (!DEBUG) return;
    const badge = ensureDebugBadge();
    if (badge) badge.textContent = text;
  }

  function removeOverlay() {
    if (overlayRoot && overlayRoot.parentNode) overlayRoot.parentNode.removeChild(overlayRoot);
    overlayRoot = null;
  }

  function showNotification(data) {
    const player = getPlayerContainer();
    if (!player) return;
    removeOverlay();

    overlayRoot = document.createElement("div");
    overlayRoot.className = "vc-root";
    overlayRoot.innerHTML = `
      <div class="vc-notify">
        <span class="vc-notify-icon">📖</span>
        <div class="vc-notify-text">
          <div class="vc-notify-title">Verse Detected</div>
          <div class="vc-notify-ref">${escapeHtml(data.scripture)} ${data.chapter}.${data.verse}</div>
        </div>
        <button class="vc-btn vc-btn-view">View</button>
        <button class="vc-btn vc-btn-dismiss" aria-label="Dismiss">✕</button>
      </div>
    `;
    player.appendChild(overlayRoot);

    overlayRoot.querySelector(".vc-btn-dismiss").addEventListener("click", removeOverlay);
    overlayRoot.querySelector(".vc-btn-view").addEventListener("click", () => showPreviewCard(data));
  }

  function showPreviewCard(data) {
    const player = getPlayerContainer();
    if (!player) return;
    removeOverlay();

    overlayRoot = document.createElement("div");
    overlayRoot.className = "vc-root";
    overlayRoot.innerHTML = `
      <div class="vc-card">
        <div class="vc-card-header">
          <div class="vc-card-ref">${escapeHtml(data.scripture)} ${data.chapter}.${data.verse}</div>
          <button class="vc-btn vc-btn-dismiss" aria-label="Close">✕</button>
        </div>
        <div class="vc-card-sanskrit">${escapeHtml(data.sanskrit_text || "")}</div>
        <div class="vc-card-translit">${escapeHtml(data.transliteration || "")}</div>
        <div class="vc-card-translation">${escapeHtml(data.translation || "")}</div>
        <div class="vc-card-actions">
          <a class="vc-link" href="${escapeHtml(data.vedabase_url)}" target="_blank" rel="noopener noreferrer">Read Full Purport</a>
          <button class="vc-btn vc-btn-save">Save</button>
          <button class="vc-btn vc-btn-copy">Copy Reference</button>
        </div>
      </div>
    `;
    player.appendChild(overlayRoot);

    overlayRoot.querySelector(".vc-btn-dismiss").addEventListener("click", removeOverlay);

    const saveBtn = overlayRoot.querySelector(".vc-btn-save");
    saveBtn.addEventListener("click", () => {
      saveVerse(data);
      saveBtn.textContent = "Saved ✓";
      saveBtn.disabled = true;
    });

    overlayRoot.querySelector(".vc-btn-copy").addEventListener("click", () => {
      const ref = `${data.scripture} ${data.chapter}.${data.verse}`;
      navigator.clipboard.writeText(ref).catch(() => {});
      const btn = overlayRoot.querySelector(".vc-btn-copy");
      const original = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { if (btn) btn.textContent = original; }, 1500);
    });
  }

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // ---------- Lifecycle: YouTube is a SPA ----------

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      textBuffer = "";
      lastVerseShownAt = {};
      removeOverlay();
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
