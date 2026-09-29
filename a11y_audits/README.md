# Accessibility audits

Static UX accessibility reviews of CosmoMail (the bespoke email simulator).

| Date | Report | Scope | Standard |
|------|--------|-------|----------|
| 2026-09-29 | [2026-09-29-cosmomail-ux-audit.md](./2026-09-29-cosmomail-ux-audit.md) | App shell (`public/`), composer, assistant, toast notifications; design-system components used by the app | WCAG 2.2 Level AA |

## Method note

These audits are **code-and-token reviews** (HTML semantics, ARIA, keyboard paths, focus styles, contrast calculations, motion, responsive structure). They are not a substitute for automated axe runs in a browser or manual testing with VoiceOver / NVDA / keyboard-only walks.
