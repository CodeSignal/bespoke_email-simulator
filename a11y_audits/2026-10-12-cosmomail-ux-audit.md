# CosmoMail UX accessibility audit

**Date:** 2026-10-12  
**Compared with:** [2026-10-06 audit](./2026-10-06-cosmomail-ux-audit.md)  
**Scope:** Learner-facing CosmoMail UI (`public/index.html`, `public/app.js`, `public/app.css`) and the design-system pieces this repo mounts (Button, Modal, SplitPanel, color tokens). Design-system pin `7e9978b` (merge of design-system PR #37 on `fix/a11y-button-focus-ring`), not design-system `main`.  
**Standard:** WCAG 2.2 Level AA  
**Method:** Static review of `main` at `d27be34` (pull was already up to date; PR #40 is in this tree), then a live pass on `http://localhost:3000`. Covered the inbox, an open thread, reply and new-message compose, the recipient menu, and the assistant. Checked computed contrast in light and dark (`prefers-color-scheme`), layout at 1280×900 and 320×800 CSS pixels, and focus after list, thread, Back, and compose open/close. Ran axe-core 4.10.3 with WCAG 2.x A/AA tags. No VoiceOver or NVDA session. No inbound toast appeared, so toast timing was checked in code only. The live pass saved a new-message draft addressed to Jane Doe in the running session.

## Verdict

The 29 September and 6 October fixes are still in place. None of those checklist rows regressed. Mail rows, folders, buttons, and the split divider show a focus ring. To and Cc have different names. The shell stacks into drawers at 320px. The reading pane is not a live region. Body text in both color schemes clears 4.5:1.

What still blocks AA is new. Opening a thread moves focus onto a heading that is clipped to 1px, so the focus indicator disappears. Closing compose hides the focused Close control and leaves focus on `body`. At 320px the message header crushes the sender name to a few pixels. The assistant transcript scrolls and, when the quick-action chips are hidden, has no keyboard tab stop. The assistant field’s placeholder fails contrast in both schemes.

---

## Prior findings

| ID | Status | Evidence |
|----|--------|----------|
| C1 | **Still fixed** | `.mail-row:focus-visible` and `.rail__mailbox:focus-visible` are a 2px `--Colors-Stroke-Primary` outline. |
| C2 | **Still fixed** | Options are `div[role="option"]` inside `li[role="presentation"]`. ArrowDown moved `aria-activedescendant` from Alex Rivera to Jane Doe. Enter, Escape, and the combobox state are unchanged. |
| S1 | **Still fixed** | `#readingPane` has no `aria-live`. Opening a thread writes one line to `#mailViewStatus` (“Opened: …”). |
| S2 | **Still fixed** | `armMailToastTimer()` pauses on `pointerenter` and `focusin`, and resumes the leftover time on leave. No toast was reached in this session. |
| S3 | **Still fixed** | At 320×800 the rail and divider are `display: none`, the assistant column is 0×0, `#mailMain` is 320px wide, and `documentElement.scrollWidth` is 320. Folders and the assistant open as drawers. |
| S4 | **Still fixed** | “Skip to mail” is the first control. On focus it is a 119×36 primary button, white on `#1062FB`, with a 2px white outline, and it targets `#mailMain`. |
| S5 | **Still fixed** | Opening a row left `activeElement` on `#mailToolbarTitle`, not on the hidden list. Back returned focus to that row and cleared the status. The heading itself is a new problem (S8). |
| S6 | **Still fixed** | The fields announce “To, Add a recipient” and “Cc, Add a recipient”. `aria-labelledby` is removed. |
| S7 | **Still fixed** | At 1280×520, three draft rows fully under the composer had `tabindex="-1"`. A row that still showed above the panel stayed tabbable. Covered reply buttons in a thread did the same. |
| M1 | **Still fixed** | The pinned button CSS is `.button-primary:focus, .button-primary:focus-visible, .button-primary.focus` with a 2px stroke outline. Secondary, tertiary, and text buttons have the same outline. |
| M2 | **Still fixed** | Under `prefers-reduced-motion: reduce`, `.email--arrive`, `.mail-toast`, and `.assistant__typing-dot` compute to `animation-name: none`. `thinkingIndicator()` sets Rive `autoplay` only when that media query does not match. `viewScrollBehavior()` uses `auto`. |
| M3 | **Still fixed** | Toasts use `--Colors-Text-Body-Light`. The app does not reference a Secondary text token. |
| M4 | **Still fixed** | `applyScenarioChrome()` sets `document.documentElement.lang` from `documentLanguage` when the tag is valid. This session was `en`. Only `i18n/en.json` exists. |
| M5 | **Still fixed** | Opening Compose moved focus to `#composeToInput`. |
| M6 | **Still fixed** | Send success and failure call `announceComposerStatus()` (“Message sent”, “Send failed”). A rejected file type announces “File type not allowed”. Those strings go to `#composerStatus`, not `#mailViewStatus`. A failed upload after the file is accepted is a separate gap (M13). |
| M7 | **Still fixed** | `.button:disabled` is opacity 0.5. `.button-primary:disabled` is opacity 1 with a disabled palette. The disabled Send control measured 4.91:1 in dark mode. |
| M8 | **Still fixed** | Active option meta in dark mode measured 5.08:1 (`#97A1BF` on `#25304D`). Inactive meta was 4.70:1. axe reported no contrast violation on the open menu. |
| M9 | **Still fixed** | After adding Jane Doe, Remove was 24×24, opacity 1, name “Remove Jane Doe”. |
| M10 | **Still fixed** | With `:focus-visible` on the separator, the line computed to `rgba(79, 92, 130, 0.58)` at 4px and the handle to white at opacity 1. Name, min, max, and now are set. |
| M11 | **Still fixed** | `reconcileAssistantLog()` updates existing turn nodes. The thinking status is inserted after `#assistantMessages`, and `aria-busy` stays on the log. Suggestion text updates the same `aria-live` node. |
| N2 | **Still fixed** | `#assistantInput` has `aria-describedby="assistantInputHint"`: “Enter sends. Shift+Enter inserts a newline.” |
| N4 | **Still fixed** | In-app mailto targets render as `<button class="js-compose-mailto">`, not `href="#"`. |
| N5 | **Still fixed** | Icon Default computed to `#5B688F` on white, 5.5:1. |
| N7 | **Still obsolete** | There is no minimize or restore control. Close is a labeled icon button. |
| N8 | **Still fixed** | The inbox row’s name is “Alex Rivera. This week's prospect list — pick one and let's align. 5:17 AM”. Draft rows use the same “. ” join. |
| N9 | **Still fixed** | `renderMailList()` does not emit `<hr>`. Rows use `border-bottom`. The live document had no `hr`. |

N1, N3, and N6 were not refiled. The editor’s accessible name is still “Message”, and the empty-state hint is still the CSS placeholder. Avatars stay `aria-hidden` next to the person’s name. There is one toolbar `h1`. The thread subject, composer title, and assistant title stay `h2`.

---

## What is working well

| Area | Evidence |
|------|----------|
| Document language | `<html lang="en">`, set from `documentLanguage` when the tag is valid |
| Landmarks | Mailbox `aside`, folder `nav`, `main`, assistant `aside` |
| Skip link | First tab stop, visible on focus, targets `#mailMain` |
| Icon controls | Compose, close, reply, and cycle buttons have names. SVGs are `aria-hidden` |
| Active folder | `aria-current="true"` |
| Unread mail | Row names append “. New”. The inbox dot is `role="img"` named “New messages” when present |
| Recipient keyboard path | Combobox, expanded state, active descendant, arrows. ArrowDown moved the active option |
| Covered composer | Fully covered list rows and reply buttons leave the tab order |
| Narrow shell | At 320px the mail column is the viewport. Drawers take focus, set `inert` on `#mailMain`, and return focus to the drawer button |
| Split divider | `role="separator"`, “Resize AI Assistant panel”, value attributes, visible focus line and white handle |
| Assistant shortcut | Described by “Enter sends. Shift+Enter inserts a newline.” |
| Suggestion cycling | Previous and Next are named. The suggestion text stays one live node |
| Reduced motion | Arrival, toast, and typing animations compute to none. Rive autoplay is off when the media query matches |
| Boot failure | `#bootError` is `role="alert"` |
| Light and dark body text | Folder, row, toolbar, thread, and assistant copy measured above 4.5:1, except the assistant placeholder (M12) |
| Button focus CSS | Primary, secondary, tertiary, and text variants use a 2px stroke outline, including `:focus-visible` |

---

## Findings

Severity guide:

- **Critical.** Blocks a primary task for keyboard or AT users, or a clear AA failure on a core path.
- **Serious.** Significant barrier. A core path is degraded.
- **Moderate.** Real WCAG or AT impact, with a workaround.
- **Minor.** Polish, best practice, or an edge case.

### Serious

#### S8. Opening a thread moves focus to a clipped heading

**WCAG:** 2.4.7 Focus Visible  
**Where:** `focusThreadHeading()` focuses `#mailToolbarTitle`. `applyView()` adds `visually-hidden` to that heading while a thread is open. `.visually-hidden` is 1×1, clipped, and `overflow: hidden`.  
**Observed:** After activating the Alex Rivera row, `document.activeElement` was `#mailToolbarTitle`. Its box was 1×1 with `clip: rect(0px, 0px, 0px, 0px)`. The visible thread subject is a separate `h2`. The “Opened:” status still announces the subject, and Back still restores the row (S5). A sighted keyboard user gets no focus indicator until the next Tab.  
**Fix:** When a thread opens, move focus to a control that is on screen, such as Back or the visible thread subject. Keep the one-line “Opened:” status.

#### S9. Closing compose leaves focus on the page

**WCAG:** 2.4.3 Focus Order  
**Where:** `closeComposeOverlay()` and the reply branch of `closeComposer()` hide the panel after the draft save. Neither moves focus first.  
**Observed:** Opening Compose put focus on To. Activating Close left focus on that button until the panel hid, then `document.activeElement` was `body`. Closing a reply composer did the same. Opening a reply does put focus in the message editor.  
**Fix:** Before the composer is hidden, move focus to the control that opened it, or to Back when the reply was opened from the thread.

#### S10. The message header clips the sender at 320px

**WCAG:** 1.4.10 Reflow  
**Where:** `.email__from` is `flex: 0 1 auto`, `min-width: 0`, `white-space: nowrap`, and ellipsis. `.email__date` is `flex: 0 0 auto` and does not shrink. The three sit on one row (`.email__row--from`).  
**Observed:** At 320×800 the shell itself fits: no horizontal document scroll, mail column 320px. Inside the open message, “Alex Rivera” computed to 8px wide (scroll width 80) and “You” to 4px. The address was about 19px. The date stayed about 138px. The thread-heading subject still wrapped. A list row at the same width kept “Alex Rivera” at 124px, so this is the message header, not the inbox row.  
**Fix:** At the narrow breakpoint, give the sender a full line of its own, and let the address and date wrap or stack, so the name stays readable at 320px CSS.

#### S11. The assistant transcript cannot be scrolled from the keyboard

**WCAG:** 2.1.1 Keyboard  
**Where:** `#assistantContent` is `overflow-y: auto` and has no `tabindex`. The textarea sits outside that scroller. Quick-action chips, when shown, are the only focusable controls inside it.  
**Observed:** On the inbox the scroller’s client height was 681px and its scroll height was 1118px, with zero focusable descendants (`#assistantChips` hidden). axe-core reported `scrollable-region-focusable` (impact serious, tags `wcag2a` / `wcag211`). With chips showing, that rule passed because a chip is a tab stop at the bottom of the region. Tabbing to the chip does not give a way to move back through earlier turns.  
**Fix:** Make the transcript a named keyboard-scrollable region so arrow and page keys move through it. Leave the log’s existing live behavior as it is, and do not announce assistant turns through `#mailViewStatus` or `#composerStatus`.

### Moderate

#### M12. Assistant placeholder text fails contrast in both schemes

**WCAG:** 1.4.3 Contrast (Minimum)  
**Where:** `.assistant__input::placeholder` uses `--Colors-Text-Body-Lighter`. The field is 16px, weight 400.  
**Observed:** Light mode, `#68759C` on `#F6F7FB`, 4.25:1. Dark mode, `#7380A5` on `#1C243C`, 3.92:1. The accessible name is “Message the AI Assistant”, so AT still has a name. The visible hint “Ask me anything...” is the text that fails. The recipient placeholder on the composer surface passed at 4.50:1 in dark mode. “Thought for 3s” passed at 4.55:1 light and 4.50:1 dark.  
**Fix:** Use a placeholder color that clears 4.5:1 on the assistant composer surface in both schemes.

#### M13. A failed upload is not announced

**WCAG:** 4.1.3 Status Messages  
**Where:** The `catch` in `handleComposerFiles()` logs `console.error` and sets the chip status to `error`. `renderAttachmentPreview()` then shows the file name plus “(failed)”.  
**Observed:** This scenario sets `attachments.enabled` to false, so Attach was hidden and the path was not exercised live. Rejected types and send errors already call `announceComposerStatus()` (M6, still fixed). A transport failure after the file is accepted does not.  
**Fix:** Write the failure into `#composerStatus`, the same status region used for “File type not allowed” and “Send failed”.

### Minor

#### N10. Recipient option names run together

**WCAG:** 2.4.6 Headings and Labels  
**Where:** `renderRecipientMenu()` puts the name and the role in adjacent spans inside `role="option"`.  
**Observed:** The accessibility tree name was “Alex Rivera Sales manager at BestCRM”, with no separator. Mail rows already join their pieces with “. ” (N8, still fixed).  
**Fix:** Give each option an accessible name with a separator between the person and the role or email.

---

## Contrast spot checks

Computed colors, composited over the element’s background. Ratios are from this pass.

Light mode:

| Pair | Ratio | Result |
|------|-------|--------|
| Active folder, `#0B1223` on `#F4F8FF` | 17.5:1 | Pass |
| Inactive folder, `#4F5C82` on white | 6.59:1 | Pass |
| Inactive count / Back / To label, `#5B688F` on white | 5.50:1 | Pass |
| Row from / toolbar, `#0B1223` on white | 18.67:1 | Pass |
| Row date, `#4F5C82` on white | 6.59:1 | Pass |
| Subject and message body, `#2E3856` on white | 11.56:1 | Pass |
| Compose, white on `#1062FB` | 5.05:1 | Pass |
| “Thought for 3s”, `#68759C` on white | 4.55:1 | Pass, thin margin |
| Assistant placeholder, `#68759C` on `#F6F7FB` | **4.25:1** | **Fail** |
| Icon Default, `#5B688F` on white | 5.5:1 | Pass |
| Focus stroke, `#377DFF` on white | 3.79:1 | Pass for 3:1 |

Dark mode:

| Pair | Ratio | Result |
|------|-------|--------|
| Active folder, white on `#182339` | 15.75:1 | Pass |
| Inactive folder / row date, `#97A1BF` on `#0B1223` | 7.26:1 | Pass |
| Count / To label, `#7F8BAD` on `#0B1223` | 5.51:1 | Pass |
| Row subject, `#BEC7DF` on `#0B1223` | 11.04:1 | Pass |
| Assistant message, `#BEC7DF` on `#11182C` | 10.43:1 | Pass |
| “Thought for 3s”, `#7380A5` on `#11182C` | 4.50:1 | Pass, no margin |
| Assistant placeholder, `#7380A5` on `#1C243C` | **3.92:1** | **Fail** |
| Recipient placeholder on the composer | 4.50:1 | Pass |
| Active recipient role, `#97A1BF` on `#25304D` | 5.08:1 | Pass |
| Inactive recipient role | 4.70:1 | Pass |
| Disabled Send, opacity 1 | 4.91:1 | Pass |

---

## axe-core 4.10.3

WCAG 2.x A/AA tags (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`).

| View | Scheme | Violations | Incomplete |
|------|--------|------------|------------|
| Inbox, chips hidden | Light | 1: `#assistantContent` `scrollable-region-focusable` | 0 |
| Thread, reply composer closed, chips showing | Light | 0 | 0 |
| Inbox, chips hidden | Dark | 1: the same scrollable region | Color contrast on an assistant line scrolled out of the pane |
| New message, recipient menu open, chips showing | Dark | 0 | Color contrast on Cc and Subject, overlapped by the menu, and on that same scrolled line |

axe does not judge the clipped heading, focus after compose closes, the 8px sender, or toast timing. Those are the manual findings above. The scrollable-region hit is S11. The dark recipient role that failed on 6 October did not fail here.

---

## Recommended fix order

1. **S8** and **S9.** Keep a visible focus stop when a thread opens, and put focus somewhere visible when compose closes.  
2. **S10.** Let the sender name survive at 320px.  
3. **S11.** Let the keyboard scroll the assistant transcript.  
4. **M12.** Raise the assistant placeholder above 4.5:1 in both schemes.  
5. **M13** and **N10.** Announce a failed upload. Separate the recipient’s name from their role.

---

## Files reviewed

- `public/index.html`
- `public/app.js`
- `public/app.css`
- `design-system` at `7e9978b`: `colors/colors.css`, `components/button/button.css`, `components/modal/modal.js`, `components/modal/modal.css`, `components/split-panel/split-panel.js`, `components/split-panel/split-panel.css`
- `i18n/en.json` (the only catalog)
- `scenario.json` (attachments flag and the mailbox used in the live pass)
