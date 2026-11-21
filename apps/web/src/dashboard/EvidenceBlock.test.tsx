import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import type { Evidence } from '@vmgs/contracts';
import { describe, expect, it } from 'vitest';

import { FORWARD_LOW_SAMPLE } from '../mocks/signals';
import { EvidenceBlock } from './EvidenceBlock';

const show = (evidence: Evidence, rewardR?: number) =>
  render(
    <MantineProvider>
      <EvidenceBlock evidence={evidence} {...(rewardR === undefined ? {} : { rewardR })} />
    </MantineProvider>,
  );

const line = () => screen.queryByTestId('evidence-break-even');

describe('the break-even bar next to the evidence of a signal', () => {
  it('says what the first target needs, and that the interval holds it, when the evidence is not clear', () => {
    show(FORWARD_LOW_SAMPLE, 1);
    expect(line()).toHaveTextContent(
      'The 50% needed to break even at TP1 (1.0R, before costs) is inside the interval: not clearly above or below it yet.',
    );
    expect(line()).toHaveAttribute('data-verdict', 'UNCLEAR');
  });

  it('says above when even the low end of the interval is over the bar', () => {
    show({ ...FORWARD_LOW_SAMPLE, winRate: 0.62, ci: [0.52, 0.71] }, 1);
    expect(line()).toHaveTextContent(
      'Above the 50% needed to break even at TP1 (1.0R, before costs).',
    );
    expect(line()).toHaveAttribute('data-verdict', 'ABOVE');
  });

  it('says below, in words, when even the high end is under the bar', () => {
    show({ ...FORWARD_LOW_SAMPLE, winRate: 0.4, ci: [0.31, 0.49], expectancyR: -0.2 }, 1);
    expect(line()).toHaveTextContent(
      'Below the 50% needed to break even at TP1 (1.0R, before costs): this setup type has not paid for its stops so far.',
    );
    expect(line()).toHaveAttribute('data-verdict', 'BELOW');
  });

  it('follows the reward: a target at half the risk needs two thirds of the trades', () => {
    show(FORWARD_LOW_SAMPLE, 0.5);
    expect(line()).toHaveTextContent('67% needed to break even at TP1 (0.5R');
  });

  it('shows no percentage below the minimum sample, only how many trades one win must be in', () => {
    show(
      {
        ...FORWARD_LOW_SAMPLE,
        n: 18,
        wins: 10,
        sampleLabel: 'INSUFFICIENT',
        winRate: null,
        ci: null,
        expectancyR: null,
        profitFactor: null,
        tp1Rate: null,
        tp2Rate: null,
      },
      1,
    );
    expect(line()).toHaveTextContent(
      'A setup must win 1 trade in 2 to break even at TP1 (1.0R, before costs).',
    );
    expect(screen.getByTestId('signal-evidence').textContent).not.toContain('%');
    expect(line()).toHaveAttribute('data-verdict', 'UNKNOWN');
  });

  it('has no such line when the reward is not given', () => {
    show(FORWARD_LOW_SAMPLE);
    expect(line()).toBeNull();
  });
});
