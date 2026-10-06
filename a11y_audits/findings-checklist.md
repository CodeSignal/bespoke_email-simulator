# Findings checklist

Remediation status after the [6 Oct 2026 re-audit](./2026-10-06-cosmomail-ux-audit.md). IDs from the [29 Sep audit](./2026-09-29-cosmomail-ux-audit.md) are kept. New issues start at S6, M8, and N8.

| ID | Severity | Summary | WCAG | Status |
|----|----------|---------|------|--------|
| C1 | Critical | Visible focus on mail rows and mailbox rail | 2.4.7, 1.4.11 | Fixed |
| C2 | Critical | Recipient picker keyboard / listbox pattern | 2.1.1, 4.1.2 | Fixed |
| S1 | Serious | Remove `aria-live` from reading pane | 4.1.3 | Open |
| S2 | Serious | Toast 8s auto-dismiss without pause | 2.2.1 | Open |
| S3 | Serious | Three-column layout fails reflow | 1.4.10 | Open |
| S4 | Serious | No skip link | 2.4.1 | Open |
| S5 | Serious | Focus lost on list ↔ thread navigation | 2.4.3 | Open |
| S6 | Serious | To and Cc share the accessible name “Add a recipient” | 1.3.1, 4.1.2 | Open |
| S7 | Serious | Floating composer can cover focusable mail rows | 2.4.11 | Open |
| M1 | Moderate | Button focus rings missing or empty; primary selector broken | 2.4.7 | Open |
| M2 | Moderate | Reduced motion only partly honored | 2.3.3 | Partial |
| M3 | Moderate | `--Colors-Text-Body-Secondary` undefined | 1.4.3 | Fixed |
| M4 | Moderate | `html[lang]` not synced to i18n | 3.1.1 | Open |
| M5 | Moderate | Expanded compose modal initial focus | 2.4.3 | Fixed |
| M6 | Moderate | Send/attachment errors not announced | 4.1.3 | Open |
| M7 | Moderate | Disabled button opacity 0.24 hard to see | Usability | Open |
| M8 | Moderate | Dark mode: active recipient role text 3.86:1 | 1.4.3 | Open |
| M9 | Moderate | Recipient remove control hidden until hover or focus | 2.5.8 | Open |
| M10 | Moderate | Split divider focus line overridden | 2.4.7 | Open |
| M11 | Moderate | Assistant log rebuilt inside a live region | 4.1.3 | Open |
| N2 | Minor | Assistant Enter-to-send undisclosed | Best practice | Open |
| N4 | Minor | `href="#"` mailto shim | Best practice | Open |
| N5 | Minor | Icon-default token contrast | 1.4.11 | Fixed |
| N7 | Minor | Composer minimized chrome | 2.1.1 | Obsolete |
| N8 | Minor | Mail-row accessible names run together | 2.4.6 | Open |
