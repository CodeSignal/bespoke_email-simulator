/**
 * CosmoMail — app.js (frontend entry, bundled by esbuild).
 *
 * Stage 1: boots the static shell and confirms the backend is reachable.
 * Later stages add scenario loading, thread rendering, the TipTap composer,
 * and the Cosmo assistant.
 */

const els = {
  bootError: document.getElementById('bootError'),
};

function showBootError(message) {
  if (!els.bootError) return;
  els.bootError.textContent = message;
  els.bootError.hidden = false;
}

async function boot() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error(`health check failed (${res.status})`);
    const data = await res.json();
    console.log('[CosmoMail] backend healthy:', data);
  } catch (err) {
    console.error('[CosmoMail] boot error:', err);
    showBootError('Could not reach the CosmoMail server. Is it running?');
  }
}

boot();
