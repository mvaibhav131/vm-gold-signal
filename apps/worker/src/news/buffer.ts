import { timeOf, type UnclassifiedHeadline } from '@vmgs/core';

/** An unclassified headline is kept this long (02 section 16: "a 2-hour in-memory buffer"). */
export const BUFFER_MS = 2 * 60 * 60_000;
/** ... and at most this many are kept, the oldest going first. */
export const BUFFER_MAX = 500;

/**
 * The headlines that no rule recognised, in memory only. They are never stored: they exist so that a sudden
 * move of gold can still show what was published around it, labelled "unclassified, timing only".
 */
export class UnclassifiedBuffer {
  private list: UnclassifiedHeadline[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Adds a headline; one with a link that is already in the buffer is not added again. */
  add(item: UnclassifiedHeadline): boolean {
    if (this.list.some((held) => held.url === item.url)) return false;
    if (this.now() - timeOf(item) > BUFFER_MS) return false;
    this.list.push(item);
    if (this.list.length > BUFFER_MAX) {
      this.list.sort((a, b) => timeOf(a) - timeOf(b));
      this.list = this.list.slice(this.list.length - BUFFER_MAX);
    }
    return true;
  }

  /** What is in the buffer now: the headlines of the last two hours, oldest first. */
  items(): UnclassifiedHeadline[] {
    const oldest = this.now() - BUFFER_MS;
    this.list = this.list.filter((item) => timeOf(item) >= oldest);
    return [...this.list].sort((a, b) => timeOf(a) - timeOf(b) || a.url.localeCompare(b.url));
  }
}
