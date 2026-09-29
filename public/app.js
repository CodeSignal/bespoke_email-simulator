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
import Modal from '../design-system/components/modal/modal.js';
import {
  MAILBOXES,
  mailboxCounts,
  mailboxForThread,
  threadsInMailbox,
  buildReplyHeaders,
  threadListCorrespondent,
  latestInboundEmail,
} from '../lib/mailboxes.js';
import {
  availableCharacters,
  characterByEmail,
  characterLabel,
  constrainToCharacters,
  resolveRecipientEmails,
  avatarPath,
  initialsFromName,
} from '../lib/characters.js';
import { buildMailboxContext } from '../lib/assistant.js';
import { draftForScope, parseInsertedDraft, removeScopedDraft, sameDraftScope, upsertScopedDraft } from '../lib/drafts.js';
import {
  appendSessionEvents,
  draftFieldsToMarkdown,
  draftsFromMessageParts,
  EVENT_TYPES,
  makeDraftInsertedEvent,
  makeDraftProposedEvent,
  makeDraftSentEvent,
  newDraftId,
  normalizeDraftFields,
  PROPOSE_DRAFT_TOOL,
} from '../lib/provenance.js';
import { resolveQuickActionChips, QUICK_ACTION_SOURCE } from '../lib/quick-actions.js';
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

function parseMailto(href) {
  const raw = String(href || '').trim();
  if (!/^mailto:/i.test(raw)) return '';
  try {
    return decodeURIComponent(raw.slice('mailto:'.length)).split('?')[0].trim();
  } catch {
    return raw.slice('mailto:'.length).split('?')[0].trim();
  }
}

marked.use({
  renderer: {
    link({ href, tokens }) {
      const email = parseMailto(href);
      if (!email) return false;
      const text = this.parser.parseInline(tokens);
      const canonical = constrainToCharacters([email], directoryCharacters())[0];
      if (!canonical) return text;
      // Stay in-app: mailto: is intercepted by browser/OS mail handlers and extensions.
      return `<a href="#" class="js-compose-mailto" data-email="${escapeHtml(canonical)}">${text}</a>`;
    },
  },
});

// ── State ─────────────────────────────────────────────────────
const state = {
  config: null,
  scenario: null,
  session: null,
  activeMailbox: 'inbox',
  activeThreadId: null,
  view: 'list', // list | thread
  composingNew: false,
  composeMinimized: false,
  composeExpanded: false,
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
    lastContextHash: null, // hash of the mailbox state last sent in full to Cosmo
    // Last AI draft the learner Inserted — used for draft_sent provenance on send.
    lastInserted: null,
    seenToolCallIds: new Set(),
    quickActionBusy: false,
    // One-shot rewrite/shorten/tone/proofread card (not part of chat transcript).
    quickDraft: null,
    // Inbox triage ranking from the prioritize chip (Markdown; not chat transcript).
    triageRanking: null,
    // Suggested reply options under the focused email.
    suggestedReplies: null, // { threadId, emailId, replies: string[] }
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
  composerChrome: document.getElementById('composerChrome'),
  composerTitle: document.getElementById('composerTitle'),
  composerMinimizeBtn: document.getElementById('composerMinimizeBtn'),
  composerExpandBtn: document.getElementById('composerExpandBtn'),
  composerCloseBtn: document.getElementById('composerCloseBtn'),
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
  assistantClearBtn: document.getElementById('assistantClearBtn'),
  assistantChips: document.getElementById('assistantChips'),
  assistantQuickResult: document.getElementById('assistantQuickResult'),
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
  const { kind, address } = threadListCorrespondent(thread, {
    mailbox,
    learnerEmail: learnerEmail(),
  });
  const name = displayName(address) || formatAddress(address);
  if (kind === 'to') return name ? `${t('To')}: ${name}` : t('To');
  return name;
}

function threadListPerson(thread, mailbox) {
  const { address } = threadListCorrespondent(thread, {
    mailbox,
    learnerEmail: learnerEmail(),
  });
  return personForAddress(address);
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
  // Keep seed senders who are not in `characters` (e.g. Lena in example 02).
  // The recipient picker still only adds directory people via constrainToCharacters.
  state.recipients.to = resolveRecipientEmails(to, directory);
  const toKeys = new Set(state.recipients.to.map((email) => email.toLowerCase()));
  state.recipients.cc = resolveRecipientEmails(cc, directory).filter(
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
  remove.className = 'button button-text button-xsmall recipient-picker__remove';
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

  if (picker) {
    picker.classList.toggle('is-open', open);
    picker.classList.toggle('open', open);
  }
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
    option.className = 'dropdown-menu-item recipient-picker__option';
    option.setAttribute('role', 'option');
    option.dataset.email = character.email;
    const content = document.createElement('span');
    content.className = 'dropdown-menu-item-content';
    content.insertAdjacentHTML('afterbegin', avatarMarkup(character, 'sm'));
    const text = document.createElement('span');
    text.className = 'recipient-picker__option-text';
    const name = document.createElement('span');
    name.className = 'dropdown-menu-item-label';
    name.textContent = characterLabel(character);
    text.appendChild(name);
    if (character.role) {
      const meta = document.createElement('span');
      meta.className = 'body-xsmall recipient-picker__option-meta';
      meta.textContent = character.role;
      text.appendChild(meta);
    }
    content.appendChild(text);
    option.appendChild(content);
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
  // Capture phase: the design-system Modal stops propagation on clicks inside
  // its dialog (so overlay clicks only close via the overlay itself), which
  // would otherwise prevent this document-level listener from ever seeing
  // clicks made while the composer is expanded into that modal.
  document.addEventListener(
    'click',
    (event) => {
      if (!state.openRecipientField) return;
      if (event.target.closest('.recipient-picker')) return;
      closeRecipientMenus();
    },
    true,
  );
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !state.openRecipientField) return;
    event.stopImmediatePropagation();
    closeRecipientMenus();
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
  if (state.view === 'compose') state.view = 'list';
  renderMailboxes();
  if (state.view === 'list') renderMailList();
  else if (state.view === 'thread') renderThread(state.activeThreadId);
  applyView();
}

const MINIMIZE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3.5 8h9"/></svg>';
const RESTORE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg>';
const EXPAND_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5H12.5V9.5"/><path d="M12.5 3.5 3.5 12.5"/></svg>';
const COLLAPSE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 12.5H3.5V6.5"/><path d="M3.5 12.5 12.5 3.5"/></svg>';

let composeModal = null;
let syncingComposeModal = false;

function composeOverlayTitle() {
  const subject = els.composeSubject?.value?.trim();
  return subject || t('New message');
}

function ensureComposeModal() {
  if (composeModal) return composeModal;
  composeModal = new Modal({
    size: 'xlarge',
    title: null,
    showCloseButton: false,
    closeOnOverlayClick: false,
    closeOnEscape: true,
    onClose: () => {
      if (syncingComposeModal) return;
      if (!state.composeExpanded) return;
      state.composeExpanded = false;
      applyView();
    },
  });
  composeModal.dialog.classList.add('compose-modal-dialog');
  composeModal.overlay.setAttribute('aria-label', t('New message'));
  return composeModal;
}

function parkComposer() {
  if (!els.composer || !els.mailMain) return;
  if (els.composer.parentElement === els.readingPane) {
    els.mailMain.insertBefore(els.composer, els.mailToasts ?? null);
  }
}

function dockComposer() {
  if (!els.composer || !els.mailMain) return;
  if (els.composer.parentElement !== els.mailMain) {
    els.mailMain.insertBefore(els.composer, els.mailToasts ?? null);
  }
}

function placeComposer() {
  if (!els.composer) return;
  const overlayCompose = Boolean(state.composingNew);
  const expanded = overlayCompose && state.composeExpanded;
  const inlineReply = state.view === 'thread' && Boolean(state.replying);
  els.composer.classList.toggle('is-overlay', overlayCompose && !expanded);
  els.composer.classList.toggle('box', overlayCompose && !expanded);
  els.composer.classList.toggle('card', overlayCompose && !expanded);
  els.composer.classList.toggle('non-interactive', overlayCompose && !expanded);
  els.composer.classList.toggle('is-expanded', expanded);
  els.composer.classList.toggle('is-inline', inlineReply);
  els.composer.classList.toggle('is-minimized', overlayCompose && !expanded && state.composeMinimized);

  if (expanded) {
    const modal = ensureComposeModal();
    modal.overlay.setAttribute('aria-label', composeOverlayTitle());
    modal.content.appendChild(els.composer);
    if (!modal.isOpen) {
      syncingComposeModal = true;
      modal.open();
      syncingComposeModal = false;
    }
    return;
  }

  if (composeModal?.isOpen) {
    syncingComposeModal = true;
    composeModal.close();
    syncingComposeModal = false;
  }

  if (inlineReply && els.readingPane && !els.readingPane.hidden) {
    els.readingPane.appendChild(els.composer);
  } else {
    dockComposer();
  }
}

function applyView() {
  if (state.view === 'compose') state.view = 'list';
  const view = state.view;
  const isList = view === 'list';
  const isThread = view === 'thread';
  const overlayCompose = Boolean(state.composingNew);
  const inlineReply = isThread && Boolean(state.replying);

  if (els.mailList) els.mailList.hidden = !isList;
  if (els.readingPane) els.readingPane.hidden = !isThread;
  const showComposer = overlayCompose || inlineReply;
  if (els.composer) {
    els.composer.hidden = !showComposer;
  }
  placeComposer();
  if (els.composerChrome) els.composerChrome.hidden = !overlayCompose;
  if (els.composerTitle) els.composerTitle.textContent = composeOverlayTitle();
  if (els.composerMinimizeBtn) {
    const minimized = overlayCompose && state.composeMinimized;
    els.composerMinimizeBtn.setAttribute('aria-label', minimized ? t('Restore') : t('Minimize'));
    els.composerMinimizeBtn.innerHTML = minimized ? RESTORE_ICON : MINIMIZE_ICON;
  }
  if (els.composerExpandBtn) {
    const expanded = overlayCompose && state.composeExpanded;
    els.composerExpandBtn.setAttribute('aria-label', expanded ? t('Collapse') : t('Expand'));
    els.composerExpandBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    els.composerExpandBtn.innerHTML = expanded ? COLLAPSE_ICON : EXPAND_ICON;
  }
  if (els.composerCloseBtn) els.composerCloseBtn.setAttribute('aria-label', t('Close'));
  if (els.discardBtn) {
    els.discardBtn.hidden = !state.replying;
    els.discardBtn.textContent = t('Discard');
  }
  if (els.backBtn) {
    els.backBtn.hidden = isList;
    els.backBtn.setAttribute('aria-label', t('Back to list'));
  }

  if (els.mailToolbarTitle) {
    if (isThread) {
      const thread = (state.session?.threads ?? []).find((th) => th.id === state.activeThreadId);
      els.mailToolbarTitle.textContent = thread?.subject || t('Inbox');
    } else {
      els.mailToolbarTitle.textContent = mailboxLabel(state.activeMailbox);
    }
  }
  renderAssistantChips();
  renderQuickResultPanel();
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

  parkComposer();
  els.readingPane.innerHTML = '';
  if (!thread) {
    backToList();
    return;
  }
  for (const email of thread.emails ?? []) {
    els.readingPane.appendChild(renderEmail(email, learnerAddr));
  }
  // Always at the end of the thread — never mid-history under a stale focus.
  const suggestions = renderSuggestedReplies(thread, replyTargetEmail(thread));
  if (suggestions) els.readingPane.appendChild(suggestions);
  if (!state.replying) els.readingPane.appendChild(renderThreadActions());
  else placeComposer();
  renderAssistantChips();
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

/**
 * Email the learner is replying to / suggesting replies for.
 * Honor scenario focusedEmailId only while that email is still the tip;
 * after the thread grows, use the latest inbound (else last email).
 */
function replyTargetEmail(thread) {
  const emails = thread?.emails ?? [];
  if (!emails.length) return null;
  const last = emails[emails.length - 1];
  const focusedId = state.scenario?.focusedEmailId;
  if (focusedId) {
    const focused = emails.find((email) => email.id === focusedId);
    if (focused && focused.id === last.id) return focused;
  }
  return latestInboundEmail(thread, learnerEmail()) || last;
}

function applyThreadComposer(threadId, mode = state.replying || 'reply') {
  const thread = (state.session?.threads ?? []).find((th) => th.id === threadId);
  if (!thread) return;
  const headers = buildReplyHeaders(replyTargetEmail(thread), {
    mode,
    learnerEmail: learnerEmail(),
    subjectFallback: thread.subject || '',
  });
  // Only this thread's own reply draft. A new-message draft must not land here.
  const saved = draftForScope(state.session?.drafts, { scope: 'reply', threadId });
  applyRecipientDraft(saved ?? headers);
  els.composeSubject.value = saved?.subject || headers.subject;
  setEditorMarkdown(saved?.body || '');
  scheduleDraftSave();
}

function selectMailbox(mailbox) {
  state.activeMailbox = mailbox;
  state.view = 'list';
  state.replying = null;
  state.activeThreadId = null;
  renderShell();
}

function selectThread(threadId) {
  state.view = 'thread';
  state.replying = null;
  state.activeThreadId = threadId;
  renderShell();
}

function startReply(mode) {
  state.view = 'thread';
  state.composingNew = false;
  state.composeMinimized = false;
  state.composeExpanded = false;
  state.replying = mode;
  applyThreadComposer(state.activeThreadId, mode);
  renderShell();
  els.composer?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  state.editor?.commands.focus();
}

function cancelReply() {
  const threadId = state.activeThreadId;
  state.replying = null;
  if (threadId) {
    state.session.drafts = removeScopedDraft(state.session?.drafts, { scope: 'reply', threadId });
    void persistDrafts();
    // Discarded reply must not attribute Cosmo insert provenance to a later send.
    if (sameDraftScope(state.assistant.lastInserted, { scope: 'reply', threadId })) {
      state.assistant.lastInserted = null;
    }
  }
  setEditorMarkdown('');
  renderShell();
}

function startCompose({ blank = true } = {}) {
  if (state.composingNew) {
    state.composeMinimized = false;
    applyView();
    els.composeToAdd?.focus();
    return;
  }
  const wasReplying = Boolean(state.replying);
  state.composingNew = true;
  state.composeMinimized = false;
  state.composeExpanded = false;
  state.replying = null;
  if (state.view === 'compose') state.view = 'list';
  if (blank) {
    applyRecipientDraft({ to: [], cc: [] });
    els.composeSubject.value = '';
    setEditorMarkdown('');
    clearAttachments();
  }
  scheduleDraftSave();
  if (wasReplying && state.view === 'thread') renderThread(state.activeThreadId);
  applyView();
  els.composeToAdd?.focus();
}

function closeComposeOverlay() {
  if (!state.composingNew) return;
  clearTimeout(state.draftSaveTimer);
  void saveDraftNow();
  state.composingNew = false;
  state.composeMinimized = false;
  state.composeExpanded = false;
  applyView();
}

function toggleComposeMinimized() {
  if (!state.composingNew) return;
  if (state.composeExpanded) {
    state.composeExpanded = false;
    state.composeMinimized = true;
  } else {
    state.composeMinimized = !state.composeMinimized;
  }
  applyView();
  if (!state.composeMinimized) els.composeToAdd?.focus();
}

function toggleComposeExpanded() {
  if (!state.composingNew) return;
  state.composeMinimized = false;
  state.composeExpanded = !state.composeExpanded;
  applyView();
  if (state.composeExpanded) state.editor?.commands.focus();
  else els.composeToAdd?.focus();
}

function composeNewTo(email) {
  startCompose({ blank: true });
  addRecipient('to', email);
  state.openRecipientField = null;
  renderRecipientPickers();
  state.editor?.commands.focus();
}

function initMailtoCompose() {
  document.addEventListener('click', (event) => {
    const el = event.target instanceof Element ? event.target : event.target.parentElement;
    const link = el?.closest('a.js-compose-mailto');
    if (!link) return;
    event.preventDefault();
    if (!link.closest('.email__body, .assistant__msg')) return;
    const canonical = constrainToCharacters([link.getAttribute('data-email')], directoryCharacters())[0];
    if (!canonical) return;
    composeNewTo(canonical);
  });
}

function backToList() {
  state.view = 'list';
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

// Starting contents for a new message: a saved new-message draft, otherwise the
// scenario's initialDraft. Reply bodies are loaded per thread in applyThreadComposer.
function computeInitialDraft() {
  const saved = draftForScope(state.session?.drafts, { scope: 'new' });
  if (saved) return saved;

  const initial = state.config?.initialDraft;
  return {
    to: initial?.to ?? [],
    cc: initial?.cc ?? [],
    subject: initial?.subject || '',
    body: initial?.body || '',
  };
}

function draftScope() {
  if (state.composingNew) return { scope: 'new' };
  if (state.replying && state.activeThreadId) {
    return { scope: 'reply', threadId: state.activeThreadId };
  }
  return null;
}

function currentDraft() {
  const scope = draftScope();
  return {
    scope: scope?.scope || 'new',
    threadId: scope?.threadId || null,
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

async function persistDrafts() {
  if (!state.session?.sessionId) return;
  try {
    await fetch('/api/session/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.session.sessionId, drafts: state.session.drafts ?? [] }),
    });
  } catch (err) {
    console.error('[CosmoMail] draft save failed:', err);
  }
}

async function saveDraftNow() {
  if (!state.session?.sessionId || !draftScope()) return;
  state.session.drafts = upsertScopedDraft(state.session.drafts, currentDraft());
  await persistDrafts();
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
      StarterKit.configure({
        link: { openOnClick: false },
      }),
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
  els.composeSubject.addEventListener('input', () => {
    scheduleDraftSave();
    if (els.composerTitle && state.composingNew) {
      els.composerTitle.textContent = composeOverlayTitle();
    }
    if (state.composeExpanded && composeModal) {
      composeModal.overlay.setAttribute('aria-label', composeOverlayTitle());
    }
  });
  els.sendBtn.addEventListener('click', sendEmail);
  els.composeBtn?.addEventListener('click', () => startCompose({ blank: true }));
  els.backBtn?.addEventListener('click', backToList);
  els.discardBtn?.addEventListener('click', cancelReply);
  els.composerMinimizeBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleComposeMinimized();
  });
  els.composerExpandBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleComposeExpanded();
  });
  els.composerCloseBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    closeComposeOverlay();
  });
  els.composerChrome?.addEventListener('click', () => {
    if (state.composeMinimized) {
      state.composeMinimized = false;
      applyView();
      els.composeToAdd?.focus();
    }
  });
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
    <button type="button" class="button button-text button-xsmall mail-toast__close" aria-label="${escapeHtml(t('Dismiss'))}">
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
  // Stale chip suggestions belonged to the previous tip of the thread.
  if (state.assistant.suggestedReplies?.threadId === thread.id) {
    state.assistant.suggestedReplies = null;
  }
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
    const sentScope = draftScope() || { scope: 'new' };
    const composingNew = sentScope.scope === 'new';
    const inserted = sameDraftScope(state.assistant.lastInserted, sentScope)
      ? state.assistant.lastInserted
      : null;
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

    if (inserted?.draft) {
      void appendProvenanceEvents([
        makeDraftSentEvent({
          draftId: inserted.draftId,
          emailId: email?.id,
          threadId: thread?.id,
          inserted: inserted.draft,
          sent: {
            to: draft.to,
            cc: draft.cc,
            subject: draft.subject,
            body: draft.body,
          },
        }),
      ]);
      state.assistant.lastInserted = null;
    }

    replaceThread(thread);
    state.composingNew = false;
    state.composeMinimized = false;
    state.composeExpanded = false;
    state.replying = null;
    state.view = 'thread';
    state.activeThreadId = thread.id;
    state.activeMailbox = mailboxForThread(thread, learnerEmail());
    state.session.drafts = removeScopedDraft(state.session.drafts, sentScope);
    state.assistant.suggestedReplies = null;
    void persistDrafts();
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
// Serializes one thread into Markdown context (used for character replies).
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

// Whole-mailbox context for Cosmo. The full mailbox is only included when it
// changed since the last turn; see buildMailboxContext.
function assistantMailboxContext() {
  return buildMailboxContext({
    threads: state.session?.threads ?? [],
    learnerEmail: state.config?.learner?.email || 'you@example.com',
    viewing: {
      threadId: state.view === 'thread' ? state.activeThreadId : null,
      composingNew: state.composingNew && !state.composeMinimized,
      mailbox: state.activeMailbox,
    },
    previousHash: state.assistant.lastContextHash,
  });
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

function messageText(message) {
  if (!message) return '';
  if (message.parts) {
    return (message.parts ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
  }
  return message.content || '';
}

function draftsFromLiveMessage(message) {
  if (!message?.parts) return [];
  return draftsFromMessageParts(message.parts, {
    seenToolCallIds: new Set(), // display-only; persistence dedupes via state
  }).drafts;
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
    ? 'assistant__msg assistant__msg--user box non-interactive'
    : 'assistant__msg assistant__msg--ai box non-interactive';
  bubble.innerHTML = contentHtml;

  if (isUser) {
    row.appendChild(bubble);
    return row;
  }

  // AI turns stack commentary + draft in a column so the draft can use the
  // full panel width instead of sitting inside a second nested box.
  const turn = document.createElement('div');
  turn.className = 'assistant__turn';
  turn.appendChild(bubble);
  row.appendChild(turn);
  return row;
}

function appendDraftField(list, label, value) {
  const dt = document.createElement('dt');
  dt.className = 'body-xsmall assistant__draft-field-label';
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.className = 'body-xsmall assistant__draft-field-value';
  dd.textContent = value;
  list.appendChild(dt);
  list.appendChild(dd);
}

function appendDraftCard(row, draft, { streaming = false } = {}) {
  const turn = row.querySelector('.assistant__turn');
  const bubble = row.querySelector('.assistant__msg');
  if (!turn) return;

  const card = document.createElement('article');
  card.className = 'assistant__draft';
  card.dataset.draftId = draft.draftId || '';

  const toolbar = document.createElement('div');
  toolbar.className = 'assistant__draft-toolbar';
  const label = document.createElement('div');
  label.className = 'body-xsmall assistant__draft-label';
  label.textContent = streaming ? t('Drafting email…') : t('Draft');
  toolbar.appendChild(label);
  if (!streaming) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'button button-text-primary button-xsmall assistant__insert';
    btn.textContent = t('Insert');
    btn.setAttribute('aria-label', t('Insert into composer'));
    btn.addEventListener('click', () => {
      void insertProposedDraft(draft, { source: draft.source || PROPOSE_DRAFT_TOOL });
    });
    toolbar.appendChild(btn);
  }
  card.appendChild(toolbar);

  const fields = document.createElement('dl');
  fields.className = 'assistant__draft-fields';
  if (draft.to?.length) appendDraftField(fields, t('To'), draft.to.join(', '));
  if (draft.cc?.length) appendDraftField(fields, t('Cc'), draft.cc.join(', '));
  if (draft.subject) appendDraftField(fields, t('Subject'), draft.subject);
  if (fields.childElementCount) card.appendChild(fields);

  if (draft.body) {
    const bodyEl = document.createElement('div');
    bodyEl.className = 'assistant__draft-body body-small';
    bodyEl.innerHTML = renderMarkdown(draft.body);
    card.appendChild(bodyEl);
  }

  turn.appendChild(card);
  if (bubble && !bubble.textContent.trim()) bubble.hidden = true;
}

function appendFenceInsertFallback(row, markdown) {
  // Only when this bubble has no structured draft card yet.
  if (row.querySelector('.assistant__draft')) return;
  const code = extractLastCodeBlock(markdown);
  if (!code) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'button button-text-primary button-xsmall assistant__insert';
  btn.textContent = t('Insert into composer');
  btn.addEventListener('click', () => {
    // Parse after the composer/reply scope is opened inside insertProposedDraft.
    void insertProposedDraft({ source: 'fence' }, { source: 'fence', rawMarkdown: code });
  });
  row.querySelector('.assistant__msg')?.appendChild(btn);
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
    updateAssistantClearBtn();
    return;
  }

  for (const m of persisted) {
    const html = m.role === 'user' ? escapeHtml(m.content) : renderMarkdown(m.content);
    const row = makeBubble(m.role, html);
    if (m.role === 'assistant') {
      for (const draft of m.drafts ?? []) appendDraftCard(row, draft);
      appendFenceInsertFallback(row, m.content);
    }
    container.appendChild(row);
  }

  // Live (this page load) turns from OctavusChat.
  for (const m of liveMessages) {
    if (m.role === 'user') {
      const text = messageText(m) || m.content || '';
      container.appendChild(makeBubble('user', escapeHtml(text)));
    } else if (m.role === 'assistant') {
      const text = messageText(m);
      const drafts = draftsFromLiveMessage(m);
      const streaming = m.status === 'streaming';
      const row = makeBubble(
        'ai',
        renderMarkdown(text) || (drafts.length || streaming
          ? ''
          : '<span class="assistant__typing">…</span>'),
      );
      for (const draft of drafts) appendDraftCard(row, draft, { streaming });
      if (!streaming) appendFenceInsertFallback(row, text);
      container.appendChild(row);
    }
  }

  container.scrollTop = container.scrollHeight;
  updateAssistantClearBtn();
}

// The clear button is only actionable when there is something to clear and
// Cosmo is not mid-reply.
function updateAssistantClearBtn() {
  const btn = els.assistantClearBtn;
  if (!btn) return;
  const hasAny = state.assistant.persisted.length > 0
    || (state.assistant.chat?.messages?.length ?? 0) > 0;
  btn.disabled = !hasAny || state.assistant.chat?.status === 'streaming';
}

// Wipe the conversation (persisted + live) and start Cosmo on a fresh session.
async function clearAssistant() {
  const chat = state.assistant.chat;
  if (chat?.status === 'streaming') return;
  els.assistantClearBtn.disabled = true;
  try {
    const res = await fetch('/api/assistant/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.session.sessionId }),
    });
    if (!res.ok) throw new Error(`assistant clear failed (${res.status})`);
    const { octavusSessionId } = await res.json();

    state.assistant.persisted = [];
    state.session.assistantMessages = [];
    state.assistant.lastContextHash = null; // resend the full mailbox on the next turn
    if (octavusSessionId) state.assistant.octavusSessionId = octavusSessionId;
    // Replacing the live message list notifies subscribers, which re-renders.
    if (chat) chat.replaceMessages([]);
    else renderAssistant([]);
    els.assistantInput?.focus();
  } catch (err) {
    console.error('[CosmoMail] assistant clear failed:', err);
    updateAssistantClearBtn();
  }
}

function insertParseContext() {
  return {
    characters: directoryCharacters(),
    threads: state.session?.threads ?? [],
    learnerEmail: learnerEmail(),
    // New-message inserts stay unscoped; inline replies use the open thread.
    threadId: state.composingNew ? null : state.activeThreadId,
  };
}

// ── Quick actions (chips) ─────────────────────────────────────

function visibleQuickActionChips() {
  if (state.config?.assistant?.enabled === false) return [];
  const chips = resolveQuickActionChips({
    capabilities: state.config?.assistant?.capabilities,
    quickActions: state.config?.assistant?.quickActions,
  });
  const composerOpen = composerIsOpen();
  const inThread = state.view === 'thread' && Boolean(state.activeThreadId);
  return chips.filter((chip) => {
    if (chip.needsThread && !inThread) return false;
    if (chip.needsComposer && !composerOpen) return false;
    return true;
  });
}

function renderAssistantChips() {
  const host = els.assistantChips;
  if (!host) return;
  const chips = visibleQuickActionChips();
  host.innerHTML = '';
  if (!chips.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  for (const chip of chips) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'button button-tertiary button-xsmall assistant__chip';
    btn.textContent = t(chip.label);
    btn.disabled = state.assistant.quickActionBusy
      || state.assistant.chat?.status === 'streaming';
    btn.addEventListener('click', () => void runQuickAction(chip.id));
    host.appendChild(btn);
  }
}

function quickDraftBelongsToActiveThread(draft) {
  if (!draft?.sourceThreadId) return true;
  return state.view === 'thread' && state.activeThreadId === draft.sourceThreadId;
}

function renderQuickResultPanel() {
  const host = els.assistantQuickResult;
  if (!host) return;
  host.innerHTML = '';
  const draft = state.assistant.quickDraft;
  const ranking = String(state.assistant.triageRanking ?? '').trim();
  const showDraft = draft && quickDraftBelongsToActiveThread(draft);
  if (!showDraft && !ranking) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  if (ranking) {
    const row = document.createElement('div');
    row.className = 'assistant__row assistant__row--ai';
    const avatar = document.createElement('span');
    avatar.className = 'icon icon-cosmo-black icon-primary icon-small assistant__avatar';
    avatar.setAttribute('aria-hidden', 'true');
    row.appendChild(avatar);
    const turn = document.createElement('div');
    turn.className = 'assistant__turn';
    const card = document.createElement('div');
    card.className = 'assistant__triage';
    card.setAttribute('aria-label', t('Inbox priority'));
    const label = document.createElement('p');
    label.className = 'body-xsmall assistant__triage-label';
    label.textContent = t('Inbox priority');
    card.appendChild(label);
    const body = document.createElement('div');
    body.className = 'assistant__triage-body body-small';
    body.innerHTML = renderMarkdown(ranking);
    card.appendChild(body);
    turn.appendChild(card);
    row.appendChild(turn);
    host.appendChild(row);
  }

  if (showDraft) {
    const row = document.createElement('div');
    row.className = 'assistant__row assistant__row--ai';
    const avatar = document.createElement('span');
    avatar.className = 'icon icon-cosmo-black icon-primary icon-small assistant__avatar';
    avatar.setAttribute('aria-hidden', 'true');
    row.appendChild(avatar);
    const turn = document.createElement('div');
    turn.className = 'assistant__turn';
    row.appendChild(turn);
    host.appendChild(row);
    appendDraftCard(row, draft);
  }
}

function renderSuggestedReplies(thread, email) {
  const pack = state.assistant.suggestedReplies;
  if (!pack?.replies?.length) return null;
  if (pack.threadId !== thread.id) return null;
  // Drop suggestions that targeted an older message once the thread moved on.
  if (pack.emailId && email?.id && pack.emailId !== email.id) return null;

  const wrap = document.createElement('div');
  wrap.className = 'suggested-replies';
  wrap.setAttribute('aria-label', t('Suggested replies'));

  const label = document.createElement('p');
  label.className = 'body-xsmall suggested-replies__label';
  label.textContent = t('Suggested replies');
  wrap.appendChild(label);

  const list = document.createElement('div');
  list.className = 'suggested-replies__list';

  for (const body of pack.replies) {
    const btn = document.createElement('button');
    btn.type = 'button';
    // Not a design-system .button — those are fixed-height single-line controls.
    btn.className = 'suggested-replies__option body-small';
    btn.textContent = String(body ?? '').trim();
    btn.title = t('Insert into composer');
    btn.addEventListener('click', () => void applySuggestedReply(body));
    list.appendChild(btn);
  }
  wrap.appendChild(list);
  return wrap;
}

function focusedEmailMarkdown(thread) {
  const email = replyTargetEmail(thread);
  if (!email) return '';
  const lines = [
    `From: ${formatAddress(email.from)}`,
    `To: ${formatAddressList(email.to)}`,
  ];
  if (email.cc?.length) lines.push(`Cc: ${formatAddressList(email.cc)}`);
  if (email.date) lines.push(`Date: ${email.date}`);
  if (email.subject) lines.push(`Subject: ${email.subject}`);
  lines.push('', String(email.body ?? ''));
  return lines.join('\n');
}

async function runQuickAction(action, detail = '') {
  if (state.assistant.quickActionBusy) return;
  if (!state.session?.sessionId) return;
  state.assistant.quickActionBusy = true;
  renderAssistantChips();

  // Capture before the await — the learner may change threads while the request runs.
  // New-message compose is unscoped; reply chips bind to the open thread.
  const sourceThreadId = state.composingNew
    ? null
    : (state.view === 'thread' ? state.activeThreadId : null);
  const thread = (state.session?.threads ?? []).find((th) => th.id === sourceThreadId);
  const context = buildMailboxContext({
    threads: state.session?.threads ?? [],
    learnerEmail: learnerEmail(),
    viewing: {
      threadId: sourceThreadId,
      composingNew: state.composingNew && !state.composeMinimized,
      mailbox: state.activeMailbox,
    },
    previousHash: null, // always send full mailbox for one-shot sessions
  });

  try {
    const res = await fetch('/api/assistant/quick-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.session.sessionId,
        action,
        detail: detail || undefined,
        threadContext: context.text,
        focusedEmail: thread ? focusedEmailMarkdown(thread) : '',
        currentDraft: getEditorMarkdown() || currentDraftMarkdownWithHeaders(),
        threadId: sourceThreadId || null,
      }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `quick-action failed (${res.status})`);
    }
    const body = await res.json();
    if (Array.isArray(body.sessionEvents)) state.session.events = body.sessionEvents;
    else if (body.events?.length) {
      state.session.events = appendSessionEvents(state.session.events, body.events);
    }

    if (action === 'suggested_replies' && body.replies?.length) {
      const focus = thread ? replyTargetEmail(thread) : null;
      state.assistant.suggestedReplies = {
        threadId: sourceThreadId,
        emailId: focus?.id || null,
        replies: body.replies,
      };
      state.assistant.quickDraft = null;
      state.assistant.triageRanking = null;
      if (state.view === 'thread' && state.activeThreadId === sourceThreadId) {
        renderThread(sourceThreadId);
      }
    } else if (action === 'prioritize_inbox' && body.ranking) {
      state.assistant.triageRanking = body.ranking;
      state.assistant.quickDraft = null;
      state.assistant.suggestedReplies = null;
      renderQuickResultPanel();
    } else if (action === 'subject_recipients' && body.headers) {
      const stillOnSourceThread = sourceThreadId
        ? state.view === 'thread' && state.activeThreadId === sourceThreadId
        : Boolean(state.composingNew);
      if (stillOnSourceThread) {
        await applyHeaderSuggestion(body.headers, body.draftId);
      }
      state.assistant.quickDraft = null;
      state.assistant.triageRanking = null;
      renderQuickResultPanel();
    } else if (body.draft) {
      state.assistant.quickDraft = {
        draftId: body.draftId || newDraftId(),
        source: QUICK_ACTION_SOURCE,
        sourceThreadId: sourceThreadId || null,
        ...normalizeDraftFields(body.draft),
      };
      state.assistant.suggestedReplies = null;
      state.assistant.triageRanking = null;
      renderQuickResultPanel();
    }
  } catch (err) {
    console.error('[CosmoMail] quick action failed:', err);
  } finally {
    state.assistant.quickActionBusy = false;
    renderAssistantChips();
  }
}

function currentDraftMarkdownWithHeaders() {
  const draft = currentDraft();
  if (!draft.body && !draft.subject && !draft.to.length && !draft.cc.length) return '(empty)';
  return draftFieldsToMarkdown(draft);
}

async function applySuggestedReply(body) {
  const draftLike = {
    draftId: newDraftId(),
    to: [],
    cc: [],
    subject: '',
    body,
  };
  // Keep thread To/Subject from reply autofill; only fill the body.
  if (composerIsDirty() && getEditorMarkdown().trim()) {
    const ok = await confirmReplaceDraft();
    if (!ok) return;
  }
  // Dismiss the suggestion picker once the learner picks one.
  state.assistant.suggestedReplies = null;
  if (!state.replying && state.view === 'thread' && state.activeThreadId) {
    startReply('reply');
  } else if (!composerIsOpen()) {
    startCompose({ blank: true });
  } else if (state.view === 'thread' && state.activeThreadId) {
    renderThread(state.activeThreadId);
  }
  setEditorMarkdown(body);
  const scope = draftScope() || { scope: 'new' };
  const events = [
    makeDraftProposedEvent({
      draftId: draftLike.draftId,
      source: QUICK_ACTION_SOURCE,
      draft: { ...draftLike, ...normalizeDraftFields({ body }) },
    }),
    makeDraftInsertedEvent({
      draftId: draftLike.draftId,
      draft: normalizeDraftFields({
        to: state.recipients.to,
        cc: state.recipients.cc,
        subject: els.composeSubject?.value || '',
        body,
      }),
      scope,
      source: QUICK_ACTION_SOURCE,
    }),
  ];
  state.assistant.lastInserted = {
    draftId: draftLike.draftId,
    draft: normalizeDraftFields({
      to: state.recipients.to,
      cc: state.recipients.cc,
      subject: els.composeSubject?.value || '',
      body,
    }),
    source: QUICK_ACTION_SOURCE,
    scope: scope.scope,
    threadId: scope.threadId ?? null,
  };
  void appendProvenanceEvents(events);
  scheduleDraftSave();
  els.composer?.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

async function applyHeaderSuggestion(headers, draftId) {
  if (!composerIsOpen()) {
    if (state.view === 'thread' && state.activeThreadId) startReply('reply');
    else startCompose({ blank: true });
  }
  const fields = normalizeDraftFields({ ...headers, body: '' });
  if (fields.to.length || fields.cc.length) applyRecipientDraft(fields);
  if (fields.subject) {
    els.composeSubject.value = fields.subject;
    if (els.composerTitle && state.composingNew) {
      els.composerTitle.textContent = composeOverlayTitle();
    }
  }
  const scope = draftScope() || { scope: 'new' };
  const draftFields = normalizeDraftFields({
    ...fields,
    body: getEditorMarkdown(),
  });
  const id = draftId || newDraftId();
  void appendProvenanceEvents([
    makeDraftInsertedEvent({
      draftId: id,
      draft: draftFields,
      scope,
      source: QUICK_ACTION_SOURCE,
    }),
  ]);
  state.assistant.lastInserted = {
    draftId: id,
    draft: draftFields,
    source: QUICK_ACTION_SOURCE,
    scope: scope.scope,
    threadId: scope.threadId ?? null,
  };
  scheduleDraftSave();
}

function composerIsOpen() {
  return Boolean(state.composingNew || state.replying);
}

// Confirm before overwrite only when the open composer has user content.
// Reply mode pre-fills To/Subject from the thread, so those alone are not dirty.
function composerIsDirty() {
  if (!composerIsOpen()) return false;
  const draft = currentDraft();
  if (draft.body.trim()) return true;
  if (state.composingNew) {
    return Boolean(draft.subject.trim() || draft.to.length || draft.cc.length);
  }
  return false;
}

function confirmReplaceDraft() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const modal = new Modal({
      size: 'small',
      title: t('Replace current draft?'),
      content: `<p class="body-medium">${escapeHtml(
        t("You're already writing an email. Replace it with Cosmo's draft?"),
      )}</p>`,
      closeOnOverlayClick: false,
      footerButtons: [
        {
          label: t('Cancel'),
          type: 'secondary',
          onClick: () => {
            finish(false);
            modal.close();
          },
        },
        {
          label: t('Replace'),
          type: 'primary',
          onClick: () => {
            finish(true);
            modal.close();
          },
        },
      ],
      onClose: () => finish(false),
    });
    modal.open();
  });
}

async function appendProvenanceEvents(events) {
  if (!state.session?.sessionId || !events?.length) return;
  state.session.events = appendSessionEvents(state.session.events, events);
  try {
    const res = await fetch('/api/session/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.session.sessionId, events }),
    });
    if (!res.ok) throw new Error(`events failed (${res.status})`);
    const body = await res.json();
    if (Array.isArray(body.events)) state.session.events = body.events;
  } catch (err) {
    console.error('[CosmoMail] provenance save failed:', err);
  }
}

// Insert fills whatever the user is working in: the open new-message window, an
// inline reply on the open thread (started if needed), or a new message from the
// inbox list. Drafts are scoped, so the text stays with that message or thread.
async function insertProposedDraft(draftLike, { source = PROPOSE_DRAFT_TOOL, rawMarkdown = null } = {}) {
  const quick = state.assistant.quickDraft;
  if (
    quick
    && draftLike?.draftId
    && quick.draftId === draftLike.draftId
    && quick.sourceThreadId
    && (state.view !== 'thread' || state.activeThreadId !== quick.sourceThreadId)
  ) {
    // Quick-action drafts stay bound to the thread they were generated for.
    return;
  }

  if (composerIsDirty()) {
    const ok = await confirmReplaceDraft();
    if (!ok) return;
  }

  if (state.composingNew) {
    state.composeMinimized = false;
    applyView();
  } else if (state.view === 'thread' && state.activeThreadId) {
    if (!state.replying) startReply('reply');
  } else {
    startCompose({ blank: true });
  }

  const markdown = rawMarkdown || draftFieldsToMarkdown(draftLike);
  const parsed = parseInsertedDraft(markdown, insertParseContext());
  // Structured tool fields win when present (already normalized).
  const structured = normalizeDraftFields(draftLike);
  const fields = {
    to: structured.to.length ? structured.to : parsed.to,
    cc: structured.cc.length ? structured.cc : parsed.cc,
    subject: structured.subject || parsed.subject,
    body: structured.body || parsed.body,
  };

  if (fields.to.length || fields.cc.length) applyRecipientDraft(fields);
  if (fields.subject) {
    els.composeSubject.value = fields.subject;
    if (els.composerTitle && state.composingNew) {
      els.composerTitle.textContent = composeOverlayTitle();
    }
  }
  setEditorMarkdown(fields.body);

  const draftId = draftLike.draftId || newDraftId();
  const scope = draftScope() || { scope: 'new' };
  const events = [];
  if (source === 'fence') {
    events.push(makeDraftProposedEvent({ draftId, source: 'fence', draft: fields }));
  }
  events.push(makeDraftInsertedEvent({ draftId, draft: fields, scope, source }));
  state.assistant.lastInserted = {
    draftId,
    draft: fields,
    source,
    scope: scope.scope,
    threadId: scope.threadId ?? null,
  };
  void appendProvenanceEvents(events);

  if (state.assistant.quickDraft?.draftId === draftId) {
    state.assistant.quickDraft = null;
    renderQuickResultPanel();
  }

  scheduleDraftSave();
  els.composer?.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function persistAssistant() {
  const proposedEvents = [];
  const live = (state.assistant.chat?.messages ?? []).map((m) => {
    const content = messageText(m) || m.content || '';
    if (m.role !== 'assistant') {
      return { role: m.role, content, timestamp: new Date().toISOString() };
    }
    const { drafts, events } = draftsFromMessageParts(m.parts ?? [], {
      seenToolCallIds: state.assistant.seenToolCallIds,
    });
    proposedEvents.push(...events);
    return {
      role: 'assistant',
      content,
      drafts,
      timestamp: new Date().toISOString(),
    };
  });
  const all = [...state.assistant.persisted, ...live];
  state.session.assistantMessages = all;
  if (proposedEvents.length) {
    state.session.events = appendSessionEvents(state.session.events, proposedEvents);
  }
  fetch('/api/session/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: state.session.sessionId,
      assistantMessages: all,
      // Only new proposed events — save merges; do not resend the full log.
      ...(proposedEvents.length ? { events: proposedEvents } : {}),
    }),
  }).catch((err) => console.error('[CosmoMail] assistant save failed:', err));
}

function setAssistantEnabled(enabled) {
  els.assistantInput.disabled = !enabled;
  els.assistantSendBtn.disabled = !enabled || !els.assistantInput.value.trim();
}

async function initAssistant() {
  state.assistant.persisted = state.session?.assistantMessages ?? [];
  state.session.events = state.session?.events ?? [];
  state.assistant.seenToolCallIds = new Set(
    (state.session.events ?? [])
      .filter((event) => event.type === EVENT_TYPES.DRAFT_PROPOSED && event.toolCallId)
      .map((event) => event.toolCallId),
  );
  renderAssistant([]);
  els.assistantClearBtn?.addEventListener('click', clearAssistant);

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
    renderAssistantChips();
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
  renderAssistantChips();
  renderQuickResultPanel();
}

async function sendAssistant() {
  const chat = state.assistant.chat;
  if (!chat || chat.status === 'streaming') return;
  const text = els.assistantInput.value.trim();
  if (!text) return;
  els.assistantInput.value = '';
  setAssistantEnabled(false);

  const context = assistantMailboxContext();
  state.assistant.lastContextHash = context.hash;
  try {
    await chat.send(
      'assistant-message',
      {
        USER_MESSAGE: text,
        CUSTOM_INSTRUCTIONS: customInstructionsValue(),
        THREAD_CONTEXT: context.text,
        CURRENT_DRAFT: getEditorMarkdown() || '(empty)',
      },
      { userMessage: { content: text } },
    );
  } catch (err) {
    // The turn may not have reached the model; resend the full mailbox next time.
    state.assistant.lastContextHash = null;
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
    initMailtoCompose();
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
