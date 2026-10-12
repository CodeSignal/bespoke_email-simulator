# Accessibility audits

Static UX accessibility reviews of CosmoMail (the bespoke email simulator).

| Date | Report | Scope | Standard |
|------|--------|-------|----------|
| 2026-10-12 | [2026-10-12-cosmomail-ux-audit.md](./2026-10-12-cosmomail-ux-audit.md) | Re-check of the fixed 29 Sep and 6 Oct findings on current main, plus new issues in thread focus, compose close, the 320px message header, the assistant scroller, and placeholder contrast | WCAG 2.2 Level AA |
| 2026-10-06 | [2026-10-06-cosmomail-ux-audit.md](./2026-10-06-cosmomail-ux-audit.md) | Re-check of the 29 Sep findings after the UI restyle, plus new issues in compose, the recipient typeahead, the split assistant, and dark mode | WCAG 2.2 Level AA |
| 2026-09-29 | [2026-09-29-cosmomail-ux-audit.md](./2026-09-29-cosmomail-ux-audit.md) | App shell (`public/`), composer, assistant, toast notifications; design-system components used by the app | WCAG 2.2 Level AA |

## Method note

The 29 Sep audit is a code-and-token review. The 6 Oct and 12 Oct audits repeat that review and add a live pass on `localhost:3000`: computed contrast in light and dark, layout at 320px and 1280px, focus after list/thread changes, and axe-core 4.10.3. The 12 Oct pass also checks focus after compose opens and closes. None of the passes include a VoiceOver or NVDA session. The 12 Oct pass did not reach a toast.
