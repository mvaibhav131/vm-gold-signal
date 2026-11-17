import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderLoggedIn } from './test-utils';

const quote = (bid: number, ask: number) =>
  ({
    event: 'quote',
    data: {
      bid,
      ask,
      spread: Math.round((ask - bid) * 1000) / 1000,
      ageMs: 300,
      feedState: 'LIVE',
    },
  }) as const;

describe('the price in the status bar', () => {
  it('lights up only the digits that changed, green for up and red for down, and keeps the direction', async () => {
    const { emit } = await renderLoggedIn('/');
    const bar = await screen.findByRole('region', { name: 'Market status' });
    const price = within(bar).getByTestId('status-price');
    await waitFor(() => {
      expect(price).toHaveTextContent(/^\d{4}\.\d{3} \(bid/);
    });
    const lit = (selector: string) =>
      [...price.querySelectorAll(selector)].map((element) => element.textContent).join('');

    emit(quote(4000.0, 4000.2));
    await waitFor(() => {
      expect(price).toHaveTextContent('4000.100 (bid 4000.000 / ask 4000.200)');
    });

    // 4000.100 to 4000.600: from the first digit that changed (the 1 became 6) to the end, the digits are green
    emit(quote(4000.5, 4000.7));
    await waitFor(() => {
      expect(price).toHaveAttribute('data-direction', 'up');
    });
    expect(price).toHaveTextContent('4000.600 (bid');
    expect(lit('.px-hi-up')).toBe('600');
    expect(price.querySelector('.px-hi-down')).toBeNull();
    // the number is still one number: the two parts are only for the size of the digits
    expect(price.querySelector('.px-int')).toHaveTextContent('4000');
    expect(price.querySelector('.px-dec')).toHaveTextContent('.600');
    // no background and no colour on the whole price
    expect(price.querySelector('.px')).not.toHaveClass('px-up');

    // 4000.600 to 3999.100: the first digit changed, so every digit is red
    emit(quote(3999.0, 3999.2));
    await waitFor(() => {
      expect(price).toHaveAttribute('data-direction', 'down');
    });
    expect(lit('.px-hi-down')).toBe('3999.100');
    expect(price.querySelector('.px-hi-up')).toBeNull();

    // the same mid price again (only the spread moved): nothing lights up again and the direction stays
    emit(quote(3998.9, 3999.3));
    await waitFor(() => {
      expect(price).toHaveTextContent('3999.100 (bid 3998.900 / ask 3999.300)');
    });
    expect(price).toHaveAttribute('data-direction', 'down');
    expect(lit('.px-hi-down')).toBe('3999.100');
  });

  it('shows how much the price moved since the trading day opened, with the sign', async () => {
    const { emit } = await renderLoggedIn('/');
    const change = await screen.findByTestId('status-change');
    await waitFor(() => {
      expect(change).toHaveTextContent(/^[▲▼]?[-+]?\d+\.\d{3} \([-+]?\d+\.\d{2}%\)$/);
    });
    // a price far above any reference of the preview is a rise, far below a fall
    emit(quote(9000.0, 9000.2));
    await waitFor(() => {
      expect(change).toHaveAttribute('data-direction', 'up');
    });
    expect(change).toHaveTextContent(/^▲\+\d+\.\d{3} \(\+\d+\.\d{2}%\)$/);
    emit(quote(1000.0, 1000.2));
    await waitFor(() => {
      expect(change).toHaveAttribute('data-direction', 'down');
    });
    expect(change).toHaveTextContent(/^▼-\d+\.\d{3} \(-\d+\.\d{2}%\)$/);
  });
});
