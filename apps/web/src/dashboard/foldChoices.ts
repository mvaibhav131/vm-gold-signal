/** With this many open signals or fewer every card is unfolded; with more only the newest one is, so the panel stays short. */
export const UNFOLD_ALL_UP_TO = 3;

/** What the owner chose card by card (by the id of the signal); a card that was not touched follows the rule above. */
export type FoldChoices = Readonly<Record<string, boolean>>;

/** Is the card at `index` (0 is the newest) of `count` unfolded? */
export function isUnfolded(
  choices: FoldChoices,
  id: string,
  index: number,
  count: number,
): boolean {
  const own = choices[id];
  if (own !== undefined) return own;
  return count <= UNFOLD_ALL_UP_TO || index === 0;
}

/** The same choice for every card: "fold all" and "unfold all". */
export function chooseAll(ids: readonly string[], unfolded: boolean): FoldChoices {
  return Object.fromEntries(ids.map((id) => [id, unfolded]));
}
