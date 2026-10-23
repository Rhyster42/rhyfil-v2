// Sales by hour: one series, so one color and no legend box (the title names
// it). Thin columns with rounded tops, a hairline grid, the peak labeled, a
// tooltip on hover and keyboard focus, and a table view with every value.
import { useEffect, useRef, useState } from 'react';
import { formatMoney } from '../domain/money';
import type { HourRow } from './types';

const PLOT_HEIGHT = 180;
const TOP = 24; // room for the peak label
const BOTTOM = 26; // x-axis labels
const LEFT = 52; // y-axis labels
const RIGHT = 8;
const MAX_BAR = 24;
const RADIUS = 4;

/** "$0", "$500", "$1.5K": compact, for axis ticks. */
function compactMoney(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(dollars % 1000 === 0 ? 0 : 1)}K`;
  return `$${Math.round(dollars)}`;
}

/** A tick step of 1, 2 or 5 × 10ⁿ giving about four gridlines. */
function niceStep(max: number): number {
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
}

function hourLabel(h: number): string {
  const suffix = h < 12 ? 'am' : 'pm';
  return `${h % 12 === 0 ? 12 : h % 12}${suffix}`;
}

/** A column with a rounded top and a square base. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, h, w / 2);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.max(280, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function HourlyChart({ hours }: { hours: HourRow[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  // Every hour between the first and last sale, so quiet hours show as gaps.
  const byHour = new Map(hours.map((h) => [h.hour, h]));
  const first = Math.min(...hours.map((h) => h.hour));
  const last = Math.max(...hours.map((h) => h.hour));
  const slots = hours.length ? Array.from({ length: last - first + 1 }, (_, i) => byHour.get(first + i) ?? { hour: first + i, orders: 0, gross: 0 }) : [];

  const maxGross = Math.max(1, ...slots.map((s) => s.gross));
  const step = niceStep(maxGross);
  const top = Math.ceil(maxGross / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const plotWidth = width - LEFT - RIGHT;
  const slotWidth = slots.length ? plotWidth / slots.length : plotWidth;
  const barWidth = Math.min(MAX_BAR, Math.max(4, slotWidth - 6));
  const y = (v: number) => TOP + PLOT_HEIGHT - (v / top) * PLOT_HEIGHT;
  const peak = slots.reduce<HourRow | null>((best, s) => (!best || s.gross > best.gross ? s : best), null);
  const labelEvery = slotWidth < 34 ? 2 : 1;

  const shown = active === null ? null : slots[active];
  return (
    <figure className="chart" ref={ref}>
      <figcaption className="chart-head">
        <span>
          <strong>Sales by hour</strong> <span className="muted">· before tax</span>
        </span>
        <button type="button" className="btn btn-sm btn-ghost" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </figcaption>

      {slots.length === 0 ? (
        <p className="muted chart-empty">No sales in this range.</p>
      ) : asTable ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>Hour</th>
              <th className="num">Orders</th>
              <th className="num">Sales</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((s) => (
              <tr key={s.hour}>
                <td>
                  {hourLabel(s.hour)}–{hourLabel((s.hour + 1) % 24)}
                </td>
                <td className="num">{s.orders}</td>
                <td className="num">{formatMoney(s.gross)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="chart-plot">
          <svg width={width} height={TOP + PLOT_HEIGHT + BOTTOM} role="group" aria-label="Sales by hour">
            {ticks.map((t) => (
              <g key={t}>
                <line className="chart-grid" x1={LEFT} x2={width - RIGHT} y1={y(t)} y2={y(t)} />
                <text className="chart-tick" x={LEFT - 8} y={y(t)} dy="0.32em" textAnchor="end">
                  {compactMoney(t)}
                </text>
              </g>
            ))}
            {slots.map((s, i) => {
              const cx = LEFT + slotWidth * i + slotWidth / 2;
              const h = Math.max(0, (s.gross / top) * PLOT_HEIGHT);
              return (
                <g
                  key={s.hour}
                  className={`chart-slot${active === i ? ' active' : ''}`}
                  tabIndex={0}
                  role="img"
                  aria-label={`${hourLabel(s.hour)}: ${formatMoney(s.gross)}, ${s.orders} orders`}
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive(null)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                >
                  {/* The whole column of the slot is the hit target, not just the bar. */}
                  <rect className="chart-hit" x={LEFT + slotWidth * i} y={TOP} width={slotWidth} height={PLOT_HEIGHT} />
                  {h > 0 && <path className="chart-bar" d={columnPath(cx - barWidth / 2, y(s.gross), barWidth, h)} />}
                  {i % labelEvery === 0 && (
                    <text className="chart-tick" x={cx} y={TOP + PLOT_HEIGHT + 18} textAnchor="middle">
                      {hourLabel(s.hour)}
                    </text>
                  )}
                </g>
              );
            })}
            <line className="chart-axis" x1={LEFT} x2={width - RIGHT} y1={y(0)} y2={y(0)} />
            {peak && peak.gross > 0 && active === null && (
              <text
                className="chart-label"
                x={LEFT + slotWidth * slots.indexOf(peak) + slotWidth / 2}
                y={y(peak.gross) - 8}
                textAnchor="middle"
              >
                {compactMoney(peak.gross)}
              </text>
            )}
          </svg>
          {shown && active !== null && (
            <div
              className="chart-tooltip"
              role="status"
              style={{
                left: Math.min(width - 190, Math.max(0, LEFT + slotWidth * active + slotWidth / 2 - 80)),
                top: Math.max(0, y(shown.gross) - 64),
              }}
            >
              <strong>{formatMoney(shown.gross)}</strong>
              <span>
                {hourLabel(shown.hour)}–{hourLabel((shown.hour + 1) % 24)} · {shown.orders} {shown.orders === 1 ? 'order' : 'orders'}
              </span>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
