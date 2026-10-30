// Vista frontal da gôndola em SVG. Coordenadas do SVG em centímetros; y cresce para baixo.

import { BRAND_COLORS } from './data.js';

const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#65a30d', '#be185d', '#475569'];
const MARGIN = { left: 8, right: 2, top: 4, bottom: 9 };

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function paletteColor(key, keys) {
  return PALETTE[Math.max(0, keys.indexOf(key)) % PALETTE.length];
}

export function dosColor(dos, rules) {
  if (dos < rules.minDos) return '#dc2626';
  if (dos < rules.targetDos) return '#f59e0b';
  if (dos <= rules.targetDos * 3) return '#16a34a';
  return '#2563eb';
}

export function colorFor(product, mode, ctx) {
  if (!product) return '#94a3b8';
  if (mode === 'dos') return dosColor(ctx.dosBySku?.get(product.sku) ?? 0, ctx.rules);
  if (mode === 'subcategory') return paletteColor(product.subcategory, ctx.subcategories);
  return BRAND_COLORS[product.brand] ?? paletteColor(product.brand, ctx.brands);
}

export function legendItems(products, mode, rules) {
  if (mode === 'dos') {
    return [
      ['#dc2626', `< ${rules.minDos} dias`],
      ['#f59e0b', `< ${rules.targetDos} dias`],
      ['#16a34a', 'No alvo'],
      ['#2563eb', `> ${rules.targetDos * 3} dias`],
    ];
  }
  const field = mode === 'subcategory' ? 'subcategory' : 'brand';
  const keys = [...new Set(products.map((p) => p[field]))];
  const ctx = { subcategories: keys, brands: keys };
  return keys.map((k) => [colorFor({ [field]: k }, mode, ctx), k]);
}

// opts: { rules, colorBy, showBlocks, selectedId, bay, checks, highlightSku, dosBySku }
export function renderPlanogram(planogram, products, opts) {
  const { fixture, shelves } = planogram;
  const W = fixture.bayCount * fixture.bayWidth;
  const H = fixture.height;
  const Y = (yFloor) => H - yFloor;
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const ctx = {
    rules: opts.rules,
    dosBySku: opts.dosBySku,
    subcategories: [...new Set(products.map((p) => p.subcategory))],
    brands: [...new Set(products.map((p) => p.brand))],
  };
  const errorIds = opts.errorIds ?? new Set();
  const checks = opts.checks ?? {};
  const bay = Number.isInteger(opts.bay) ? opts.bay : null;
  const x0 = bay === null ? 0 : bay * fixture.bayWidth;
  const x1 = bay === null ? W : x0 + fixture.bayWidth;
  const vb = [x0 - MARGIN.left, -MARGIN.top, x1 - x0 + MARGIN.left + MARGIN.right, H + MARGIN.top + MARGIN.bottom];

  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" class="pog-svg" role="img" aria-label="Vista frontal do planograma">`,
    `<defs><clipPath id="fx-clip"><rect x="${x0}" y="0" width="${x1 - x0}" height="${H}"/></clipPath></defs>`,
    `<rect class="fx-back" x="0" y="0" width="${W}" height="${H}" rx="0.8"/>`,
    `<rect class="fx-base" x="0" y="${Y(fixture.baseHeight)}" width="${W}" height="${fixture.baseHeight}"/>`,
  ];

  for (let b = 0; b <= fixture.bayCount; b++) {
    out.push(`<rect class="fx-upright" x="${b * fixture.bayWidth - 0.5}" y="0" width="1" height="${H}"/>`);
    if (b < fixture.bayCount && (bay === null || bay === b)) {
      out.push(
        `<text class="fx-bay" x="${(b + 0.5) * fixture.bayWidth}" y="${H + 6}" text-anchor="middle">Módulo ${b + 1}</text>`,
      );
    }
  }
  for (const shelf of shelves) {
    const y = Y(shelf.y);
    out.push(
      `<rect class="fx-shelf" x="0" y="${y}" width="${W}" height="${fixture.shelfThickness}" rx="0.3"/>`,
      `<circle class="fx-badge" cx="${x0 - 4.2}" cy="${y - shelf.clearance / 2}" r="2.6"/>`,
      `<text class="fx-badge-text" x="${x0 - 4.2}" y="${y - shelf.clearance / 2 + 1}" text-anchor="middle">${shelf.index + 1}</text>`,
    );
  }

  out.push('<g clip-path="url(#fx-clip)">');
  for (const pos of planogram.positions) {
    const product = bySku.get(pos.sku);
    const shelf = shelves[pos.shelf];
    if (!product || !shelf) continue;
    if (pos.x + pos.width < x0 || pos.x > x1) continue;
    const color = colorFor(product, opts.colorBy, ctx);
    const high = Math.max(1, pos.high);
    const dim = opts.highlightSku && opts.highlightSku !== pos.sku;
    const cls = [
      'pos',
      pos.id === opts.selectedId && 'is-selected',
      errorIds.has(pos.id) && 'has-error',
      dim && 'is-dim',
      opts.highlightSku === pos.sku && 'is-hit',
    ]
      .filter(Boolean)
      .join(' ');
    out.push(`<g class="${cls}" data-id="${pos.id}">`);
    out.push(`<title>${esc(product.name)} · ${pos.facings} frente(s)</title>`);
    for (let f = 0; f < pos.facings; f++) {
      for (let h = 0; h < high; h++) {
        const ux = pos.x + f * product.width;
        const uy = Y(shelf.y + (h + 1) * product.height);
        if (product.image) {
          out.push(
            `<image href="${esc(product.image)}" x="${ux + 0.15}" y="${uy + 0.15}" width="${product.width - 0.3}" height="${product.height - 0.3}" preserveAspectRatio="xMidYMid meet"/>`,
          );
        } else {
          out.push(
            `<rect class="unit" x="${ux + 0.15}" y="${uy + 0.15}" width="${product.width - 0.3}" height="${product.height - 0.3}" rx="0.6" fill="${color}"/>`,
            `<rect class="unit-sheen" x="${ux + 0.15}" y="${uy + 0.15}" width="${product.width - 0.3}" height="${(product.height - 0.3) * 0.22}" rx="0.6"/>`,
          );
        }
      }
    }
    out.push(
      `<rect class="pos-outline" x="${pos.x}" y="${Y(shelf.y + high * product.height)}" width="${pos.width}" height="${high * product.height}" rx="0.8"/>`,
    );
    const label = shortName(product.name, pos.width);
    if (label && !product.image) {
      out.push(
        `<text class="pos-label" x="${pos.x + pos.width / 2}" y="${Y(shelf.y) - 1.3}" text-anchor="middle">${esc(label)}</text>`,
      );
    }
    out.push(
      `<text class="pos-facings" x="${pos.x + pos.width / 2}" y="${Y(shelf.y + high * product.height) - 0.9}" text-anchor="middle">${pos.facings}×</text>`,
    );
    const check = checks[pos.id];
    if (check) {
      const cx = pos.x + pos.width - 2.4;
      const cy = Y(shelf.y + high * product.height) + 2.4;
      out.push(
        `<circle class="chk ${check.state}" cx="${cx}" cy="${cy}" r="2"/>`,
        `<text class="chk-text" x="${cx}" y="${cy + 0.95}" text-anchor="middle">${check.state === 'ok' ? '✓' : '!'}</text>`,
      );
    }
    out.push('</g>');
  }

  if (opts.showBlocks && planogram.blocks) {
    for (const block of planogram.blocks) {
      const top = shelves[block.shelves[0]];
      const bottom = shelves[block.shelves.at(-1)];
      const y0 = Y(top.y + top.clearance);
      const y1 = Y(bottom.y);
      out.push(
        `<rect class="block" x="${block.x0 + 0.4}" y="${y0 + 0.4}" width="${Math.max(0, block.x1 - block.x0 - 0.8)}" height="${y1 - y0 - 0.8}" rx="1"/>`,
        `<text class="block-label" x="${block.x0 + 1.4}" y="${y0 + 3}">${esc(block.path.join(' › '))}</text>`,
      );
    }
  }
  out.push('</g></svg>');
  return out.join('');
}

function shortName(name, width) {
  const chars = Math.floor(width / 1.15);
  if (chars < 4) return '';
  return name.length <= chars ? name : `${name.slice(0, chars - 1)}…`;
}

// Converte um ponto da tela em coordenadas da gôndola (cm, y a partir do chão).
export function toFixturePoint(svg, clientX, clientY, fixture) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const local = pt.matrixTransform(svg.getScreenCTM().inverse());
  return { x: local.x, y: fixture.height - local.y };
}

export function shelfAt(shelves, yFloor) {
  return (
    shelves.find((s) => yFloor >= s.y - 1 && yFloor <= s.y + s.clearance) ??
    shelves.reduce((best, s) => (Math.abs(s.y - yFloor) < Math.abs(best.y - yFloor) ? s : best))
  );
}

// "3ª da esquerda" na prateleira: o promotor conta posições, não centímetros.
export function slotIndex(planogram, pos) {
  return (
    planogram.positions
      .filter((p) => p.shelf === pos.shelf)
      .sort((a, b) => a.x - b.x)
      .findIndex((p) => p.id === pos.id) + 1
  );
}
