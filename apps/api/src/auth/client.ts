import { isIPv4, isIPv6 } from 'node:net';

/** The eight groups of an IPv6 address as numbers (an IPv4 tail counts as the last two). */
function groupsOf(address: string): number[] {
  let text = address.split('%')[0] ?? address;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.slice(1).map(Number);
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parts = text.split('::');
  const side = (part: string | undefined): number[] =>
    part === undefined || part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));
  const head = side(parts[0]);
  if (parts.length === 1) return head;
  const rest = side(parts[1]);
  return [...head, ...Array.from({ length: 8 - head.length - rest.length }, () => 0), ...rest];
}

/**
 * Who a request is, for the throttle and for `ip_hash`: an IPv4 address as it is, an IPv6 address as its /64
 * (whoever has an address has the whole /64, so counting single addresses would count nothing), and everything that
 * cannot be read as one key. The text is hashed with a key before it is stored.
 */
export function clientKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const v4 = mapped?.[1];
  if (v4 !== undefined && isIPv4(v4)) return v4;
  if (isIPv4(ip)) return ip;
  if (isIPv6(ip)) {
    return `${groupsOf(ip)
      .slice(0, 4)
      .map((group) => group.toString(16))
      .join(':')}::/64`;
  }
  return 'unknown';
}
