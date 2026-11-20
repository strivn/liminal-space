// Addresses on this machine or a private network, with nothing from Node, so the Worker's add_links and
// scripts/lib/public-address.ts (the scripts' check before each fetch) refuse the same ranges.

// RFC 6890 special-purpose ranges a web page has no business pointing to: this machine, private networks, link-local
// (169.254.169.254 is a cloud's metadata service) and carrier-grade NAT, as [address, prefix length].
const IPV4_RANGES: [string, number][] = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	// Reserved, multicast and benchmark ranges.
	["192.0.0.0", 24],
	["198.18.0.0", 15],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
	// Azure's WireServer: one fixed address, in a public range, that every Azure VM reaches from inside. GitHub's
	// runners are Azure VMs (https://learn.microsoft.com/en-us/azure/virtual-network/what-is-ip-address-168-63-129-16).
	["168.63.129.16", 32],
];
const IPV6_RANGES: [string, number][] = [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	// IPv6 forms that carry an IPv4 address a gateway could route to this machine or a private network:
	// IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16), refused for networks that route them.
	// fec0::/10 is the old site-local range.
	["::", 96],
	["64:ff9b::", 96],
	["2002::", 16],
	["fec0::", 10],
	// Multicast: no web page lives there.
	["ff00::", 8],
	// Teredo tunnels: the address carries an IPv4 address (the server's and, obscured, the client's).
	["2001::", 32],
];

// "127.0.0.1" -> its 4 bytes; null for anything but four decimal numbers 0 to 255 joined by dots.
function ipv4Bytes(text: string): number[] | null {
	const parts = text.split(".");
	if (parts.length !== 4) {
		return null;
	}
	const bytes: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part) || Number(part) > 255) {
			return null;
		}
		bytes.push(Number(part));
	}
	return bytes;
}

// The 16-bit groups of one side of "::": "fe80:0:1" -> [0xfe80, 0, 1]; a last part "a.b.c.d" gives two groups.
// null when a part is neither 1 to 4 hex digits nor, last, an IPv4 address.
function ipv6Groups(text: string): number[] | null {
	if (text === "") {
		return [];
	}
	const parts = text.split(":");
	const groups: number[] = [];
	for (let k = 0; k < parts.length; k++) {
		const part = parts[k] || "";
		const isLast = k === parts.length - 1;
		const ipv4 = ipv4Bytes(part);
		if (isLast && ipv4 !== null) {
			groups.push((ipv4[0] || 0) * 256 + (ipv4[1] || 0));
			groups.push((ipv4[2] || 0) * 256 + (ipv4[3] || 0));
		} else if (/^[0-9a-f]{1,4}$/i.test(part)) {
			groups.push(Number.parseInt(part, 16));
		} else {
			return null;
		}
	}
	return groups;
}

// "::1" or "fe80::1%en0" -> its 16 bytes (a zone after "%" is dropped); null when it isn't an IPv6 address.
function ipv6Bytes(text: string): number[] | null {
	const address = text.split("%")[0] || "";
	const halves = address.split("::");
	if (halves.length > 2) {
		return null;
	}
	const head = ipv6Groups(halves[0] || "");
	let groups: number[] | null = head;
	if (halves.length === 2) {
		// "::" stands for as many zero groups as the two sides leave out of 8, at least one.
		const tail = ipv6Groups(halves[1] || "");
		if (head === null || tail === null || head.length + tail.length > 7) {
			return null;
		}
		const zeros: number[] = new Array(8 - head.length - tail.length).fill(0);
		groups = head.concat(zeros, tail);
	}
	if (groups === null || groups.length !== 8) {
		return null;
	}
	const bytes: number[] = [];
	for (const group of groups) {
		bytes.push(Math.floor(group / 256), group % 256);
	}
	return bytes;
}

// True when the first `prefix` bits of two addresses of the same length agree.
function sharesPrefix(address: number[], range: number[], prefix: number) {
	for (let bit = 0; bit < prefix; bit++) {
		const byte = Math.floor(bit / 8);
		const mask = 128 >> (bit % 8);
		if (((address[byte] || 0) & mask) !== ((range[byte] || 0) & mask)) {
			return false;
		}
	}
	return true;
}

// True when an address lies in one of the ranges, each read with `parse`.
function inRanges(
	address: number[],
	ranges: [string, number][],
	parse: (text: string) => number[] | null,
) {
	return ranges.some((range) => {
		const start = parse(range[0]);
		return start !== null && sharesPrefix(address, start, range[1]);
	});
}

// True for an IPv4 or IPv6 address, written as an address, that is on this machine or a private network. An IPv4
// address written as IPv6 (::ffff:127.0.0.1, or ::ffff:7f00:1 as a URL writes it) is judged as the IPv4 address too,
// as Node's BlockList does. False for anything that isn't an address, such as a host name.
export function isLocalAddress(text: string): boolean {
	const ipv4 = ipv4Bytes(text);
	if (ipv4 !== null) {
		return inRanges(ipv4, IPV4_RANGES, ipv4Bytes);
	}
	const ipv6 = ipv6Bytes(text);
	if (ipv6 === null) {
		return false;
	}
	if (inRanges(ipv6, IPV6_RANGES, ipv6Bytes)) {
		return true;
	}
	// ::ffff:a.b.c.d: ten zero bytes, two 0xff bytes, then the IPv4 address.
	const isMapped =
		ipv6.slice(0, 10).every((byte) => byte === 0) &&
		ipv6[10] === 255 &&
		ipv6[11] === 255;
	return isMapped && inRanges(ipv6.slice(12), IPV4_RANGES, ipv4Bytes);
}

// True for a URL's host that names this machine or a private network as written: "localhost", any name ending in
// ".localhost" (RFC 6761), or a local address. A URL's hostname keeps an IPv6 address's brackets and may end in a dot;
// both are dropped first. A name that only resolves to a local address is not seen here: that takes DNS.
export function isLocalHost(hostname: string): boolean {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (host === "localhost" || host.endsWith(".localhost")) {
		return true;
	}
	return isLocalAddress(host);
}
