// Gráfico de linha diário (SVG) com a virada marcada e as janelas antes/depois sombreadas.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dayIndex = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 864e5);
const short = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

export function dailyChart(daily, { value = 'revenue', virada = null, before = null, after = null, format = (v) => v } = {}) {
  if (daily.length < 2) return '<p class="hint">Poucos dias com venda para desenhar o gráfico.</p>';
  const W = 760;
  const H = 220;
  const pad = { l: 56, r: 12, t: 14, b: 26 };
  const first = dayIndex(daily[0].date);
  const last = dayIndex(daily.at(-1).date);
  const span = Math.max(1, last - first);
  const max = Math.max(...daily.map((d) => d[value])) || 1;
  const x = (iso) => pad.l + ((dayIndex(iso) - first) / span) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const band = (w, cls) =>
    w && w.to >= daily[0].date && w.from <= daily.at(-1).date
      ? `<rect class="chart-${cls}" x="${x(w.from < daily[0].date ? daily[0].date : w.from)}" y="${pad.t}" width="${Math.max(0, x(w.to > daily.at(-1).date ? daily.at(-1).date : w.to) - x(w.from < daily[0].date ? daily[0].date : w.from))}" height="${H - pad.t - pad.b}"/>`
      : '';
  const ticks = [0, 0.5, 1].map((f) => `<line class="chart-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(max * f)}" y2="${y(max * f)}"/>
    <text class="chart-axis" x="${pad.l - 6}" y="${y(max * f) + 4}" text-anchor="end">${esc(format(max * f))}</text>`);
  const path = daily.map((d, i) => `${i ? 'L' : 'M'}${x(d.date).toFixed(1)},${y(d[value]).toFixed(1)}`).join(' ');
  const viradaLine =
    virada && virada >= daily[0].date && virada <= daily.at(-1).date
      ? `<line class="chart-virada" x1="${x(virada)}" x2="${x(virada)}" y1="${pad.t}" y2="${H - pad.b}"/>
         <text class="chart-virada-label" x="${x(virada) + 4}" y="${pad.t + 10}">virada ${short(virada)}</text>`
      : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Venda diária">
    ${band(before, 'before')}${band(after, 'after')}${ticks.join('')}
    <path class="chart-line" d="${path}"/>
    ${viradaLine}
    <text class="chart-axis" x="${pad.l}" y="${H - 6}">${short(daily[0].date)}</text>
    <text class="chart-axis" x="${W - pad.r}" y="${H - 6}" text-anchor="end">${short(daily.at(-1).date)}</text>
  </svg>`;
}
