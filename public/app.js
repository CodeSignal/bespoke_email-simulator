/**
 * CosmoMail — app.js (frontend entry, bundled by esbuild).
 *
 * Stage 3: load the scenario + session and render the thread rail and reading
 * pane (emails rendered from Markdown). Composer (TipTap) and the Cosmo
 * assistant are wired in later stages.
 */

import { marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/core';
import plaintext from 'highlight.js/lib/languages/plaintext';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';

hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('markdown', markdown);

marked.use(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    },
  }),
);

// ── State ─────────────────────────────────────────────────────
const state = {
  config: null,
  scenario: null,
  session: null,
  activeThreadId: null,
};

// ── DOM ───────────────────────────────────────────────────────
const els = {
  bootError: document.getElementById('bootError'),
  appTitle: document.getElementById('appTitle'),
  scenarioHeading: document.getElementById('scenarioHeading'),
  scenarioBrief: document.getElementById('scenarioBrief'),
  threadList: document.getElementById('threadList'),
  threadListEmpty: document.getElementById('threadListEmpty'),
  readingPane: document.getElementById('readingPane'),
  readingEmpty: document.getElementById('readingEmpty'),
  assistantHint: document.getElementById('assistantHint'),
};

// ── Helpers ───────────────────────────────────────────────────
function showBootError(message) {
  if (!els.bootError) return;
  els.bootError.textContent = message;
  els.bootError.hidden = false;
}

// Resolve a UI string through the config's resolved strings map, falling back to
// the original English text.
function t(key) {
  return state.config?.strings?.[key] ?? key;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdown(md) {
  return marked.parse(String(md ?? ''), { breaks: true });
}

function formatAddress(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
}

function formatAddressList(list) {
  if (!Array.isArray(list)) return formatAddress(list);
  return list.map(formatAddress).join(', ');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function threadPreview(thread) {
  const last = thread.emails?.[thread.emails.length - 1];
  const from = last ? formatAddress(last.from) : '';
  return from;
}

// ── Rendering ─────────────────────────────────────────────────
function renderThreadRail() {
  const threads = state.session?.threads ?? [];
  els.threadList.querySelectorAll('.rail__thread').forEach((n) => n.remove());

  if (!threads.length) {
    els.threadListEmpty.hidden = false;
    els.threadListEmpty.textContent = t('No threads yet.');
    return;
  }
  els.threadListEmpty.hidden = true;

  for (const thread of threads) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rail__thread' + (thread.id === state.activeThreadId ? ' is-active' : '');
    btn.dataset.threadId = thread.id;
    btn.innerHTML = `
      <span class="body-small rail__thread-subject">${escapeHtml(thread.subject || '(no subject)')}</span>
      <span class="body-xsmall rail__thread-preview">${escapeHtml(threadPreview(thread))}</span>
      <span class="body-xxsmall rail__thread-preview">${thread.emails?.length ?? 0} message(s)</span>
    `;
    btn.addEventListener('click', () => selectThread(thread.id));
    els.threadList.appendChild(btn);
  }
}

function renderEmail(email, learnerEmail) {
  const isOutbound =
    email.outbound === true ||
    (learnerEmail && formatAddress(email.from).includes(learnerEmail));
  const wrap = document.createElement('article');
  wrap.className = 'email' + (isOutbound ? ' email--outbound' : '');
  const toLine = formatAddressList(email.to);
  const ccLine = email.cc && email.cc.length ? `<div class="body-xsmall email__to">Cc: ${escapeHtml(formatAddressList(email.cc))}</div>` : '';
  wrap.innerHTML = `
    <div class="email__meta">
      <div>
        <div class="body-small email__from">${escapeHtml(formatAddress(email.from))}</div>
        <div class="body-xsmall email__to">To: ${escapeHtml(toLine)}</div>
        ${ccLine}
      </div>
      <div class="body-xsmall email__date">${escapeHtml(formatDate(email.date))}</div>
    </div>
    <div class="email__body">${renderMarkdown(email.body)}</div>
  `;
  return wrap;
}

function renderThread(threadId) {
  const threads = state.session?.threads ?? [];
  const thread = threads.find((th) => th.id === threadId) ?? threads[0];
  const learnerEmail = state.config?.learner?.email;

  els.readingPane.innerHTML = '';
  if (!thread) {
    const empty = document.createElement('div');
    empty.className = 'reading-pane__empty';
    empty.innerHTML = `<p class="body-medium">${escapeHtml(t('Select a thread to get started.'))}</p>`;
    els.readingPane.appendChild(empty);
    return;
  }
  for (const email of thread.emails ?? []) {
    els.readingPane.appendChild(renderEmail(email, learnerEmail));
  }
}

function selectThread(threadId) {
  state.activeThreadId = threadId;
  renderThreadRail();
  renderThread(threadId);
}

function applyScenarioChrome() {
  const title = state.config?.title || 'CosmoMail';
  document.title = title;
  if (els.appTitle) els.appTitle.textContent = title;
  if (els.scenarioHeading) els.scenarioHeading.textContent = state.config?.ui?.heading || title;
  if (els.scenarioBrief) els.scenarioBrief.textContent = state.scenario?.brief || '';
  if (els.assistantHint && state.config?.assistant?.initialMessage) {
    els.assistantHint.textContent = state.config.assistant.initialMessage;
  }
}

// ── Boot ──────────────────────────────────────────────────────
async function boot() {
  try {
    const [configRes, scenarioRes, sessionRes] = await Promise.all([
      fetch('/api/config'),
      fetch('/api/scenario'),
      fetch('/api/session'),
    ]);
    if (!configRes.ok || !scenarioRes.ok || !sessionRes.ok) {
      throw new Error('failed to load initial data');
    }
    state.config = await configRes.json();
    state.scenario = await scenarioRes.json();
    state.session = await sessionRes.json();

    state.activeThreadId =
      state.scenario.activeThreadId ||
      state.session.threads?.[0]?.id ||
      null;

    applyScenarioChrome();
    renderThreadRail();
    renderThread(state.activeThreadId);
  } catch (err) {
    console.error('[CosmoMail] boot error:', err);
    showBootError('Could not load CosmoMail. Is the server running?');
  }
}

boot();
