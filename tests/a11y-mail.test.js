// @vitest-environment happy-dom
/**
 * Accessibility regressions for the 2026-10-06 fixes (S6, S1, S5, S7, S3,
 * and Shift+Tab in the recipient combobox).
 *
 * public/app.js reads the document while the module loads, so this mounts
 * public/index.html first and imports the module after that. Vitest skips
 * the network boot; the tests then call the same UI functions the page uses.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeAccessibleName } from 'dom-accessibility-api';

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
