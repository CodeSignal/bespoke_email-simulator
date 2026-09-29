# CosmoMail UX accessibility audit

**Date:** 2026-09-29  
**Scope:** Learner-facing CosmoMail UI (`public/index.html`, `public/app.js`, `public/app.css`) and design-system pieces the app mounts (Modal, buttons, inputs, tags, boxes).  
**Standard:** WCAG 2.2 Level AA  
**Method:** Static review of markup, interaction code, CSS focus/motion, and calculated contrast for semantic color tokens. No automated axe scan or AT session was run for this pass.

## Verdict

The shell has a solid landmark structure and several intentional a11y patterns (labeled icon buttons, recipient remove labels, modal inert/focus trap, assistant `role="log"`, toast live region). The highest-risk gaps are **missing focus visibility on the mail list and mailbox rail**, a **non-APG recipient picker**, **noisy live regions on the reading pane**, **toast auto-dismiss timing**, and **no reflow strategy** for the fixed three-column layout.

---

## What is working well

| Area | Evidence |
|------|----------|
| Document language | `<html lang="en">` |
| Landmarks | `aside` mailbox rail, `main`, `nav` folders, `aside` assistant, labeled regions |
| Icon-only controls | Compose chrome, back, clear, toast dismiss use `aria-label` + decorative SVG `aria-hidden` |
| Active folder | `aria-current="true"` on the active mailbox button |
| Subject field | Native `<label>` wrapping the input |
| To / Cc | `role="group"` + `aria-labelledby` |
| TipTap body | `aria-label` on the editor surface; focus ring via `.composer__body:focus-within` |
| Compose overlay modal | Design-system Modal: `role="dialog"`, `aria-modal`, inert background, Tab trap, Escape, focus restore |
| Toasts container | `aria-live="polite"` + `aria-relevant="additions"`; each toast `role="status"` |
| Assistant | `role="log"` + `aria-live="polite"`; input has `aria-label` |
| Boot failure | `#bootError` uses `role="alert"` |
| Text contrast (body) | `--Colors-Text-Body-Light` (#515C7A) ≥ ~6.1:1 on main backgrounds (token already tuned for 1.4.3) |
| Design-system Dropdown / SplitPanel / NumericSlider | Roving focus, `aria-*` value attrs, Escape nesting with modals (when those components are used) |
| Reduced motion (Modal only) | Hash scroll respects `prefers-reduced-motion` |

---

## Findings

Severity guide:

- **Critical** — Blocks primary task for keyboard or AT users, or clear AA failure in a core path.
- **Serious** — Significant barrier; core path degraded.
- **Moderate** — Real WCAG/issue impact, workaround exists.
- **Minor** — Polish, best practice, or edge case.

### Critical

#### C1. Mail list and mailbox rail lack visible focus styles

**WCAG:** 2.4.7 Focus Visible, 1.4.11 Non-text Contrast (focus indicator)  
**Where:** `.mail-row`, `.rail__mailbox` in `public/app.css`; rendered in `renderMailList()` / `renderMailboxes()`  
**Issue:** Both are native `<button>`s (good) with `:hover` backgrounds only. There is no `:focus` / `:focus-visible` rule. Keyboard users can tab through Inbox / Sent / Spam and every thread row with little or no visible indication of focus (browser default outline may be suppressed by global resets or hard to see on these full-bleed rows).  
**Fix:** Add `:focus-visible` styles matching the recipient-picker / toast pattern (2px primary outline + offset, or the same background+ring language as inputs). Do not rely on `:hover` alone.

#### C2. Recipient picker is not a keyboard-complete listbox

**WCAG:** 2.1.1 Keyboard, 4.1.2 Name, Role, Value  
**Where:** `renderRecipientMenu()` / `initRecipientPickers()` in `public/app.js`; markup in `public/index.html`  
**Issue:**

- Menu is `ul[role="listbox"]` with `li[role="presentation"]` wrapping **`<button role="option">`**. Hosting `role="option"` on a button conflicts with the APG listbox pattern and can confuse AT (nested button semantics vs option).
- Opening focuses the first option (good), and Escape closes (good).
- There is **no ArrowUp/ArrowDown/Home/End** handling on the menu; Tab leaves options as discrete tab stops rather than a single composite widget.
- Outside click closes; no documented typeahead.

**Fix:** Prefer the design-system Dropdown pattern (or APG listbox): options as non-button elements with `role="option"`, `tabindex="-1"`, arrow-key focus, `aria-activedescendant` *or* roving tabindex, and a single tab stop on the trigger. Keep chip remove buttons as separate tab stops.

### Serious

#### S1. Reading pane `aria-live="polite"` re-announces whole threads

**WCAG:** 4.1.3 Status Messages (intent); AT usability  
**Where:** `#readingPane` in `public/index.html`; content replaced in `renderThread()`  
**Issue:** The conversation container is a polite live region. Opening a thread or refreshing inbound mail replaces large HTML trees inside a live region, which often causes screen readers to read (or interrupt with) large dumps of email content. That competes with intentional status UI (toasts, assistant log).  
**Fix:** Remove `aria-live` from `#readingPane`. Announce view changes via the visible `h1` (`#mailToolbarTitle`) and/or a small dedicated status region (e.g. “Opened: &lt;subject&gt;”). Keep toast / assistant live regions for transient status.

#### S2. Inbound mail toasts auto-dismiss after 8 seconds

**WCAG:** 2.2.1 Timing Adjustable  
**Where:** `showMailToast()` — `setTimeout(..., 8000)`  
**Issue:** Toasts disappear on a fixed timer with no pause-on-hover/focus, no extend control, and no persistent alternative beyond the mailbox list updating. Keyboard and SR users may not reach “Open” / “Dismiss” in time.  
**Fix:** Pause the timer while the toast (or any descendant) has hover or focus; provide a non-time-limited path (already partially true via the inbox list); consider not auto-dismissing until blur after interaction, or make duration configurable ≥ 20s with a pause.

#### S3. Fixed three-column shell does not reflow

**WCAG:** 1.4.10 Reflow  
**Where:** `.mail-app { grid-template-columns: 220px minmax(0, 1fr) 340px; height: 100vh; overflow: hidden; }`  
**Issue:** No breakpoint collapses rail / assistant. At 320 CSS px width or ~400% zoom, columns clip behind `overflow: hidden` rather than stacking. Primary mail tasks become unreachable or require two-dimensional scrolling.  
**Fix:** Below a chosen breakpoint, stack or drawer the rail and assistant; ensure the mail list + reading pane remain usable in a single column without horizontal scroll for vertical text content.

#### S4. No skip link / bypass for repeated chrome

**WCAG:** 2.4.1 Bypass Blocks  
**Where:** `public/index.html` body start  
**Issue:** Every page load presents Compose, folder list, mail list, and Cosmo before the reading/compose content. There is no “Skip to mail” / “Skip to main content” link.  
**Fix:** Add a visually hidden skip link as the first focusable element targeting `#mailMain` (and optionally `#assistantPanel`).

#### S5. Focus often lost when switching list ↔ thread

**WCAG:** 2.4.3 Focus Order, 2.4.8 Focus Location (AAA advisory but severe UX)  
**Where:** `selectThread()`, `backToList()`, `selectMailbox()`, `renderMailList()`  
**Issue:** Selecting a thread replaces the list DOM. The focused list button is destroyed; focus commonly falls to `body`. Returning via Back does not restore focus to the previously selected row. Same pattern when emptying/refilling mailboxes.  
**Fix:** After navigation, move focus to `#mailToolbarTitle` (make it `tabindex="-1"`) or to `#backBtn` / the active row; when returning to the list, restore focus to the thread button for `activeThreadId` if still present.

### Moderate

#### M1. Secondary / tertiary button focus rings are effectively empty

**WCAG:** 2.4.7 Focus Visible  
**Where:** `design-system/components/button/button.css` — `.button-secondary:focus` / `.button-tertiary:focus` use `box-shadow: 0 0 0 0 …`  
**Issue:** Reply / Reply all / assistant Send (secondary) get little more than a border color change. Primary buttons get a 4px ring; secondary/tertiary do not.  
**Fix:** Apply a visible `:focus-visible` ring consistent with primary / input focus tokens.

#### M2. App-level motion ignores `prefers-reduced-motion`

**WCAG:** 2.3.3 Animation from Interactions  
**Where:** `.email--arrive` / `@keyframes email-arrive` in `public/app.css`; `scrollIntoView({ behavior: 'smooth' })` in `scrollToEmail()` / `startReply()`  
**Issue:** Arrival highlight animates for 1.2s and smooth scrolling always runs. Modal already respects reduced motion; the app shell does not.  
**Fix:** Wrap animation and smooth scroll behind `matchMedia('(prefers-reduced-motion: reduce)')` (instant scroll + no keyframes).

#### M3. Undefined token `--Colors-Text-Body-Secondary`

**WCAG:** 1.4.3 Contrast (Minimum) — unreliable  
**Where:** `.mail-toast__kicker`, `.mail-toast__snippet` in `public/app.css`  
**Issue:** Token is referenced in the app and mentioned in design-system docs but **not defined** in `design-system/colors/colors.css`. Toast secondary text may inherit unexpectedly or ignore the intended color, so contrast cannot be guaranteed.  
**Fix:** Define the token (alias to `--Colors-Text-Body-Light` or a verified 4.5:1 color) or switch those rules to an existing body text token.

#### M4. `html[lang]` does not follow i18n language

**WCAG:** 3.1.1 Language of Page  
**Where:** Hardcoded `lang="en"`; runtime strings via `t()` / `state.config.strings`  
**Issue:** If a scenario loads a non-English catalog, the page language attribute stays English.  
**Fix:** Set `document.documentElement.lang` from config language at boot (`applyScenarioChrome`).

#### M5. Compose expanded modal initial focus is suboptimal

**WCAG:** 2.4.3 Focus Order  
**Where:** Modal `open()` focuses close button, else title, else overlay; compose modal uses `showCloseButton: false` and `title: null`, so focus lands on the overlay before app code focuses fields  
**Issue:** Brief focus on an empty dialog chrome can confuse SR users; race depends on `applyView` ordering.  
**Fix:** Pass an `onOpen` that focuses the first invalid/empty field (To → Subject → editor), or teach Modal a `initialFocus` option.

#### M6. Send / attachment failures are not announced to AT

**WCAG:** 4.1.3 Status Messages  
**Where:** `sendEmail()`, `handleComposerFiles()`  
**Issue:** Send button text flips to “Sending…” (visible only). Upload rejects and send errors mostly `console.warn` / `console.error` without a polite/assertive live message.  
**Fix:** Update a dedicated status live region (“Message sent”, “Send failed”, “File type not allowed”).

#### M7. Disabled controls at 0.24 opacity

**WCAG:** Exempt from 1.4.3 when disabled, but fails usable contrast  
**Where:** `.button:disabled { opacity: 0.24 }`  
**Issue:** Send (disabled) and other disabled actions are hard to perceive as present vs missing.  
**Fix:** Prefer a disabled palette with ≥ 3:1 for the control chrome, or keep opacity ≥ ~0.5 with a text/icon treatment that still reads as disabled.

### Minor

#### N1. TipTap placeholder is CSS-only

Placeholder via `::before` / `data-placeholder` is fine for sighted users; ensure `aria-label` (already present) remains the accessible name and that empty state is not the only instruction for required fields (To still gates Send).

#### N2. Assistant Enter-to-send

Enter sends; Shift+Enter newline. Consider `aria-description` or visible hint so SR users know the shortcut.

#### N3. Decorative avatars

`alt=""` / `aria-hidden` on initials is correct when the name appears in adjacent text. Keep that pairing if avatar-only rows are ever introduced.

#### N4. `href="#"` mailto shim

In-app compose links use `href="#"` + click handler. Prefer `href="#compose"` or `role="button"` with keyboard activation already covered by `<a>`, and always `preventDefault` (already done).

#### N5. Icon-default token contrast

`--Colors-Icon-Default` (#ACB4C7 on white ≈ 2.1:1) fails 3:1 if used as the **only** means to convey meaning. Current mailbox icons sit next to text labels — acceptable. Avoid icon-only status that relies on this token without a stronger color or text.

#### N6. Heading hierarchy

Toolbar uses one `h1`; composer title uses `h2`. Email cards do not introduce competing `h1`s. Good. Avoid promoting empty-state titles to `h1`.

#### N7. Composer minimized chrome click-to-restore

Pointer-only convenience; keyboard users have the Restore control with an updated `aria-label`. Acceptable if the Restore button remains visible and labeled.

---

## Contrast spot checks (light mode)

| Pair | Approx. ratio | Result |
|------|---------------|--------|
| Body Default (#2D3855) on Main Default (#F4F5F9) | 10.7:1 | Pass |
| Body Light (#515C7A) on white / main surfaces | 5.5–6.6:1 | Pass |
| Primary button white on #1062FB | 5.1:1 | Pass |
| Icon Default (#ACB4C7) on white | ~2.1:1 | Fail if sole indicator |
| Body Secondary token | undefined | Cannot verify |

Dark-mode body light tokens (~6.4:1 on Main Top) look intentionally tuned; still verify toast/snippet once Secondary is defined.

---

## Component inventory vs app usage

| Component | Used by CosmoMail? | A11y posture |
|-----------|--------------------|--------------|
| Modal | Yes (expanded compose) | Strong (inert, trap, Escape, reduced-motion scroll) |
| Button / Input / Tags / Boxes | Yes | Mixed focus styles (see M1) |
| Dropdown | Not for recipient picker | Strong APG-ish combobox; **do not reinvent worse** |
| SplitPanel | Not wired in app yet (`features.md` asks for assistant SplitPanel) | Has separator role + keyboard resize — prefer it over a mouse-only drag |
| NumericSlider / Horizontal cards | No | Out of app scope for this audit |

---

## Recommended fix order

1. **C1** — Focus-visible on `.mail-row` and `.rail__mailbox`  
2. **C2** — Rebuild recipient picker keyboard/AT pattern  
3. **S1** — Drop reading-pane live region; announce intentionally  
4. **S5** — Manage focus on list/thread transitions  
5. **S2** — Toast timing / pause  
6. **S4** + **S3** — Skip link and reflow  
7. **M1–M6** — Button focus, reduced motion, Secondary token, `lang`, status messages  

---

## Suggested verification (follow-up)

- Keyboard-only pass: folders → list → thread → reply → send → Cosmo  
- VoiceOver (macOS) or NVDA: compose To picker, expanded compose dialog, inbound toast  
- axe DevTools on list, thread, compose overlay, assistant  
- Zoom to 400% / narrow viewport for 1.4.10  

---

## Files reviewed

- `public/index.html`
- `public/app.js`
- `public/app.css`
- `design-system/colors/colors.css`
- `design-system/components/button/button.css`
- `design-system/components/input/input.css`
- `design-system/components/modal/modal.js`
- `design-system/components/dropdown/dropdown.js`
- `design-system/components/split-panel/split-panel.js`
