// @vitest-environment happy-dom
/**
 * Accessibility regressions for the 2026-10-06 fixes (S6, S1, S5, S7, S3,
 * S2, S4, M4, M6, M9, M2, and Shift+Tab in the recipient combobox).
 *
 * public/app.js reads the document while the module loads, so this mounts
 * public/index.html first and imports the module after that. Vitest skips
 * the network boot; the tests then call the same UI functions the page uses.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeAccessibleName } from 'dom-accessibility-api';
import { resolveDocumentLanguage } from '../lib/helpers.js';

const { riveOptions } = vi.hoisted(() => ({ riveOptions: [] }));

vi.mock('@rive-app/canvas', () => ({
  RuntimeLoader: {
    setWasmUrl() {},
  },
  Rive: class {
    constructor(options) {
      riveOptions.push(options);
      this.viewModelInstance = null;
    }

    resizeDrawingSurfaceToCanvas() {}
  },
}));

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const strings = JSON.parse(readFileSync(join(root, 'i18n/en.json'), 'utf8')).strings;

const LEARNER = 'alex@northwind.test';
const DANA = 'dana@acme.test';
const SAM = 'sam@acme.test';
const QUOTE_BODY = 'Please review the Friday shipment.';

const CHARACTERS = [
  { id: 'dana', name: 'Dana Reyes', email: DANA, role: 'Vendor' },
  { id: 'sam', name: 'Sam Okonkwo', email: SAM, role: 'Buyer' },
];

function installPage() {
  const html = readFileSync(join(root, 'public/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!body) throw new Error('public/index.html is missing a body');
  document.body.innerHTML = body[1];
}

installPage();
const appStyle = document.createElement('style');
appStyle.textContent = readFileSync(join(root, 'public/app.css'), 'utf8');
document.head.appendChild(appStyle);
const { mailAppTestHooks } = await import('../public/app.js');
const mail = mailAppTestHooks();
mail.initRecipientPickers();

function threads() {
  return [
    {
      id: 'thread-quote',
      subject: 'Vendor quote',
      emails: [
        {
          id: 'email-quote',
          from: { name: 'Dana Reyes', email: DANA },
          to: [{ name: 'Alex', email: LEARNER }],
          date: '2026-10-05T15:00:00.000Z',
          body: QUOTE_BODY,
        },
      ],
    },
    {
      id: 'thread-blank',
      subject: '',
      emails: [
        {
          id: 'email-blank',
          from: { name: 'Sam Okonkwo', email: SAM },
          to: [{ name: 'Alex', email: LEARNER }],
          date: '2026-09-01T15:00:00.000Z',
          body: 'A thread that was sent without a subject line.',
        },
      ],
    },
  ];
}

function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function statusEl() {
  return document.getElementById('mailViewStatus');
}

function clickThread(threadId) {
  const row = document.querySelector(`.mail-row[data-thread-id="${threadId}"]`);
  expect(row, `mail row ${threadId}`).toBeTruthy();
  row.click();
  return row;
}

function setViewport(width, height) {
  window.innerWidth = width;
  window.innerHeight = height;
  window.happyDOM?.setViewport?.({ width, height });
}

function rect(top, left, width, height) {
  return {
    x: left,
    y: top,
    top,
    left,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON() { return this; },
  };
}

function mockRect(el, box) {
  el.getBoundingClientRect = () => box;
}

async function resetMailbox() {
  setViewport(1280, 800);
  clearTimeout(mail.state.draftSaveTimer);
  const { state } = mail;
  state.config = {
    strings,
    learner: { email: LEARNER, displayName: 'Alex' },
    characters: CHARACTERS,
    assistant: { enabled: false },
  };
  state.session = { threads: threads(), drafts: [], readEmailIds: [] };
  state.activeMailbox = 'inbox';
  state.activeThreadId = null;
  state.view = 'list';
  state.composingNew = false;
  state.replying = null;
  state.selectedEmailId = null;
  state.replyToEmailId = null;
  state.recipients = { to: [], cc: [] };
  state.openRecipientField = null;
  state.recipientQuery = { to: '', cc: '' };
  state.recipientActiveIndex = 0;
  state.attachments = [];
  statusEl().textContent = '';
  const composerStatus = document.getElementById('composerStatus');
  if (composerStatus) composerStatus.textContent = '';
  document.documentElement.lang = 'en';
  mail.renderShell();
  // Drop an "Opened:" callback queued by the previous test.
  await nextFrame();
  if (state.view !== 'thread') statusEl().textContent = '';
}

function showComposer() {
  mail.state.composingNew = true;
  mail.renderShell();
  mail.renderRecipientPickers();
}

function typeRecipient(field, query) {
  const input = document.getElementById(field === 'cc' ? 'composeCcInput' : 'composeToInput');
  input.focus();
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}

function keydown(target, key, { shiftKey = false } = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

beforeEach(async () => {
  await resetMailbox();
});

describe('English catalog', () => {
  it('keeps the strings the recipient fields and opened-thread status use', () => {
    expect(strings).toMatchObject({
      To: 'To',
      Cc: 'Cc',
      'Add a recipient': 'Add a recipient',
      'No more people to add': 'No more people to add',
      Opened: 'Opened',
      '(no subject)': '(no subject)',
    });
  });
});

describe('S6 recipient field names', () => {
  it('names To and Cc separately after the picker renders', () => {
    showComposer();

    const toInput = document.getElementById('composeToInput');
    const ccInput = document.getElementById('composeCcInput');
    expect(computeAccessibleName(toInput)).toBe(`${strings.To}, ${strings['Add a recipient']}`);
    expect(computeAccessibleName(ccInput)).toBe(`${strings.Cc}, ${strings['Add a recipient']}`);
    expect(toInput.hasAttribute('aria-labelledby')).toBe(false);
    expect(ccInput.hasAttribute('aria-labelledby')).toBe(false);
    expect(document.getElementById('composeToMenu').getAttribute('aria-labelledby')).toBe('composeToLabel');
    expect(document.getElementById('composeCcMenu').getAttribute('aria-labelledby')).toBe('composeCcLabel');
  });

  it('keeps the To or Cc prefix when nobody is left to add', () => {
    showComposer();
    mail.state.recipients = { to: [DANA], cc: [SAM] };
    mail.state.recipientQuery.to = 'pat';
    mail.state.openRecipientField = 'to';
    mail.renderRecipientPickers();

    const toInput = document.getElementById('composeToInput');
    const ccInput = document.getElementById('composeCcInput');
    const emptyHint = strings['No more people to add'];
    expect(computeAccessibleName(toInput)).toBe(`${strings.To}, ${emptyHint}`);
    expect(computeAccessibleName(ccInput)).toBe(`${strings.Cc}, ${emptyHint}`);
    expect(toInput.hasAttribute('aria-labelledby')).toBe(false);
    expect(ccInput.hasAttribute('aria-labelledby')).toBe(false);
    expect(document.querySelector('#composeToMenu .recipient-picker__empty').textContent).toBe(emptyHint);
    expect(document.getElementById('composeToMenu').getAttribute('aria-labelledby')).toBe('composeToLabel');
    expect(document.getElementById('composeCcMenu').getAttribute('aria-labelledby')).toBe('composeCcLabel');
  });
});

describe('S1 opened thread status', () => {
  it('announces the subject on a status outside the reading pane', async () => {
    const pane = document.getElementById('readingPane');
    const status = statusEl();
    expect(pane.hasAttribute('aria-live')).toBe(false);
    expect(status.getAttribute('role')).toBe('status');
    expect(pane.contains(status)).toBe(false);

    clickThread('thread-quote');
    await nextFrame();

    expect(pane.hasAttribute('aria-live')).toBe(false);
    expect(status.textContent).toBe(`${strings.Opened}: Vendor quote`);
    expect(status.textContent).not.toContain('Friday shipment');
    expect(pane.textContent).toContain(QUOTE_BODY);
    expect(pane.contains(status)).toBe(false);
  });

  it('uses the catalog fallback when the thread has no subject', async () => {
    clickThread('thread-blank');
    await nextFrame();
    expect(statusEl().textContent).toBe(`${strings.Opened}: ${strings['(no subject)']}`);
  });

  it('clears the status when going back to the list, and a pending frame does not restore it', async () => {
    clickThread('thread-quote');
    expect(statusEl().textContent).toBe('');
    mail.backToList();
    await nextFrame();
    expect(statusEl().textContent).toBe('');

    clickThread('thread-quote');
    await nextFrame();
    expect(statusEl().textContent).toBe(`${strings.Opened}: Vendor quote`);
    mail.backToList();
    expect(statusEl().textContent).toBe('');
    await nextFrame();
    expect(statusEl().textContent).toBe('');
  });

  it('clears the status when switching mailboxes', async () => {
    clickThread('thread-quote');
    await nextFrame();
    expect(statusEl().textContent).toBe(`${strings.Opened}: Vendor quote`);

    document.querySelector('#mailboxList [data-mailbox="sent"]').click();
    expect(mail.state.view).toBe('list');
    expect(statusEl().textContent).toBe('');
    await nextFrame();
    expect(statusEl().textContent).toBe('');
  });

  it('sets the status again when the same thread is opened again', async () => {
    clickThread('thread-quote');
    await nextFrame();
    mail.backToList();
    expect(statusEl().textContent).toBe('');

    clickThread('thread-quote');
    await nextFrame();
    expect(statusEl().textContent).toBe(`${strings.Opened}: Vendor quote`);
  });

  it('does not copy the message body into the status when the open thread re-renders', async () => {
    clickThread('thread-quote');
    await nextFrame();
    const opened = `${strings.Opened}: Vendor quote`;
    expect(statusEl().textContent).toBe(opened);

    mail.renderThread('thread-quote');
    expect(statusEl().textContent).toBe(opened);
    expect(document.getElementById('readingPane').textContent).toContain(QUOTE_BODY);
    expect(document.getElementById('readingPane').hasAttribute('aria-live')).toBe(false);
  });
});

describe('S5 focus when the list and thread change', () => {
  it('moves focus to the toolbar title and hides the list when a row opens', () => {
    const title = document.getElementById('mailToolbarTitle');
    expect(title.getAttribute('tabindex')).toBe('-1');

    clickThread('thread-blank');

    expect(document.getElementById('mailList').hidden).toBe(true);
    expect(document.activeElement).toBe(title);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('returns focus to the row that was open', () => {
    clickThread('thread-blank');
    mail.backToList();

    const restored = document.querySelector('.mail-row[data-thread-id="thread-blank"]');
    const other = document.querySelector('.mail-row[data-thread-id="thread-quote"]');
    expect(document.activeElement).toBe(restored);
    expect(document.activeElement).not.toBe(other);
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe('recipient combobox Shift+Tab', () => {
  it('does not commit or rebuild chips, and blur only closes the query', () => {
    showComposer();
    mail.state.recipients.to = [DANA];
    mail.renderRecipientPickers();
    const input = typeRecipient('to', 'Sam');
    const remove = document.querySelector('#composeToChips .recipient-picker__remove');
    const menu = document.getElementById('composeToMenu');

    expect(remove).toBeTruthy();
    expect(menu.hidden).toBe(false);
    expect(menu.querySelector(`[data-email="${SAM}"]`)).toBeTruthy();

    const shiftTab = keydown(input, 'Tab', { shiftKey: true });

    expect(shiftTab.defaultPrevented).toBe(false);
    expect(mail.state.recipients.to).toEqual([DANA]);
    expect(input.value).toBe('Sam');
    expect(remove.isConnected).toBe(true);

    input.blur();

    expect(menu.hidden).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(mail.state.recipientQuery.to).toBe('');
    expect(input.value).toBe('');
    expect(remove.isConnected).toBe(true);
    expect(document.getElementById('composeToChips').contains(remove)).toBe(true);
    expect(mail.state.recipients.to).toEqual([DANA]);
  });

  it('still commits the highlighted match on Tab', () => {
    showComposer();
    const input = typeRecipient('to', 'Sam');
    const tab = keydown(input, 'Tab');

    expect(tab.defaultPrevented).toBe(true);
    expect(mail.state.recipients.to).toEqual([SAM]);
  });

  it('still commits the highlighted match on Enter', () => {
    showComposer();
    const input = typeRecipient('to', 'Sam');
    const enter = keydown(input, 'Enter');

    expect(enter.defaultPrevented).toBe(true);
    expect(mail.state.recipients.to).toEqual([SAM]);
  });
});

describe('S7 composer does not cover focused controls', () => {
  const panel = rect(200, 12, 400, 260);

  function rows() {
    return [...document.querySelectorAll('#threadList .mail-row')];
  }

  async function openNewMessage() {
    showComposer();
    await nextFrame();
    const composer = document.getElementById('composer');
    expect(composer.classList.contains('is-new')).toBe(true);
    expect(composer.hidden).toBe(false);
    mockRect(composer, panel);
    return composer;
  }

  it('drops a fully covered mail row from the tab order and leaves a row above it', async () => {
    const composer = await openNewMessage();
    const [above, covered] = rows();
    mockRect(above, rect(80, 20, 360, 36));
    mockRect(covered, rect(240, 20, 360, 36));
    mockRect(document.getElementById('composerCloseBtn'), rect(208, 360, 26, 26));

    mail.syncCoveredFocus();

    expect(covered.getAttribute('tabindex')).toBe('-1');
    expect(covered.hasAttribute('data-focus-covered')).toBe(true);
    expect(above.hasAttribute('tabindex')).toBe(false);
    expect(document.getElementById('composerCloseBtn').getAttribute('tabindex')).not.toBe('-1');
    expect(composer.contains(document.getElementById('composerCloseBtn'))).toBe(true);
  });

  it('keeps a row that only partly overlaps the panel in the tab order', async () => {
    await openNewMessage();
    const [above, partial] = rows();
    mockRect(above, rect(80, 20, 360, 36));
    mockRect(partial, rect(180, 20, 360, 40));

    mail.syncCoveredFocus();

    expect(partial.hasAttribute('tabindex')).toBe(false);
    expect(above.hasAttribute('tabindex')).toBe(false);
  });

  it('moves focus off a covered row onto a row that stays above the panel', async () => {
    await openNewMessage();
    const [above, covered] = rows();
    mockRect(above, rect(80, 20, 360, 36));
    mockRect(covered, rect(240, 20, 360, 36));
    covered.focus();

    mail.syncCoveredFocus();

    expect(document.activeElement).toBe(above);
    expect(covered.getAttribute('tabindex')).toBe('-1');
  });

  it('restores a row once it is no longer fully underneath the panel', async () => {
    await openNewMessage();
    const covered = rows()[1];
    mockRect(covered, rect(240, 20, 360, 36));
    mail.syncCoveredFocus();
    expect(covered.getAttribute('tabindex')).toBe('-1');

    mockRect(covered, rect(80, 20, 360, 36));
    mail.syncCoveredFocus();

    expect(covered.hasAttribute('tabindex')).toBe(false);
    expect(covered.hasAttribute('data-focus-covered')).toBe(false);
  });

  it('does not leave new rows out of the tab order after the overlay closes', async () => {
    await openNewMessage();
    mockRect(rows()[1], rect(240, 20, 360, 36));
    mail.syncCoveredFocus();

    mail.state.composingNew = false;
    mail.renderShell();
    await nextFrame();

    expect(document.getElementById('composer').hidden).toBe(true);
    for (const row of rows()) {
      expect(row.getAttribute('tabindex')).not.toBe('-1');
    }
  });

  it('uses the same tab-order rule for a sticky reply composer', async () => {
    clickThread('thread-quote');
    mail.state.replying = 'reply';
    mail.state.composingNew = false;
    mail.renderShell();
    await nextFrame();

    const composer = document.getElementById('composer');
    expect(composer.classList.contains('is-inline')).toBe(true);
    expect(composer.classList.contains('is-new')).toBe(false);
    expect(composer.hidden).toBe(false);
    mockRect(composer, panel);

    const [visible, covered] = [...document.querySelectorAll('#readingPane .email__action')];
    expect(visible).toBeTruthy();
    expect(covered).toBeTruthy();
    expect(composer.contains(visible)).toBe(false);
    mockRect(visible, rect(80, 20, 32, 32));
    mockRect(covered, rect(240, 60, 32, 32));

    mail.syncCoveredFocus();

    expect(covered.getAttribute('tabindex')).toBe('-1');
    expect(visible.hasAttribute('tabindex')).toBe(false);
    expect(document.getElementById('readingPane').contains(composer)).toBe(true);
  });
});

describe('S3 narrow shell reflow', () => {
  function shell() {
    return {
      app: document.getElementById('mailApp'),
      rail: document.getElementById('threadRail'),
      assistant: document.getElementById('assistantPanel'),
      main: document.getElementById('mailMain'),
      list: document.getElementById('mailList'),
      pane: document.getElementById('readingPane'),
      folders: document.getElementById('railDrawerBtn'),
      assistantBtn: document.getElementById('assistantDrawerBtn'),
    };
  }

  it('drawers the rail and keeps the list and reading pane in the main column at 320px', () => {
    setViewport(320, 800);
    mail.applyNarrowShell();
    const ui = shell();

    expect(ui.app.classList.contains('is-narrow')).toBe(true);
    expect(ui.rail.hidden).toBe(true);
    expect(ui.assistant.hidden).toBe(true);
    expect(ui.folders.hidden).toBe(false);
    expect(ui.folders.getAttribute('aria-expanded')).toBe('false');
    expect(ui.assistantBtn.hidden).toBe(true);
    expect(ui.main.contains(ui.list)).toBe(true);
    expect(ui.main.contains(ui.pane)).toBe(true);
    expect(ui.rail.contains(ui.list)).toBe(false);
    expect(ui.assistant.contains(ui.list)).toBe(false);
    expect(ui.list.hidden).toBe(false);
    expect(ui.pane.hidden).toBe(true);

    ui.folders.click();
    expect(ui.rail.hidden).toBe(false);
    expect(ui.rail.classList.contains('is-drawer-open')).toBe(true);
    expect(ui.folders.getAttribute('aria-expanded')).toBe('true');
    expect(ui.main.inert).toBe(true);

    document.querySelector('#mailboxList [data-mailbox="sent"]').click();
    expect(ui.rail.hidden).toBe(true);
    expect(ui.folders.getAttribute('aria-expanded')).toBe('false');
    expect(mail.state.view).toBe('list');
    expect(ui.main.contains(ui.list)).toBe(true);
    expect(ui.main.inert).toBe(false);
  });

  it('opens the assistant drawer when the assistant is enabled, and Escape closes it', () => {
    mail.state.config.assistant.enabled = true;
    setViewport(320, 800);
    mail.applyNarrowShell();
    const ui = shell();

    expect(ui.assistantBtn.hidden).toBe(false);
    ui.assistantBtn.click();

    expect(ui.assistant.hidden).toBe(false);
    expect(ui.assistant.classList.contains('is-drawer-open')).toBe(true);
    expect(ui.assistantBtn.getAttribute('aria-expanded')).toBe('true');
    expect(ui.rail.hidden).toBe(true);
    expect(ui.main.contains(ui.list)).toBe(true);
    expect(ui.main.contains(ui.pane)).toBe(true);

    const escape = keydown(document.getElementById('assistantDrawerCloseBtn'), 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(ui.assistant.hidden).toBe(true);
    expect(ui.assistantBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the list and the reading pane in one column while a thread is open', () => {
    setViewport(320, 800);
    mail.applyNarrowShell();
    clickThread('thread-quote');
    const ui = shell();

    expect(ui.main.contains(ui.list)).toBe(true);
    expect(ui.main.contains(ui.pane)).toBe(true);
    expect(ui.list.hidden).toBe(true);
    expect(ui.pane.hidden).toBe(false);
    expect(ui.rail.contains(ui.pane)).toBe(false);
    expect(ui.assistant.contains(ui.pane)).toBe(false);
  });

  it('leaves the desktop three-column shell in place at 1280px', () => {
    setViewport(320, 800);
    mail.applyNarrowShell();
    document.getElementById('railDrawerBtn').click();

    setViewport(1280, 900);
    mail.applyNarrowShell();
    const ui = shell();

    expect(ui.app.classList.contains('is-narrow')).toBe(false);
    expect(ui.rail.hidden).toBe(false);
    expect(ui.rail.classList.contains('is-drawer-open')).toBe(false);
    expect(ui.assistant.hidden).toBe(false);
    expect(ui.folders.hidden).toBe(true);
    expect(ui.assistantBtn.hidden).toBe(true);
    expect(ui.main.inert).toBe(false);
    expect(ui.main.contains(ui.list)).toBe(true);
    expect(ui.main.contains(ui.pane)).toBe(true);
  });
});

describe('S2 toast auto-dismiss', () => {
  const DISMISS_MS = 8000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.getElementById('mailToasts')?.replaceChildren();
  });

  function showInboundToast() {
    const thread = mail.state.session.threads.find((item) => item.id === 'thread-quote');
    mail.showMailToast(thread, thread.emails[0]);
    const toast = document.querySelector('#mailToasts .mail-toast:last-child');
    expect(toast).toBeTruthy();
    return toast;
  }

  function pointer(el, type) {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true }));
  }

  function inboxRow() {
    return document.querySelector('.mail-row[data-thread-id="thread-quote"]');
  }

  it('dismisses the toast after eight seconds and keeps the inbox row', () => {
    const toast = showInboundToast();
    expect(inboxRow()).toBeTruthy();

    vi.advanceTimersByTime(DISMISS_MS - 1);
    expect(toast.isConnected).toBe(true);
    vi.advanceTimersByTime(1);

    expect(toast.isConnected).toBe(false);
    expect(document.querySelector('#mailToasts .mail-toast')).toBeNull();
    expect(inboxRow()).toBeTruthy();
  });

  it('preserves elapsed time across hover pause and resume', () => {
    const toast = showInboundToast();
    vi.advanceTimersByTime(3000);
    pointer(toast, 'pointerenter');
    vi.advanceTimersByTime(20000);
    expect(toast.isConnected).toBe(true);

    pointer(toast, 'pointerleave');
    vi.advanceTimersByTime(4999);
    expect(toast.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(toast.isConnected).toBe(false);
    expect(inboxRow()).toBeTruthy();
  });

  it('does not resume the timer while focus moves between controls inside the toast', () => {
    const toast = showInboundToast();
    const open = toast.querySelector('.mail-toast__open');
    const close = toast.querySelector('.mail-toast__close');
    vi.advanceTimersByTime(2000);
    open.focus();
    vi.advanceTimersByTime(10000);
    expect(toast.isConnected).toBe(true);
    expect(document.activeElement).toBe(open);

    close.focus();
    expect(document.activeElement).toBe(close);
    expect(toast.contains(document.activeElement)).toBe(true);
    vi.advanceTimersByTime(10000);
    expect(toast.isConnected).toBe(true);
  });

  it('resumes the timer only after focus leaves the toast', () => {
    const toast = showInboundToast();
    const open = toast.querySelector('.mail-toast__open');
    const close = toast.querySelector('.mail-toast__close');
    vi.advanceTimersByTime(2500);
    open.focus();
    close.focus();
    pointer(toast, 'pointerenter');
    pointer(toast, 'pointerleave');
    vi.advanceTimersByTime(20000);
    expect(toast.isConnected).toBe(true);
    expect(toast.contains(document.activeElement)).toBe(true);

    document.getElementById('composeBtn').focus();
    expect(toast.contains(document.activeElement)).toBe(false);
    vi.advanceTimersByTime(5499);
    expect(toast.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(toast.isConnected).toBe(false);
  });

  it('dismisses a paused toast without a stale timer removing the next one', () => {
    const first = showInboundToast();
    vi.advanceTimersByTime(1000);
    pointer(first, 'pointerenter');
    first.querySelector('.mail-toast__close').click();
    expect(first.isConnected).toBe(false);
    expect(inboxRow()).toBeTruthy();

    const second = showInboundToast();
    vi.advanceTimersByTime(DISMISS_MS - 1);
    expect(second.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(second.isConnected).toBe(false);
    expect(inboxRow()).toBeTruthy();
  });

  it('opens the thread from a paused toast and leaves later toasts on their own timer', () => {
    const toast = showInboundToast();
    const open = toast.querySelector('.mail-toast__open');
    open.focus();
    vi.advanceTimersByTime(3000);
    open.click();

    expect(toast.isConnected).toBe(false);
    expect(mail.state.view).toBe('thread');
    expect(mail.state.activeThreadId).toBe('thread-quote');
    expect(mail.state.session.threads.some((item) => item.id === 'thread-quote')).toBe(true);

    const later = showInboundToast();
    vi.advanceTimersByTime(DISMISS_MS - 1);
    expect(later.isConnected).toBe(true);
    vi.advanceTimersByTime(20000);
    expect(later.isConnected).toBe(false);
  });
});

describe('S4 skip to mail', () => {
  function sequentialFocusable() {
    return [...document.body.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
      .filter((el) => {
        if (el.closest('[hidden]')) return false;
        if (el.disabled) return false;
        if (el.matches('input[type="hidden"]')) return false;
        const tab = el.getAttribute('tabindex');
        if (tab !== null && Number(tab) < 0) return false;
        return true;
      });
  }

  it('is the first focusable element and targets #mailMain', () => {
    const skip = document.getElementById('skipToMail');
    const main = document.getElementById('mailMain');
    const focusable = sequentialFocusable();

    expect(skip).toBeTruthy();
    expect(skip.textContent.trim()).toBe('Skip to mail');
    expect(skip.getAttribute('href')).toBe('#mailMain');
    expect(focusable[0]).toBe(skip);
    expect(focusable.includes(main)).toBe(false);
  });

  it('moves focus to #mailMain when activated', () => {
    const skip = document.getElementById('skipToMail');
    const main = document.getElementById('mailMain');
    skip.focus();
    expect(document.activeElement).toBe(skip);

    skip.click();

    expect(document.activeElement).toBe(main);
    expect(main.getAttribute('tabindex')).toBe('-1');
  });

  it('keeps #mailMain out of the sequential tab order', () => {
    const main = document.getElementById('mailMain');
    const focusable = sequentialFocusable();

    expect(main.getAttribute('tabindex')).toBe('-1');
    expect(main.tabIndex).toBe(-1);
    expect(focusable.includes(main)).toBe(false);
    expect(focusable[0].getAttribute('href')).toBe('#mailMain');
    expect(focusable[1]).not.toBe(main);
  });
});

describe('M4 document language', () => {
  const en = JSON.parse(readFileSync(join(root, 'i18n/en.json'), 'utf8'));
  const spanish = {
    languageNames: ['es', 'spanish', 'español'],
    strings: { Mail: 'Correo' },
  };

  it('follows the resolved scenario language, including a non-English catalog', () => {
    document.documentElement.lang = 'fr';
    mail.state.config.documentLanguage = resolveDocumentLanguage('English', [en]);
    mail.applyScenarioChrome();
    expect(document.documentElement.lang).toBe('en');

    mail.state.config.documentLanguage = resolveDocumentLanguage('Spanish', [en, spanish]);
    mail.applyScenarioChrome();
    expect(document.documentElement.lang).toBe('es');
  });

  it('accepts a catalog tag that uses a BCP 47 singleton subtag', () => {
    const extension = {
      languageNames: ['es-u-ca-gregory', 'spanish'],
      strings: { Mail: 'Correo' },
    };
    const privateUse = {
      languageNames: ['es-x-custom', 'spanish'],
      strings: {},
    };
    const malformed = {
      languageNames: ['es-u', 'es-u-c', 'english', 'spanish'],
      strings: {},
    };

    document.documentElement.lang = 'en';
    const tag = resolveDocumentLanguage('Spanish', [en, extension]);
    expect(tag).toBe('es-u-ca-gregory');
    mail.state.config.documentLanguage = tag;
    mail.applyScenarioChrome();
    expect(document.documentElement.lang).toBe('es-u-ca-gregory');

    expect(resolveDocumentLanguage('Spanish', [privateUse])).toBe('es-x-custom');
    expect(resolveDocumentLanguage('Spanish', [malformed])).toBe('');
  });

  it('does not clear lang when the catalog does not identify a language', () => {
    document.documentElement.lang = 'en';
    const unnamed = { languageNames: ['spanish'], strings: { Mail: 'Correo' } };
    expect(resolveDocumentLanguage('Spanish', [unnamed])).toBe('');
    expect(resolveDocumentLanguage('Spanish', [])).toBe('');
    expect(resolveDocumentLanguage('', [en])).toBe('');

    mail.state.config.documentLanguage = resolveDocumentLanguage('Spanish', [unnamed]);
    mail.applyScenarioChrome();
    expect(document.documentElement.lang).toBe('en');

    mail.state.config.documentLanguage = 'spanish';
    mail.applyScenarioChrome();
    expect(document.documentElement.lang).toBe('en');

    delete mail.state.config.documentLanguage;
    mail.applyScenarioChrome();
    expect(document.documentElement.lang).toBe('en');
  });
});

describe('M6 composer status', () => {
  const sent = 'Mensaje enviado';
  const failed = 'No se pudo enviar';
  const rejected = 'Tipo de archivo no permitido';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function composerStatusEl() {
    return document.getElementById('composerStatus');
  }

  function useStatusStrings() {
    mail.state.config.strings = {
      ...strings,
      'Message sent': sent,
      'Send failed': failed,
      'File type not allowed': rejected,
      'Sending…': 'Enviando…',
    };
  }

  function expectComposerAnnouncement(text) {
    const status = composerStatusEl();
    const pane = document.getElementById('readingPane');
    const log = document.getElementById('assistantMessages');
    expect(status).toBeTruthy();
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe(text);
    expect(pane.contains(status)).toBe(false);
    expect(log.contains(status)).toBe(false);
    expect(pane.hasAttribute('aria-live')).toBe(false);
    expect(status).not.toBe(statusEl());
    expect(statusEl().textContent).toBe(`${strings.Opened}: Vendor quote`);
  }

  async function openQuote() {
    clickThread('thread-quote');
    await nextFrame();
    expect(statusEl().textContent).toBe(`${strings.Opened}: Vendor quote`);
  }

  async function prepareSend() {
    await openQuote();
    useStatusStrings();
    mail.state.session.sessionId = 'session-1';
    mail.state.recipients.to = [DANA];
    document.getElementById('composeSubject').value = 'Quote reply';
    document.getElementById('sendBtn').disabled = false;
  }

  it('announces a successful send outside the reading pane and the assistant log', async () => {
    await prepareSend();
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/api/email/send')) {
        return {
          ok: true,
          json: async () => ({
            email: { id: 'email-sent' },
            thread: mail.state.session.threads[0],
            responders: [],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }));

    await mail.sendEmail();
    await nextFrame();

    expectComposerAnnouncement(sent);
  });

  it('announces a failed send and keeps the opened thread announcement', async () => {
    await prepareSend();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })));

    await mail.sendEmail();
    await nextFrame();

    expectComposerAnnouncement(failed);
    expect(document.getElementById('sendBtn').textContent).toBe(strings.Send);
  });

  it('announces a rejected attachment without replacing the opened thread status', async () => {
    await openQuote();
    useStatusStrings();
    mail.state.config.attachments = { enabled: true, allowedTypes: ['.pdf'] };
    mail.state.assistant.chat = {};

    await mail.handleComposerFiles([new File(['notes'], 'notes.exe', { type: 'application/octet-stream' })]);
    await nextFrame();

    expectComposerAnnouncement(rejected);
  });
});

describe('M9 recipient remove target', () => {
  it('shows a remove control of at least 24 by 24 without hover', () => {
    showComposer();
    mail.state.recipients.to = [DANA];
    mail.renderRecipientPickers();

    const remove = document.querySelector('#composeToChips .recipient-picker__remove');
    const style = getComputedStyle(remove);
    expect(remove.matches(':hover')).toBe(false);
    expect(Number.parseFloat(style.opacity)).toBeGreaterThan(0);
    expect(Number.parseFloat(style.width)).toBeGreaterThanOrEqual(24);
    expect(Number.parseFloat(style.height)).toBeGreaterThanOrEqual(24);
    expect(computeAccessibleName(remove)).toBe(`${strings.Remove} Dana Reyes`);
  });
});

describe('M2 reduced motion', () => {
  let realMatchMedia;

  beforeEach(() => {
    realMatchMedia = window.matchMedia.bind(window);
    riveOptions.length = 0;
    mail.resetThinkingIndicator();
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
    mail.resetThinkingIndicator();
    vi.restoreAllMocks();
  });

  function preferReducedMotion(reduce) {
    window.matchMedia = (query) => {
      const media = String(query);
      if (media.includes('prefers-reduced-motion')) {
        return {
          matches: reduce,
          media,
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
          addListener() {},
          removeListener() {},
          dispatchEvent() { return false; },
        };
      }
      return realMatchMedia(media);
    };
  }

  async function scrollBehaviors(run) {
    const seen = [];
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation((options) => {
      seen.push(options);
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return seen.filter((options) => options && Object.hasOwn(options, 'behavior'));
  }

  async function appScrolls() {
    mail.selectThread('thread-quote');
    await nextFrame();
    const reply = await scrollBehaviors(() => {
      mail.startReply('reply');
    });
    const arrive = await scrollBehaviors(async () => {
      mail.scrollToEmail('email-quote');
      await nextFrame();
    });
    mail.state.view = 'list';
    mail.state.replying = null;
    mail.state.composingNew = false;
    mail.state.activeThreadId = null;
    const inserted = await scrollBehaviors(() => mail.insertProposedDraft({
      to: [DANA],
      cc: [],
      subject: 'Quote',
      body: 'Please send the revised quote.',
    }));
    return [...reply, ...arrive, ...inserted];
  }

  it('uses instant scroll and does not autoplay thinking when motion is reduced', async () => {
    preferReducedMotion(true);
    const scrolls = await appScrolls();
    expect(scrolls.length).toBeGreaterThan(0);
    expect(scrolls.every((options) => options.behavior === 'auto')).toBe(true);

    mail.resetThinkingIndicator();
    riveOptions.length = 0;
    mail.thinkingIndicator();
    expect(riveOptions.at(-1)?.autoplay).toBe(false);
  });

  it('keeps smooth scroll and thinking autoplay without reduced motion', async () => {
    preferReducedMotion(false);
    const scrolls = await appScrolls();
    expect(scrolls.length).toBeGreaterThan(0);
    expect(scrolls.every((options) => options.behavior === 'smooth')).toBe(true);

    mail.resetThinkingIndicator();
    riveOptions.length = 0;
    mail.thinkingIndicator();
    expect(riveOptions.at(-1)?.autoplay).toBe(true);
  });
});
