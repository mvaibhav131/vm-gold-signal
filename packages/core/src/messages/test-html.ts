/** The words of a Telegram HTML message without its tags and entities, for tests that check what a reader sees. */
export const plain = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
