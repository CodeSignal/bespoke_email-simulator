# Findings checklist

Remediation status after the [12 Oct 2026 audit](./2026-10-12-cosmomail-ux-audit.md). IDs from the [29 Sep](./2026-09-29-cosmomail-ux-audit.md) and [6 Oct](./2026-10-06-cosmomail-ux-audit.md) audits are kept. Issues opened on 12 Oct start at S8, M12, and N10.

| ID | Severity | Summary | WCAG | Status | GitHub |
|----|----------|---------|------|--------|--------|
| C1 | Critical | Visible focus on mail rows and mailbox rail | 2.4.7, 1.4.11 | Fixed | — |
| C2 | Critical | Recipient picker keyboard / listbox pattern | 2.1.1, 4.1.2 | Fixed | — |
| S1 | Serious | Remove `aria-live` from reading pane | 4.1.3 | Fixed | [#14](https://github.com/CodeSignal/bespoke_email-simulator/issues/14) |
| S2 | Serious | Toast 8s auto-dismiss without pause | 2.2.1 | Fixed | [#15](https://github.com/CodeSignal/bespoke_email-simulator/issues/15) |
| S3 | Serious | Three-column layout fails reflow | 1.4.10 | Fixed | [#16](https://github.com/CodeSignal/bespoke_email-simulator/issues/16) |
| S4 | Serious | No skip link | 2.4.1 | Fixed | [#17](https://github.com/CodeSignal/bespoke_email-simulator/issues/17) |
| S5 | Serious | Focus lost on list ↔ thread navigation | 2.4.3 | Fixed | [#18](https://github.com/CodeSignal/bespoke_email-simulator/issues/18) |
| S6 | Serious | To and Cc share the accessible name “Add a recipient” | 1.3.1, 4.1.2 | Fixed | [#19](https://github.com/CodeSignal/bespoke_email-simulator/issues/19) |
| S7 | Serious | Floating composer can cover focusable mail rows | 2.4.11 | Fixed | [#20](https://github.com/CodeSignal/bespoke_email-simulator/issues/20) |
| M1 | Moderate | Button focus rings missing or empty; primary selector broken | 2.4.7 | Fixed | [#21](https://github.com/CodeSignal/bespoke_email-simulator/issues/21) |
| M2 | Moderate | Reduced motion only partly honored | 2.3.3 | Fixed | [#22](https://github.com/CodeSignal/bespoke_email-simulator/issues/22) |
| M3 | Moderate | `--Colors-Text-Body-Secondary` undefined | 1.4.3 | Fixed | — |
| M4 | Moderate | `html[lang]` not synced to i18n | 3.1.1 | Fixed | [#23](https://github.com/CodeSignal/bespoke_email-simulator/issues/23) |
| M5 | Moderate | Expanded compose modal initial focus | 2.4.3 | Fixed | — |
| M6 | Moderate | Send/attachment errors not announced | 4.1.3 | Fixed | [#24](https://github.com/CodeSignal/bespoke_email-simulator/issues/24) |
| M7 | Moderate | Disabled button opacity 0.24 hard to see | Usability | Fixed | [#25](https://github.com/CodeSignal/bespoke_email-simulator/issues/25) |
| M8 | Moderate | Dark mode: active recipient role text 3.86:1 | 1.4.3 | Fixed | [#26](https://github.com/CodeSignal/bespoke_email-simulator/issues/26) |
| M9 | Moderate | Recipient remove control hidden until hover or focus | 2.5.8 | Fixed | [#27](https://github.com/CodeSignal/bespoke_email-simulator/issues/27) |
| M10 | Moderate | Split divider focus line overridden | 2.4.7 | Fixed | [#28](https://github.com/CodeSignal/bespoke_email-simulator/issues/28) |
| M11 | Moderate | Assistant log rebuilt inside a live region | 4.1.3 | Fixed | [#29](https://github.com/CodeSignal/bespoke_email-simulator/issues/29) |
| N2 | Minor | Assistant Enter-to-send undisclosed | Best practice | Fixed | [#30](https://github.com/CodeSignal/bespoke_email-simulator/issues/30) |
| N4 | Minor | `href="#"` mailto shim | Best practice | Fixed | [#31](https://github.com/CodeSignal/bespoke_email-simulator/issues/31) |
| N5 | Minor | Icon-default token contrast | 1.4.11 | Fixed | — |
| N7 | Minor | Composer minimized chrome | 2.1.1 | Obsolete | — |
| N8 | Minor | Mail-row accessible names run together | 2.4.6 | Fixed | [#32](https://github.com/CodeSignal/bespoke_email-simulator/issues/32) |
| N9 | Minor | List separators are real `<hr>` elements | Best practice | Fixed | — |
| S8 | Serious | Opening a thread focuses a clipped heading | 2.4.7 | Fixed | [#41](https://github.com/CodeSignal/bespoke_email-simulator/issues/41) |
| S9 | Serious | Closing compose leaves focus on the page | 2.4.3 | Fixed | [#42](https://github.com/CodeSignal/bespoke_email-simulator/issues/42) |
| S10 | Serious | Message header clips the sender at 320px | 1.4.10 | Fixed | [#43](https://github.com/CodeSignal/bespoke_email-simulator/issues/43) |
| S11 | Serious | Assistant transcript is not keyboard scrollable | 2.1.1 | Fixed | [#44](https://github.com/CodeSignal/bespoke_email-simulator/issues/44) |
| M12 | Moderate | Assistant placeholder fails contrast in light and dark | 1.4.3 | Open | [#45](https://github.com/CodeSignal/bespoke_email-simulator/issues/45) |
| M13 | Moderate | Failed upload is not announced | 4.1.3 | Open | [#46](https://github.com/CodeSignal/bespoke_email-simulator/issues/46) |
| N10 | Minor | Recipient option names run together | 2.4.6 | Open | [#47](https://github.com/CodeSignal/bespoke_email-simulator/issues/47) |
