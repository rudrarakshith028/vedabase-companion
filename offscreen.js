// Offscreen document: captures the tab's audio, cuts it into short clips,
// sends each clip to the speech-to-text API and reports the text back.
// (Offscreen documents only have chrome.runtime, so settings arrive in the start message.)

const CHUNK_MS = 8000;          // length of each audio clip
const SILENCE_RMS = 0.008;      // clips quieter than this are skipped (saves API cost)

let stream = null;
let audioCtx = null;
let analyser = null;
let running = false;
let session = null; // { tabId, apiBase, language, prompt }

function report(type, payload) {
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
}

async function start({ streamId, tabId, apiBase, language, prompt }) {
  await stop();
  session = { tabId, apiBase, language, prompt };

  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false
  });

  // Capturing a tab mutes it for the user — route the audio back to the speakers.
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  source.connect(audioCtx.destination);

  running = true;
  report("STT_STATUS", { tabId, status: "listening" });
  recordLoop();
}

async function stop() {
  running = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (audioCtx) { try { await audioCtx.close(); } catch (_) {} }
  audioCtx = null;
  analyser = null;
  if (session) report("STT_STATUS", { tabId: session.tabId, status: "stopped" });
  session = null;
}

function currentRms() {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

// Each clip uses its own MediaRecorder so every blob is a complete, decodable file.
async function recordLoop() {
  while (running && stream) {
    const clip = await recordOneClip();
    if (!running || !clip) continue;
    transcribe(clip.blob, session).catch((err) => {
      report("STT_STATUS", { tabId: session && session.tabId, status: "error", error: err.message });
    });
  }
}

function recordOneClip() {
  return new Promise((resolve) => {
    const chunks = [];
    let loud = 0;
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    const meter = setInterval(() => { if (analyser && currentRms() > SILENCE_RMS) loud++; }, 250);

    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      clearInterval(meter);
      const heardSomething = loud >= 2;
      resolve(heardSomething && chunks.length ? { blob: new Blob(chunks, { type: "audio/webm" }) } : null);
    };
    recorder.start();
    setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); }, CHUNK_MS);
  });
}

async function transcribe(blob, s) {
  if (!s) return;
  const form = new FormData();
  form.append("file", blob, "clip.webm");
  if (s.language) form.append("language", s.language);
  if (s.prompt) form.append("prompt", s.prompt);

  report("STT_STATUS", { tabId: s.tabId, status: "transcribing" });
  // Engine 1 on the backend: audio clip -> text (the speech API key lives on the server)
  const res = await fetch(`${s.apiBase}/api/transcribe`, { method: "POST", body: form });
  if (!res.ok) {
    let msg = `Backend error ${res.status}`;
    try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch (_) {}
    throw new Error(msg);
  }
  const data = await res.json();
  const text = (data.text || "").trim();
  report("STT_STATUS", { tabId: s.tabId, status: "listening" });
  if (text) report("STT_TEXT", { tabId: s.tabId, text });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "OFFSCREEN_START") {
    start(msg).catch((err) => report("STT_STATUS", { tabId: msg.tabId, status: "error", error: err.message }));
  } else if (msg.type === "OFFSCREEN_STOP") {
    stop();
  }
});
