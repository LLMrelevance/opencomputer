/**
 * The `[egress]` allowlist in `opencomputer.toml` (work 057). One `allow`
 * list of domains, `*.` wildcards, IPs and CIDRs, split here into the two
 * lists the service takes. The service validates the same way.
 */
export interface DeploymentEgress {
  /** Exact or `*.` wildcard domains; matched on TLS SNI, port 443 only. */
  domains: string[];
  /** IPv4/IPv6 CIDRs (a bare address becomes /32 or /128); any port. */
  cidrs: string[];
}

export const EGRESS_MAX_ENTRIES = 64;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A lowercased domain or `*.` wildcard, or null when it is not one. */
export function egressDomain(value: string): string | null {
  const lowered = value.trim().toLowerCase().replace(/\.$/, "");
  const wildcard = lowered.startsWith("*.");
  const host = wildcard ? lowered.slice(2) : lowered;
  if (host.length > 253 || IPV4.test(host)) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null;
  return wildcard ? `*.${host}` : host;
}

function ipv6(address: string): boolean {
  if (!address.includes(":") || !/^[0-9a-f:.]+$/.test(address)) return false;
  try {
    new URL(`http://[${address}]/`);
    return true;
  } catch {
    return false;
  }
}

/** An IP or CIDR as a CIDR (a bare address gets /32 or /128), or null. */
export function egressCidr(value: string): string | null {
  const [address = "", prefix, extra] = value.trim().toLowerCase().split("/");
  if (extra !== undefined) return null;
  const max = IPV4.test(address) ? 32 : ipv6(address) ? 128 : null;
  if (max === null) return null;
  if (prefix === undefined) return `${address}/${max}`;
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) return null;
  return `${address}/${Number(prefix)}`;
}

/**
 * Splits `allow` into domains and CIDRs, deduplicated and sorted. Throws
 * with the offending entry; an empty list is valid and allows only the
 * platform's own hosts.
 */
export function splitEgressAllow(allow: unknown): DeploymentEgress {
  if (!Array.isArray(allow)) {
    throw new Error(
      'opencomputer.toml [egress] allow must be a list, e.g. allow = ["api.github.com", "10.0.0.0/8"]',
    );
  }
  const domains = new Set<string>();
  const cidrs = new Set<string>();
  for (const entry of allow) {
    const text = typeof entry === "string" ? entry : "";
    const cidr = egressCidr(text);
    const domain = cidr ? null : egressDomain(text);
    if (cidr) cidrs.add(cidr);
    else if (domain) domains.add(domain);
    else {
      throw new Error(
        `opencomputer.toml [egress] allow entry ${JSON.stringify(entry)} is not a domain ` +
          '("api.github.com", "*.example.com"), IP address or CIDR; leave out schemes, ports and paths',
      );
    }
  }
  if (domains.size > EGRESS_MAX_ENTRIES || cidrs.size > EGRESS_MAX_ENTRIES) {
    throw new Error(
      `opencomputer.toml [egress] allow takes at most ${EGRESS_MAX_ENTRIES} domains and ${EGRESS_MAX_ENTRIES} IPs/CIDRs`,
    );
  }
  return { domains: [...domains].sort(), cidrs: [...cidrs].sort() };
}
