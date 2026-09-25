import { classifyApiKey } from "./src/core/worker-auth.js";
import { normalizeWorkerSettings } from "./src/core/worker-config.js";

const els = {
  form: document.getElementById("form"),
  enabled: document.getElementById("enabled"),
  backendUrl: document.getElementById("backendUrl"),
  anonKey: document.getElementById("anonKey"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  laneName: document.getElementById("laneName"),
  pollSeconds: document.getElementById("pollSeconds"),
  leaseSeconds: document.getElementById("leaseSeconds"),
  paceMin: document.getElementById("paceMin"),
  paceMax: document.getElementById("paceMax"),
  keyMin: document.getElementById("keyMin"),
  keyMax: document.getElementById("keyMax"),
  backoff: document.getElementById("backoff"),
  betweenMin: document.getElementById("betweenMin"),
  betweenMax: document.getElementById("betweenMax"),
  jobsPerHour: document.getElementById("jobsPerHour"),
  heartbeat: document.getElementById("heartbeat"),
  realtime: document.getElementById("realtime"),
  health: document.getElementById("health"),
  msg: document.getElementById("msg"),
  lane: document.getElementById("lane"),
};

function send(action, input = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, input }, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || { ok: false, error: "no response" });
    });
  });
}

function show(text, kind) {
  els.msg.textContent = text;
  els.msg.className = `msg ${kind || ""}`;
}

const KEY_ERRORS = {
  secret_key_rejected: "That is an sb_secret_ key. Paste the publishable or anon key instead.",
  service_role_rejected: "That is a service_role key. Paste the publishable or anon key instead.",
  missing_anon_key: "Paste the publishable or anon key.",
  invalid_api_key: "That key is not a publishable key or an anon JWT.",
};

function settingsFromForm() {
  return {
    workerEnabled: els.enabled.checked,
    workerBackendUrl: els.backendUrl.value.trim(),
    workerAnonKey: els.anonKey.value.trim(),
    workerEmail: els.email.value.trim(),
    workerLaneName: els.laneName.value.trim(),
    workerPollSeconds: Number(els.pollSeconds.value),
    workerLeaseSeconds: Number(els.leaseSeconds.value),
    workerPaceMinMs: Number(els.paceMin.value),
    workerPaceMaxMs: Number(els.paceMax.value),
    workerKeystrokeMinMs: Number(els.keyMin.value),
    workerKeystrokeMaxMs: Number(els.keyMax.value),
    workerBlockBackoffMin: Number(els.backoff.value),
    workerBetweenJobsMinMs: Number(els.betweenMin.value) * 1000,
    workerBetweenJobsMaxMs: Number(els.betweenMax.value) * 1000,
    workerJobsPerHour: Number(els.jobsPerHour.value),
    workerHeartbeatSeconds: Number(els.heartbeat.value),
    workerRealtime: els.realtime.checked,
  };
}

function fill(settings) {
  els.enabled.checked = settings.workerEnabled === true;
  els.backendUrl.value = settings.workerBackendUrl || "";
  els.anonKey.value = settings.workerAnonKey || "";
  els.email.value = settings.workerEmail || "";
  els.password.value = "";
  els.laneName.value = settings.workerLaneName || "";
  els.pollSeconds.value = settings.workerPollSeconds ?? 20;
  els.leaseSeconds.value = settings.workerLeaseSeconds ?? 180;
  els.paceMin.value = settings.workerPaceMinMs ?? 4000;
  els.paceMax.value = settings.workerPaceMaxMs ?? 9000;
  els.keyMin.value = settings.workerKeystrokeMinMs ?? 40;
  els.keyMax.value = settings.workerKeystrokeMaxMs ?? 140;
  els.backoff.value = settings.workerBlockBackoffMin ?? 30;
  els.betweenMin.value = Math.round((settings.workerBetweenJobsMinMs ?? 20000) / 1000);
  els.betweenMax.value = Math.round((settings.workerBetweenJobsMaxMs ?? 60000) / 1000);
  els.jobsPerHour.value = settings.workerJobsPerHour ?? 30;
  els.heartbeat.value = settings.workerHeartbeatSeconds ?? 30;
  els.realtime.checked = settings.workerRealtime !== false;
}

async function refreshLane() {
  const response = await send("worker.session");
  const lane = response?.ok ? response.result : null;
  els.lane.textContent = lane && lane.status
    ? JSON.stringify(lane, null, 2)
    : "No lane state yet. Enable worker mode and leave this Chrome window visible.";
}

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = settingsFromForm();
  const key = classifyApiKey(settings.workerAnonKey);
  if (settings.workerAnonKey && !key.ok) {
    show(KEY_ERRORS[key.error] || key.error, "error");
    return;
  }
  const cfg = normalizeWorkerSettings(settings);
  if (settings.workerEnabled && !cfg.ready) {
    show(KEY_ERRORS[cfg.configError] || cfg.configError || "Check the backend URL, key, and lane name.", "error");
    return;
  }
  const password = els.password.value;
  if (settings.workerEnabled && !password && !loadedSignedIn) {
    show("Enter the lane email and password to sign in.", "error");
    return;
  }
  if (settings.workerEnabled && cfg.hostPermission) {
    const granted = await chrome.permissions.request({ origins: [cfg.hostPermission] });
    if (!granted) {
      show("Chrome did not grant permission to reach that backend.", "error");
      return;
    }
  }
  const saved = await send("settings.save", { settings });
  if (!saved.ok) {
    show(saved.error || "Could not save.", "error");
    return;
  }
  if (password) {
    const auth = await send("worker.signIn", { email: settings.workerEmail, password });
    els.password.value = "";
    if (!auth.ok || auth.result?.ok === false) {
      show(auth.result?.error || auth.error || "Sign-in failed.", "error");
      return;
    }
    loadedSignedIn = true;
  }
  show(settings.workerEnabled ? "Worker mode is on. Keep this window visible." : "Saved. Worker mode is off.", "ok");
  await refreshLane();
});

els.health.addEventListener("click", async () => {
  const response = await send("worker.health");
  if (!response.ok || response.result?.ok === false) {
    show(response.error || response.result?.error || "Health check failed.", "error");
    return;
  }
  const role = response.result?.role || "operator";
  const lane = response.result?.lane_name ? ` (${response.result.lane_name})` : "";
  show(`Signed in as ${role}${lane}.`, "ok");
  els.lane.textContent = JSON.stringify(response.result, null, 2);
});

let loadedSignedIn = false;
const loaded = await send("settings.get");
if (loaded.ok) {
  fill(loaded.result || {});
  loadedSignedIn = loaded.result?.workerSignedIn === true;
}
await refreshLane();
setInterval(refreshLane, 2000);
