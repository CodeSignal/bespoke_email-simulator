# CosmoMail UX accessibility audit

**Date:** 2026-10-06  
**Compared with:** [2026-09-29 audit](./2026-09-29-cosmomail-ux-audit.md)  
**Scope:** Learner-facing CosmoMail UI (`public/index.html`, `public/app.js`, `public/app.css`) and the design-system pieces it mounts (Button, Modal, SplitPanel).  
**Standard:** WCAG 2.2 Level AA  
**Method:** Static review, then a live pass on `http://localhost:3000` (inbox, thread, reply composer, recipient menu). Checked computed contrast in light and dark (`prefers-color-scheme`), layout at 1280×900 and 320×800 CSS pixels, focus after list/thread changes, and recipient keyboard handling. Ran axe-core 4.10.3 (WCAG 2.x A/AA tags). No VoiceOver or NVDA session.

## Verdict

The two critical issues from 29 September are fixed in code: mail rows and mailbox buttons have a visible `:focus-visible` ring, and the recipient menu is now a combobox with arrow keys and `aria-activedescendant`. Body text contrast in both color schemes is in good shape, and axe reported no violations on the light-mode inbox or thread.

What is still in the way of AA is the shell around that: the reading pane is still a live region, toasts still vanish after 8 seconds, there is still no skip link, focus is still dropped when opening or leaving a thread, and the fixed rail plus assistant split still does not reflow. New UI since the last audit adds four further AA problems: To and Cc share one accessible name, the floating composer can cover the list, the active recipient’s role line fails contrast in dark mode, and the assistant log is rebuilt inside a live region on every update.

---

## September 29 findings

| ID | Was | Now | Notes |
|----|-----|-----|-------|
| C1 | Critical | **Fixed** | `.mail-row:focus-visible` and `.rail__mailbox:focus-visible` use a 2px `--Colors-Stroke-Primary` outline. |
| C2 | Critical | **Fixed** | Options are `div[role="option"]` inside `li[role="presentation"]`. ArrowUp/ArrowDown, Enter, Escape, and `aria-activedescendant` work. The field’s name is a separate issue (S6). |
| S1 | Serious | **Still open** | `#readingPane` still has `aria-live="polite"`. Opening a thread replaces that subtree. |
| S2 | Serious | **Still open** | `showMailToast()` still dismisses on a fixed 8s timer. No pause on hover or focus. |
| S3 | Serious | **Still open** | At 320px the rail stays 260px, the mail column measures 40px, and the assistant column 24px, under `overflow: hidden`. |
| S4 | Serious | **Still open** | No skip link. First stops are Compose, folders, rows, the split divider, then the assistant. |
| S5 | Serious | **Still open** | Activating a focused row left focus on that row inside the now-hidden list. Back sent focus to `body` and did not restore the row. |
| M1 | Moderate | **Still open** | Secondary and tertiary focus rings are still a zero-spread shadow. The primary rule is now a broken selector (see below). |
| M2 | Moderate | **Partial** | Toast entrance and the typing dots honor `prefers-reduced-motion`. Arrival highlight, smooth `scrollIntoView`, and the thinking Rive animation do not. |
| M3 | Moderate | **Fixed** | Toasts use `--Colors-Text-Body-Light`. The app no longer references the undefined Secondary token. |
| M4 | Moderate | **Still open** | `document.documentElement.lang` stayed `en`. `applyScenarioChrome()` does not set it. |
| M5 | Moderate | **Fixed** | Compose is no longer a Modal. Open moves focus to the To field. |
| M6 | Moderate | **Still open** | Send failures and rejected attachments still go to the console. “Sending…” is only a button label. |
| M7 | Moderate | **Still open** | `.button:disabled { opacity: 0.24 }` is unchanged. |
| N1 | Minor | Unchanged | TipTap placeholder is still CSS; the editor’s accessible name is “Message”. |
| N2 | Minor | **Still open** | Enter sends in the assistant. No hint in the name or description. |
| N3 | Minor | Holding | Avatars stay `aria-hidden` next to names. |
| N4 | Minor | **Still open** | In-app mailto links are still `href="#"` plus a click handler. |
| N5 | Minor | **Fixed** | `--Colors-Icon-Default` is now `#5B688F` (~5.5:1 on white), not the old `#ACB4C7`. |
| N6 | Minor | Holding | One `h1`. Thread subject, composer, and assistant are `h2`. |
| N7 | Minor | **Obsolete** | Minimize/restore is gone. Close is a labeled icon button. |

---

## What is working well

| Area | Evidence |
|------|----------|
| Document language (English scenarios) | `<html lang="en">` matches the loaded scenario |
| Landmarks | Mailbox `aside`, folder `nav`, `main`, assistant `aside` |
| Icon controls | Compose, close, toast dismiss, reply, and cycle buttons have names; SVGs are `aria-hidden` |
| Active folder | `aria-current="true"` |
| Unread mail | List rows append a visually hidden “, New”. The inbox dot is `role="img"` named “New messages” |
| Recipient keyboard path | Combobox, expanded state, active descendant, arrows, Enter to commit, Escape to close |
| Split divider | `role="separator"`, label “Resize AI Assistant panel”, `aria-valuemin/max/now`, `tabindex="0"` |
| Suggestion cycling | Previous/Next are named, and focus returns to the control that was used |
| Boot failure | `#bootError` is `role="alert"` |
| Light-mode text | Measured ratios for folder, row, toolbar, To label, and assistant copy are all above 4.5:1 |
| Dark-mode body text | Folder, row, date, and assistant hint measured 7.3:1 to 18:1 |
| axe-core 4.10.3 | 0 violations on the light-mode inbox and on the thread with the reply composer open |

---

## Findings

Severity guide:

- **Critical** — Blocks a primary task for keyboard or AT users, or a clear AA failure on a core path.
- **Serious** — Significant barrier; a core path is degraded.
- **Moderate** — Real WCAG or AT impact, with a workaround.
- **Minor** — Polish, best practice, or an edge case.

### Serious

#### S1. Reading pane `aria-live="polite"` re-announces threads

**WCAG:** 4.1.3 Status Messages  
**Where:** `#readingPane` in `public/index.html`; content replaced in `renderThread()`  
**Status:** Still open from 29 September.  
**Issue:** The conversation container is a polite live region. Opening a thread swaps in the whole message (283 characters on the short “hi” thread in this session). That competes with toasts and the assistant log.  
**Fix:** Remove `aria-live` from `#readingPane`. Announce the view change from the toolbar `h1` or a one-line status (“Opened: …”).

#### S2. Inbound mail toasts auto-dismiss after 8 seconds

**WCAG:** 2.2.1 Timing Adjustable  
**Where:** `showMailToast()` — `setTimeout(..., 8000)`  
**Status:** Still open. The slide-in animation now turns off under reduced motion; the timer does not pause.  
**Issue:** Open and Dismiss are on a fixed clock, with no pause while the toast is hovered or focused.  
**Fix:** Pause the timer while the toast or a descendant is hovered or focused. Keep the inbox row as the durable copy of the same message.

#### S3. Fixed rail and assistant split do not reflow

**WCAG:** 1.4.10 Reflow  
**Where:** `.mail-app { grid-template-columns: 260px minmax(0, 1fr); height: 100vh; overflow: hidden; }` and `SplitPanel` minimums (`minLeft: 40`, `minRight: 18`)  
**Status:** Still open, and the assistant split makes the narrow case worse.  
**Measured at 320×800 CSS px:** rail 260×800, mail column 40px wide, assistant 24px wide, a mail row 26px wide. `scrollWidth` equals the viewport because overflow is hidden, so the clipped mail cannot be scrolled to.  
**Fix:** Below a breakpoint, stack or drawer the rail and the assistant. Keep the list and the reading pane in one column.

#### S4. No skip link

**WCAG:** 2.4.1 Bypass Blocks  
**Where:** Start of `body` in `public/index.html`  
**Status:** Still open.  
**Fix:** First focusable element should be a visually hidden “Skip to mail” link targeting `#mailMain`.

#### S5. Focus is lost or left in hidden content when switching list and thread

**WCAG:** 2.4.3 Focus Order  
**Where:** `selectThread()`, `backToList()`, `selectMailbox()`, `renderMailList()`  
**Status:** Still open. Confirmed in the running app.  
**Issue:** Focusing a row and activating it left `document.activeElement` on that `.mail-row` after `#mailList` was hidden. Activating Back (which then hides) moved focus to `body`. Returning to the list does not focus the thread that was open.  
**Fix:** On open, move focus to `#mailToolbarTitle` (`tabindex="-1"`) or to Back. On return, focus the row for `activeThreadId` if it is still there.

#### S6. To and Cc have the same accessible name

**WCAG:** 1.3.1 Info and Relationships, 2.4.6 Headings and Labels, 4.1.2 Name, Role, Value  
**Where:** `renderRecipientMenu()` sets `aria-label="Add a recipient"` on `#composeToInput` and `#composeCcInput`, which also have `aria-labelledby` pointing at “To” and “Cc”  
**Status:** New. The keyboard widget from C2 is in place; the name regressed with the typeahead.  
**Issue:** When both `aria-label` and `aria-labelledby` are set, the label wins and the labelled-by relationship is dropped. Both fields announce as “Add a recipient”. The visible “To” / “Cc” text is a `<span>`, and the colon is a CSS `::after`, so it is not in the name either. Confirmed in the accessibility tree.  
**Fix:** Remove the extra `aria-label`, or set the name to “To, add a recipient” / “Cc, add a recipient” and drop `aria-labelledby`. Keep one naming method.

#### S7. The new-message composer can cover the mail list

**WCAG:** 2.4.11 Focus Not Obscured (Minimum)  
**Where:** `.composer.is-new` is `position: absolute` over the bottom of `#mailMain`. The list stays in the tab order.  
**Status:** New. Compose used to be a modal; it is now a non-modal overlay (`role="group"`, no `aria-modal`, background not inert).  
**Measured:** At about 680×466 the panel was 390px tall from y=64 and covered all three inbox rows completely (`visibleAbove: 0`) while those buttons stayed focusable. At 1280×900 the same three short rows sat above the panel. A longer list, or 400% zoom, puts focused rows under the panel.  
**Fix:** While the overlay is open, move covered list controls out of the tab order, or keep the list scrolled so the focused row stays above the panel. A reply composer that is `position: sticky` at the bottom of the thread has the same risk for content under it.

### Moderate

#### M1. Design-system button focus rings are missing or empty

**WCAG:** 2.4.7 Focus Visible  
**Where:** `design-system/components/button/button.css`  
**Status:** Still open, and the primary ring regressed.  
**Issue:** The primary rule is missing a comma, so it is a descendant selector that never matches:

```css
.button-primary:focus
.button-primary.focus { /* parsed as .button-primary:focus .button-primary.focus */ }
```

The stylesheet text is `.button-primary:focus .button-primary.focus`. Secondary and tertiary still use `box-shadow: 0 0 0 0 …`. `.button` does not set `outline: none`, so the browser’s own outline can still show in Chrome. The design-system ring does not. Reply / Reply all use `button-secondary`.  
**Fix:** Restore `.button-primary:focus, .button-primary.focus` and give secondary, tertiary, and text buttons a visible `:focus-visible` ring.

#### M2. Some motion still ignores `prefers-reduced-motion`

**WCAG:** 2.3.3 Animation from Interactions (AAA criterion; still a user setting the shell already handles in places)  
**Where:** `.email--arrive` in `public/app.css`; `scrollIntoView({ behavior: 'smooth' })` in `scrollToEmail()`, `startReply()`, and draft insert; `thinkingIndicator()` autoplays `thinking.riv`  
**Status:** Partial. `@media (prefers-reduced-motion: reduce)` now disables `.mail-toast` animation and `.assistant__typing-dot`.  
**Fix:** Under reduce, use `behavior: 'auto'`, drop the arrival keyframes, and do not autoplay the Rive file.

#### M4. `html[lang]` does not follow the scenario language

**WCAG:** 3.1.1 Language of Page  
**Where:** Hardcoded `lang="en"`; `applyScenarioChrome()` updates the title and labels only  
**Status:** Still open. This session’s scenario is English, so the live page was correct. `i18n/es.json` is a real non-English catalog.  
**Fix:** Set `document.documentElement.lang` from the resolved language at boot.

#### M6. Send and attachment failures are not announced

**WCAG:** 4.1.3 Status Messages  
**Where:** `sendEmail()`, `handleComposerFiles()`  
**Status:** Still open.  
**Issue:** The Send label flips to “Sending…”. Upload rejects and send errors call `console.warn` / `console.error` only. There is no status live region.  
**Fix:** Write “Message sent”, “Send failed”, and “File type not allowed” into a polite or assertive status region that is not the reading pane.

#### M7. Disabled buttons sit at 0.24 opacity

**WCAG:** Disabled controls are exempt from 1.4.3; this is still hard to see  
**Where:** `.button:disabled { opacity: 0.24 }`  
**Status:** Still open. Send uses this treatment while it is disabled.  
**Fix:** A disabled palette whose text stays near 4.5:1, or opacity no lower than about 0.5, with a disabled cursor and `aria` state already provided by the `disabled` attribute.

#### M8. Dark mode: highlighted recipient role text is 3.86:1

**WCAG:** 1.4.3 Contrast (Minimum)  
**Where:** `.recipient-picker__option-meta` uses `--Colors-Text-Body-Light` (`#7F8BAD`). The active option’s fill composites to about `#24304C`.  
**Status:** New. axe-core reported this as the only violation in the dark-mode thread (impact: serious, ratio 3.85, 14px regular).  
**Measured:** Active option meta 3.86:1. Inactive option meta 4.70:1 (pass). Option names 7.7:1 and up. Light-mode equivalents for folder, row, To label, and chips all passed 4.5:1. Placeholder token `#68759C` on white is 4.55:1, a pass with little margin.  
**Fix:** On the active option, use a lighter meta color that clears 4.5:1 on `--Colors-Control-Primary-Subtle` in dark mode.

#### M9. Recipient remove control is hidden until hover or keyboard focus

**WCAG:** 2.5.8 Target Size (Minimum); pointer users who cannot hover  
**Where:** `.recipient-picker__remove` is `width: 0` and `opacity: 0` until `:hover` on the chip or `:focus-visible`  
**Status:** New. Confirmed computed width `0px` and opacity `0` after adding Jane Doe. The accessible name (“Remove Jane Doe”) is fine, and keyboard focus does reveal an 18×18 control.  
**Issue:** The hit target is absent until hover. Touch and other non-hover pointers cannot reach it. Backspace removes only the last chip. 18px is also under the 24px CSS minimum once it appears.  
**Fix:** Keep at least a 24×24 visible remove control, or show it on tap of the chip.

#### M10. Split divider’s focus line is overridden

**WCAG:** 2.4.7 Focus Visible  
**Where:** `public/app.css` sets `#mailSplit .split-panel-divider::after { background: transparent }`. The design-system focus style is `.split-panel-divider:focus-visible::after`.  
**Status:** New. The separator’s name and value attributes are in good shape.  
**Issue:** The id selector beats the design-system focus rule, so keyboard focus does not turn the line blue. What does appear is `.split-panel-divider-handle` (10×40, background `#000`) fading to opacity 1. On the dark shell that handle sits on a near-black seam. Hover does paint a line, via a more specific `#mailSplit …:hover::after` rule.  
**Fix:** Give `#mailSplit .split-panel-divider:focus-visible::after` the same visible line as hover, and a handle color that clears 3:1 in dark mode.

#### M11. Assistant output is rebuilt inside a live region

**WCAG:** 4.1.3 Status Messages; AT usability  
**Where:** `renderAssistant()` sets `assistantMessages.innerHTML = ''` on a `role="log"` with `aria-live="polite"`. `thinkingIndicator()` is `role="status"` and is appended inside that log. `updateAssistantThinking()` sets `aria-busy` on the same node. Suggested-reply text is an `aria-live` node that `renderQuickResultPanel()` destroys and recreates on every cycle.  
**Status:** New. The 29 September audit treated the log as a sound pattern. Rebuilding it on each chat update, and nesting the thinking status in an `aria-busy` live region, fights that.  
**Issue:** Replacing the log’s children can make a screen reader read the whole conversation again. `aria-busy="true"` on the parent can also suppress the “Thinking…” / “Working…” status the code comment expects to announce. Cycling suggestions restores focus to Previous/Next (good) but the new reply text is a brand-new live node, which often does not announce.  
**Fix:** Append or update the latest turn instead of clearing the log. Put the thinking status outside the log. Update the suggestion text in a stable live node instead of recreating the card.

### Minor

#### N2. Assistant Enter-to-send is undisclosed

Enter sends; Shift+Enter inserts a newline. The textarea name is “Message the AI Assistant” and does not mention the shortcut.

#### N4. `href="#"` mailto shim

`renderMarkdown` still emits `<a href="#" class="js-compose-mailto">`. The click handler calls `preventDefault`. A real fragment or `role="button"` would match the behavior.

#### N8. Mail-row names run together

**Where:** `renderMailList()`  
**Status:** New.  
**Example from this session:** “Alex Rivera hi 8:15 AM , New”. From, subject, and time are separate spans with no accessible separator other than the unread suffix. The snippet exists only as a `title` tooltip.  
**Fix:** Build the button name with explicit pieces (“Alex Rivera. hi. 8:15 AM. New”) or `aria-label` it. Leave the snippet out of `title` if it is not also in the name or description.

#### N9. List separators are real `<hr>` elements

Each row is followed by `<hr class="mail-list__rule">`, so a screen reader announces a separator between messages. A CSS border would keep the visual rule without the extra stop.

---

## Contrast spot checks

Light mode, computed and composited over the real background:

| Pair | Ratio | Result |
|------|-------|--------|
| Active folder (#0B1223) on tinted row | 17.5:1 | Pass |
| Inactive folder (#4F5C82) on white | 6.6:1 | Pass |
| Inactive count (#5B688F) on white | 5.5:1 | Pass |
| Row from / toolbar on white | 18.7:1 | Pass |
| Row subject / assistant hint (#2E3856) on white | 11.6:1 | Pass |
| Row date (#4F5C82) on white | 6.6:1 | Pass |
| To/Cc label (#5B688F) on white | 5.5:1 | Pass |
| Compose button, white on #1062FB | 5.1:1 | Pass |
| Placeholder token (#68759C) on white | 4.55:1 | Pass, thin margin |
| Icon Default (#5B688F) on white | ~5.5:1 | Pass (N5 fixed) |

Dark mode:

| Pair | Ratio | Result |
|------|-------|--------|
| Active folder, white on tinted row | 15.8:1 | Pass |
| Inactive folder / row date (#97A1BF) on #0B1223 | 7.3:1 | Pass |
| Row subject / assistant hint (#BEC7DF) | 10–11:1 | Pass |
| To label (#7F8BAD) on composer surface | 5.2:1 | Pass |
| Recipient role, inactive option | 4.7:1 | Pass |
| Recipient role, **active** option (#7F8BAD on #24304C) | **3.86:1** | **Fail** |

---

## axe-core 4.10.3

| View | Scheme | Violations | Incomplete |
|------|--------|------------|------------|
| Inbox, composer closed or covered by the overlay | Light | 0 | 0 |
| Thread, reply composer, recipient menu open | Light | 0 | Color contrast on empty Cc and Subject inputs (axe could not decide) |
| Thread, recipient menu open | Dark | 1: active recipient meta, 3.85:1 | Color contrast on the same empty inputs |

axe does not judge reflow, skip links, focus retention, live-region noise, or toast timing. Those remain manual findings above.

---

## Recommended fix order

1. **S6** — Give To and Cc distinct accessible names  
2. **S1** and **M11** — Stop announcing whole threads and whole assistant transcripts  
3. **S5** — Move focus on list, thread, and Back  
4. **S7** and **S3** — Keep focused content visible, then reflow the shell  
5. **S2** and **S4** — Pause toasts; add a skip link  
6. **M8** and **M1** — Dark-mode meta contrast; repair button focus CSS  
7. **M4, M6, M9, M10, M2** — Language, status messages, remove target, divider focus, reduced motion  

---

## Files reviewed

- `public/index.html`
- `public/app.js`
- `public/app.css`
- `design-system/colors/colors.css`
- `design-system/components/button/button.css`
- `design-system/components/modal/modal.js`
- `design-system/components/split-panel/split-panel.js`
- `design-system/components/split-panel/split-panel.css`
