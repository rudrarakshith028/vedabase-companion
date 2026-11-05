// Vedabase Companion — background service worker
// 1. Calls the verse-detection API.
// 2. Starts/stops tab-audio listening (via an offscreen document) and relays
//    transcripts + status to the YouTube tab's content script.

const DEFAULT_BACKEND = "http://127.0.0.1:8000";
const DEBUG = true;

async function getApiBase() {
  const { backendUrl } = await chrome.storage.local.get({ backendUrl: DEFAULT_BACKEND });
  // "localhost" can resolve to IPv6 on Windows while the server listens on IPv4 only.
  return (backendUrl || DEFAULT_BACKEND).replace(/\/+$/, "").replace("//localhost", "//127.0.0.1");
}

function dlog(...args) {
  if (DEBUG) console.log("[Vedabase Companion / background]", ...args);
}

async function detectVerse(text) {
  const detectUrl = `${await getApiBase()}/api/public/detect`;
  dlog("calling", detectUrl, "with text:", JSON.stringify(text));
  let res;
  try {
    res = await fetch(detectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
  } catch (networkErr) {
    throw new Error(`Network error reaching backend: ${networkErr.message}`);
  }
  if (!res.ok) {
    let errBody = null;
    try { errBody = await res.json(); } catch (_) {}
    const detail = errBody && errBody.error && (errBody.error.message || errBody.error);
    throw new Error(typeof detail === "string" ? detail : `Request failed (${res.status})`);
  }
  return res.json();
}

// ---------- Offscreen audio capture ----------

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture the tab's audio to recognise spoken Sanskrit verses."
  });
}

async function startListening({ tabId, streamId }) {
  const { language, prompt } = await chrome.storage.local.get({ language: "hi", prompt: "" });
  const apiBase = await getApiBase();
  await ensureOffscreen();
  await chrome.storage.session.set({ listeningTabId: tabId });
  chrome.runtime.sendMessage({
    target: "offscreen", type: "OFFSCREEN_START", streamId, tabId, apiBase, language, prompt
  });
}

async function stopListening() {
  await chrome.storage.session.remove("listeningTabId");
  chrome.runtime.sendMessage({ target: "offscreen", type: "OFFSCREEN_STOP" }).catch(() => {});
  // Closing the offscreen document releases the tab-capture stream even if it got stuck.
  try { await chrome.offscreen.closeDocument(); } catch (_) {}
}

function toTab(tabId, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === "offscreen") return false;

  switch (message.type) {
    case "DETECT_VERSE":
      detectVerse(message.text)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "START_LISTENING":
      startListening(message)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "STOP_LISTENING":
      stopListening().then(() => sendResponse({ ok: true }));
      return true;

    case "STT_TEXT":
      toTab(message.tabId, { type: "TRANSCRIPT", text: message.text });
      return false;

    case "STT_STATUS":
      toTab(message.tabId, { type: "LISTEN_STATUS", status: message.status, error: message.error });
      chrome.storage.session.set({ listenStatus: message.status, listenError: message.error || "" });
      return false;
  }
  return false;
});

// Stop if the listened tab is closed.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { listeningTabId } = await chrome.storage.session.get("listeningTabId");
  if (listeningTabId === tabId) stopListening();
});
