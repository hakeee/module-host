import { isIPv6 } from "node:net";

/**
 * The key for per-address limits. IPv6 clients usually get a whole /64, so
 * counting single addresses would let one machine pose as billions of
 * clients: they're counted by their /64 instead. IPv4 (also as
 * `::ffff:1.2.3.4`) stays one address. Same rule as vault-service's
 * `ipBucket`; kept here so module-host doesn't depend on it.
 */
export function ipBucket(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  const address = ip.split("%")[0]!;
  if (!isIPv6(address)) return ip;
  const [head = "", tail] = address.split("::");
  const left = head ? head.split(":") : [];
  // An embedded IPv4 tail (::1.2.3.4) counts as two groups; only the first four groups matter here anyway.
  const right = tail ? tail.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => (parseInt(g, 16) || 0).toString(16))
    .join(":")}::/64`;
}
