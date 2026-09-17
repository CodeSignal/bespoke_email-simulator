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
import { Placeholder } from '@tiptap/extensions';
import {
  MAILBOXES,
  mailboxCounts,
  mailboxForThread,
  threadsInMailbox,
  buildReplyHeaders,
} from '../lib/mailboxes.js';
import {
  availableCharacters,
  characterByEmail,
  characterLabel,
  constrainToCharacters,
  avatarPath,
  initialsFromName,
} from '../lib/characters.js';
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
  activeMailbox: 'inbox',
  activeThreadId: null,
  view: 'list', // list | thread | compose
  composingNew: false,
  replying: null, // null | 'reply' | 'replyAll'
  recipients: { to: [], cc: [] },
  openRecipientField: null, // null | 'to' | 'cc'
  editor: null,
  draftSaveTimer: null,
  assistant: {
    chat: null,
    unsubscribe: null,
    octavusSessionId: null,
    persisted: [],
    lastInsertable: null,
  },
  characterSessions: {},
  attachments: [],
};

// ── DOM ───────────────────────────────────────────────────────
const els = {
  bootError: document.getElementById('bootError'),
  appTitle: document.getElementById('appTitle'),
  composeBtn: document.getElementById('composeBtn'),
  composeBtnLabel: document.getElementById('composeBtnLabel'),
  mailboxList: document.getElementById('mailboxList'),
  mailMain: document.getElementById('mailMain'),
  mailList: document.getElementById('mailList'),
  threadList: document.getElementById('threadList'),
  mailToolbarTitle: document.getElementById('mailToolbarTitle'),
  backBtn: document.getElementById('backBtn'),
  readingPane: document.getElementById('readingPane'),
  composer: document.getElementById('composer'),
  assistantHint: document.getElementById('assistantHint'),
  composeToLabel: document.getElementById('composeToLabel'),
  composeCcLabel: document.getElementById('composeCcLabel'),
  composeToPicker: document.getElementById('composeToPicker'),
  composeCcPicker: document.getElementById('composeCcPicker'),
  composeToChips: document.getElementById('composeToChips'),
  composeCcChips: document.getElementById('composeCcChips'),
  composeToAdd: document.getElementById('composeToAdd'),
  composeCcAdd: document.getElementById('composeCcAdd'),
  composeToMenu: document.getElementById('composeToMenu'),
  composeCcMenu: document.getElementById('composeCcMenu'),
  composeSubject: document.getElementById('composeSubject'),
  composerBody: document.getElementById('composerBody'),
  composerPlaceholder: document.getElementById('composerPlaceholder'),
  sendBtn: document.getElementById('sendBtn'),
  discardBtn: document.getElementById('discardBtn'),
  attachBtn: document.getElementById('attachBtn'),
  fileInput: document.getElementById('fileInput'),
  attachmentPreview: document.getElementById('attachmentPreview'),
  assistantMessages: document.getElementById('assistantMessages'),
  assistantInput: document.getElementById('assistantInput'),
  assistantSendBtn: document.getElementById('assistantSendBtn'),
  mailToasts: document.getElementById('mailToasts'),
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

function formatListDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function threadSnippet(thread) {
  const last = thread.emails?.[thread.emails.length - 1];
  return emailSnippet(last);
}

function emailSnippet(email) {
  return String(email?.body ?? '')
    .replace(/\[\[(?:continue|done)\]\]/gi, '')
    .replace(/[#*_`>[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function displayName(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  return addr.name || addr.email || '';
}

function addressEmail(addr) {
  if (!addr) return '';
  return typeof addr === 'string' ? addr : (addr.email || '');
}

function learnerPerson() {
  const learner = state.config?.learner || {};
  return { name: learner.displayName || 'You', email: learner.email, avatar: learner.avatar };
}

function personForAddress(addr) {
  const email = addressEmail(addr);
  const learner = state.config?.learner;
  if (email && learner?.email && email.toLowerCase() === learner.email.toLowerCase()) {
    return learnerPerson();
  }
  const character = characterByEmail(state.config?.characters ?? [], email);
  if (character) return character;
  return { name: displayName(addr), email };
}

function avatarMarkup(person, size = 'md') {
  const src = avatarPath(person?.avatar);
  const label = person?.name || person?.email || '';
  if (src) {
    return `<img class="person-avatar person-avatar--${size}" src="${escapeHtml(src)}" alt="" />`;
  }
  return `<span class="person-avatar person-avatar--${size} person-avatar--initials" aria-hidden="true">${escapeHtml(initialsFromName(label))}</span>`;
}

function threadListFrom(thread, mailbox) {
  const last = thread.emails?.[thread.emails.length - 1];
  if (mailbox === 'sent') {
    const to = Array.isArray(last?.to) ? last.to[0] : last?.to;
    const name = displayName(to);
    return name ? `${t('To')}: ${name}` : t('To');
  }
  return displayName(last?.from) || formatAddress(last?.from);
}

function threadListPerson(thread, mailbox) {
  const last = thread.emails?.[thread.emails.length - 1];
  if (mailbox === 'sent') {
    const to = Array.isArray(last?.to) ? last.to[0] : last?.to;
    return personForAddress(to);
  }
  if (last?.outbound) return learnerPerson();
  return personForAddress(last?.from);
}

function learnerEmail() {
  return state.config?.learner?.email || '';
}

function directoryCharacters() {
  const learner = learnerEmail().toLowerCase();
  return (state.config?.characters ?? []).filter(
    (character) => character.email.toLowerCase() !== learner,
  );
}

function selectedRecipientEmails() {
  return [...state.recipients.to, ...state.recipients.cc];
}

function applyRecipientDraft({ to = [], cc = [] } = {}) {
  const directory = directoryCharacters();
  state.recipients.to = constrainToCharacters(to, directory);
  const toKeys = new Set(state.recipients.to.map((email) => email.toLowerCase()));
  state.recipients.cc = constrainToCharacters(cc, directory).filter(
    (email) => !toKeys.has(email.toLowerCase()),
  );
  renderRecipientPickers();
}

function addRecipient(field, email) {
  const directory = directoryCharacters();
  const other = field === 'to' ? 'cc' : 'to';
  const canonical = constrainToCharacters([email], directory)[0];
  if (!canonical) return;
  state.recipients[other] = state.recipients[other].filter(
    (value) => value.toLowerCase() !== canonical.toLowerCase(),
  );
  if (!state.recipients[field].some((value) => value.toLowerCase() === canonical.toLowerCase())) {
    state.recipients[field] = [...state.recipients[field], canonical];
  }
  state.openRecipientField = availableCharacters(directory, { selected: selectedRecipientEmails() }).length
    ? field
    : null;
  renderRecipientPickers();
  scheduleDraftSave();
  if (state.openRecipientField === field) {
    pickerEls(field).menu?.querySelector('button')?.focus();
  } else {
    pickerEls(field).add?.focus();
  }
}

function removeRecipient(field, email) {
  const key = String(email || '').toLowerCase();
  state.recipients[field] = state.recipients[field].filter((value) => value.toLowerCase() !== key);
  renderRecipientPickers();
  scheduleDraftSave();
}

function pickerEls(field) {
  return field === 'cc'
    ? { picker: els.composeCcPicker, chips: els.composeCcChips, add: els.composeCcAdd, menu: els.composeCcMenu }
    : { picker: els.composeToPicker, chips: els.composeToChips, add: els.composeToAdd, menu: els.composeToMenu };
}

function closeRecipientMenus() {
  state.openRecipientField = null;
  renderRecipientPickers();
}

function renderRecipientChip(field, email) {
  const character = characterByEmail(directoryCharacters(), email) || personForAddress(email);
  const chip = document.createElement('span');
  chip.className = 'tag outline recipient-picker__chip';
  chip.dataset.email = email;
  chip.insertAdjacentHTML('afterbegin', avatarMarkup(character, 'xs'));

  const label = document.createElement('span');
  label.textContent = characterLabel(character) || email;
  chip.appendChild(label);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'recipient-picker__remove';
  remove.setAttribute('aria-label', `${t('Remove')} ${label.textContent}`);
  remove.textContent = '×';
  remove.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    removeRecipient(field, email);
  });
  chip.appendChild(remove);
  return chip;
}

function renderRecipientMenu(field) {
  const { picker, add, menu } = pickerEls(field);
  const directory = directoryCharacters();
  const remaining = availableCharacters(directory, { selected: selectedRecipientEmails() });
  const open = state.openRecipientField === field && remaining.length > 0;

  if (picker) picker.classList.toggle('is-open', open);
  if (add) {
    add.hidden = remaining.length === 0;
    add.disabled = remaining.length === 0;
    add.setAttribute('aria-expanded', open ? 'true' : 'false');
    add.textContent = t('Select a recipient');
    if (remaining.length === 0) add.setAttribute('aria-label', t('No more people to add'));
    else add.setAttribute('aria-label', t('Select a recipient'));
  }
  if (!menu) return;
  menu.hidden = !open;
  menu.innerHTML = '';
  if (!open) return;

  for (const character of remaining) {
    const item = document.createElement('li');
    item.setAttribute('role', 'presentation');
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'recipient-picker__option';
    option.setAttribute('role', 'option');
    option.dataset.email = character.email;
    option.insertAdjacentHTML('afterbegin', avatarMarkup(character, 'sm'));
    const text = document.createElement('span');
    text.className = 'recipient-picker__option-text';
    const name = document.createElement('span');
    name.className = 'recipient-picker__option-name';
    name.textContent = characterLabel(character);
    text.appendChild(name);
    if (character.role) {
      const meta = document.createElement('span');
      meta.className = 'body-xsmall recipient-picker__option-meta';
      meta.textContent = character.role;
      text.appendChild(meta);
    }
    option.appendChild(text);
    option.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      addRecipient(field, character.email);
    });
    item.appendChild(option);
    menu.appendChild(item);
  }
}

function renderRecipientPickers() {
  for (const field of ['to', 'cc']) {
    const { chips } = pickerEls(field);
    if (chips) {
      chips.innerHTML = '';
      for (const email of state.recipients[field]) {
        chips.appendChild(renderRecipientChip(field, email));
      }
    }
    renderRecipientMenu(field);
  }
}

function toggleRecipientMenu(field) {
  const remaining = availableCharacters(directoryCharacters(), { selected: selectedRecipientEmails() });
  if (!remaining.length) return;
  state.openRecipientField = state.openRecipientField === field ? null : field;
  renderRecipientPickers();
  if (state.openRecipientField === field) {
    pickerEls(field).menu?.querySelector('button')?.focus();
  }
}

function initRecipientPickers() {
  for (const field of ['to', 'cc']) {
    const { picker, add } = pickerEls(field);
    const open = (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleRecipientMenu(field);
    };
    add?.addEventListener('click', open);
    picker?.addEventListener('click', (event) => {
      if (event.target.closest('.recipient-picker__remove, .recipient-picker__option')) return;
      open(event);
    });
  }
  document.addEventListener('click', (event) => {
    if (!state.openRecipientField) return;
    if (event.target.closest('.recipient-picker')) return;
    closeRecipientMenus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.openRecipientField) closeRecipientMenus();
  });
}

function visibleThreads() {
  return threadsInMailbox(state.session?.threads ?? [], state.activeMailbox, learnerEmail());
}

function mailboxLabel(mailbox) {
  const box = MAILBOXES.find((m) => m.id === mailbox);
  return t(box?.label || 'Inbox');
}

function emptyMailboxCopy(mailbox) {
  if (mailbox === 'sent') {
    return { title: t('No sent messages'), body: t('Messages you send will appear here.') };
  }
  if (mailbox === 'spam') {
    return { title: t('Hooray, no spam here!'), body: t('Messages that look like spam will show up in this folder.') };
  }
  return { title: t('Inbox Zero'), body: t("You're all caught up. No new mail.") };
}

const MAILBOX_ICONS = {
  inbox: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 9.5 4.2 4h7.6L14 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9.5Z"/><path d="M2 9.5h3l.8 1.5h4.4l.8-1.5H14"/></svg>',
  sent: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M14 2 7 9M14 2 9.2 14 7 9 2 6.8 14 2Z"/></svg>',
  spam: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.25"/><path d="m4.4 11.6 7.2-7.2"/></svg>',
};

function renderShell() {
  renderMailboxes();
  applyView();
  if (state.view === 'list') renderMailList();
  else if (state.view === 'thread') renderThread(state.activeThreadId);
}

function applyView() {
  const view = state.view;
  const isList = view === 'list';
  const isThread = view === 'thread';
  const isCompose = view === 'compose';

  if (els.mailList) els.mailList.hidden = !isList;
  if (els.readingPane) els.readingPane.hidden = !isThread;
  const showComposer = isCompose || (isThread && Boolean(state.replying));
  if (els.composer) els.composer.hidden = !showComposer;
  if (els.discardBtn) {
    els.discardBtn.hidden = !state.replying;
    els.discardBtn.textContent = t('Discard');
  }
  if (els.backBtn) {
    els.backBtn.hidden = isList;
    els.backBtn.setAttribute('aria-label', t('Back to list'));
  }
  if (els.mailMain) els.mailMain.classList.toggle('is-composing', isCompose);

  if (els.mailToolbarTitle) {
    if (isCompose) els.mailToolbarTitle.textContent = t('New message');
    else if (isThread) {
      const thread = (state.session?.threads ?? []).find((th) => th.id === state.activeThreadId);
      els.mailToolbarTitle.textContent = thread?.subject || t('Inbox');
    } else {
      els.mailToolbarTitle.textContent = mailboxLabel(state.activeMailbox);
    }
  }
}

// ── Rendering ─────────────────────────────────────────────────
function renderMailboxes() {
  if (!els.mailboxList) return;
  const counts = mailboxCounts(state.session?.threads ?? [], learnerEmail());
  els.mailboxList.innerHTML = '';
  for (const box of MAILBOXES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rail__mailbox' + (box.id === state.activeMailbox ? ' is-active' : '');
    btn.dataset.mailbox = box.id;
    if (box.id === state.activeMailbox) btn.setAttribute('aria-current', 'true');
    const count = counts[box.id] ?? 0;
    btn.innerHTML = `
      <span class="rail__mailbox-icon">${MAILBOX_ICONS[box.id] || ''}</span>
      <span class="body-small rail__mailbox-label">${escapeHtml(t(box.label))}</span>
      <span class="body-xsmall rail__mailbox-count">${count ? escapeHtml(String(count)) : ''}</span>
    `;
    btn.addEventListener('click', () => selectMailbox(box.id));
    els.mailboxList.appendChild(btn);
  }
  if (els.composeBtnLabel) els.composeBtnLabel.textContent = t('Compose');
}

function renderMailList() {
  const threads = visibleThreads();
  els.threadList.innerHTML = '';

  if (!threads.length) {
    const copy = emptyMailboxCopy(state.activeMailbox);
    const empty = document.createElement('div');
    empty.className = 'mail-list__empty';
    empty.innerHTML = `
      <span class="icon icon-cosmo-black icon-xlarge icon-secondary" aria-hidden="true"></span>
      <p class="heading-small mail-list__empty-title">${escapeHtml(copy.title)}</p>
      <p class="body-small mail-list__empty-body">${escapeHtml(copy.body)}</p>
    `;
    els.threadList.appendChild(empty);
    return;
  }

  for (const thread of threads) {
    const last = thread.emails?.[thread.emails.length - 1];
    const snippet = threadSnippet(thread);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mail-row';
    btn.dataset.threadId = thread.id;
    btn.innerHTML = `
      ${avatarMarkup(threadListPerson(thread, state.activeMailbox), 'sm')}
      <span class="body-small mail-row__from">${escapeHtml(threadListFrom(thread, state.activeMailbox))}</span>
      <span class="mail-row__main">
        <span class="body-small mail-row__subject">${escapeHtml(thread.subject || '(no subject)')}</span>
        ${snippet ? `<span class="body-xsmall mail-row__snippet"> – ${escapeHtml(snippet)}</span>` : ''}
      </span>
      <span class="body-xsmall mail-row__date">${escapeHtml(formatListDate(last?.date))}</span>
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
  wrap.className = 'email box card non-interactive' + (isOutbound ? ' email--outbound' : '');
  if (email.id) wrap.dataset.emailId = email.id;
  const toLine = formatAddressList(email.to);
  const ccLine = email.cc && email.cc.length ? `<div class="body-xsmall email__to">Cc: ${escapeHtml(formatAddressList(email.cc))}</div>` : '';
  const attachments = Array.isArray(email.attachments) ? email.attachments : [];
  const attachmentsHtml = attachments.length
    ? `<div class="email__attachments">${attachments
        .map((a) => `<span class="tag outline email__attachment">${escapeHtml(a.name || 'attachment')}</span>`)
        .join('')}</div>`
    : '';
  wrap.innerHTML = `
    <div class="email__meta">
      ${avatarMarkup(isOutbound ? learnerPerson() : personForAddress(email.from), 'md')}
      <div class="email__meta-text">
        <div class="heading-xxxsmall email__from">${escapeHtml(formatAddress(email.from))}</div>
        <div class="body-xsmall email__to">To: ${escapeHtml(toLine)}</div>
        ${ccLine}
      </div>
      <div class="body-xsmall email__date">${escapeHtml(formatDate(email.date))}</div>
    </div>
    <div class="email__body">${renderMarkdown(email.body)}</div>
    ${attachmentsHtml}
  `;
  return wrap;
}

function renderThread(threadId) {
  const threads = state.session?.threads ?? [];
  const thread = threads.find((th) => th.id === threadId);
  const learnerAddr = learnerEmail();

  els.readingPane.innerHTML = '';
  if (!thread) {
    backToList();
    return;
  }
  for (const email of thread.emails ?? []) {
    els.readingPane.appendChild(renderEmail(email, learnerAddr));
  }
  if (!state.replying) els.readingPane.appendChild(renderThreadActions());
}

function renderThreadActions() {
  const actions = document.createElement('div');
  actions.className = 'thread-actions';

  const reply = document.createElement('button');
  reply.type = 'button';
  reply.className = 'button button-tertiary button-small';
  reply.textContent = t('Reply');
  reply.addEventListener('click', () => startReply('reply'));

  const replyAll = document.createElement('button');
  replyAll.type = 'button';
  replyAll.className = 'button button-tertiary button-small';
  replyAll.textContent = t('Reply all');
  replyAll.addEventListener('click', () => startReply('replyAll'));

  actions.append(reply, replyAll);
  return actions;
}

function replyTargetEmail(thread) {
  const emails = thread?.emails ?? [];
  const focusedId = state.scenario?.focusedEmailId;
  return emails.find((email) => email.id === focusedId) ?? emails[emails.length - 1];
}

function applyThreadComposer(threadId, mode = state.replying || 'reply') {
  const thread = (state.session?.threads ?? []).find((th) => th.id === threadId);
  if (!thread) return;
  const headers = buildReplyHeaders(replyTargetEmail(thread), {
    mode,
    learnerEmail: learnerEmail(),
    subjectFallback: thread.subject || '',
  });
  applyRecipientDraft(headers);
  els.composeSubject.value = headers.subject;
  scheduleDraftSave();
}

function selectMailbox(mailbox) {
  state.activeMailbox = mailbox;
  state.view = 'list';
  state.composingNew = false;
  state.replying = null;
  state.activeThreadId = null;
  renderShell();
}

function selectThread(threadId) {
  state.view = 'thread';
  state.composingNew = false;
  state.replying = null;
  state.activeThreadId = threadId;
  renderShell();
}

function startReply(mode) {
  state.view = 'thread';
  state.composingNew = false;
  state.replying = mode;
  applyThreadComposer(state.activeThreadId, mode);
  renderShell();
  els.composerBody?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  state.editor?.commands.focus();
}

function cancelReply() {
  state.replying = null;
  renderShell();
}

function startCompose({ blank = true } = {}) {
  state.view = 'compose';
  state.composingNew = true;
  state.replying = null;
  state.activeThreadId = null;
  if (blank) {
    applyRecipientDraft({ to: [], cc: [] });
    els.composeSubject.value = '';
    setEditorMarkdown('');
    clearAttachments();
  }
  scheduleDraftSave();
  renderShell();
  els.composeToAdd?.focus();
}

function backToList() {
  state.view = 'list';
  state.composingNew = false;
  state.replying = null;
  state.activeThreadId = null;
  renderShell();
}

function applyScenarioChrome() {
  const title = state.config?.title || 'CosmoMail';
  document.title = title;
  if (els.appTitle) els.appTitle.textContent = title;
  if (els.composeToLabel) els.composeToLabel.textContent = t('To');
  if (els.composeCcLabel) els.composeCcLabel.textContent = t('Cc');
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
    to: [...state.recipients.to],
    cc: [...state.recipients.cc],
    subject: els.composeSubject.value || '',
    body: getEditorMarkdown(),
    updated_at: new Date().toISOString(),
  };
}

function updateSendEnabled() {
  const draft = currentDraft();
  const hasContent = draft.body.trim().length > 0 || draft.subject.trim().length > 0;
  els.sendBtn.disabled = !hasContent || draft.to.length === 0;
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
  applyRecipientDraft(draft);
  els.composeSubject.value = draft.subject || '';

  if (els.composerPlaceholder) els.composerPlaceholder.remove();

  state.editor = new Editor({
    element: els.composerBody,
    extensions: [
      StarterKit,
      Markdown,
      Placeholder.configure({
        placeholder: t('Write your message...'),
      }),
    ],
    content: draft.body || '',
    contentType: 'markdown',
    editorProps: {
      attributes: {
        class: 'composer__editor',
        'aria-label': t('Message'),
      },
    },
    onUpdate: scheduleDraftSave,
  });

  els.composerBody.addEventListener('mousedown', (event) => {
    if (event.target === els.composerBody) {
      event.preventDefault();
      state.editor?.commands.focus('end');
    }
  });

  initRecipientPickers();
  els.composeSubject.addEventListener('input', scheduleDraftSave);
  els.sendBtn.addEventListener('click', sendEmail);
  els.composeBtn?.addEventListener('click', () => startCompose({ blank: true }));
  els.backBtn?.addEventListener('click', backToList);
  els.discardBtn?.addEventListener('click', cancelReply);
  updateSendEnabled();
}

// ── Attachments ───────────────────────────────────────────────
function allowedAttachmentTypes() {
  return (state.config?.attachments?.allowedTypes ?? []).map((t) => t.toLowerCase());
}

function isAllowedFile(file) {
  const allowed = allowedAttachmentTypes();
  if (!allowed.length) return true;
  const name = (file.name || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  return allowed.includes(ext);
}

function renderAttachmentPreview() {
  const items = state.attachments;
  els.attachmentPreview.hidden = items.length === 0;
  els.attachmentPreview.innerHTML = '';
  items.forEach((item, idx) => {
    const chip = document.createElement('span');
    chip.className = 'tag outline composer__attachment';
    const label = item.status === 'uploading' ? `${item.file.name} (uploading…)`
      : item.status === 'error' ? `${item.file.name} (failed)` : item.file.name;
    chip.innerHTML = `<span class="composer__attachment-name">${escapeHtml(label)}</span>`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'composer__attachment-remove';
    remove.setAttribute('aria-label', `Remove ${item.file.name}`);
    remove.innerHTML = '<span class="icon icon-trash icon-small" aria-hidden="true"></span>';
    remove.addEventListener('click', () => {
      state.attachments.splice(idx, 1);
      renderAttachmentPreview();
    });
    chip.appendChild(remove);
    els.attachmentPreview.appendChild(chip);
  });
}

async function handleComposerFiles(files) {
  const chat = state.assistant.chat;
  if (!chat) {
    console.warn('[CosmoMail] attachments require the assistant session');
    return;
  }
  const accepted = [];
  for (const file of files) {
    if (!isAllowedFile(file)) {
      console.warn('[CosmoMail] rejected disallowed file type:', file.name);
      continue;
    }
    accepted.push(file);
  }
  if (!accepted.length) return;

  const newItems = accepted.map((file) => ({ file, ref: null, status: 'uploading' }));
  state.attachments.push(...newItems);
  renderAttachmentPreview();

  try {
    const refs = await chat.uploadFiles(accepted);
    refs.forEach((ref, i) => {
      newItems[i].ref = ref;
      newItems[i].status = 'ready';
    });
  } catch (err) {
    console.error('[CosmoMail] upload error:', err);
    newItems.forEach((item) => { item.status = 'error'; });
  } finally {
    renderAttachmentPreview();
  }
}

function readyAttachments() {
  return state.attachments
    .filter((i) => i.status === 'ready')
    .map((i) => ({ name: i.file.name, type: i.file.type, size: i.file.size, ref: i.ref }));
}

function clearAttachments() {
  state.attachments = [];
  renderAttachmentPreview();
}

function initAttachments() {
  if (!state.config?.attachments?.enabled) {
    els.attachBtn.hidden = true;
    return;
  }
  els.attachBtn.hidden = false;
  const allowed = allowedAttachmentTypes();
  if (allowed.length) els.fileInput.accept = allowed.join(',');
  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    const files = Array.from(els.fileInput.files || []);
    els.fileInput.value = '';
    handleComposerFiles(files);
  });
}

// ── Send flow & character replies ─────────────────────────────
function replaceThread(thread) {
  const threads = state.session.threads ?? (state.session.threads = []);
  const idx = threads.findIndex((t) => t.id === thread.id);
  if (idx >= 0) threads[idx] = thread;
  else threads.push(thread);
}

function isViewingThread(threadId) {
  return state.view === 'thread' && state.activeThreadId === threadId && els.readingPane && !els.readingPane.hidden;
}

function escapeSelector(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function scrollToEmail(emailId) {
  if (!emailId || !els.readingPane) return;
  requestAnimationFrame(() => {
    const el = els.readingPane.querySelector(`[data-email-id="${escapeSelector(emailId)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    el.classList.remove('email--arrive');
    void el.offsetWidth;
    el.classList.add('email--arrive');
  });
}

function openInboundEmail(threadId, emailId) {
  dismissMailToasts();
  const thread = (state.session?.threads ?? []).find((item) => item.id === threadId);
  if (!thread) return;
  if (!isViewingThread(threadId)) {
    state.activeMailbox = mailboxForThread(thread, learnerEmail());
    selectThread(threadId);
  }
  scrollToEmail(emailId);
}

function dismissMailToast(toast) {
  if (!toast) return;
  if (toast._timer) clearTimeout(toast._timer);
  toast.remove();
}

function dismissMailToasts() {
  if (!els.mailToasts) return;
  for (const toast of [...els.mailToasts.children]) dismissMailToast(toast);
}

function showMailToast(thread, email) {
  if (!els.mailToasts || !email) return;
  const person = personForAddress(email.from);
  const subject = thread?.subject || t('(no subject)');
  const snippet = emailSnippet(email);
  const toast = document.createElement('div');
  toast.className = 'mail-toast box card';
  toast.setAttribute('role', 'status');
  toast.innerHTML = `
    <button type="button" class="mail-toast__open">
      ${avatarMarkup(person, 'sm')}
      <span class="mail-toast__text">
        <span class="label-small mail-toast__kicker">${escapeHtml(t('New email'))}</span>
        <span class="body-small mail-toast__from">${escapeHtml(person.name || person.email || '')}</span>
        <span class="body-xsmall mail-toast__snippet">${escapeHtml(subject)}${snippet ? ` · ${escapeHtml(snippet)}` : ''}</span>
      </span>
    </button>
    <button type="button" class="mail-toast__close" aria-label="${escapeHtml(t('Dismiss'))}">
      <span aria-hidden="true">×</span>
    </button>
  `;
  toast.querySelector('.mail-toast__open').addEventListener('click', () => {
    openInboundEmail(thread.id, email.id);
  });
  toast.querySelector('.mail-toast__close').addEventListener('click', (event) => {
    event.stopPropagation();
    dismissMailToast(toast);
  });
  els.mailToasts.appendChild(toast);
  while (els.mailToasts.children.length > 3) {
    dismissMailToast(els.mailToasts.firstElementChild);
  }
  toast._timer = setTimeout(() => dismissMailToast(toast), 8000);
}

function refreshMailAfterInbound(thread, email) {
  replaceThread(thread);
  renderMailboxes();
  if (state.view === 'list') renderMailList();
  if (isViewingThread(thread.id)) {
    renderThread(thread.id);
    scrollToEmail(email?.id);
  }
  showMailToast(thread, email);
}

async function sendEmail() {
  if (els.sendBtn.disabled) return;
  const draft = currentDraft();
  if (!draft.body.trim() && !draft.subject.trim()) return;

  els.sendBtn.disabled = true;
  els.sendBtn.textContent = 'Sending…';
  try {
    const composingNew = state.composingNew || !state.activeThreadId;
    const res = await fetch('/api/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.session.sessionId,
        threadId: composingNew ? null : state.activeThreadId,
        to: draft.to,
        cc: draft.cc,
        subject: draft.subject,
        body: draft.body,
        attachments: readyAttachments(),
      }),
    });
    if (!res.ok) throw new Error(`send failed (${res.status})`);
    const { email, thread, responders } = await res.json();

    replaceThread(thread);
    state.composingNew = false;
    state.replying = null;
    state.view = 'thread';
    state.activeThreadId = thread.id;
    state.activeMailbox = mailboxForThread(thread, learnerEmail());
    state.session.drafts = [];
    setEditorMarkdown('');
    clearAttachments();
    renderShell();

    void collectCharacterReplies(responders, email, thread.id);
  } catch (err) {
    console.error('[CosmoMail] send failed:', err);
  } finally {
    els.sendBtn.textContent = t('Send');
    updateSendEnabled();
  }
}

async function collectCharacterReplies(responders, email, threadId) {
  for (const responder of responders || []) {
    await runCharacterReply(responder, email, threadId);
  }
}

async function finalizeCharacterReply(characterId, threadId, replyText, inReplyToId) {
  const res = await fetch('/api/character/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: state.session.sessionId,
      threadId,
      characterId,
      reply: replyText,
      inReplyToId,
    }),
  });
  if (!res.ok) return null;
  const { thread, email } = await res.json();
  refreshMailAfterInbound(thread, email);
  return email;
}

async function ensureCharacterSession(characterId) {
  if (state.characterSessions[characterId]) return state.characterSessions[characterId];
  const r = await fetch('/api/character/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: state.session.sessionId, characterId }),
  });
  if (!r.ok) throw new Error(`character session failed (${r.status})`);
  const { characterOctavusSessionId } = await r.json();
  state.characterSessions[characterId] = characterOctavusSessionId;
  return characterOctavusSessionId;
}

function formatRecipientsContext(email) {
  const lines = [`From: ${formatAddress(email?.from)}`, `To: ${formatAddressList(email?.to)}`];
  if (email?.cc?.length) lines.push(`Cc: ${formatAddressList(email.cc)}`);
  return lines.join('\n');
}

async function runCharacterReply(character, sentEmail, threadId) {
  let octavusSessionId;
  try {
    octavusSessionId = await ensureCharacterSession(character.id);
  } catch (err) {
    console.error('[CosmoMail] character unavailable:', err);
    return;
  }

  const transport = createHttpTransport({
    request: (payload) =>
      fetch('/api/character/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: octavusSessionId, ...payload }),
      }),
  });
  const chat = new OctavusChat({ transport });
  const sentBody = sentEmail?.body || '';
  try {
    await chat.send(
      'character-reply',
      {
        LEARNER_EMAIL: sentBody,
        THREAD_CONTEXT: serializeThreadContext(threadId),
        RECIPIENTS: formatRecipientsContext(sentEmail),
      },
      { userMessage: { content: sentBody } },
    );
  } catch (err) {
    console.error('[CosmoMail] character reply failed:', err);
    return;
  }

  const replyText = assistantTextFromMessages(chat.messages);
  if (!replyText.trim()) return;
  await finalizeCharacterReply(character.id, threadId, replyText, sentEmail?.id);
}

// ── Assistant (Cosmo) ─────────────────────────────────────────
// Serializes the active thread into Markdown context for the agent.
function serializeThreadContext(threadId = state.activeThreadId) {
  const threads = state.session?.threads ?? [];
  const thread = threads.find((th) => th.id === threadId) ?? threads[0];
  if (!thread) return 'No emails in the current mailbox.';
  const lines = [`Subject: ${thread.subject || '(no subject)'}`, ''];
  for (const email of thread.emails ?? []) {
    lines.push(`From: ${formatAddress(email.from)}`);
    lines.push(`To: ${formatAddressList(email.to)}`);
    if (email.cc?.length) lines.push(`Cc: ${formatAddressList(email.cc)}`);
    if (email.date) lines.push(`Date: ${formatDate(email.date)}`);
    if (email.attachments?.length) {
      lines.push(`Attachments: ${email.attachments.map((a) => a.name || 'file').join(', ')}`);
    }
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
  const isUser = role === 'user';
  const row = document.createElement('div');
  row.className = `assistant__row assistant__row--${isUser ? 'user' : 'ai'}`;

  if (!isUser) {
    const avatar = document.createElement('span');
    avatar.className = 'icon icon-cosmo-black icon-primary icon-small assistant__avatar';
    avatar.setAttribute('aria-hidden', 'true');
    row.appendChild(avatar);
  }

  const bubble = document.createElement('div');
  bubble.className = isUser
    ? 'assistant__msg assistant__msg--user'
    : 'assistant__msg assistant__msg--ai box non-interactive';
  bubble.innerHTML = contentHtml;
  row.appendChild(bubble);
  return row;
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
      const row = makeBubble('ai', renderMarkdown(text) || '<span class="assistant__typing">…</span>');
      // Offer an "insert into composer" action when the reply contains an email.
      const code = extractLastCodeBlock(text);
      if (code && m.status !== 'streaming') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'button button-text-primary button-xsmall assistant__insert';
        btn.textContent = 'Insert into composer';
        btn.addEventListener('click', () => insertIntoComposer(code));
        row.querySelector('.assistant__msg').appendChild(btn);
      }
      container.appendChild(row);
    }
  }

  container.scrollTop = container.scrollHeight;
}

function insertIntoComposer(markdown) {
  if (state.view === 'list') startCompose({ blank: false });
  else if (state.view === 'thread' && !state.replying) startReply('reply');
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

  if (state.config?.assistant?.enabled === false) {
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

  const requestUploadUrls = async (files) => {
    const r = await fetch('/api/upload-urls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.assistant.octavusSessionId, files }),
    });
    return r.json();
  };

  state.assistant.chat = new OctavusChat({ transport, requestUploadUrls });
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

    const threads = state.session.threads ?? [];
    const seeded = threads.find((th) => th.id === state.scenario.activeThreadId) ?? threads[0];
    state.activeMailbox = seeded ? mailboxForThread(seeded, learnerEmail()) : 'inbox';
    state.activeThreadId = null;
    state.composingNew = false;
    state.replying = null;
    state.view = 'list';

    applyScenarioChrome();
    initComposer();
    initAttachments();
    if (state.config?.scenarioType === 'compose_new') {
      startCompose({ blank: false });
    } else {
      renderShell();
    }
    await initAssistant();
  } catch (err) {
    console.error('[CosmoMail] boot error:', err);
    showBootError('Could not load CosmoMail. Is the server running?');
  }
}

boot();
