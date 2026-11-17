import type { IChartApi } from 'lightweight-charts';

/** A press that moves less than this (px) is a click, not a drag: the drawing tools click with a little shake. */
const DRAG_START_PX = 4;

interface Drag {
  readonly startY: number;
  readonly from: number;
  readonly to: number;
  readonly height: number;
}

/**
 * Moving the chart up and down with the mouse, as on TradingView. The chart library moves the price with a drag only when the
 * price scale is not automatic, and ours always is, so a drag up or down did nothing. Here a drag in the plot (not on an
 * axis, not in a pane under the price) turns the automatic scale off and moves the visible prices with the pointer.
 * "Now", "Reset" and a double click on the price axis bring the automatic scale back (and with it the newest candles).
 * Returns the function that takes the listeners away.
 */
export function attachVerticalPan(chart: IChartApi, element: HTMLElement): () => void {
  const scale = chart.priceScale('right');
  let drag: Drag | null = null;
  let moved = false;

  const onMove = (event: PointerEvent) => {
    if (drag === null) return;
    const dy = event.clientY - drag.startY;
    if (!moved && Math.abs(dy) < DRAG_START_PX) return;
    moved = true;
    scale.applyOptions({ autoScale: false });
    // what is under the pointer stays under it: a drag down shows higher prices
    const shift = (dy / drag.height) * (drag.to - drag.from);
    scale.setVisibleRange({ from: drag.from + shift, to: drag.to + shift });
  };

  const stop = () => {
    drag = null;
    moved = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
  };

  const onDown = (event: PointerEvent) => {
    // The library moves the price itself once the scale is not automatic: no second mover then.
    if (event.pointerType !== 'mouse' || event.button !== 0 || !scale.options().autoScale) return;
    const box = element.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const height = chart.panes()[0]?.getHeight() ?? 0;
    if (height <= 0 || x > box.width - scale.width() || y > height - 4) return;
    const range = scale.getVisibleRange();
    if (range === null) return;
    drag = { startY: event.clientY, from: range.from, to: range.to, height };
    moved = false;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  element.addEventListener('pointerdown', onDown, true);
  return () => {
    element.removeEventListener('pointerdown', onDown, true);
    stop();
  };
}
