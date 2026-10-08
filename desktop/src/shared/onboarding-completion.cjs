function buildSetupCompleteUrl(serverPort) {
  if (!serverPort) throw new Error("Server is not ready");
  return `http://127.0.0.1:${serverPort}/api/preferences/setup-complete`;
}

async function parseSetupCompleteError(res) {
  try {
    const body = await res.json();
    if (body?.error) return String(body.error);
  } catch {}
  return `setup completion failed with HTTP ${res.status}`;
}

async function submitOnboardingCompleteIntent({
  serverPort,
  serverToken,
  mode,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!serverToken) throw new Error("Server is not ready");
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");

  if (mode !== undefined && mode !== 'ai' && mode !== 'files-only') throw new Error('Invalid setup mode');
  const res = await fetchImpl(buildSetupCompleteUrl(serverPort), {
    method: "POST",
    headers: { Authorization: `Bearer ${serverToken}`, ...(mode ? { 'Content-Type': 'application/json' } : {}) },
    ...(mode ? { body: JSON.stringify({ mode }) } : {}),
  });
  if (!res.ok) {
    throw new Error(await parseSetupCompleteError(res));
  }

  const body = await res.json();
  if (body?.ok !== true || body?.setupComplete !== true) {
    throw new Error("setup completion was not persisted");
  }
  return body;
}

async function completeOnboardingAndOpenMain({
  serverPort,
  serverToken,
  mode,
  createMainWindow,
  fetchImpl = globalThis.fetch,
} = {}) {
  await submitOnboardingCompleteIntent({ serverPort, serverToken, mode, fetchImpl });
  if (typeof createMainWindow !== "function") {
    throw new Error("createMainWindow is not available");
  }
  createMainWindow();
}

module.exports = {
  completeOnboardingAndOpenMain,
  submitOnboardingCompleteIntent,
};
