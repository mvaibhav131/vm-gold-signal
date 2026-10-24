import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, vi } from 'vitest';

// A screen is loaded on demand (lazy route, data table), and the first load of its code can take
// longer than a second on a busy machine: waiting for it is not a failure.
configure({ asyncUtilTimeout: 5000 });

// The chart draws on a canvas, which jsdom does not have. The e2e tests cover the real chart.
vi.mock('./dashboard/chart/PriceChart', () => ({
  default: () => createElement('div', { 'data-testid': 'price-chart-stub' }),
}));

// Mantine needs a few browser APIs that jsdom does not have. The screen is 1280 px wide (a desktop):
// a width query is true or false by that width, which the data table of the history screen relies on.
const SCREEN_WIDTH_PX = 1280;

function matchesWidth(query: string): boolean {
  // The empty query matches everything, as in a browser (the data table asks for it)
  if (query.trim() === '') return true;
  const match = /\((min|max)-width:\s*([\d.]+)(px|em)?\)/.exec(query);
  if (!match) return false;
  const limit = Number(match[2]) * (match[3] === 'em' ? 16 : 1);
  return match[1] === 'min' ? SCREEN_WIDTH_PX >= limit : SCREEN_WIDTH_PX <= limit;
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: matchesWidth(query),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

class ResizeObserverStub {
  observe() {
    return undefined;
  }
  unobserve() {
    return undefined;
  }
  disconnect() {
    return undefined;
  }
}
globalThis.ResizeObserver = ResizeObserverStub;

window.HTMLElement.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  cleanup();
});
