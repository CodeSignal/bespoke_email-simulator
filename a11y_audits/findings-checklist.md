# Findings checklist

Track remediation against the [2026-09-29 CosmoMail audit](./2026-09-29-cosmomail-ux-audit.md).

| ID | Severity | Summary | WCAG | Status |
|----|----------|---------|------|--------|
| C1 | Critical | Visible focus on mail rows and mailbox rail | 2.4.7, 1.4.11 | Open |
| C2 | Critical | Recipient picker keyboard / listbox pattern | 2.1.1, 4.1.2 | Open |
| S1 | Serious | Remove `aria-live` from reading pane | 4.1.3 | Open |
| S2 | Serious | Toast 8s auto-dismiss without pause | 2.2.1 | Open |
| S3 | Serious | Three-column layout fails reflow | 1.4.10 | Open |
| S4 | Serious | No skip link | 2.4.1 | Open |
| S5 | Serious | Focus lost on list ↔ thread navigation | 2.4.3 | Open |
| M1 | Moderate | Secondary/tertiary button focus ring empty | 2.4.7 | Open |
| M2 | Moderate | No `prefers-reduced-motion` in app shell | 2.3.3 | Open |
| M3 | Moderate | `--Colors-Text-Body-Secondary` undefined | 1.4.3 | Open |
| M4 | Moderate | `html[lang]` not synced to i18n | 3.1.1 | Open |
| M5 | Moderate | Expanded compose modal initial focus | 2.4.3 | Open |
| M6 | Moderate | Send/attachment errors not announced | 4.1.3 | Open |
| M7 | Moderate | Disabled button opacity 0.24 hard to see | Usability | Open |
| N1–N7 | Minor | See full audit | Various | Open |
