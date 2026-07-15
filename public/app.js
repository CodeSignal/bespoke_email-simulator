/**
 * CosmoMail — app.js (frontend entry, bundled by esbuild).
 *
 * Stage 3: load the scenario + session and render the thread rail and reading
 * pane (emails rendered from Markdown). Composer (TipTap) and the Cosmo
 * assistant are wired in later stages.
 */

import { OctavusChat, createHttpTransport } from '@octavus/client-sdk';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
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
  editor: null,
  draftSaveTimer: null,
  assistant: {
    chat: null,
    unsubscribe: null,
    octavusSessionId: null,
    persisted: [],
    lastInsertable: null,
  },
  recipient: {
    octavusSessionId: null,
  },
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
  composeTo: document.getElementById('composeTo'),
  composeCc: document.getElementById('composeCc'),
  composeSubject: document.getElementById('composeSubject'),
  composerBody: document.getElementById('composerBody'),
  composerPlaceholder: document.getElementById('composerPlaceholder'),
  sendBtn: document.getElementById('sendBtn'),
  submitBtn: document.getElementById('submitBtn'),
  submitStatus: document.getElementById('submitStatus'),
  assistantMessages: document.getElementById('assistantMessages'),
  assistantInput: document.getElementById('assistantInput'),
  assistantSendBtn: document.getElementById('assistantSendBtn'),
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
  const isSubmitted = state.session?.selectedSubmission?.email_id === email.id;
  const wrap = document.createElement('article');
  wrap.className = 'email' + (isOutbound ? ' email--outbound' : '') + (isSubmitted ? ' email--submitted' : '');
  const toLine = formatAddressList(email.to);
  const ccLine = email.cc && email.cc.length ? `<div class="body-xsmall email__to">Cc: ${escapeHtml(formatAddressList(email.cc))}</div>` : '';
  const submittedBadge = isSubmitted ? '<span class="tag success email__badge">Submitted</span>' : '';
  wrap.innerHTML = `
    <div class="email__meta">
      <div>
        <div class="body-small email__from">${escapeHtml(formatAddress(email.from))}</div>
        <div class="body-xsmall email__to">To: ${escapeHtml(toLine)}</div>
        ${ccLine}
      </div>
      <div class="email__meta-right">
        ${submittedBadge}
        <div class="body-xsmall email__date">${escapeHtml(formatDate(email.date))}</div>
      </div>
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

// ── Composer (TipTap, Markdown-native) ────────────────────────
function getEditorMarkdown() {
  if (!state.editor) return '';
  if (typeof state.editor.getMarkdown === 'function') return state.editor.getMarkdown();
  // Fallback for markdown-extension variants that expose storage helpers.
  return state.editor.storage?.markdown?.getMarkdown?.() ?? '';
}

function setEditorMarkdown(md) {
  if (!state.editor) return;
  state.editor.commands.setContent(String(md ?? ''), { contentType: 'markdown' });
}

// Determines the starting To/Cc/Subject/body for the composer: a saved draft
// wins, then the scenario's initialDraft, then a reply prefill derived from the
// focused email for reply/reply_chain scenarios.
function computeInitialDraft() {
  const saved = state.session?.drafts?.[0];
  if (saved) return saved;

  const initial = state.config?.initialDraft;
  const base = { to: [], cc: [], subject: '', body: '' };

  const type = state.config?.scenarioType;
  if (type === 'reply' || type === 'reply_chain') {
    const thread = state.session?.threads?.find((t) => t.id === state.activeThreadId);
    const focusedId = state.scenario?.focusedEmailId;
    const emails = thread?.emails ?? [];
    const focused = emails.find((e) => e.id === focusedId) ?? emails[emails.length - 1];
    if (focused) {
      base.to = [focused.from?.email].filter(Boolean);
      const subj = focused.subject || thread?.subject || '';
      base.subject = /^re:/i.test(subj) ? subj : `Re: ${subj}`;
    }
  }

  return {
    to: initial?.to?.length ? initial.to : base.to,
    cc: initial?.cc?.length ? initial.cc : base.cc,
    subject: initial?.subject || base.subject,
    body: initial?.body || base.body,
  };
}

function currentDraft() {
  return {
    to: (els.composeTo.value || '').split(',').map((s) => s.trim()).filter(Boolean),
    cc: (els.composeCc.value || '').split(',').map((s) => s.trim()).filter(Boolean),
    subject: els.composeSubject.value || '',
    body: getEditorMarkdown(),
    updated_at: new Date().toISOString(),
  };
}

function updateSendEnabled() {
  const draft = currentDraft();
  const hasContent = draft.body.trim().length > 0 || draft.subject.trim().length > 0;
  els.sendBtn.disabled = !hasContent;
}

async function saveDraftNow() {
  if (!state.session?.sessionId) return;
  const draft = currentDraft();
  state.session.drafts = [draft];
  try {
    await fetch('/api/session/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.session.sessionId, drafts: [draft] }),
    });
  } catch (err) {
    console.error('[CosmoMail] draft save failed:', err);
  }
}

function scheduleDraftSave() {
  updateSendEnabled();
  clearTimeout(state.draftSaveTimer);
  state.draftSaveTimer = setTimeout(saveDraftNow, 600);
}

function initComposer() {
  const draft = computeInitialDraft();
  els.composeTo.value = (draft.to || []).join(', ');
  els.composeCc.value = (draft.cc || []).join(', ');
  els.composeSubject.value = draft.subject || '';

  if (els.composerPlaceholder) els.composerPlaceholder.remove();

  state.editor = new Editor({
    element: els.composerBody,
    extensions: [StarterKit, Markdown],
    content: draft.body || '',
    contentType: 'markdown',
    onUpdate: scheduleDraftSave,
  });

  for (const input of [els.composeTo, els.composeCc, els.composeSubject]) {
    input.addEventListener('input', scheduleDraftSave);
  }
  els.sendBtn.addEventListener('click', sendEmail);
  updateSendEnabled();
}

// ── Submission ────────────────────────────────────────────────
function hasAnySend() {
  return (state.session?.threads ?? []).some((th) => (th.emails ?? []).some((e) => e.outbound));
}

function maxSubmissions() {
  return state.config?.submission?.maxSubmissions ?? 1;
}

function submissionsRemaining() {
  return Math.max(0, maxSubmissions() - (state.session?.submissionCount ?? 0));
}

function updateSubmissionUI() {
  if (!els.submitBtn) return;
  els.submitBtn.hidden = false;
  els.submitBtn.textContent = state.config?.submission?.label || t('Submit final email');
  const remaining = submissionsRemaining();
  els.submitBtn.disabled = !hasAnySend() || remaining <= 0;

  const submitted = state.session?.selectedSubmission;
  if (submitted) {
    els.submitStatus.hidden = false;
    els.submitStatus.textContent =
      remaining > 0 ? `Submitted · ${remaining} change(s) left` : 'Submitted · final';
  } else {
    els.submitStatus.hidden = true;
  }
}

async function submitEmail() {
  if (els.submitBtn.disabled) return;
  els.submitBtn.disabled = true;
  try {
    const res = await fetch('/api/submission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.session.sessionId }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.warn('[CosmoMail] submission rejected:', data.error);
      if (data.selectedSubmission) state.session.selectedSubmission = data.selectedSubmission;
      return;
    }
    state.session.selectedSubmission = data.selectedSubmission;
    state.session.submissionCount = (state.session.submissionCount ?? 0) + 1;
    renderThread(state.activeThreadId);
  } catch (err) {
    console.error('[CosmoMail] submit failed:', err);
  } finally {
    updateSubmissionUI();
  }
}

function initSubmission() {
  els.submitBtn.addEventListener('click', submitEmail);
  updateSubmissionUI();
}

// ── Send flow & simulated recipient ───────────────────────────
function replaceThread(thread) {
  const threads = state.session.threads ?? (state.session.threads = []);
  const idx = threads.findIndex((t) => t.id === thread.id);
  if (idx >= 0) threads[idx] = thread;
  else threads.push(thread);
}

function appendPendingRecipientEmail() {
  const article = document.createElement('article');
  article.className = 'email';
  article.innerHTML = `
    <div class="email__meta">
      <div><div class="body-small email__from">Awaiting reply…</div></div>
    </div>
    <div class="email__body"><span class="assistant__typing">…</span></div>
  `;
  els.readingPane.appendChild(article);
  els.readingPane.scrollTop = els.readingPane.scrollHeight;
  return article;
}

async function sendEmail() {
  if (els.sendBtn.disabled) return;
  const draft = currentDraft();
  if (!draft.body.trim() && !draft.subject.trim()) return;

  els.sendBtn.disabled = true;
  els.sendBtn.textContent = 'Sending…';
  try {
    const res = await fetch('/api/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.session.sessionId,
        threadId: state.activeThreadId,
        to: draft.to,
        cc: draft.cc,
        subject: draft.subject,
        body: draft.body,
      }),
    });
    if (!res.ok) throw new Error(`send failed (${res.status})`);
    const { email, thread, recipient } = await res.json();

    replaceThread(thread);
    state.activeThreadId = thread.id;
    state.session.drafts = [];
    setEditorMarkdown('');
    renderThreadRail();
    renderThread(state.activeThreadId);
    updateSubmissionUI();

    if (recipient?.allowed) {
      await runRecipientReply(email.body, thread.id, recipient.behavior);
    }
  } catch (err) {
    console.error('[CosmoMail] send failed:', err);
  } finally {
    els.sendBtn.textContent = t('Send');
    updateSendEnabled();
  }
}

async function finalizeRecipient(threadId, replyText) {
  const res = await fetch('/api/recipient/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: state.session.sessionId, threadId, reply: replyText }),
  });
  if (!res.ok) return;
  const { thread } = await res.json();
  replaceThread(thread);
  renderThreadRail();
  renderThread(state.activeThreadId);
}

async function runRecipientReply(sentBody, threadId, behavior) {
  // Scripted replies come straight from the author's beats (no LLM).
  if (behavior === 'scripted') {
    appendPendingRecipientEmail();
    await finalizeRecipient(threadId, '');
    return;
  }

  // Ensure the recipient Octavus session exists.
  if (!state.recipient.octavusSessionId) {
    try {
      const r = await fetch('/api/recipient/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.session.sessionId }),
      });
      if (!r.ok) throw new Error(`recipient session failed (${r.status})`);
      state.recipient.octavusSessionId = (await r.json()).recipientOctavusSessionId;
    } catch (err) {
      console.error('[CosmoMail] recipient unavailable:', err);
      return;
    }
  }

  const placeholder = appendPendingRecipientEmail();
  const bodyEl = placeholder.querySelector('.email__body');

  const transport = createHttpTransport({
    request: (payload) =>
      fetch('/api/recipient/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.recipient.octavusSessionId, ...payload }),
      }),
  });
  const chat = new OctavusChat({ transport });
  const unsub = chat.subscribe(() => {
    const text = assistantTextFromMessages(chat.messages);
    bodyEl.innerHTML = renderMarkdown(text) || '<span class="assistant__typing">…</span>';
    els.readingPane.scrollTop = els.readingPane.scrollHeight;
  });

  try {
    await chat.send(
      'recipient-reply',
      { LEARNER_EMAIL: sentBody, THREAD_CONTEXT: serializeThreadContext() },
      { userMessage: { content: sentBody } },
    );
  } catch (err) {
    console.error('[CosmoMail] recipient reply failed:', err);
  } finally {
    unsub();
  }

  const replyText = assistantTextFromMessages(chat.messages);
  await finalizeRecipient(threadId, replyText);
}

// ── Assistant (Cosmo) ─────────────────────────────────────────
// Serializes the active thread into Markdown context for the agent.
function serializeThreadContext() {
  const threads = state.session?.threads ?? [];
  const thread = threads.find((th) => th.id === state.activeThreadId) ?? threads[0];
  if (!thread) return 'No emails in the current mailbox.';
  const lines = [`Subject: ${thread.subject || '(no subject)'}`, ''];
  for (const email of thread.emails ?? []) {
    lines.push(`From: ${formatAddress(email.from)}`);
    lines.push(`To: ${formatAddressList(email.to)}`);
    if (email.cc?.length) lines.push(`Cc: ${formatAddressList(email.cc)}`);
    if (email.date) lines.push(`Date: ${formatDate(email.date)}`);
    lines.push('');
    lines.push(String(email.body ?? ''));
    lines.push('\n---\n');
  }
  return lines.join('\n');
}

function customInstructionsValue() {
  const allow = state.config?.assistant?.allowCustomInstructions;
  const ci = state.config?.customInstructions || state.config?.assistant?.customInstructions;
  return allow && ci ? ci : 'NO CUSTOM INSTRUCTIONS';
}

function assistantTextFromMessages(messages) {
  // Return the latest assistant message's concatenated text parts (live turn).
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      return (messages[i].parts ?? [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
    }
  }
  return '';
}

// Extract the last fenced code block (a ready-to-send email) from Markdown.
function extractLastCodeBlock(md) {
  const matches = [...String(md ?? '').matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)];
  if (!matches.length) return null;
  return matches[matches.length - 1][1].trim();
}

function makeBubble(role, contentHtml) {
  const div = document.createElement('div');
  div.className = `assistant__msg assistant__msg--${role === 'user' ? 'user' : 'ai'}`;
  div.innerHTML = contentHtml;
  return div;
}

function renderAssistant(liveMessages = []) {
  const container = els.assistantMessages;
  container.innerHTML = '';

  const persisted = state.assistant.persisted;
  const hasAny = persisted.length > 0 || liveMessages.length > 0;
  if (!hasAny) {
    const hint = document.createElement('p');
    hint.className = 'body-xsmall assistant__hint';
    hint.textContent = state.config?.assistant?.initialMessage
      || t('Ask Cosmo to help draft, summarize, or answer questions about this thread.');
    container.appendChild(hint);
    return;
  }

  for (const m of persisted) {
    const html = m.role === 'user' ? escapeHtml(m.content) : renderMarkdown(m.content);
    container.appendChild(makeBubble(m.role, html));
  }

  // Live (this page load) turns from OctavusChat.
  for (const m of liveMessages) {
    if (m.role === 'user') {
      const text = (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('')
        || m.content || '';
      container.appendChild(makeBubble('user', escapeHtml(text)));
    } else if (m.role === 'assistant') {
      const text = (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('');
      const bubble = makeBubble('ai', renderMarkdown(text) || '<span class="assistant__typing">…</span>');
      // Offer an "insert into composer" action when the reply contains an email.
      const code = extractLastCodeBlock(text);
      if (code && m.status !== 'streaming') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'button button-text-primary button-xsmall assistant__insert';
        btn.textContent = 'Insert into composer';
        btn.addEventListener('click', () => insertIntoComposer(code));
        bubble.appendChild(btn);
      }
      container.appendChild(bubble);
    }
  }

  container.scrollTop = container.scrollHeight;
}

function insertIntoComposer(markdown) {
  setEditorMarkdown(markdown);
  scheduleDraftSave();
  els.composerBody.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function persistAssistant() {
  const live = (state.assistant.chat?.messages ?? []).map((m) => ({
    role: m.role,
    content: m.role === 'assistant'
      ? (m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('')
      : ((m.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('') || m.content || ''),
    timestamp: new Date().toISOString(),
  }));
  const all = [...state.assistant.persisted, ...live];
  state.session.assistantMessages = all;
  fetch('/api/session/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: state.session.sessionId, assistantMessages: all }),
  }).catch((err) => console.error('[CosmoMail] assistant save failed:', err));
}

function setAssistantEnabled(enabled) {
  els.assistantInput.disabled = !enabled;
  els.assistantSendBtn.disabled = !enabled || !els.assistantInput.value.trim();
}

async function initAssistant() {
  state.assistant.persisted = state.session?.assistantMessages ?? [];
  renderAssistant([]);

  if (state.config?.assistant?.enabled === false || state.config?.ui?.hideAssistant) {
    document.getElementById('assistantPanel')?.setAttribute('hidden', '');
    return;
  }

  // Create (or resume) the backing Octavus session.
  try {
    const res = await fetch('/api/assistant/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.session.sessionId }),
    });
    if (!res.ok) throw new Error(`assistant session failed (${res.status})`);
    const { octavusSessionId } = await res.json();
    state.assistant.octavusSessionId = octavusSessionId;
  } catch (err) {
    console.error('[CosmoMail] assistant unavailable:', err);
    els.assistantInput.placeholder = 'Assistant unavailable (agent not configured).';
    setAssistantEnabled(false);
    return;
  }

  const transport = createHttpTransport({
    request: (payload) =>
      fetch('/api/assistant/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: state.assistant.octavusSessionId, ...payload }),
      }),
  });

  state.assistant.chat = new OctavusChat({ transport });
  state.assistant.unsubscribe = state.assistant.chat.subscribe(() => {
    const chat = state.assistant.chat;
    renderAssistant(chat.messages);
    if (chat.status !== 'streaming') persistAssistant();
    setAssistantEnabled(chat.status !== 'streaming');
  });

  els.assistantInput.addEventListener('input', () => {
    els.assistantSendBtn.disabled = !els.assistantInput.value.trim()
      || state.assistant.chat?.status === 'streaming';
  });
  els.assistantInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAssistant();
    }
  });
  els.assistantSendBtn.addEventListener('click', sendAssistant);
  setAssistantEnabled(true);
}

async function sendAssistant() {
  const chat = state.assistant.chat;
  if (!chat || chat.status === 'streaming') return;
  const text = els.assistantInput.value.trim();
  if (!text) return;
  els.assistantInput.value = '';
  setAssistantEnabled(false);

  try {
    await chat.send(
      'assistant-message',
      {
        USER_MESSAGE: text,
        CUSTOM_INSTRUCTIONS: customInstructionsValue(),
        THREAD_CONTEXT: serializeThreadContext(),
        CURRENT_DRAFT: getEditorMarkdown() || '(empty)',
      },
      { userMessage: { content: text } },
    );
  } catch (err) {
    console.error('[CosmoMail] assistant send failed:', err);
    setAssistantEnabled(true);
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
    initComposer();
    initSubmission();
    await initAssistant();
  } catch (err) {
    console.error('[CosmoMail] boot error:', err);
    showBootError('Could not load CosmoMail. Is the server running?');
  }
}

boot();
