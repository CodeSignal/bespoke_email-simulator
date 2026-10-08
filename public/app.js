/**
 * Mail — app.js (frontend entry, bundled by esbuild).
 *
 * Loads the scenario + session and renders the mailbox rail, mail list and
 * reading pane (emails rendered from Markdown), the TipTap composer, and the
 * AI Assistant panel (backed by the Cosmo agent on Octavus).
 */

import { OctavusChat, createHttpTransport } from '@octavus/client-sdk';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Placeholder } from '@tiptap/extensions';
import Modal from '../design-system/components/modal/modal.js';
import { Rive, RuntimeLoader } from '@rive-app/canvas';
import SplitPanel from '../design-system/components/split-panel/split-panel.js';
import {
  MAILBOXES,
  mailboxCounts,
  mailboxForThread,
  threadsInMailbox,
  buildReplyHeaders,
  threadListCorrespondent,
  latestInboundEmail,
  threadIsUnread,
  unreadEmailKeys,
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
import { draftForScope, draftHasPersistableContent, parseInsertedDraft, removeScopedDraft, sameDraftScope, upsertScopedDraft, visibleDrafts } from '../lib/drafts.js';
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
import { isDocumentLanguageTag } from '../lib/document-language.js';
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
    // marked preserves raw HTML by default; escape so sinks using innerHTML stay safe.
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, tokens }) {
      const email = parseMailto(href);
      if (!email) return false;
      const text = this.parser.parseInline(tokens);
      const canonical = constrainToCharacters([email], directoryCharacters())[0];
      if (!canonical) return text;
      // Stay in-app: mailto: is intercepted by browser/OS mail handlers and extensions.
      return `<button type="button" class="js-compose-mailto" data-email="${escapeHtml(canonical)}">${text}</button>`;
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
  activeDraftId: null,
  replying: null, // null | 'reply' | 'replyAll'
  selectedEmailId: null, // highlighted message in a multi-message thread
  replyToEmailId: null, // email a per-message reply button targeted
  recipients: { to: [], cc: [] },
  openRecipientField: null, // null | 'to' | 'cc'
  recipientQuery: { to: '', cc: '' }, // typeahead text per field
  recipientActiveIndex: 0, // highlighted suggestion in the open menu
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
    // Thinking indicator: when the current turn started, and how long each
    // finished turn thought (by live message id) for the "Thought for Ns" line.
    thinkingSince: null,
    thinkingKind: null, // 'chat' | 'quick'
    thoughtMs: {},
    quickThoughtMs: null, // last quick action's thinking time (not persisted)
    // One-shot rewrite/shorten/tone/proofread card (not part of chat transcript).
    quickDraft: null,
    // Inbox triage ranking from the prioritize chip (Markdown; not chat transcript).
    triageRanking: null,
    // Suggested reply options under the focused email.
    suggestedReplies: null, // { threadId, emailId, replies: string[], index }
  },
  characterSessions: {},
  attachments: [],
  mailSplit: null,
  railDrawerOpen: false,
  assistantDrawerOpen: false,
};

// ── DOM ───────────────────────────────────────────────────────
const els = {
  bootError: document.getElementById('bootError'),
  skipToMail: document.getElementById('skipToMail'),
  appTitle: document.getElementById('appTitle'),
  composeBtn: document.getElementById('composeBtn'),
  composeBtnLabel: document.getElementById('composeBtnLabel'),
  mailboxList: document.getElementById('mailboxList'),
  railDrawerBtn: document.getElementById('railDrawerBtn'),
  railDrawerBtnLabel: document.getElementById('railDrawerBtnLabel'),
  railDrawerCloseBtn: document.getElementById('railDrawerCloseBtn'),
  assistantDrawerBtn: document.getElementById('assistantDrawerBtn'),
  assistantDrawerBtnLabel: document.getElementById('assistantDrawerBtnLabel'),
  assistantDrawerCloseBtn: document.getElementById('assistantDrawerCloseBtn'),
  shellBackdrop: document.getElementById('shellBackdrop'),
  mailSplit: document.getElementById('mailSplit'),
  mailMain: document.getElementById('mailMain'),
  mailList: document.getElementById('mailList'),
  threadList: document.getElementById('threadList'),
  mailToolbarTitle: document.getElementById('mailToolbarTitle'),
  mailToolbarName: document.getElementById('mailToolbarName'),
  mailToolbarCount: document.getElementById('mailToolbarCount'),
  backBtn: document.getElementById('backBtn'),
  backBtnLabel: document.getElementById('backBtnLabel'),
  toolbarComposeBtn: document.getElementById('toolbarComposeBtn'),
  toolbarComposeLabel: document.getElementById('toolbarComposeLabel'),
  readingPane: document.getElementById('readingPane'),
  mailViewStatus: document.getElementById('mailViewStatus'),
  composerStatus: document.getElementById('composerStatus'),
  composer: document.getElementById('composer'),
  composerChrome: document.getElementById('composerChrome'),
  composerTitle: document.getElementById('composerTitle'),
  composerIcon: document.getElementById('composerIcon'),
  composerCloseBtn: document.getElementById('composerCloseBtn'),
  assistantHint: document.getElementById('assistantHint'),
  composeToLabel: document.getElementById('composeToLabel'),
  composeCcLabel: document.getElementById('composeCcLabel'),
  composeSubjectLabel: document.getElementById('composeSubjectLabel'),
  composeToPicker: document.getElementById('composeToPicker'),
  composeCcPicker: document.getElementById('composeCcPicker'),
  composeToChips: document.getElementById('composeToChips'),
  composeCcChips: document.getElementById('composeCcChips'),
  composeToInput: document.getElementById('composeToInput'),
  composeCcInput: document.getElementById('composeCcInput'),
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
  assistantPanel: document.getElementById('assistantPanel'),
  assistantContent: document.getElementById('assistantContent'),
  assistantMessages: document.getElementById('assistantMessages'),
  assistantInput: document.getElementById('assistantInput'),
  assistantInputHint: document.getElementById('assistantInputHint'),
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
  const day = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} ${time}`;
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

function isLearnerAddress(addr) {
  const email = addressEmail(addr).toLowerCase();
  const learner = learnerEmail().toLowerCase();
  return Boolean(email && learner && email === learner);
}

// Header recipient list: names only, with the learner shown as "You".
function recipientNames(list) {
  const items = Array.isArray(list) ? list : [list];
  return items
    .filter(Boolean)
    .map((addr) => (isLearnerAddress(addr) ? t('You') : displayName(personForAddress(addr)) || addressEmail(addr)))
    .join(', ');
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
  // Typeahead: clear the query and keep the caret right after the new
  // entry. The suggestions close so they don't cover the next row; typing
  // (or ArrowDown) opens them again.
  state.recipientQuery[field] = '';
  state.recipientActiveIndex = 0;
  const { input } = pickerEls(field);
  if (input) input.value = '';
  state.openRecipientField = null;
  renderRecipientPickers();
  scheduleDraftSave();
  input?.focus();
}

function removeRecipient(field, email) {
  const key = String(email || '').toLowerCase();
  state.recipients[field] = state.recipients[field].filter((value) => value.toLowerCase() !== key);
  renderRecipientPickers();
  scheduleDraftSave();
}

function pickerEls(field) {
  return field === 'cc'
    ? { picker: els.composeCcPicker, chips: els.composeCcChips, input: els.composeCcInput, menu: els.composeCcMenu }
    : { picker: els.composeToPicker, chips: els.composeToChips, input: els.composeToInput, menu: els.composeToMenu };
}

// Directory people not yet on the message, filtered by the typed query.
// Name-prefix matches rank first, then word-prefix, then anywhere in
// name / email / role.
function recipientMatches(field) {
  const remaining = availableCharacters(directoryCharacters(), { selected: selectedRecipientEmails() });
  const query = String(state.recipientQuery[field] || '').trim().toLowerCase();
  if (!query) return remaining;
  const ranked = [];
  for (const character of remaining) {
    const name = String(characterLabel(character) || '').toLowerCase();
    const email = String(character.email || '').toLowerCase();
    const role = String(character.role || '').toLowerCase();
    let rank = -1;
    if (name.startsWith(query) || email.startsWith(query)) rank = 0;
    else if (name.split(/\s+/).some((word) => word.startsWith(query))) rank = 1;
    else if (name.includes(query) || email.includes(query) || role.includes(query)) rank = 2;
    if (rank >= 0) ranked.push({ character, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.character);
}

function highlightMatch(text, query) {
  const value = String(text ?? '');
  const q = String(query || '').trim();
  const index = q ? value.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (index < 0) return escapeHtml(value);
  return `${escapeHtml(value.slice(0, index))}<mark class="recipient-picker__match">${escapeHtml(value.slice(index, index + q.length))}</mark>${escapeHtml(value.slice(index + q.length))}`;
}

function closeRecipientMenus() {
  state.openRecipientField = null;
  renderRecipientPickers();
}

function renderRecipientChip(field, email) {
  const character = characterByEmail(directoryCharacters(), email) || personForAddress(email);
  const chip = document.createElement('span');
  chip.className = 'recipient-picker__chip';
  chip.dataset.email = email;
  chip.insertAdjacentHTML('afterbegin', avatarMarkup(character, 'xs'));

  const label = document.createElement('span');
  label.className = 'recipient-picker__chip-name';
  label.textContent = characterLabel(character) || email;
  chip.appendChild(label);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'recipient-picker__remove';
  remove.setAttribute('aria-label', `${t('Remove')} ${label.textContent}`);
  remove.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>';
  remove.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    removeRecipient(field, email);
  });
  chip.appendChild(remove);
  return chip;
}

function renderRecipientMenu(field) {
  const { picker, input, menu } = pickerEls(field);
  const remaining = availableCharacters(directoryCharacters(), { selected: selectedRecipientEmails() });
  const matches = recipientMatches(field);
  const query = state.recipientQuery[field] || '';
  const open = state.openRecipientField === field && (matches.length > 0 || query.trim().length > 0);
  if (state.recipientActiveIndex >= matches.length) state.recipientActiveIndex = Math.max(0, matches.length - 1);

  if (picker) {
    picker.classList.toggle('is-open', open);
    picker.classList.toggle('open', open);
  }
  if (input) {
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Placeholder only while the row is empty; entries speak for themselves.
    input.placeholder = state.recipients[field].length ? '' : t('Type a name');
    // One naming method. aria-label wins over aria-labelledby, so a shared
    // "Add a recipient" label made To and Cc announce the same name.
    const fieldLabel = field === 'cc' ? t('Cc') : t('To');
    const hint = remaining.length ? t('Add a recipient') : t('No more people to add');
    input.setAttribute('aria-label', `${fieldLabel}, ${hint}`);
    input.removeAttribute('aria-labelledby');
  }
  if (!menu) return;
  menu.hidden = !open;
  menu.innerHTML = '';
  if (!open) {
    input?.removeAttribute('aria-activedescendant');
    return;
  }

  if (!matches.length) {
    const empty = document.createElement('li');
    empty.className = 'recipient-picker__empty';
    empty.setAttribute('role', 'presentation');
    empty.textContent = remaining.length ? t('No matching people') : t('No more people to add');
    menu.appendChild(empty);
    input?.removeAttribute('aria-activedescendant');
    return;
  }

  matches.forEach((character, index) => {
    const item = document.createElement('li');
    item.setAttribute('role', 'presentation');
    const option = document.createElement('div');
    option.id = `${field}-recipient-option-${index}`;
    option.className = 'dropdown-menu-item recipient-picker__option' + (index === state.recipientActiveIndex ? ' is-active' : '');
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', index === state.recipientActiveIndex ? 'true' : 'false');
    option.dataset.email = character.email;
    const content = document.createElement('span');
    content.className = 'dropdown-menu-item-content';
    content.insertAdjacentHTML('afterbegin', avatarMarkup(character, 'sm'));
    const text = document.createElement('span');
    text.className = 'recipient-picker__option-text';
    const name = document.createElement('span');
    name.className = 'dropdown-menu-item-label';
    name.innerHTML = highlightMatch(characterLabel(character), query);
    text.appendChild(name);
    const metaText = character.role || character.email;
    if (metaText) {
      const meta = document.createElement('span');
      meta.className = 'body-xsmall recipient-picker__option-meta';
      meta.innerHTML = highlightMatch(metaText, query);
      text.appendChild(meta);
    }
    content.appendChild(text);
    option.appendChild(content);
    // mousedown keeps focus in the input so the caret never leaves the row.
    option.addEventListener('mousedown', (event) => event.preventDefault());
    option.addEventListener('mouseenter', () => {
      if (state.recipientActiveIndex === index) return;
      state.recipientActiveIndex = index;
      renderRecipientMenu(field);
    });
    option.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      addRecipient(field, character.email);
    });
    item.appendChild(option);
    menu.appendChild(item);
  });
  if (input) input.setAttribute('aria-activedescendant', `${field}-recipient-option-${state.recipientActiveIndex}`);
  menu.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
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

function openRecipientMenu(field) {
  if (state.openRecipientField !== field) {
    state.openRecipientField = field;
    state.recipientActiveIndex = 0;
  }
  renderRecipientPickers();
}

function onRecipientKeydown(field, event) {
  const { input } = pickerEls(field);
  const matches = recipientMatches(field);
  const open = state.openRecipientField === field;
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      event.preventDefault();
      if (!open) {
        openRecipientMenu(field);
        return;
      }
      if (!matches.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      state.recipientActiveIndex = (state.recipientActiveIndex + step + matches.length) % matches.length;
      renderRecipientMenu(field);
      return;
    }
    case 'Enter':
    case 'Tab':
    case ',':
    case ';': {
      // Shift+Tab leaves the field. Treating it as a commit calls preventDefault
      // and focus stays in the combobox, so reverse tab never gets past To/Cc.
      if (event.key === 'Tab' && event.shiftKey) return;
      // Commit the highlighted match when the user has typed something
      // (Enter also commits from an open, untyped list).
      const typed = Boolean(String(input?.value || '').trim());
      if (!open || !matches.length || (!typed && event.key !== 'Enter')) return;
      event.preventDefault();
      addRecipient(field, matches[state.recipientActiveIndex]?.email ?? matches[0].email);
      return;
    }
    case 'Backspace': {
      if (input && input.selectionStart === 0 && input.selectionEnd === 0 && state.recipients[field].length) {
        event.preventDefault();
        const last = state.recipients[field][state.recipients[field].length - 1];
        removeRecipient(field, last);
        state.openRecipientField = field;
        renderRecipientPickers();
      }
      return;
    }
    case 'Escape':
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        closeRecipientMenus();
      }
      return;
    default:
  }
}

function initRecipientPickers() {
  for (const field of ['to', 'cc']) {
    const { picker, input } = pickerEls(field);
    if (!input) continue;
    input.addEventListener('focus', () => openRecipientMenu(field));
    input.addEventListener('input', () => {
      state.recipientQuery[field] = input.value;
      state.openRecipientField = field;
      state.recipientActiveIndex = 0;
      renderRecipientMenu(field);
    });
    input.addEventListener('keydown', (event) => onRecipientKeydown(field, event));
    input.addEventListener('blur', () => {
      // Leaving the field drops the half-typed query (only directory people
      // can be added) and closes the suggestions. Rebuild the menu only:
      // rebuilding chips destroys the remove button Shift+Tab is moving to,
      // and focus falls back into this field.
      if (state.openRecipientField === field) state.openRecipientField = null;
      state.recipientQuery[field] = '';
      input.value = '';
      renderRecipientMenu(field);
    });
    // Clicking anywhere on the whole 42px row (label, padding, entries, empty
    // space) puts the caret after the last entry. A second click on the
    // already-focused input does not fire `focus` again, so reopen the list.
    const row = picker?.closest('.composer__field') || picker;
    row?.addEventListener('mousedown', (event) => {
      if (event.target.closest('.recipient-picker__remove, .recipient-picker__option, .recipient-picker__menu')) return;
      const onInput = event.target === input;
      if (!onInput) event.preventDefault();
      if (document.activeElement === input) openRecipientMenu(field);
      else input.focus();
      if (!onInput) input.setSelectionRange(input.value.length, input.value.length);
    });
  }
  // Capture phase so components that stop propagation (e.g. design-system
  // Modals) can't keep a suggestions menu open behind them.
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

function readEmailIdSet() {
  return new Set(state.session?.readEmailIds ?? []);
}

function isThreadUnread(thread) {
  return threadIsUnread(thread, readEmailIdSet(), learnerEmail());
}

// Opening a conversation reads all of its received mail. Persisted on the
// session so the inbox markers survive a reload.
function markThreadRead(thread) {
  const keys = unreadEmailKeys(thread, readEmailIdSet(), learnerEmail());
  if (!keys.length || !state.session) return;
  state.session.readEmailIds = [...(state.session.readEmailIds ?? []), ...keys];
  renderMailboxes();
  if (!state.session.sessionId) return;
  fetch('/api/session/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: state.session.sessionId, readEmailIds: keys }),
  }).catch((err) => console.error('[Mail] read state save failed:', err));
}

function savedDrafts() {
  return visibleDrafts(state.session?.drafts).slice().sort((a, b) => {
    const ta = Date.parse(a?.updated_at) || 0;
    const tb = Date.parse(b?.updated_at) || 0;
    return tb - ta;
  });
}

function visibleThreads() {
  if (state.activeMailbox === 'drafts') return [];
  return threadsInMailbox(state.session?.threads ?? [], state.activeMailbox, learnerEmail());
}

function mailboxItemCount() {
  return state.activeMailbox === 'drafts' ? savedDrafts().length : visibleThreads().length;
}

function mailboxLabel(mailbox) {
  const box = MAILBOXES.find((m) => m.id === mailbox);
  return t(box?.label || 'Inbox');
}

function backLabel(mailbox) {
  if (mailbox === 'sent') return t('Back to sent');
  if (mailbox === 'spam') return t('Back to spam');
  if (mailbox === 'drafts') return t('Back to drafts');
  return t('Back to inbox');
}

function emptyMailboxCopy(mailbox) {
  if (mailbox === 'sent') {
    return { title: t('No sent messages'), body: t('Messages you send will appear here.') };
  }
  if (mailbox === 'spam') {
    return { title: t('Hooray, no spam here!'), body: t('Messages that look like spam will show up in this folder.') };
  }
  if (mailbox === 'drafts') {
    return { title: t('No drafts'), body: t('Messages you start and close without sending will show up here.') };
  }
  return { title: t('Inbox Zero'), body: t("You're all caught up. No new mail.") };
}

const MAILBOX_ICONS = {
  inbox: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.66667 8H3.92131C4.37811 8 4.79571 8.25809 5 8.66667C5.20429 9.07524 5.62189 9.33333 6.07869 9.33333H9.92131C10.3781 9.33333 10.7957 9.07524 11 8.66667C11.2043 8.25809 11.6219 8 12.0787 8H14.3333M5.97771 2.66667H10.0223C10.7402 2.66667 11.0992 2.66667 11.4161 2.77598C11.6963 2.87264 11.9516 3.0304 12.1634 3.23783C12.4029 3.4724 12.5634 3.79347 12.8845 4.43558L14.3288 7.32433C14.4548 7.57632 14.5178 7.70232 14.5623 7.83437C14.6017 7.95163 14.6302 8.07231 14.6473 8.19484C14.6667 8.33282 14.6667 8.47368 14.6667 8.75542V10.1333C14.6667 11.2534 14.6667 11.8135 14.4487 12.2413C14.2569 12.6176 13.951 12.9236 13.5746 13.1153C13.1468 13.3333 12.5868 13.3333 11.4667 13.3333H4.53333C3.41323 13.3333 2.85318 13.3333 2.42535 13.1153C2.04903 12.9236 1.74307 12.6176 1.55132 12.2413C1.33333 11.8135 1.33333 11.2534 1.33333 10.1333V8.75542C1.33333 8.47368 1.33333 8.33282 1.35265 8.19484C1.3698 8.07231 1.39829 7.95163 1.43775 7.83437C1.48217 7.70232 1.54517 7.57632 1.67117 7.32433L3.11554 4.43558C3.4366 3.79346 3.59713 3.4724 3.83663 3.23783C4.04842 3.0304 4.30368 2.87264 4.58393 2.77598C4.90084 2.66667 5.25979 2.66667 5.97771 2.66667Z"/></svg>',
  drafts: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.33333 1.33333H4.53333C3.41323 1.33333 2.85318 1.33333 2.42535 1.55132C2.04903 1.74307 1.74307 2.04903 1.55132 2.42535C1.33333 2.85318 1.33333 3.41323 1.33333 4.53333V11.4667C1.33333 12.5868 1.33333 13.1468 1.55132 13.5746C1.74307 13.951 2.04903 14.2569 2.42535 14.4487C2.85318 14.6667 3.41323 14.6667 4.53333 14.6667H11.4667C12.5868 14.6667 13.1468 14.6667 13.5746 14.4487C13.951 14.2569 14.2569 13.951 14.4487 13.5746C14.6667 13.1468 14.6667 12.5868 14.6667 11.4667V6.66667M9.33333 1.33333L14.6667 6.66667M9.33333 1.33333V5.46667C9.33333 5.84036 9.33333 6.02721 9.40607 6.16996C9.47007 6.2955 9.57117 6.3966 9.69671 6.4606C9.83946 6.53333 10.0263 6.53333 10.4 6.53333H14.6667M5.33333 8.66667H8M5.33333 11.3333H10.6667"/></svg>',
  sent: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.00028 8.00002H3.33362M3.27718 8.19436L1.72057 12.8442C1.59828 13.2094 1.53713 13.3921 1.58101 13.5046C1.61912 13.6022 1.70096 13.6763 1.80195 13.7045C1.91824 13.7369 2.09388 13.6579 2.44517 13.4998L13.5862 8.48638C13.929 8.33209 14.1005 8.25494 14.1535 8.14776C14.1995 8.05465 14.1995 7.9454 14.1535 7.85229C14.1005 7.74511 13.929 7.66796 13.5862 7.51367L2.44129 2.49851C2.09106 2.3409 1.91595 2.2621 1.79977 2.29443C1.69888 2.3225 1.61704 2.39636 1.57881 2.49385C1.53478 2.60612 1.59527 2.78837 1.71625 3.15287L3.27761 7.85704C3.29839 7.91965 3.30878 7.95095 3.31288 7.98296C3.31652 8.01137 3.31649 8.04013 3.31277 8.06853C3.30859 8.10053 3.29812 8.13181 3.27718 8.19436Z"/></svg>',
  spam: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.28667 3.28667L12.7133 12.7133M1.33333 5.68183V10.3182C1.33333 10.4812 1.33333 10.5628 1.35175 10.6395C1.36808 10.7075 1.39502 10.7725 1.43157 10.8322C1.4728 10.8995 1.53045 10.9571 1.64575 11.0724L4.92758 14.3542C5.04288 14.4695 5.10053 14.5272 5.16781 14.5684C5.22746 14.605 5.29249 14.6319 5.36051 14.6482C5.43724 14.6667 5.51877 14.6667 5.68183 14.6667H10.3182C10.4812 14.6667 10.5628 14.6667 10.6395 14.6482C10.7075 14.6319 10.7725 14.605 10.8322 14.5684C10.8995 14.5272 10.9571 14.4695 11.0724 14.3542L14.3542 11.0724C14.4695 10.9571 14.5272 10.8995 14.5684 10.8322C14.605 10.7725 14.6319 10.7075 14.6482 10.6395C14.6667 10.5628 14.6667 10.4812 14.6667 10.3182V5.68183C14.6667 5.51877 14.6667 5.43724 14.6482 5.36051C14.6319 5.29249 14.605 5.22746 14.5684 5.16781C14.5272 5.10053 14.4695 5.04288 14.3542 4.92758L11.0724 1.64575C10.9571 1.53045 10.8995 1.4728 10.8322 1.43157C10.7725 1.39502 10.7075 1.36808 10.6395 1.35175C10.5628 1.33333 10.4812 1.33333 10.3182 1.33333H5.68183C5.51877 1.33333 5.43724 1.33333 5.36051 1.35175C5.29249 1.36808 5.22746 1.39502 5.16781 1.43157C5.10053 1.4728 5.04288 1.53045 4.92758 1.64575L1.64575 4.92758C1.53045 5.04288 1.4728 5.10053 1.43157 5.16781C1.39502 5.22746 1.36808 5.29249 1.35175 5.36051C1.33333 5.43724 1.33333 5.51877 1.33333 5.68183Z"/></svg>',
};

// Figma "Row" (490:13178): reply / reply-all on the email head divider.
// Stroke redraws of the Figma glyphs (fi_2990259 / reply all) so the line
// weight can be set: 1.25px.
const EMAIL_REPLY_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.25 2.5 1.25 7l5 4.5M1.75 7h4.5c4.25 0 6.5 1.75 6.5 5.5"/></svg>';
const EMAIL_REPLY_ALL_ICON = '<svg width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.75 2.5 0.75 7l4 4.5M8.25 2.5 3.75 7l4.5 4.5M4.25 7h3.75c4.25 0 6.5 1.75 6.5 5.5"/></svg>';

// Figma untitled-ui mail-01 with lines (thread header).
const THREAD_ICON = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.66667 5.14583L6.59962 8.59889C6.99907 8.87851 7.1988 9.01832 7.41605 9.07247C7.60795 9.12031 7.80866 9.12031 8.00056 9.07247C8.21781 9.01832 8.41754 8.87851 8.817 8.59889L13.7499 5.14583M13.7499 8.16665V6.23332C13.7499 5.21823 13.7499 4.71068 13.5524 4.32297C13.3786 3.98193 13.1014 3.70465 12.7603 3.53088C12.3726 3.33333 11.8651 3.33333 10.85 3.33333H4.56665C3.55156 3.33333 3.04402 3.33333 2.6563 3.53088C2.31526 3.70465 2.03799 3.98193 1.86422 4.32297C1.66667 4.71068 1.66667 5.21823 1.66667 6.23332V10.1C1.66667 11.1151 1.66667 11.6226 1.86422 12.0103C2.03799 12.3514 2.31526 12.6286 2.6563 12.8024C3.04402 13 3.55156 13 4.56665 13H8.70831"/><path d="M11 10.5H18M11 13.5H18M11 16.5H16"/></svg>';

// Figma "Content Icon" sparkles used inside AI Assistant action chips.
const CHIP_ICON = '<span class="assistant__chip-icon" aria-hidden="true"><img src="/icons/chip-sparkles.svg" width="18" height="18" alt="" /></span>';

function renderShell() {
  if (state.view === 'compose') state.view = 'list';
  renderMailboxes();
  if (state.view === 'list') renderMailList();
  else if (state.view === 'thread') renderThread(state.activeThreadId);
  applyView();
}

// Composer head icons (Figma "Replying" › Head): reply arrow for replies,
// untitled-ui edit-03 for a new message. Both tint with Icon/Primary/Default.
const COMPOSER_REPLY_ICON = '<svg width="13" height="14" viewBox="0 0 12.9376 13.5058" fill="currentColor" aria-hidden="true"><path d="M6.18669 3.3738V0.561079C6.18639 0.447659 6.15182 0.336976 6.0875 0.243553C6.02319 0.15013 5.93214 0.0783306 5.82629 0.037574C5.72044 -0.00318247 5.60475 -0.0109922 5.49439 0.0151697C5.38403 0.0413316 5.28415 0.100243 5.20786 0.184175L0.144972 5.80961C0.05168 5.91298 3.91006e-05 6.04727 3.91006e-05 6.18651C3.91006e-05 6.32575 0.05168 6.46005 0.144972 6.56342L5.20786 12.1888C5.28415 12.2728 5.38403 12.3317 5.49439 12.3579C5.60475 12.384 5.72044 12.3762 5.82629 12.3355C5.93214 12.2947 6.02319 12.2229 6.0875 12.1295C6.15182 12.036 6.18639 11.9254 6.18669 11.8119V8.99923C9.48319 9.11174 10.1695 10.2818 11.4746 12.5039C11.604 12.7345 11.7446 12.9708 11.8909 13.2127C11.9392 13.2987 12.0094 13.3706 12.0943 13.4209C12.1793 13.4713 12.2759 13.4984 12.3747 13.4996C12.425 13.5078 12.4763 13.5078 12.5266 13.4996C12.6482 13.4655 12.7549 13.3915 12.8294 13.2895C12.9039 13.1875 12.9419 13.0633 12.9372 12.937C12.9372 9.67991 12.9372 3.70007 6.18669 3.3738ZM5.62414 7.87414C5.47495 7.87414 5.33186 7.93341 5.22637 8.03891C5.12087 8.1444 5.0616 8.28749 5.0616 8.43669V10.3437L1.32069 6.18651L5.0616 2.02932V3.93634C5.0616 4.08553 5.12087 4.22862 5.22637 4.33412C5.33186 4.43961 5.47495 4.49888 5.62414 4.49888C10.6027 4.49888 11.5759 7.78976 11.7671 10.8219C10.6083 8.99923 9.33693 7.87414 5.62414 7.87414Z"/></svg>';
const COMPOSER_NEW_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20H21M3.00003 20H4.67457C5.16375 20 5.40834 20 5.63852 19.9447C5.84259 19.8957 6.03768 19.8149 6.21662 19.7053C6.41846 19.5816 6.59141 19.4086 6.93731 19.0627L19.5001 6.49999C20.3285 5.67156 20.3285 4.32842 19.5001 3.49999C18.6716 2.67156 17.3285 2.67156 16.5001 3.49999L3.93729 16.0627C3.59138 16.4086 3.41843 16.5816 3.29475 16.7834C3.18509 16.9624 3.10428 17.1575 3.05529 17.3615C3.00003 17.5917 3.00003 17.8363 3.00003 18.3255V20Z"/></svg>';

function composeOverlayTitle() {
  return state.composingNew ? t('New message') : t('Reply to');
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

// One panel serves new messages and replies. A reply sits at the end of the
// conversation (sticky to the pane bottom); a new message floats over the
// bottom of the main column so it works from any view.
function placeComposer() {
  if (!els.composer) return;
  const newMessage = Boolean(state.composingNew);
  const inlineReply = !newMessage && state.view === 'thread' && Boolean(state.replying);
  els.composer.classList.toggle('is-new', newMessage);
  els.composer.classList.toggle('is-inline', inlineReply);

  if (inlineReply && els.readingPane && !els.readingPane.hidden) {
    els.readingPane.appendChild(els.composer);
  } else {
    dockComposer();
  }
}

// WCAG 2.4.11: a focused control must not sit fully underneath the new-message
// overlay or the sticky reply composer. Covered controls leave the tab order
// until they are no longer fully covered.
const COVERED_FOCUS_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
].join(', ');

function coveringComposer() {
  const composer = els.composer;
  if (!composer || composer.hidden) return null;
  if (!composer.classList.contains('is-new') && !composer.classList.contains('is-inline')) return null;
  return composer;
}

function isFullyCovered(el, cover) {
  const box = el.getBoundingClientRect();
  const panel = cover.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0 || panel.width <= 0 || panel.height <= 0) return false;
  return box.top >= panel.top - 0.5
    && box.left >= panel.left - 0.5
    && box.bottom <= panel.bottom + 0.5
    && box.right <= panel.right + 0.5;
}

function rememberCoveredTab(el) {
  if (!el.hasAttribute('data-focus-covered')) {
    el.setAttribute('data-covered-tabindex', el.hasAttribute('tabindex') ? el.getAttribute('tabindex') : '');
    el.setAttribute('data-focus-covered', '');
  }
  if (el.getAttribute('tabindex') !== '-1') el.setAttribute('tabindex', '-1');
}

function restoreCoveredTab(el) {
  if (!el.hasAttribute('data-focus-covered')) return;
  const previous = el.getAttribute('data-covered-tabindex');
  if (previous) el.setAttribute('tabindex', previous);
  else el.removeAttribute('tabindex');
  el.removeAttribute('data-covered-tabindex');
  el.removeAttribute('data-focus-covered');
}

function focusControl(el) {
  if (!el || typeof el.focus !== 'function') return;
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
}

let syncingCoveredFocus = false;

function syncCoveredFocus() {
  if (syncingCoveredFocus || !els.mailMain) return;
  syncingCoveredFocus = true;
  try {
    const composer = coveringComposer();
    const marked = [...els.mailMain.querySelectorAll('[data-focus-covered]')];
    if (!composer) {
      for (const el of marked) restoreCoveredTab(el);
      return;
    }

    const candidates = [...els.mailMain.querySelectorAll(COVERED_FOCUS_SELECTOR)].filter((el) => {
      if (composer.contains(el)) return false;
      if (el.closest('[hidden]')) return false;
      return true;
    });
    const coveredNow = new Set();
    for (const el of candidates) {
      if (!isFullyCovered(el, composer)) continue;
      rememberCoveredTab(el);
      coveredNow.add(el);
    }
    for (const el of marked) {
      if (!coveredNow.has(el)) restoreCoveredTab(el);
    }

    const active = document.activeElement;
    if (!active || active === document.body || composer.contains(active) || !isFullyCovered(active, composer)) return;
    const panelTop = composer.getBoundingClientRect().top;
    const above = candidates.filter((el) => {
      if (coveredNow.has(el)) return false;
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.bottom <= panelTop + 0.5;
    });
    focusControl(above[above.length - 1] || els.composerCloseBtn || composer);
  } finally {
    syncingCoveredFocus = false;
  }
}

// Below this width the fixed rail plus the assistant split leaves the mail
// column too narrow to read (WCAG 1.4.10). Keep this in step with the
// matching @media rule in app.css.
const NARROW_SHELL_QUERY = '(max-width: 959px)';

function isNarrowShell() {
  return window.matchMedia(NARROW_SHELL_QUERY).matches;
}

function assistantFeatureOff() {
  return state.config?.assistant?.enabled === false;
}

function assistantDrawerHost() {
  const panel = els.assistantPanel;
  if (!panel) return null;
  return panel.closest('.split-panel-right') || panel;
}

function splitDivider() {
  return els.mailSplit?.querySelector('.split-panel-divider') || null;
}

function setNarrowHidden(el, hidden) {
  if (!el) return;
  if (hidden) {
    el.hidden = true;
    el.setAttribute('data-narrow-hidden', '');
    return;
  }
  if (!el.hasAttribute('data-narrow-hidden')) return;
  el.hidden = false;
  el.removeAttribute('data-narrow-hidden');
}

function setInert(el, inert) {
  if (!el) return;
  el.inert = Boolean(inert);
}

function showDrawerHost(el) {
  if (!el) return;
  el.hidden = false;
  el.removeAttribute('data-narrow-hidden');
  el.classList.add('is-drawer-open');
}

function hideDrawerHost(el) {
  if (!el) return;
  el.classList.remove('is-drawer-open');
  setNarrowHidden(el, true);
}

let drawerReturnFocus = null;

function focusDrawer(root) {
  const closeBtn = root?.querySelector('.rail__drawer-close, .assistant__drawer-close');
  focusControl(closeBtn || root);
}

function openRailDrawer() {
  if (!isNarrowShell()) return;
  drawerReturnFocus = document.activeElement;
  state.railDrawerOpen = true;
  state.assistantDrawerOpen = false;
  applyNarrowShell();
  focusDrawer(document.getElementById('threadRail'));
}

function openAssistantDrawer() {
  if (!isNarrowShell() || assistantFeatureOff()) return;
  drawerReturnFocus = document.activeElement;
  state.assistantDrawerOpen = true;
  state.railDrawerOpen = false;
  applyNarrowShell();
  focusDrawer(els.assistantPanel);
}

function closeShellDrawers() {
  const wasRail = state.railDrawerOpen;
  const wasAssistant = state.assistantDrawerOpen;
  const returnTo = drawerReturnFocus;
  state.railDrawerOpen = false;
  state.assistantDrawerOpen = false;
  drawerReturnFocus = null;
  applyNarrowShell();
  if (!wasRail && !wasAssistant) return;
  const fallback = wasRail ? els.railDrawerBtn : els.assistantDrawerBtn;
  const target = returnTo && returnTo.isConnected && !returnTo.closest('[hidden]') ? returnTo : fallback;
  focusControl(target);
}

function applyNarrowShell() {
  const narrow = isNarrowShell();
  const app = document.getElementById('mailApp');
  app?.classList.toggle('is-narrow', narrow);

  const rail = document.getElementById('threadRail');
  const assistantHost = assistantDrawerHost();
  const assistantOff = assistantFeatureOff();
  const divider = splitDivider();
  const railOpen = narrow && Boolean(state.railDrawerOpen);
  const assistantOpen = narrow && Boolean(state.assistantDrawerOpen) && !assistantOff;

  if (!narrow) {
    state.railDrawerOpen = false;
    state.assistantDrawerOpen = false;
  }

  if (rail) {
    if (railOpen) showDrawerHost(rail);
    else if (narrow) hideDrawerHost(rail);
    else {
      rail.classList.remove('is-drawer-open');
      setNarrowHidden(rail, false);
      rail.hidden = false;
    }
    setInert(rail, assistantOpen);
  }

  if (assistantHost) {
    if (assistantOff) {
      assistantHost.classList.remove('is-drawer-open');
      if (narrow) {
        if (els.assistantPanel && !els.assistantPanel.hidden) setNarrowHidden(els.assistantPanel, true);
        if (assistantHost !== els.assistantPanel && !assistantHost.hidden) setNarrowHidden(assistantHost, true);
      } else {
        setNarrowHidden(els.assistantPanel, false);
        if (assistantHost !== els.assistantPanel) setNarrowHidden(assistantHost, false);
      }
    } else if (assistantOpen) {
      showDrawerHost(assistantHost);
      if (assistantHost !== els.assistantPanel) {
        els.assistantPanel.hidden = false;
        els.assistantPanel.removeAttribute('data-narrow-hidden');
      }
    } else if (narrow) {
      hideDrawerHost(assistantHost);
    } else {
      assistantHost.classList.remove('is-drawer-open');
      setNarrowHidden(assistantHost, false);
      if (assistantHost !== els.assistantPanel) setNarrowHidden(els.assistantPanel, false);
    }
    setInert(assistantHost, railOpen);
  }

  if (divider) setNarrowHidden(divider, narrow);
  setInert(els.mailMain, railOpen || assistantOpen);
  if (els.shellBackdrop) els.shellBackdrop.hidden = !(railOpen || assistantOpen);

  if (els.railDrawerBtn) {
    els.railDrawerBtn.hidden = !narrow;
    els.railDrawerBtn.setAttribute('aria-expanded', railOpen ? 'true' : 'false');
  }
  if (els.railDrawerBtnLabel) els.railDrawerBtnLabel.textContent = t('Folders');
  if (els.assistantDrawerBtn) {
    els.assistantDrawerBtn.hidden = !narrow || assistantOff;
    els.assistantDrawerBtn.setAttribute('aria-expanded', assistantOpen ? 'true' : 'false');
  }
  if (els.assistantDrawerBtnLabel) els.assistantDrawerBtnLabel.textContent = t('AI Assistant');
  if (els.railDrawerCloseBtn) {
    els.railDrawerCloseBtn.hidden = !railOpen;
    els.railDrawerCloseBtn.setAttribute('aria-label', t('Close'));
  }
  if (els.assistantDrawerCloseBtn) {
    els.assistantDrawerCloseBtn.hidden = !assistantOpen;
    els.assistantDrawerCloseBtn.setAttribute('aria-label', t('Close'));
  }
}

function initShellDrawers() {
  if (initShellDrawers.done) return;
  initShellDrawers.done = true;
  els.railDrawerBtn?.addEventListener('click', () => {
    if (state.railDrawerOpen) closeShellDrawers();
    else openRailDrawer();
  });
  els.railDrawerCloseBtn?.addEventListener('click', () => closeShellDrawers());
  els.assistantDrawerBtn?.addEventListener('click', () => {
    if (state.assistantDrawerOpen) closeShellDrawers();
    else openAssistantDrawer();
  });
  els.assistantDrawerCloseBtn?.addEventListener('click', () => closeShellDrawers());
  els.shellBackdrop?.addEventListener('click', () => closeShellDrawers());
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!state.railDrawerOpen && !state.assistantDrawerOpen) return;
    event.preventDefault();
    closeShellDrawers();
  });
  window.addEventListener('resize', () => {
    applyNarrowShell();
    syncCoveredFocus();
  });
  window.matchMedia(NARROW_SHELL_QUERY).addEventListener?.('change', () => applyNarrowShell());
}

function initCoveredFocus() {
  if (initCoveredFocus.done || typeof ResizeObserver === 'undefined') return;
  initCoveredFocus.done = true;
  const observer = new ResizeObserver(() => syncCoveredFocus());
  if (els.composer) observer.observe(els.composer);
  if (els.mailMain) observer.observe(els.mailMain);
}

// Toolbar hairline while the visible content is scrolled: the list, the
// reading pane, or a single message's body.
function updateToolbarScrolled() {
  const toolbar = document.getElementById('mailToolbar');
  if (!toolbar) return;
  const scrollers = state.view === 'thread'
    ? [els.readingPane, els.readingPane?.querySelector('.reading-pane--single > .email .email__content')]
    : [els.threadList];
  toolbar.classList.toggle('is-scrolled', scrollers.some((el) => el && !el.hidden && el.scrollTop > 0));
  syncCoveredFocus();
}

function initToolbarScrollShadow() {
  // Capture phase: scroll events don't bubble, and message bodies are rendered later.
  els.mailMain?.addEventListener('scroll', updateToolbarScrolled, { capture: true, passive: true });
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
  if (els.composerTitle) els.composerTitle.textContent = composeOverlayTitle();
  if (els.composerIcon) els.composerIcon.innerHTML = overlayCompose ? COMPOSER_NEW_ICON : COMPOSER_REPLY_ICON;
  if (els.composer) els.composer.setAttribute('aria-label', composeOverlayTitle());
  if (els.composerCloseBtn) {
    els.composerCloseBtn.setAttribute('aria-label', t('Close'));
    els.composerCloseBtn.title = t('Close');
  }
  if (els.discardBtn) {
    els.discardBtn.hidden = !showComposer;
    els.discardBtn.textContent = t('Cancel');
  }
  if (els.backBtn) {
    els.backBtn.hidden = isList;
    if (els.backBtnLabel) els.backBtnLabel.textContent = backLabel(state.activeMailbox);
  }

  if (els.mailToolbarTitle) {
    // In a conversation the subject is shown in the reading pane; keep the
    // heading for screen readers only.
    els.mailToolbarTitle.classList.toggle('visually-hidden', isThread);
    if (isThread) {
      const thread = (state.session?.threads ?? []).find((th) => th.id === state.activeThreadId);
      if (els.mailToolbarName) els.mailToolbarName.textContent = thread?.subject || t('Inbox');
      if (els.mailToolbarCount) els.mailToolbarCount.textContent = '';
    } else {
      if (els.mailToolbarName) els.mailToolbarName.textContent = mailboxLabel(state.activeMailbox);
      if (els.mailToolbarCount) els.mailToolbarCount.textContent = `(${mailboxItemCount()})`;
    }
  }
  if (els.toolbarComposeLabel) els.toolbarComposeLabel.textContent = t('Compose');
  renderAssistantChips();
  renderQuickResultPanel();
  applyNarrowShell();
  // Measure now (getBoundingClientRect flushes layout) and again after the
  // frame, in case the composer grows once the editor paints.
  syncCoveredFocus();
  requestAnimationFrame(updateToolbarScrolled);
}

// ── Rendering ─────────────────────────────────────────────────
function renderMailboxes() {
  if (!els.mailboxList) return;
  const counts = mailboxCounts(state.session?.threads ?? [], learnerEmail(), savedDrafts());
  els.mailboxList.innerHTML = '';
  for (const box of MAILBOXES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rail__mailbox' + (box.id === state.activeMailbox ? ' is-active' : '');
    btn.dataset.mailbox = box.id;
    if (box.id === state.activeMailbox) btn.setAttribute('aria-current', 'true');
    const count = counts[box.id] ?? 0;
    // Figma: the inbox carries a badge marker while it holds new (unread) mail.
    const hasNew = box.id === 'inbox' && threadsInMailbox(state.session?.threads ?? [], 'inbox', learnerEmail())
      .some((thread) => isThreadUnread(thread));
    const marker = hasNew ? `<span class="rail__mailbox-marker" role="img" aria-label="${escapeHtml(t('New messages'))}"></span>` : '';
    btn.innerHTML = `
      <span class="rail__mailbox-icon">${MAILBOX_ICONS[box.id] || ''}</span>
      <span class="rail__mailbox-label">${escapeHtml(t(box.label))}</span>
      <span class="rail__mailbox-meta">${marker}<span class="rail__mailbox-count">${escapeHtml(String(count))}</span></span>
    `;
    btn.addEventListener('click', () => selectMailbox(box.id));
    els.mailboxList.appendChild(btn);
  }
  if (els.composeBtnLabel) els.composeBtnLabel.textContent = t('Compose');
  if (els.composeBtn) els.composeBtn.title = t('Compose');
}

// Newest activity first (a thread's time is its latest email's date).
function threadTime(thread) {
  let latest = -Infinity;
  for (const email of thread.emails ?? []) {
    const time = Date.parse(email?.date);
    if (!Number.isNaN(time) && time > latest) latest = time;
  }
  return latest;
}

function draftListFrom(draft) {
  const to = Array.isArray(draft?.to) ? draft.to : [];
  if (!to.length) return t('No recipients');
  const name = displayName(personForAddress(to[0])) || formatAddress(to[0]);
  return name ? `${t('To')}: ${name}` : t('To');
}

function draftListPerson(draft) {
  const to = Array.isArray(draft?.to) ? draft.to : [];
  return to.length ? personForAddress(to[0]) : learnerPerson();
}

function mailRowAccessibleName(parts, { unread = false } = {}) {
  const name = parts.map((part) => String(part ?? '').trim()).filter(Boolean);
  if (unread) name.push(t('New'));
  return name.join('. ');
}

function renderDraftList() {
  const drafts = savedDrafts();
  els.threadList.innerHTML = '';
  if (!drafts.length) {
    const copy = emptyMailboxCopy('drafts');
    const empty = document.createElement('div');
    empty.className = 'mail-list__empty';
    empty.innerHTML = `
      <img class="mail-list__empty-icon" src="/icons/mail-logo.svg" width="22" height="22" alt="" />
      <p class="mail-list__empty-title">${escapeHtml(copy.title)}</p>
      <p class="mail-list__empty-body">${escapeHtml(copy.body)}</p>
    `;
    els.threadList.appendChild(empty);
    syncCoveredFocus();
    return;
  }
  for (const draft of drafts) {
    const from = draftListFrom(draft);
    const subject = draft.subject || t('(no subject)');
    const date = formatListDate(draft.updated_at);
    const item = document.createElement('div');
    item.className = 'mail-item';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mail-row';
    btn.setAttribute('aria-label', mailRowAccessibleName([from, subject, date]));
    btn.innerHTML = `
      ${avatarMarkup(draftListPerson(draft), 'lg')}
      <span class="mail-row__main">
        <span class="mail-row__from">${escapeHtml(from)}</span>
        <span class="mail-row__subject">${escapeHtml(subject)}</span>
      </span>
      <span class="mail-row__date">${escapeHtml(date)}</span>
    `;
    btn.addEventListener('click', () => openDraft(draft));
    const container = document.createElement('div');
    container.className = 'mail-item__container';
    container.append(btn);
    item.appendChild(container);
    els.threadList.appendChild(item);
  }
  syncCoveredFocus();
}

function renderMailList() {
  if (state.activeMailbox === 'drafts') {
    renderDraftList();
    return;
  }
  // Stable sort: threads without dates keep their seeded order at the end.
  const threads = [...visibleThreads()].sort((a, b) => (threadTime(b) - threadTime(a)) || 0);
  els.threadList.innerHTML = '';

  if (!threads.length) {
    const copy = emptyMailboxCopy(state.activeMailbox);
    const empty = document.createElement('div');
    empty.className = 'mail-list__empty';
    empty.innerHTML = `
      <img class="mail-list__empty-icon" src="/icons/mail-logo.svg" width="22" height="22" alt="" />
      <p class="mail-list__empty-title">${escapeHtml(copy.title)}</p>
      <p class="mail-list__empty-body">${escapeHtml(copy.body)}</p>
    `;
    els.threadList.appendChild(empty);
    syncCoveredFocus();
    return;
  }

  // Figma "Inbox Item" (470:11383): first container (column) holds the
  // second container — the row, which carries the new-mail marker — and the hrule.
  for (const thread of threads) {
    const last = thread.emails?.[thread.emails.length - 1];
    const unread = isThreadUnread(thread);
    const from = threadListFrom(thread, state.activeMailbox);
    const subject = thread.subject || '(no subject)';
    const date = formatListDate(last?.date);
    const item = document.createElement('div');
    item.className = 'mail-item' + (unread ? ' is-unread' : '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mail-row';
    btn.dataset.threadId = thread.id;
    btn.setAttribute('aria-label', mailRowAccessibleName([from, subject, date], { unread }));
    btn.innerHTML = `
      ${unread ? '<span class="mail-item__marker" aria-hidden="true"></span>' : ''}
      ${avatarMarkup(threadListPerson(thread, state.activeMailbox), 'lg')}
      <span class="mail-row__main">
        <span class="mail-row__from">${escapeHtml(from)}</span>
        <span class="mail-row__subject">${escapeHtml(subject)}</span>
      </span>
      <span class="mail-row__date">${escapeHtml(date)}</span>
    `;
    btn.addEventListener('click', () => selectThread(thread.id));
    const container = document.createElement('div');
    container.className = 'mail-item__container';
    container.append(btn);
    item.appendChild(container);
    els.threadList.appendChild(item);
  }
  syncCoveredFocus();
}

function renderEmail(email, learnerEmail, { showSubject = true, subject = '' } = {}) {
  const isOutbound =
    email.outbound === true ||
    (learnerEmail && formatAddress(email.from).includes(learnerEmail));
  const wrap = document.createElement('article');
  wrap.className = 'email' + (isOutbound ? ' email--outbound' : '');
  if (email.id) wrap.dataset.emailId = email.id;
  const sender = isOutbound ? learnerPerson() : personForAddress(email.from);
  const senderName = displayName(email.from) || sender.name || addressEmail(email.from);
  const senderEmail = addressEmail(email.from);
  const subjectText = email.subject || subject;
  const subjectRow = showSubject && subjectText
    ? `<div class="email__row"><span class="email__label">${escapeHtml(t('Subject'))}:</span> <span class="email__subject">${escapeHtml(subjectText)}</span></div>`
    : '';
  const ccRow = email.cc && email.cc.length
    ? `<div class="email__row"><span class="email__label">${escapeHtml(t('Cc'))}:</span> <span class="email__recipients">${escapeHtml(recipientNames(email.cc))}</span></div>`
    : '';
  const attachments = Array.isArray(email.attachments) ? email.attachments : [];
  const attachmentsHtml = attachments.length
    ? `<div class="email__attachments">${attachments
        .map((a, index) => {
          const name = escapeHtml(a.name || 'attachment');
          const hasText = typeof a.text === 'string' && a.text.length > 0;
          if (hasText) {
            return `<button type="button" class="tag outline email__attachment email__attachment--preview" data-attachment-index="${index}" aria-label="${escapeHtml(t('Preview attachment'))}: ${name}">${name}</button>`;
          }
          return `<span class="tag outline email__attachment">${name}</span>`;
        })
        .join('')}</div>`
    : '';
  wrap.innerHTML = `
    <div class="email__meta">
      ${avatarMarkup(sender, 'lg')}
      <div class="email__meta-text">
        <div class="email__row email__row--from">
          <span class="email__from">${escapeHtml(senderName)}</span>
          ${senderEmail && senderEmail !== senderName ? `<span class="email__address">&lt;${escapeHtml(senderEmail)}&gt;</span>` : ''}
          <span class="email__date">${escapeHtml(formatDate(email.date))}</span>
        </div>
        ${subjectRow}
        <div class="email__row"><span class="email__label">${escapeHtml(t('To'))}:</span> <span class="email__recipients">${escapeHtml(recipientNames(email.to))}</span></div>
        ${ccRow}
      </div>
    </div>
    <div class="email__divider">
      <div class="email__actions" role="group" aria-label="${escapeHtml(t('Reply options'))}">
        <button type="button" class="email__action" data-reply-mode="reply" aria-label="${escapeHtml(t('Reply'))}" title="${escapeHtml(t('Reply'))}">${EMAIL_REPLY_ICON}</button>
        <button type="button" class="email__action" data-reply-mode="replyAll" aria-label="${escapeHtml(t('Reply all'))}" title="${escapeHtml(t('Reply all'))}"><span class="email__action-icon">${EMAIL_REPLY_ALL_ICON}</span></button>
      </div>
    </div>
    <div class="email__content">
      <div class="email__body">${renderMarkdown(email.body)}</div>
      ${attachmentsHtml}
    </div>
  `;
  for (const btn of wrap.querySelectorAll('.email__action')) {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      startReply(btn.dataset.replyMode, email.id);
    });
  }
  for (const btn of wrap.querySelectorAll('.email__attachment--preview')) {
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.attachmentIndex);
      const attachment = attachments[index];
      if (attachment) openAttachmentPreview(attachment);
    });
  }
  return wrap;
}

function openAttachmentPreview(attachment) {
  const name = attachment?.name || t('Attachment');
  const text = typeof attachment?.text === 'string' ? attachment.text : '';
  const modal = new Modal({
    size: 'medium',
    title: name,
    content: `<pre class="attachment-preview-modal__body body-small">${escapeHtml(text)}</pre>`,
    closeOnOverlayClick: true,
    footerButtons: [
      {
        label: t('Close'),
        type: 'secondary',
        onClick: () => modal.close(),
      },
    ],
  });
  modal.open();
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
  markThreadRead(thread);
  const emails = thread.emails ?? [];
  const isThread = emails.length > 1;
  els.readingPane.classList.toggle('reading-pane--thread', isThread);
  els.readingPane.classList.toggle('reading-pane--single', !isThread);

  if (isThread) {
    const head = document.createElement('div');
    head.className = 'thread-head';
    head.innerHTML = `${THREAD_ICON}<h2 class="thread-head__subject">${escapeHtml(thread.subject || '(no subject)')}</h2>`;
    els.readingPane.appendChild(head);
    if (!emails.some((email) => email.id && email.id === state.selectedEmailId)) {
      state.selectedEmailId = emails[0]?.id ?? null;
    }
  }
  emails.forEach((email, index) => {
    const card = renderEmail(email, learnerAddr, {
      // A thread repeats the subject only on its first message.
      showSubject: index === 0,
      subject: thread.subject,
    });
    if (isThread) {
      card.classList.add('email--card');
      card.classList.toggle('is-selected', Boolean(email.id) && email.id === state.selectedEmailId);
      card.addEventListener('click', () => selectEmail(email.id));
    }
    els.readingPane.appendChild(card);
  });
  if (state.replying) placeComposer();
  else els.readingPane.appendChild(renderThreadActions());
  renderAssistantChips();
  renderQuickResultPanel();
  syncCoveredFocus();
}

// Reply / Reply all sit after the conversation (the toolbar holds Compose).
function renderThreadActions() {
  const actions = document.createElement('div');
  actions.className = 'thread-actions';
  for (const [mode, label] of [['reply', t('Reply')], ['replyAll', t('Reply all')]]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'button button-secondary button-xsmall';
    btn.textContent = label;
    btn.addEventListener('click', () => startReply(mode));
    actions.appendChild(btn);
  }
  return actions;
}

// Visual selection inside a multi-message thread (no behavior attached).
function selectEmail(emailId) {
  if (!emailId || state.selectedEmailId === emailId) return;
  state.selectedEmailId = emailId;
  for (const card of els.readingPane.querySelectorAll('.email--card')) {
    card.classList.toggle('is-selected', card.dataset.emailId === emailId);
  }
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
  // A per-email reply button targets that email; otherwise the thread tip.
  const target = (state.replyToEmailId && thread.emails?.find((email) => email.id === state.replyToEmailId))
    || replyTargetEmail(thread);
  const headers = buildReplyHeaders(target, {
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
  const closeDrawer = state.railDrawerOpen;
  state.railDrawerOpen = false;
  state.activeMailbox = mailbox;
  state.view = 'list';
  state.replying = null;
  state.activeThreadId = null;
  clearOpenedThreadStatus();
  renderShell();
  if (closeDrawer) focusControl(els.railDrawerBtn);
}

function selectThread(threadId) {
  state.view = 'thread';
  state.replying = null;
  state.activeThreadId = threadId;
  state.selectedEmailId = null;
  state.replyToEmailId = null;
  renderShell();
  announceOpenedThread(threadId);
  focusThreadHeading();
}

// One short status when a thread opens. The reading pane is not a live region,
// so replacing its messages does not re-announce the whole conversation.
function announceOpenedThread(threadId) {
  const status = els.mailViewStatus;
  if (!status) return;
  const thread = (state.session?.threads ?? []).find((th) => th.id === threadId);
  const subject = thread?.subject || t('(no subject)');
  const message = `${t('Opened')}: ${subject}`;
  status.textContent = '';
  // Back or another thread can win before the next frame. Don't let this
  // callback put the old "Opened:" line back.
  requestAnimationFrame(() => {
    if (state.view !== 'thread' || state.activeThreadId !== threadId) return;
    status.textContent = message;
  });
}

function clearOpenedThreadStatus() {
  if (els.mailViewStatus) els.mailViewStatus.textContent = '';
}

// Composer outcomes go here, not into #mailViewStatus, so an "Opened" thread
// announcement stays put. The reading pane is not a live region.
function announceComposerStatus(message) {
  const status = els.composerStatus;
  const text = String(message ?? '');
  if (!status || !text) return;
  status.textContent = '';
  requestAnimationFrame(() => {
    status.textContent = text;
  });
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

function viewScrollBehavior() {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}

function focusThreadHeading() {
  els.mailToolbarTitle?.focus({ preventScroll: true });
}

function focusMailRow(threadId) {
  if (!threadId || !els.threadList) return;
  const row = els.threadList.querySelector(`[data-thread-id="${escapeSelector(threadId)}"]`);
  row?.focus({ preventScroll: true });
}

function startReply(mode, emailId = null) {
  state.view = 'thread';
  state.composingNew = false;
  state.replying = mode;
  state.replyToEmailId = emailId;
  if (emailId) state.selectedEmailId = emailId;
  applyThreadComposer(state.activeThreadId, mode);
  renderShell();
  els.composer?.scrollIntoView({ behavior: viewScrollBehavior(), block: 'end' });
  state.editor?.commands.focus();
}

function cancelReply() {
  const threadId = state.activeThreadId;
  state.replying = null;
  if (threadId) {
    state.session.drafts = removeScopedDraft(state.session?.drafts, { scope: 'reply', threadId });
    void persistDrafts().then(refreshDraftsUi);
    // Discarded reply must not attribute Cosmo insert provenance to a later send.
    if (sameDraftScope(state.assistant.lastInserted, { scope: 'reply', threadId })) {
      state.assistant.lastInserted = null;
    }
  }
  setEditorMarkdown('');
  renderShell();
}

function startCompose({ blank = true, draft = null } = {}) {
  if (state.composingNew && !draft) {
    applyView();
    els.composeToInput?.focus();
    return;
  }
  const wasReplying = Boolean(state.replying);
  state.composingNew = true;
  state.replying = null;
  if (state.view === 'compose') state.view = 'list';
  if (draft) {
    state.activeDraftId = draft.id || newDraftId();
    applyRecipientDraft(draft);
    els.composeSubject.value = draft.subject || '';
    setEditorMarkdown(draft.body || '');
    clearAttachments();
  } else if (blank) {
    state.activeDraftId = newDraftId();
    applyRecipientDraft({ to: [], cc: [] });
    els.composeSubject.value = '';
    setEditorMarkdown('');
    clearAttachments();
  } else {
    const initial = computeInitialDraft();
    state.activeDraftId = initial.id || newDraftId();
    applyRecipientDraft(initial);
    els.composeSubject.value = initial.subject || '';
    setEditorMarkdown(initial.body || '');
  }
  scheduleDraftSave();
  if (wasReplying && state.view === 'thread') renderThread(state.activeThreadId);
  applyView();
  els.composeToInput?.focus();
}

async function closeComposeOverlay() {
  if (!state.composingNew) return;
  clearTimeout(state.draftSaveTimer);
  await saveDraftNow();
  state.composingNew = false;
  state.activeDraftId = null;
  applyView();
  refreshDraftsUi();
}

function refreshDraftsUi() {
  renderMailboxes();
  if (state.view === 'list' && els.mailToolbarCount) {
    els.mailToolbarCount.textContent = `(${mailboxItemCount()})`;
  }
  if (state.view === 'list') renderMailList();
}

async function openDraft(draft) {
  if (!draft) return;
  if (state.composingNew) await saveDraftNow();
  const latest = (state.session?.drafts ?? []).find((item) => sameDraftScope(item, draft)) || draft;
  if (latest.scope === 'reply' && latest.threadId) {
    const thread = (state.session?.threads ?? []).find((th) => th.id === latest.threadId);
    if (!thread) return;
    state.composingNew = false;
    state.activeDraftId = null;
    state.activeMailbox = mailboxForThread(thread, learnerEmail());
    state.activeThreadId = thread.id;
    startReply('reply');
    return;
  }
  startCompose({ blank: false, draft: latest });
}

// Close (×): hide the panel but keep what was written. New messages keep
// their draft as before; a reply's draft is restored when it's reopened.
function closeComposer() {
  closeRecipientMenus();
  if (state.composingNew) {
    void closeComposeOverlay();
    return;
  }
  if (!state.replying) return;
  clearTimeout(state.draftSaveTimer);
  void saveDraftNow().then(() => {
    state.replying = null;
    renderShell();
  });
}

// Cancel: a reply is discarded; a new message closes and keeps its draft.
function cancelComposer() {
  if (state.composingNew) closeComposeOverlay();
  else cancelReply();
}

function composeNewTo(email) {
  startCompose({ blank: true });
  addRecipient('to', email);
  state.openRecipientField = null;
  renderRecipientPickers();
  state.editor?.commands.focus();
}

let mailtoComposeBound = false;

function initMailtoCompose() {
  if (mailtoComposeBound) return;
  mailtoComposeBound = true;
  document.addEventListener('click', (event) => {
    const el = event.target instanceof Element ? event.target : event.target.parentElement;
    const link = el?.closest('.js-compose-mailto');
    if (!link) return;
    event.preventDefault();
    if (!link.closest('.email__body, .assistant__msg')) return;
    const canonical = constrainToCharacters([link.getAttribute('data-email')], directoryCharacters())[0];
    if (!canonical) return;
    composeNewTo(canonical);
  });
}

function backToList() {
  const threadId = state.activeThreadId;
  state.view = 'list';
  state.replying = null;
  state.activeThreadId = null;
  clearOpenedThreadStatus();
  renderShell();
  focusMailRow(threadId);
}

function initSkipToMail() {
  const link = els.skipToMail;
  const main = els.mailMain;
  if (!link || !main) return;
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  link.addEventListener('click', (event) => {
    event.preventDefault();
    main.focus();
  });
}

function applyScenarioChrome() {
  const title = state.config?.title || t('Mail');
  document.title = title;
  // Keep the document's existing lang when the catalog has no language tag.
  const language = String(state.config?.documentLanguage ?? '').trim();
  if (isDocumentLanguageTag(language)) document.documentElement.lang = language;
  if (els.appTitle) els.appTitle.textContent = title;
  if (els.skipToMail) els.skipToMail.textContent = t('Skip to mail');
  if (els.composeToLabel) els.composeToLabel.textContent = t('To');
  if (els.composeCcLabel) els.composeCcLabel.textContent = t('Cc');
  if (els.composeSubjectLabel) els.composeSubjectLabel.textContent = t('Subject');
  if (els.assistantInput) {
    els.assistantInput.placeholder = t('Ask me anything...');
    els.assistantInput.setAttribute('aria-label', t('Message the AI Assistant'));
    els.assistantInput.setAttribute('aria-describedby', 'assistantInputHint');
  }
  if (els.assistantInputHint) {
    els.assistantInputHint.textContent = t('Enter sends. Shift+Enter inserts a newline.');
  }
  if (els.assistantClearBtn) {
    els.assistantClearBtn.setAttribute('aria-label', t('New conversation'));
    els.assistantClearBtn.title = t('New conversation');
  }
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
  const saved = savedDrafts().find((draft) => draft.scope !== 'reply')
    || draftForScope(state.session?.drafts, { scope: 'new' });
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
  if (state.composingNew) return { scope: 'new', id: state.activeDraftId };
  if (state.replying && state.activeThreadId) {
    return { scope: 'reply', threadId: state.activeThreadId };
  }
  return null;
}

function currentDraft() {
  const scope = draftScope();
  return {
    scope: scope?.scope || 'new',
    id: scope?.id || state.activeDraftId || null,
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
  const draft = currentDraft();
  const scope = draftScope();
  if (!draftHasPersistableContent(draft)) {
    state.session.drafts = removeScopedDraft(state.session.drafts, scope);
    await persistDrafts();
    refreshDraftsUi();
    return;
  }
  if (draft.scope === 'new' && !draft.id) draft.id = newDraftId();
  state.session.drafts = upsertScopedDraft(state.session.drafts, draft);
  await persistDrafts();
  refreshDraftsUi();
}

function scheduleDraftSave() {
  updateSendEnabled();
  renderAssistantChips();
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
  els.composeSubject.addEventListener('input', scheduleDraftSave);
  els.sendBtn.addEventListener('click', sendEmail);
  els.composeBtn?.addEventListener('click', () => startCompose({ blank: true }));
  els.backBtn?.addEventListener('click', backToList);
  els.toolbarComposeBtn?.addEventListener('click', () => startCompose({ blank: true }));
  els.discardBtn?.addEventListener('click', cancelComposer);
  els.composerCloseBtn?.addEventListener('click', closeComposer);
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
      announceComposerStatus(t('File type not allowed'));
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
    el.scrollIntoView({ behavior: viewScrollBehavior(), block: 'nearest' });
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

const MAIL_TOAST_DISMISS_MS = 8000;
let mailToastTimerSerial = 0;

function clearMailToastTimer(toast) {
  if (toast._timer != null) clearTimeout(toast._timer);
  toast._timer = null;
  toast._timerToken = null;
}

function toastHasFocus(toast) {
  const active = document.activeElement;
  return !!(active && toast.contains(active));
}

function scheduleMailToastDismiss(toast) {
  clearMailToastTimer(toast);
  if (toast._dismissed || !toast.isConnected) return;
  const token = ++mailToastTimerSerial;
  toast._timerToken = token;
  toast._startedAt = Date.now();
  const delay = Math.max(0, toast._remaining);
  toast._timer = setTimeout(() => {
    if (toast._timerToken !== token) return;
    toast._timer = null;
    toast._timerToken = null;
    if (toast._dismissed || toast._paused || !toast.isConnected) return;
    dismissMailToast(toast);
  }, delay);
}

function pauseMailToastTimer(toast) {
  if (toast._dismissed || toast._paused) return;
  const elapsed = Math.max(0, Date.now() - (toast._startedAt || Date.now()));
  toast._remaining = Math.max(0, toast._remaining - elapsed);
  toast._paused = true;
  clearMailToastTimer(toast);
}

function resumeMailToastTimer(toast) {
  if (toast._dismissed || !toast.isConnected || !toast._paused) return;
  if (toast._pointerInside || toastHasFocus(toast)) return;
  toast._paused = false;
  scheduleMailToastDismiss(toast);
}

// Keep the remaining auto-dismiss time while the pointer or focus is inside.
// Moving between controls stays paused; leaving both resumes the leftover time.
function armMailToastTimer(toast) {
  toast._remaining = MAIL_TOAST_DISMISS_MS;
  toast._paused = false;
  toast._pointerInside = false;
  toast._dismissed = false;

  toast.addEventListener('pointerenter', () => {
    toast._pointerInside = true;
    pauseMailToastTimer(toast);
  });
  toast.addEventListener('pointerleave', () => {
    toast._pointerInside = false;
    resumeMailToastTimer(toast);
  });
  toast.addEventListener('focusin', () => {
    pauseMailToastTimer(toast);
  });
  toast.addEventListener('focusout', (event) => {
    if (toast._dismissed) return;
    const next = event.relatedTarget;
    // relatedTarget is where focus is going. activeElement can still be inside
    // the toast during focusout, so a focus check here would keep the timer paused.
    if (next instanceof Node && toast.contains(next)) return;
    if (toast._pointerInside) return;
    if (!toast.isConnected || !toast._paused) return;
    toast._paused = false;
    scheduleMailToastDismiss(toast);
  });

  scheduleMailToastDismiss(toast);
}

function dismissMailToast(toast) {
  if (!toast || toast._dismissed) return;
  toast._dismissed = true;
  toast._paused = true;
  clearMailToastTimer(toast);
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
  armMailToastTimer(toast);
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

  clearTimeout(state.draftSaveTimer);
  state.draftSaveTimer = null;

  els.sendBtn.disabled = true;
  els.sendBtn.textContent = t('Sending…');
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
        draftId: composingNew ? sentScope.id : undefined,
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
    state.activeDraftId = null;
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
    announceComposerStatus(t('Message sent'));

    void collectCharacterReplies(responders, email, thread.id);
  } catch (err) {
    console.error('[CosmoMail] send failed:', err);
    announceComposerStatus(t('Send failed'));
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
    drafts: state.session?.drafts ?? [],
    viewing: {
      threadId: state.view === 'thread' ? state.activeThreadId : null,
      composingNew: state.composingNew,
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

  const bubble = document.createElement('div');
  bubble.className = isUser
    ? 'assistant__msg assistant__msg--user'
    : 'assistant__msg assistant__msg--ai';
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

// actionsAtBottom: quick results put Insert in a row under the content.
function appendDraftCard(row, draft, { streaming = false, actionsAtBottom = false } = {}) {
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
  let insertBtn = null;
  if (!streaming) {
    insertBtn = document.createElement('button');
    insertBtn.type = 'button';
    insertBtn.className = 'button button-text-primary button-xsmall assistant__insert';
    insertBtn.textContent = t('Insert');
    insertBtn.setAttribute('aria-label', t('Insert into composer'));
    insertBtn.addEventListener('click', () => {
      void insertProposedDraft(draft, { source: draft.source || PROPOSE_DRAFT_TOOL });
    });
    if (!actionsAtBottom) toolbar.appendChild(insertBtn);
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

  if (insertBtn && actionsAtBottom) {
    const actions = document.createElement('div');
    actions.className = 'assistant__draft-actions';
    actions.appendChild(insertBtn);
    card.appendChild(actions);
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

const ASSISTANT_TYPING_HTML = '<span class="assistant__typing" aria-label="Thinking"><span class="assistant__typing-dot"></span><span class="assistant__typing-dot"></span><span class="assistant__typing-dot"></span></span>';

function assistantHintText() {
  return state.config?.assistant?.initialMessage
    || t('Ask the AI Assistant to help draft, summarize, or answer questions about this thread.');
}

function assistantNodeSpec(key, signature, create, update) {
  return { key, signature, create, update };
}

function paintAssistantRow(row, { role, html, drafts, streaming, markdown }) {
  const bubble = row.querySelector('.assistant__msg');
  if (bubble && bubble.innerHTML !== html) bubble.innerHTML = html;
  for (const card of row.querySelectorAll('.assistant__draft')) card.remove();
  for (const button of row.querySelectorAll('.assistant__insert')) button.remove();
  if (role !== 'user') {
    for (const draft of drafts ?? []) appendDraftCard(row, draft, { streaming });
    if (!streaming) appendFenceInsertFallback(row, markdown);
  }
}

function assistantBubbleSpec(key, details) {
  const signature = JSON.stringify({
    role: details.role,
    html: details.html,
    streaming: Boolean(details.streaming),
    markdown: details.streaming ? '' : (details.markdown ?? ''),
    drafts: details.drafts ?? [],
  });
  return assistantNodeSpec(
    key,
    signature,
    () => {
      const row = makeBubble(details.role, details.html);
      paintAssistantRow(row, details);
      return row;
    },
    (row) => paintAssistantRow(row, details),
  );
}

function thoughtSpec(key, ms) {
  const text = t('Thought for {seconds}s').replace('{seconds}', String(Math.max(1, Math.round(ms / 1000))));
  return assistantNodeSpec(
    key,
    text,
    () => thoughtLine(ms),
    (node) => { node.textContent = text; },
  );
}

function hintSpec() {
  const text = assistantHintText();
  return assistantNodeSpec(
    keyHint(),
    text,
    () => {
      const hint = document.createElement('p');
      hint.className = 'assistant__hint';
      hint.id = 'assistantHint';
      hint.textContent = text;
      return hint;
    },
    (node) => { node.textContent = text; },
  );
}

function keyHint() {
  return 'hint';
}

// Keep earlier turn nodes. A streaming token may rewrite the in-progress
// bubble, and a cleared conversation may drop the transcript.
function reconcileAssistantLog(container, specs) {
  const byKey = new Map();
  for (const child of container.children) {
    const key = child.dataset.assistantKey;
    if (key && !byKey.has(key)) byKey.set(key, child);
  }
  const next = specs.map((spec) => {
    const existing = byKey.get(spec.key);
    if (existing) {
      byKey.delete(spec.key);
      if (existing.dataset.assistantSignature !== spec.signature) {
        spec.update(existing);
        existing.dataset.assistantSignature = spec.signature;
      }
      return existing;
    }
    const node = spec.create();
    node.dataset.assistantKey = spec.key;
    node.dataset.assistantSignature = spec.signature;
    return node;
  });
  for (const stale of byKey.values()) stale.remove();
  for (const child of [...container.children]) {
    if (!next.includes(child)) child.remove();
  }
  for (let index = 0; index < next.length; index += 1) {
    if (container.children[index] !== next[index]) {
      container.insertBefore(next[index], container.children[index] ?? null);
    }
  }
}

function renderAssistant(liveMessages = []) {
  const container = els.assistantMessages;
  if (!container) return;
  const persisted = state.assistant.persisted ?? [];
  const live = liveMessages ?? [];
  const specs = [];

  if (!persisted.length && !live.length) {
    specs.push(hintSpec());
  } else {
    persisted.forEach((message, index) => {
      if (message.role === 'assistant' && message.thoughtMs) {
        specs.push(thoughtSpec(`persisted:${index}:thought`, message.thoughtMs));
      }
      const html = message.role === 'user' ? escapeHtml(message.content) : renderMarkdown(message.content);
      specs.push(assistantBubbleSpec(`persisted:${index}:${message.role}`, {
        role: message.role,
        html,
        drafts: message.role === 'assistant' ? (message.drafts ?? []) : [],
        streaming: false,
        markdown: message.role === 'assistant' ? message.content : '',
      }));
    });

    live.forEach((message, index) => {
      if (message.role === 'user') {
        const text = messageText(message) || message.content || '';
        const key = message.id ? `live:${message.id}` : `live:${index}:user`;
        specs.push(assistantBubbleSpec(key, {
          role: 'user',
          html: escapeHtml(text),
          drafts: [],
          streaming: false,
          markdown: '',
        }));
        return;
      }
      if (message.role !== 'assistant') return;
      const text = messageText(message);
      const drafts = draftsFromLiveMessage(message);
      const streaming = message.status === 'streaming';
      noteThinkingProgress(message, Boolean(text || drafts.length));
      // Until the reply has content, the thinking status stands in for it.
      if (streaming && !text && !drafts.length) return;
      const key = message.id ? `live:${message.id}` : `live:${index}:assistant`;
      if (state.assistant.thoughtMs[message.id]) {
        specs.push(thoughtSpec(`${key}:thought`, state.assistant.thoughtMs[message.id]));
      }
      specs.push(assistantBubbleSpec(key, {
        role: 'assistant',
        html: renderMarkdown(text) || (drafts.length || streaming ? '' : ASSISTANT_TYPING_HTML),
        drafts,
        streaming,
        markdown: text,
      }));
    });

    if (state.assistant.quickThoughtMs && !state.assistant.thinkingSince) {
      specs.push(thoughtSpec('quick-thought', state.assistant.quickThoughtMs));
    }
  }

  reconcileAssistantLog(container, specs);
  updateAssistantThinking();
  const scroller = els.assistantContent || container;
  scroller.scrollTop = scroller.scrollHeight;
  updateAssistantClearBtn();
}

// ── Thinking indicator (in the chat body) ────────────────────
// thinking.riv: artboard "Icon", "State Machine 1", view model { speed, darkMode }.
// One loop takes ~2.6s ÷ speed; 1.5 (~1.7s) reads as calm but alive.
const THINKING_RIVE_SPEED = 1.5;
let thinkingEl = null;
let thinkingRive = null;

function thinkingIndicator() {
  if (thinkingEl) return thinkingEl;
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'assistant__status';
  thinkingEl.setAttribute('role', 'status');
  thinkingEl.innerHTML = '<canvas class="assistant__status-anim" width="40" height="40" aria-hidden="true"></canvas><span class="assistant__status-label"></span>';
  const canvas = thinkingEl.querySelector('canvas');
  try {
    RuntimeLoader.setWasmUrl('/vendor/rive.wasm');
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)');
    thinkingRive = new Rive({
      src: '/animations/thinking.riv',
      canvas,
      autoplay: !prefersReducedMotion(),
      autoBind: true,
      stateMachine: 'State Machine 1',
      onLoad: () => {
        thinkingRive.resizeDrawingSurfaceToCanvas();
        const vm = thinkingRive.viewModelInstance;
        const speed = vm?.number('speed');
        if (speed) speed.value = THINKING_RIVE_SPEED;
        const darkMode = vm?.boolean('darkMode');
        if (darkMode && dark) {
          darkMode.value = dark.matches;
          dark.addEventListener?.('change', (event) => { darkMode.value = event.matches; });
        }
      },
      onLoadError: () => canvas.classList.add('is-fallback'),
    });
  } catch (err) {
    console.error('[Mail] thinking animation unavailable:', err);
    canvas.classList.add('is-fallback');
  }
  return thinkingEl;
}

function resetThinkingIndicator() {
  thinkingEl?.remove();
  thinkingEl = null;
  thinkingRive = null;
}

function thoughtLine(ms) {
  const line = document.createElement('p');
  line.className = 'assistant__thought';
  const seconds = Math.max(1, Math.round(ms / 1000));
  line.textContent = t('Thought for {seconds}s').replace('{seconds}', String(seconds));
  return line;
}

function startThinking(kind) {
  state.assistant.thinkingSince = performance.now();
  state.assistant.thinkingKind = kind;
  state.assistant.quickThoughtMs = null;
}

// Chat turns stop "thinking" once the reply has content (or the stream ends).
function noteThinkingProgress(message, hasContent) {
  if (state.assistant.thinkingKind !== 'chat' || !state.assistant.thinkingSince) return;
  if (!hasContent && message.status === 'streaming') return;
  if (!state.assistant.thoughtMs[message.id]) {
    state.assistant.thoughtMs[message.id] = performance.now() - state.assistant.thinkingSince;
  }
  state.assistant.thinkingSince = null;
  state.assistant.thinkingKind = null;
}

function assistantIsBusy() {
  return state.assistant.chat?.status === 'streaming'
    || state.assistant.quickActionBusy === true;
}

function updateAssistantThinking() {
  const busy = assistantIsBusy();
  // A chat stream that has started answering is no longer "thinking".
  const thinking = busy && (state.assistant.quickActionBusy || Boolean(state.assistant.thinkingSince));
  const el = thinkingIndicator();
  const log = els.assistantMessages;
  if (thinking) {
    el.querySelector('.assistant__status-label').textContent = state.assistant.quickActionBusy && state.assistant.chat?.status !== 'streaming'
      ? t('Working…')
      : t('Thinking…');
    // The header has no status region. Keep this status beside the log so
    // aria-busy on the log does not wrap it.
    if (log?.parentElement && (el.parentElement !== log.parentElement || el.previousElementSibling !== log)) {
      log.insertAdjacentElement('afterend', el);
    }
  } else if (el.parentElement) {
    el.remove();
  }
  if (log) log.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/** Refresh thinking, clear, and Send when busy state flips (e.g. quick actions). */
function syncAssistantBusyControls() {
  updateAssistantThinking();
  updateAssistantClearBtn();
  if (!els.assistantSendBtn) return;
  // Preserve input-disabled (agent unavailable / assistant off); only gate Send on empty + busy.
  const inputDisabled = els.assistantInput?.disabled === true;
  els.assistantSendBtn.disabled = inputDisabled
    || !String(els.assistantInput?.value ?? '').trim()
    || assistantIsBusy();
}

// The clear button is only actionable when there is something to clear and
// Cosmo is not mid-reply.
function updateAssistantClearBtn() {
  const btn = els.assistantClearBtn;
  if (!btn) return;
  const hasAny = state.assistant.persisted.length > 0
    || (state.assistant.chat?.messages?.length ?? 0) > 0;
  btn.disabled = !hasAny || assistantIsBusy();
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
    state.assistant.thoughtMs = {};
    state.assistant.quickThoughtMs = null;
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
  const composerOpen = composerIsOpen();
  const draft = composerOpen ? currentDraft() : null;
  return resolveQuickActionChips({
    capabilities: state.config?.assistant?.capabilities,
    quickActions: state.config?.assistant?.quickActions,
    context: {
      view: state.view,
      mailbox: state.activeMailbox,
      composerOpen,
      composingNew: Boolean(state.composingNew),
      hasDraftBody: Boolean(draft?.body?.trim()),
      hasRecipients: Boolean(draft && (draft.to.length || draft.cc.length)),
      hasSubject: Boolean(draft?.subject?.trim()),
    },
  });
}

function renderAssistantChips() {
  const host = els.assistantChips;
  if (!host) return;
  const chips = visibleQuickActionChips();
  host.innerHTML = '';
  // Hidden while the assistant works (thinking or streaming a reply); they
  // come back when the turn ends.
  if (!chips.length || assistantIsBusy()) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  for (const chip of chips) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'assistant__chip';
    btn.innerHTML = `${CHIP_ICON}<span class="assistant__chip-label">${escapeHtml(t(chip.label))}</span>`;
    btn.disabled = state.assistant.quickActionBusy
      || state.assistant.chat?.status === 'streaming';
    btn.addEventListener('click', () => void runQuickAction(chip.id));
    host.appendChild(btn);
  }
}

// Suggested replies for the open conversation, while they still target its
// reply email (they go stale once the thread moves on).
function activeSuggestedReplies() {
  const pack = state.assistant.suggestedReplies;
  if (!pack?.replies?.length) return null;
  if (state.view !== 'thread' || state.activeThreadId !== pack.threadId) return null;
  const thread = (state.session?.threads ?? []).find((th) => th.id === pack.threadId);
  const email = thread ? replyTargetEmail(thread) : null;
  if (pack.emailId && email?.id && pack.emailId !== email.id) return null;
  return pack;
}

const CYCLE_PREV_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18L9 12L15 6"/></svg>';
const CYCLE_NEXT_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18L15 12L9 6"/></svg>';

function suggestedReplyPosition(pack) {
  const total = pack.replies.length;
  const index = ((pack.index ?? 0) % total + total) % total;
  return { total, index };
}

function updateSuggestedReplyCard(pack) {
  const row = document.getElementById('assistantSuggestions');
  if (!row || !pack?.replies?.length) return;
  const { total, index } = suggestedReplyPosition(pack);
  const body = row.querySelector('.assistant__suggestion-body');
  if (body) body.textContent = String(pack.replies[index] ?? '').trim();
  const count = row.querySelector('.assistant__cycle-count');
  if (count) {
    count.textContent = t('{current} of {total}')
      .replace('{current}', String(index + 1))
      .replace('{total}', String(total));
  }
  for (const button of row.querySelectorAll('.assistant__cycle')) {
    button.disabled = total < 2;
  }
}

function stepSuggestedReply(delta) {
  const pack = activeSuggestedReplies();
  if (!pack?.replies?.length) return;
  const { total, index } = suggestedReplyPosition(pack);
  pack.index = (index + delta + total) % total;
  updateSuggestedReplyCard(pack);
  document.getElementById('assistantSuggestions')
    ?.querySelector(`.assistant__cycle[data-step="${delta}"]`)
    ?.focus();
}

// One suggestion at a time; ‹ › cycle (wrapping), Insert drops it in the reply.
// The card stays in place so cycling updates the same live node.
function renderSuggestedRepliesCard(pack) {
  let row = document.getElementById('assistantSuggestions');
  if (!row) {
    row = document.createElement('div');
    row.id = 'assistantSuggestions';
    row.className = 'assistant__row assistant__row--ai';
    const turn = document.createElement('div');
    turn.className = 'assistant__turn';
    const card = document.createElement('article');
    card.className = 'assistant__draft assistant__suggestions';
    card.setAttribute('aria-label', t('Suggested replies'));

    const label = document.createElement('div');
    label.className = 'body-xsmall assistant__draft-label';
    label.textContent = t('Suggested replies');
    card.appendChild(label);

    const body = document.createElement('div');
    body.className = 'assistant__suggestion-body body-small';
    body.setAttribute('aria-live', 'polite');
    card.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'assistant__draft-actions';
    const cycleBtn = (delta, icon, text) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'icon-button icon-button--ghost assistant__cycle';
      btn.dataset.step = String(delta);
      btn.innerHTML = icon;
      btn.setAttribute('aria-label', text);
      btn.title = text;
      btn.addEventListener('click', () => stepSuggestedReply(delta));
      return btn;
    };
    const count = document.createElement('span');
    count.className = 'assistant__cycle-count';
    const insert = document.createElement('button');
    insert.type = 'button';
    insert.className = 'button button-text-primary button-xsmall assistant__insert';
    insert.textContent = t('Insert');
    insert.setAttribute('aria-label', t('Insert into composer'));
    insert.addEventListener('click', () => {
      const current = activeSuggestedReplies();
      if (!current?.replies?.length) return;
      const { index } = suggestedReplyPosition(current);
      void applySuggestedReply(current.replies[index]);
    });
    actions.append(
      cycleBtn(-1, CYCLE_PREV_ICON, t('Previous suggestion')),
      count,
      cycleBtn(1, CYCLE_NEXT_ICON, t('Next suggestion')),
      insert,
    );
    card.appendChild(actions);
    turn.appendChild(card);
    row.appendChild(turn);
  }
  updateSuggestedReplyCard(pack);
  return row;
}

function quickDraftBelongsToActiveThread(draft) {
  if (!draft?.sourceThreadId) return true;
  return state.view === 'thread' && state.activeThreadId === draft.sourceThreadId;
}

function renderQuickResultPanel() {
  const host = els.assistantQuickResult;
  if (!host) return;
  const draft = state.assistant.quickDraft;
  const ranking = String(state.assistant.triageRanking ?? '').trim();
  const showDraft = draft && quickDraftBelongsToActiveThread(draft);
  const suggestions = activeSuggestedReplies();
  if (!showDraft && !ranking && !suggestions) {
    host.replaceChildren();
    host.hidden = true;
    return;
  }
  host.hidden = false;
  for (const child of [...host.children]) {
    if (child.id !== 'assistantSuggestions') child.remove();
  }

  if (suggestions) {
    const card = renderSuggestedRepliesCard(suggestions);
    if (card.parentElement !== host) host.insertBefore(card, host.firstChild);
  } else {
    document.getElementById('assistantSuggestions')?.remove();
  }

  if (ranking) {
    const row = document.createElement('div');
    row.className = 'assistant__row assistant__row--ai';
    const turn = document.createElement('div');
    turn.className = 'assistant__turn';
    const card = document.createElement('div');
    card.className = 'assistant__triage';
    card.setAttribute('aria-label', t('Inbox priority'));
    const label = document.createElement('h3');
    label.className = 'assistant__triage-label';
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
    const turn = document.createElement('div');
    turn.className = 'assistant__turn';
    row.appendChild(turn);
    host.appendChild(row);
    appendDraftCard(row, draft, { actionsAtBottom: true });
  }
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
  startThinking('quick');
  renderAssistant(state.assistant.chat?.messages ?? []);
  renderAssistantChips();
  syncAssistantBusyControls();

  // Capture before the await — the learner may change threads while the request runs.
  // New-message compose is unscoped; reply chips bind to the open thread.
  const sourceThreadId = state.composingNew
    ? null
    : (state.view === 'thread' ? state.activeThreadId : null);
  const thread = (state.session?.threads ?? []).find((th) => th.id === sourceThreadId);
  const context = buildMailboxContext({
    threads: state.session?.threads ?? [],
    learnerEmail: learnerEmail(),
    drafts: state.session?.drafts ?? [],
    viewing: {
      threadId: sourceThreadId,
      composingNew: state.composingNew,
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
        index: 0,
      };
      state.assistant.quickDraft = null;
      state.assistant.triageRanking = null;
      renderQuickResultPanel();
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
    if (state.assistant.thinkingKind === 'quick' && state.assistant.thinkingSince) {
      state.assistant.quickThoughtMs = performance.now() - state.assistant.thinkingSince;
      state.assistant.thinkingSince = null;
      state.assistant.thinkingKind = null;
    }
    renderAssistant(state.assistant.chat?.messages ?? []);
    renderAssistantChips();
    syncAssistantBusyControls();
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
  renderQuickResultPanel();
  if (!state.replying && state.view === 'thread' && state.activeThreadId) {
    startReply('reply');
  } else if (!composerIsOpen()) {
    startCompose({ blank: true });
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
    id: scope.id ?? null,
    threadId: scope.threadId ?? null,
  };
  void appendProvenanceEvents(events);
  scheduleDraftSave();
  els.composer?.scrollIntoView({ behavior: viewScrollBehavior(), block: 'end' });
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
    id: scope.id ?? null,
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
        t("You're already writing an email. Replace it with the AI Assistant's draft?"),
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
    modal.dialog.classList.add('replace-draft-dialog');
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
    id: scope.id ?? null,
  };
  void appendProvenanceEvents(events);

  if (state.assistant.quickDraft?.draftId === draftId) {
    state.assistant.quickDraft = null;
    renderQuickResultPanel();
  }

  scheduleDraftSave();
  els.composer?.scrollIntoView({ behavior: viewScrollBehavior(), block: 'end' });
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
    const thoughtMs = state.assistant.thoughtMs[m.id];
    return {
      role: 'assistant',
      content,
      drafts,
      ...(thoughtMs ? { thoughtMs: Math.round(thoughtMs) } : {}),
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
  els.assistantSendBtn.disabled = !enabled || !els.assistantInput.value.trim() || assistantIsBusy();
  updateAssistantThinking();
}

const SPLIT_STORAGE_KEY = 'cosmoMail.splitPercent';
// Figma: ~341px assistant column beside the mail column at a 1224px viewport.
const SPLIT_DEFAULT_PERCENT = 66.5;

function readStoredSplitPercent() {
  try {
    const raw = sessionStorage.getItem(SPLIT_STORAGE_KEY);
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 40 && value <= 82) return value;
  } catch {
    /* ignore */
  }
  return SPLIT_DEFAULT_PERCENT;
}

function initMailSplit() {
  const host = els.mailSplit;
  const main = els.mailMain;
  const assistant = els.assistantPanel;
  if (!host || !main || !assistant) return;

  if (state.config?.assistant?.enabled === false) {
    assistant.setAttribute('hidden', '');
    host.classList.add('mail-split--solo');
    return;
  }

  // Detach existing panels before SplitPanel clears the host.
  main.remove();
  assistant.remove();
  const panel = new SplitPanel(host, {
    orientation: 'horizontal',
    initialSplit: readStoredSplitPercent(),
    minLeft: 40,
    minRight: 18,
    dividerLabel: t('Resize AI Assistant panel'),
    onChange: (percent) => {
      try {
        sessionStorage.setItem(SPLIT_STORAGE_KEY, String(Math.round(percent)));
      } catch {
        /* ignore */
      }
    },
  });
  panel.getLeftPanel().appendChild(main);
  panel.getRightPanel().appendChild(assistant);
  // SplitPanel replaces container.className; restore our layout hook class.
  host.classList.add('mail-split');
  for (const pane of [panel.getLeftPanel(), panel.getRightPanel()]) {
    pane.style.overflow = 'hidden';
    pane.style.display = 'flex';
    pane.style.flexDirection = 'column';
    pane.style.minHeight = '0';
    pane.style.height = '100%';
  }
  state.mailSplit = panel;
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
  updateAssistantThinking();

  if (state.config?.assistant?.enabled === false) {
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
    updateAssistantThinking();
  });

  bindAssistantComposer();
  setAssistantEnabled(true);
  renderAssistantChips();
  renderQuickResultPanel();
}

let assistantComposerBound = false;

function bindAssistantComposer() {
  if (assistantComposerBound || !els.assistantInput || !els.assistantSendBtn) return;
  assistantComposerBound = true;
  els.assistantInput.addEventListener('input', () => {
    els.assistantSendBtn.disabled = !els.assistantInput.value.trim()
      || assistantIsBusy();
  });
  els.assistantInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAssistant();
    }
  });
  els.assistantSendBtn.addEventListener('click', sendAssistant);
}

async function sendAssistant() {
  const chat = state.assistant.chat;
  if (!chat || chat.status === 'streaming') return;
  const text = els.assistantInput.value.trim();
  if (!text) return;
  els.assistantInput.value = '';
  setAssistantEnabled(false);
  startThinking('chat');

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
    state.assistant.thinkingSince = null;
    state.assistant.thinkingKind = null;
    updateAssistantThinking();
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
    initMailSplit();
    initShellDrawers();
    initCoveredFocus();
    applyNarrowShell();
    initToolbarScrollShadow();
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
    showBootError('Could not load Mail. Is the server running?');
  }
}

// The browser bundle boots on load. Vitest imports this module after mounting
// public/index.html, and drives the real UI from there.
if (globalThis.process?.env?.VITEST !== 'true') boot();
else initShellDrawers();
initSkipToMail();

/** Live mailbox behaviors for the accessibility regression tests. */
export function mailAppTestHooks() {
  return {
    state,
    initRecipientPickers,
    renderRecipientPickers,
    renderShell,
    renderThread,
    selectThread,
    backToList,
    selectMailbox,
    syncCoveredFocus,
    applyNarrowShell,
    showMailToast,
    applyScenarioChrome,
    sendEmail,
    handleComposerFiles,
    scrollToEmail,
    startReply,
    insertProposedDraft,
    thinkingIndicator,
    resetThinkingIndicator,
    renderAssistant,
    renderQuickResultPanel,
    updateAssistantThinking,
    bindAssistantComposer,
    initMailtoCompose,
  };
}
