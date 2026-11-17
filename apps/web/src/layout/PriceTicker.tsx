import { Text } from '@mantine/core';
import { useState } from 'react';

import { changedMask, nextDirection, type TickDirection } from '../format/dayChange';
import { formatPrice, midOf } from '../format/format';

interface Tick {
  readonly mid: number | null;
  readonly text: string;
  /** The text of the price before, to see which digits moved. */
  readonly previous: string | null;
  readonly direction: TickDirection;
  readonly count: number;
}

const textOf = (mid: number | null) => (mid === null ? '' : formatPrice(mid));

/**
 * The mid price, large, with the bid and the ask under it. When the price moves, only the digits that changed light up
 * (green for up, red for down) and fade back to the normal colour; the digits that stayed are not touched. The text is the
 * same number as before, and the direction is also written as an attribute for the tests.
 */
export function PriceTicker({ bid, ask }: { bid: number | undefined; ask: number | undefined }) {
  const mid = bid === undefined || ask === undefined ? null : midOf(bid, ask);
  const [tick, setTick] = useState<Tick>({
    mid,
    text: textOf(mid),
    previous: null,
    direction: 'flat',
    count: 0,
  });
  // Derived from the previous price: set while rendering, which React allows when the condition makes it settle at once.
  if (tick.mid !== mid) {
    setTick({
      mid,
      text: textOf(mid),
      previous: tick.mid === null ? null : tick.text,
      direction: nextDirection(tick.mid, mid, tick.direction),
      count: tick.count + 1,
    });
  }

  if (mid === null || bid === undefined || ask === undefined) {
    return (
      <Text component="div" lh={1.15} data-testid="status-price">
        —
      </Text>
    );
  }
  const chars = Array.from(tick.text);
  const mask = changedMask(tick.previous, tick.text);
  const dot = tick.text.indexOf('.');
  // A changed digit gets a new key for every move, so that its colour starts again; the others keep theirs.
  const digit = (char: string, index: number) =>
    mask[index] === true ? (
      <span
        key={`${String(tick.count)}-${String(index)}`}
        className={`px-hi px-hi-${tick.direction}`}
      >
        {char}
      </span>
    ) : (
      <span key={index}>{char}</span>
    );
  return (
    <Text component="div" lh={1.15} data-testid="status-price" data-direction={tick.direction}>
      <span className="px">
        <span className="px-int">{chars.slice(0, dot).map((char, i) => digit(char, i))}</span>
        <span className="px-dec">{chars.slice(dot).map((char, i) => digit(char, i + dot))}</span>
      </span>{' '}
      <Text span size="sm" c="dimmed" className="status-detail">
        (bid {formatPrice(bid)} / ask {formatPrice(ask)})
      </Text>
    </Text>
  );
}
