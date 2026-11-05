function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString();
}

function renderSaved(saved) {
  const panel = document.getElementById("tab-saved");
  if (!saved.length) {
    panel.innerHTML = '<div class="vc-empty">No saved verses yet. Click "Save" on a detected verse while watching a lecture.</div>';
    return;
  }
  panel.innerHTML = saved
    .slice()
    .reverse()
    .map((v, i) => {
      const idx = saved.length - 1 - i;
      return `
        <div class="vc-item" data-index="${idx}">
          <div class="vc-item-ref">${escapeHtml(v.scripture)} ${v.chapter}.${v.verse}</div>
          <div class="vc-item-translation">${escapeHtml(v.translation || "")}</div>
          <div class="vc-item-meta">Saved ${formatTime(v.created_at)}</div>
          <div class="vc-item-actions">
            <a href="${v.vedabase_url}" target="_blank" rel="noopener noreferrer">Open</a>
            <button class="vc-item-remove" data-remove="${idx}">Remove</button>
          </div>
        </div>
      `;
    })
    .join("");

  panel.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const index = Number(btn.getAttribute("data-remove"));
      chrome.storage.local.get({ saved: [] }, ({ saved }) => {
        saved.splice(index, 1);
        chrome.storage.local.set({ saved }, () => renderSaved(saved));
      });
    });
  });
}

function renderHistory(detections) {
  const panel = document.getElementById("tab-history");
  if (!detections.length) {
    panel.innerHTML = '<div class="vc-empty">No detections logged yet. Watch a lecture with captions turned on.</div>';
    return;
  }
  panel.innerHTML = detections
    .slice()
    .reverse()
    .slice(0, 100)
    .map((d) => {
      if (!d.matched) {
        return `
          <div class="vc-item vc-item-nomatch">
            <div class="vc-item-ref">No match (${Math.round(d.confidence * 100)}%)</div>
            <div class="vc-item-meta">${formatTime(d.timestamp)}</div>
          </div>
        `;
      }
      return `
        <div class="vc-item">
          <div class="vc-item-ref">${escapeHtml(d.scripture)} ${d.chapter}.${d.verse} — ${Math.round(d.confidence * 100)}%</div>
          <div class="vc-item-translation">${escapeHtml(d.translation || "")}</div>
          <div class="vc-item-meta">${formatTime(d.timestamp)}</div>
          <div class="vc-item-actions">
            <a href="${d.vedabase_url}" target="_blank" rel="noopener noreferrer">Open</a>
          </div>
        </div>
      `;
    })
    .join("");
}

function loadAll() {
  chrome.storage.local.get({ saved: [], detections: [] }, ({ saved, detections }) => {
    renderSaved(saved);
    renderHistory(detections);
  });
}

document.querySelectorAll(".vc-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".vc-tab").forEach((t) => t.classList.remove("vc-tab-active"));
    document.querySelectorAll(".vc-panel").forEach((p) => p.classList.add("vc-hidden"));
    tab.classList.add("vc-tab-active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.remove("vc-hidden");
  });
});

// ---------- Listen tab ----------

const statusEl = document.getElementById("listen-status");
const STATUS_TEXT = {
  listening: "🎙 Listening to this tab…",
  transcribing: "🎙 Recognising speech…",
  stopped: "Not listening",
  error: "Error"
};

function refreshStatus() {
  chrome.storage.session.get({ listenStatus: "stopped", listenError: "", listeningTabId: null }, (s) => {
    if (!s.listeningTabId && s.listenStatus !== "error") {
      statusEl.textContent = STATUS_TEXT.stopped;
      return;
    }
    statusEl.textContent = s.listenStatus === "error"
      ? `Error: ${s.listenError}`
      : STATUS_TEXT[s.listenStatus] || s.listenStatus;
  });
}

document.getElementById("btn-start").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/youtube\.com/.test(tab.url || "")) {
    statusEl.textContent = "Open a YouTube video tab first.";
    return;
  }
  try {
    // Release any capture a previous session left behind; a stuck one causes
    // "Cannot capture a tab with an active stream".
    await new Promise((resolve) => chrome.runtime.sendMessage({ type: "STOP_LISTENING" }, () => { void chrome.runtime.lastError; resolve(); }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Must be requested here, from the popup, so Chrome treats it as a user gesture.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    chrome.runtime.sendMessage({ type: "START_LISTENING", tabId: tab.id, streamId }, (res) => {
      if (!res || !res.ok) statusEl.textContent = `Error: ${(res && res.error) || "could not start"}`;
      else statusEl.textContent = "Starting…";
    });
  } catch (err) {
    statusEl.textContent = /active stream/i.test(err.message)
      ? "Another capture still holds this tab. Close this YouTube tab, reopen the video in a new tab, and try again. Make sure only one Vedabase Companion is installed."
      : `Error: ${err.message}`;
  }
});

document.getElementById("btn-stop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_LISTENING" }, () => {
    statusEl.textContent = STATUS_TEXT.stopped;
  });
});

chrome.storage.local.get({ backendUrl: "http://127.0.0.1:8000", language: "hi", prompt: "" }, (s) => {
  document.getElementById("backend-url").value = s.backendUrl.replace("//localhost", "//127.0.0.1");
  checkBackend();
  document.getElementById("language").value = s.language;
  document.getElementById("prompt").value = s.prompt;
});

document.getElementById("btn-save-settings").addEventListener("click", () => {
  chrome.storage.local.set({
    backendUrl: document.getElementById("backend-url").value.trim().replace(/\/+$/, "") || "http://127.0.0.1:8000",
    language: document.getElementById("language").value,
    prompt: document.getElementById("prompt").value.trim()
  }, () => {
    const msg = document.getElementById("settings-msg");
    msg.textContent = "Saved ✓";
    setTimeout(() => { msg.textContent = ""; }, 1500);
  });
});

chrome.storage.onChanged.addListener(refreshStatus);
refreshStatus();
loadAll();


// Shows whether the backend is reachable and ready, so a failure is never silent.
async function checkBackend() {
  const el = document.getElementById("backend-status");
  const url = document.getElementById("backend-url").value.trim().replace(/\/+$/, "").replace("//localhost", "//127.0.0.1");
  el.textContent = "Checking backend…";
  try {
    const res = await fetch(`${url}/health`);
    const h = await res.json();
    el.textContent = h.speech_ready
      ? `✓ Backend connected · ${h.verses_loaded} verses · speech ready`
      : `Backend connected, but speech is NOT configured on the server (set GROQ_API_KEY and restart it).`;
  } catch (_) {
    el.textContent = `✗ Cannot reach ${url}. Start the backend server, or fix the URL and press Save settings.`;
  }
}
document.getElementById("btn-save-settings").addEventListener("click", () => setTimeout(checkBackend, 300));
