const API_BASE = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "");

if (!API_BASE) {
  throw new Error("VITE_API_BASE_URL is not defined");
}

// ---- Core helper ----
async function fetchJsonOrThrow(res) {
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch (_) {}

  if (!res.ok) {
    const err = new Error("API error");
    err.detail = data?.detail || text;
    throw err;
  }

  return data;
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }

  return res;
}

// ---- Endpoints ----
export async function simulate(payload) {
  const res = await apiFetch("/simulate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function commentaryDraft(payload) {
  const res = await apiFetch("/commentary/draft", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function commentaryRun(payload) {
  const res = await apiFetch("/commentary/run", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function exportExcel(payload) {
  const res = await apiFetch("/export/excel", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    await fetchJsonOrThrow(res);
    return null;
  }

  return res.blob();
}


export async function getConfidenceFactors() {
  const res = await apiFetch("/config/confidence-factors", { method: "GET" });
  return res.json();
}

export async function exportJson(payload) {
  const res = await apiFetch("/export/json", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    await fetchJsonOrThrow(res);
    return null;
  }

  return res.blob();
}
