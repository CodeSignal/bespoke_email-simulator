/**
 * Expand ${relative date} tokens in scenario seed strings.
 *
 * Tokens resolve at scenario load time (not per request) so seeded sessions
 * keep stable absolute timestamps for the life of the process.
 *
 * Supported expressions (case-insensitive):
 *   today | tomorrow | yesterday
 *   next week | last week
 *   N days from today | N day from today
 *   in N days
 *   N days ago | N day ago
 *
 * Calendar-day results are YYYY-MM-DD. When a token stands alone as an
 * email.date value, a midday UTC time is appended (T12:00:00Z) so ISO parsing
 * stays unambiguous. Authors may also write `${today}T14:02:00Z`.
 */

const TOKEN_RE = /\$\{([^}]+)\}/g;

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Parse a relative-date expression into a UTC calendar day, or null if unknown.
 * @param {string} expression
 * @param {Date} [now]
 * @returns {Date|null}
 */
export function resolveRelativeDateExpression(expression, now = new Date()) {
  const expr = String(expression || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!expr) return null;

  const today = startOfUtcDay(now);

  if (expr === 'today') return today;
  if (expr === 'tomorrow') return addUtcDays(today, 1);
  if (expr === 'yesterday') return addUtcDays(today, -1);
  if (expr === 'next week') return addUtcDays(today, 7);
  if (expr === 'last week') return addUtcDays(today, -7);

  let match = expr.match(/^(\d+)\s+days?\s+from\s+today$/);
  if (match) return addUtcDays(today, Number(match[1]));

  match = expr.match(/^in\s+(\d+)\s+days?$/);
  if (match) return addUtcDays(today, Number(match[1]));

  match = expr.match(/^(\d+)\s+days?\s+ago$/);
  if (match) return addUtcDays(today, -Number(match[1]));

  return null;
}

/**
 * Expand ${...} tokens inside a string. Unknown tokens are left unchanged.
 * @param {string} value
 * @param {Date} [now]
 * @returns {string}
 */
export function expandRelativeDatesInString(value, now = new Date()) {
  if (typeof value !== 'string' || !value.includes('${')) return value;
  return value.replace(TOKEN_RE, (full, expr) => {
    const resolved = resolveRelativeDateExpression(expr, now);
    return resolved ? formatUtcDate(resolved) : full;
  });
}

/**
 * Expand tokens in an email.date field. Bare `${today}` becomes an ISO
 * datetime; mixed strings (e.g. body prose) use expandRelativeDatesInString.
 * @param {string} value
 * @param {Date} [now]
 * @returns {string}
 */
export function expandRelativeDateField(value, now = new Date()) {
  if (typeof value !== 'string' || !value.includes('${')) return value;

  const trimmed = value.trim();
  const bare = trimmed.match(/^\$\{([^}]+)\}$/);
  if (bare) {
    const resolved = resolveRelativeDateExpression(bare[1], now);
    if (resolved) return `${formatUtcDate(resolved)}T12:00:00Z`;
  }

  // `${today}T14:02:00Z` → `2026-09-30T14:02:00Z`
  const withTime = trimmed.match(/^\$\{([^}]+)\}(T[\d:.]+Z?)$/i);
  if (withTime) {
    const resolved = resolveRelativeDateExpression(withTime[1], now);
    if (resolved) return `${formatUtcDate(resolved)}${withTime[2]}`;
  }

  return expandRelativeDatesInString(value, now);
}

function expandValue(value, now, { asDateField = false } = {}) {
  if (typeof value === 'string') {
    return asDateField
      ? expandRelativeDateField(value, now)
      : expandRelativeDatesInString(value, now);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandValue(entry, now));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = expandValue(child, now, { asDateField: key === 'date' });
    }
    return out;
  }
  return value;
}

/**
 * Deep-expand relative date tokens across a resolved inbox `{ threads }`.
 * @param {{ threads?: unknown[] }|null|undefined} inbox
 * @param {Date} [now]
 * @returns {{ threads: unknown[] }}
 */
export function expandRelativeDatesInInbox(inbox, now = new Date()) {
  const threads = Array.isArray(inbox?.threads) ? inbox.threads : [];
  return {
    threads: threads.map((thread) => expandValue(thread, now)),
  };
}
