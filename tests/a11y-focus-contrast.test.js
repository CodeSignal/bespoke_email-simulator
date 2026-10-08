// M1 (button focus) and M8 (recipient meta contrast).
// Loads the design-system button CSS and color tokens into happy-dom and
// reads the computed result. Colors come from those tokens, not from the
// audit's old hex values.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const STYLES = [
  'design-system/colors/colors.css',
  'design-system/components/button/button.css',
  'public/global.css',
  'public/app.css',
];

function withScheme(scheme, run) {
  const window = new Window({
    url: 'http://localhost:3000/',
    settings: { device: { prefersColorScheme: scheme } },
  });
  const { document } = window;
  const style = document.createElement('style');
  style.textContent = STYLES.map((file) => readFileSync(join(root, file), 'utf8')).join('\n');
  document.head.appendChild(style);
  try {
    return run(window);
  } finally {
    window.happyDOM.close();
  }
}

function styleRules(document) {
  const rules = [];
  const walk = (list) => {
    for (const rule of list) {
      if (rule.selectorText) rules.push(rule);
      else if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) walk(sheet.cssRules);
  return rules;
}

function selectorList(selectorText) {
  return selectorText.split(',').map((selector) => selector.replace(/\s+/g, ' ').trim());
}

function parseColor(input) {
  const value = String(input).trim().toLowerCase();
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex8 = value.match(/^#([0-9a-f]{8})$/);
  if (hex8) {
    const n = Number.parseInt(hex8[1], 16);
    return {
      r: (n >> 24) & 255,
      g: (n >> 16) & 255,
      b: (n >> 8) & 255,
      a: (n & 255) / 255,
    };
  }
  const hex = value.match(/^#([0-9a-f]{6})$/);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = value.match(/^rgba?\(([^)]+)\)$/);
  if (!rgba) throw new Error(`Unresolved color: ${input}`);
  const parts = rgba[1].split(',').map((part) => Number(part.trim()));
  return {
    r: parts[0],
    g: parts[1],
    b: parts[2],
    a: parts.length > 3 ? parts[3] : 1,
  };
}

function opaque(color) {
  if (!color) return false;
  try {
    return parseColor(color).a > 0;
  } catch {
    return false;
  }
}

function channel(value) {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(color) {
  return (0.2126 * channel(color.r)) + (0.7152 * channel(color.g)) + (0.0722 * channel(color.b));
}

function composite(foreground, background) {
  const alpha = foreground.a;
  return {
    r: (foreground.r * alpha) + (background.r * (1 - alpha)),
    g: (foreground.g * alpha) + (background.g * (1 - alpha)),
    b: (foreground.b * alpha) + (background.b * (1 - alpha)),
    a: 1,
  };
}

function contrast(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

// Translucent option fills sit on the menu surface. Contrast uses that painted result.
function painted(background, backdrop) {
  const fill = parseColor(background);
  if (fill.a >= 1) return fill;
  const surface = parseColor(backdrop);
  if (surface.a < 1) throw new Error(`Menu background is not opaque: ${backdrop}`);
  return composite(fill, surface);
}

function focusIndicator(style) {
  const width = Number.parseFloat(style.outlineWidth);
  if (Number.isFinite(width) && width >= 2 && style.outlineStyle && style.outlineStyle !== 'none' && opaque(style.outlineColor)) {
    return { kind: 'outline', size: width, color: style.outlineColor };
  }
  const shadow = style.boxShadow;
  if (!shadow || shadow === 'none') return null;
  // happy-dom prints unitless zeros (`0 0 0 4px`), so count length tokens, not only `px`.
  const parts = shadow.split(/,(?![^(]*\))/);
  for (const part of parts) {
    const color = part.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i)?.[0] ?? '';
    const lengths = [...part.replace(color, '').matchAll(/-?\d*\.?\d+/g)].map((match) => Number.parseFloat(match[0]));
    const spread = lengths.length >= 4 ? lengths[3] : 0;
    if (spread >= 2 && opaque(color)) return { kind: 'box-shadow', size: spread, color };
  }
  return null;
}

function button(document, variant, { focusClass = true } = {}) {
  const el = document.createElement('button');
  el.className = `button button-${variant}${focusClass ? ' focus' : ''}`;
  el.textContent = variant;
  document.body.appendChild(el);
  return el;
}

function ruleBlocks(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('{', cursor);
    if (open === -1) break;
    const prelude = source.slice(cursor, open).trim();
    let depth = 1;
    let end = open + 1;
    while (end < source.length && depth > 0) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') depth -= 1;
      end += 1;
    }
    if (prelude.startsWith('@')) {
      cursor = open + 1;
      continue;
    }
    if (prelude) blocks.push({ prelude, body: source.slice(open + 1, end - 1) });
    cursor = end;
  }
  return blocks;
}

function blocksFor(css, selector) {
  return ruleBlocks(css).filter((rule) => selectorList(rule.prelude).includes(selector));
}

// happy-dom matches :focus and :focus-visible, but getComputedStyle skips those
// pseudos. The declaration text is what those selectors actually set.
function declarationIndicator(body) {
  const outline = body.match(/(?:^|[;{}])\s*outline\s*:\s*([^;]+)/);
  if (outline) {
    const value = outline[1].trim();
    const width = value.match(/(\d*\.?\d+)px/);
    const color = value
      .replace(/(\d*\.?\d+)px/g, '')
      .replace(/\b(solid|dashed|dotted|double|groove|ridge|inset|outset|none)\b/g, '')
      .trim();
    if (width && Number(width[1]) >= 2 && !/\bnone\b/.test(value) && color && color !== 'transparent') {
      return { kind: 'outline', size: Number(width[1]), color };
    }
  }
  const shadow = body.match(/(?:^|[;{}])\s*box-shadow\s*:\s*([^;]+)/);
  if (!shadow) return null;
  const value = shadow[1].trim();
  const color = value.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}|var\([^)]+\)/i)?.[0] ?? '';
  const lengths = [...value.replace(color, '').matchAll(/-?\d*\.?\d+/g)].map((match) => Number.parseFloat(match[0]));
  const spread = lengths.length >= 4 ? lengths[3] : 0;
  if (spread >= 2 && color && color !== 'transparent') return { kind: 'box-shadow', size: spread, color };
  return null;
}

function expectPseudoIndicator(css, variant, pseudos) {
  for (const pseudo of pseudos) {
    const selector = `.button-${variant}${pseudo}`;
    const indicators = blocksFor(css, selector).map((rule) => declarationIndicator(rule.body)).filter(Boolean);
    expect(indicators, selector).not.toEqual([]);
    expect(indicators[0].size, selector).toBeGreaterThanOrEqual(2);
    expect(indicators[0].color, selector).not.toBe('transparent');
  }
}

function recipientOptions(document) {
  const picker = document.createElement('div');
  picker.className = 'recipient-picker dropdown-container open';
  const menu = document.createElement('ul');
  menu.className = 'dropdown-menu';
  const make = (active) => {
    const option = document.createElement('div');
    option.className = `dropdown-menu-item recipient-picker__option${active ? ' is-active' : ''}`;
    const name = document.createElement('span');
    name.className = 'dropdown-menu-item-label';
    name.textContent = active ? 'Dana Reyes' : 'Sam Okonkwo';
    const meta = document.createElement('span');
    meta.className = 'body-xsmall recipient-picker__option-meta';
    meta.textContent = active ? 'Vendor' : 'Buyer';
    option.append(name, meta);
    menu.append(option);
    return { option, meta };
  };
  const active = make(true);
  const inactive = make(false);
  picker.append(menu);
  document.body.append(picker);
  return { menu, active, inactive };
}

function metaContrast(scheme) {
  return withScheme(scheme, (window) => {
    const { document } = window;
    const { menu, active, inactive } = recipientOptions(document);
    const menuColor = window.getComputedStyle(menu).backgroundColor;
    const ratio = (meta, option) => {
      const style = window.getComputedStyle(meta);
      const background = window.getComputedStyle(option).backgroundColor;
      return contrast(parseColor(style.color), painted(background, menuColor));
    };
    return {
      active: ratio(active.meta, active.option),
      inactive: ratio(inactive.meta, inactive.option),
    };
  });
}

describe('M1 button focus', () => {
  it('matches .button-primary itself and is not a descendant focus selector', () => {
    withScheme('light', (window) => {
      const rules = styleRules(window.document);
      const broken = '.button-primary:focus .button-primary.focus';
      const lists = rules.map((rule) => selectorList(rule.selectorText || ''));
      expect(lists.some((selectors) => selectors.includes(broken))).toBe(false);

      const primary = lists.find((selectors) => (
        selectors.includes('.button-primary:focus') && selectors.includes('.button-primary.focus')
      ));
      expect(primary).toBeTruthy();

      const button = window.document.createElement('button');
      button.className = 'button button-primary focus';
      window.document.body.appendChild(button);
      expect(button.matches('.button-primary.focus')).toBe(true);
      expect(button.matches(broken)).toBe(false);
      expect(focusIndicator(window.getComputedStyle(button))).not.toBeNull();
    });
  });

  it('gives primary, secondary, tertiary, and text buttons a visible focus indicator', () => {
    withScheme('light', (window) => {
      const css = window.document.querySelector('style').textContent;
      for (const variant of ['primary', 'secondary', 'tertiary', 'text']) {
        const indicator = focusIndicator(window.getComputedStyle(button(window.document, variant)));
        expect(indicator, `.button-${variant}.focus`).not.toBeNull();
        expect(indicator.size).toBeGreaterThanOrEqual(2);
        expect(opaque(indicator.color)).toBe(true);
        expectPseudoIndicator(css, variant, [':focus', ':focus-visible']);
      }

      const focused = button(window.document, 'primary', { focusClass: false });
      focused.focus();
      expect(focused.classList.contains('focus')).toBe(false);
      expect(focused.matches(':focus')).toBe(true);
      expect(focused.matches(':focus-visible')).toBe(true);
      expectPseudoIndicator(css, 'primary', [':focus', ':focus-visible']);
    });
  });

  it('keeps a visible focus indicator on danger and success', () => {
    withScheme('light', (window) => {
      const css = window.document.querySelector('style').textContent;
      for (const variant of ['danger', 'success']) {
        const indicator = focusIndicator(window.getComputedStyle(button(window.document, variant)));
        expect(indicator, `.button-${variant}.focus`).not.toBeNull();
        expect(indicator.size).toBeGreaterThanOrEqual(2);
        expect(opaque(indicator.color)).toBe(true);
        expectPseudoIndicator(css, variant, [':focus']);
      }
    });
  });
});

describe('M8 recipient meta contrast', () => {
  it('keeps dark-mode active and inactive meta at least 4.5:1', () => {
    const ratios = metaContrast('dark');
    expect(ratios.active).toBeGreaterThanOrEqual(4.5);
    expect(ratios.inactive).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps light-mode active and inactive meta at least 4.5:1', () => {
    const ratios = metaContrast('light');
    expect(ratios.active).toBeGreaterThanOrEqual(4.5);
    expect(ratios.inactive).toBeGreaterThanOrEqual(4.5);
  });
});
