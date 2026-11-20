// Unit tests for shared/local-address.ts, the ranges fulltext.sh (through fetch-guard.ts) and the Worker refuse:
// loopback, private, link-local, carrier-grade NAT, unspecified, IPv6 unique-local, link-local, multicast (ff00::/8) and
// Teredo (2001::/32), at their edges, and the public addresses just outside them (2001:db8::/32, the documentation
// range, is outside 2001::/32).
import assert from "node:assert/strict";
import { test } from "vitest";
import { isLocalAddress, isLocalHost } from "../../shared/local-address.ts";

const LOCAL = [
	"127.0.0.1",
	"127.255.255.254",
	"10.0.0.1",
	"10.255.255.255",
	"172.16.5.4",
	"172.31.255.1",
	"192.168.1.1",
	"169.254.169.254",
	"100.64.0.1",
	"100.127.255.254",
	"0.0.0.0",
	"::1",
	"fd00::1",
	"fc00::1",
	"fe80::1",
	"::ffff:127.0.0.1",
	"::ffff:7f00:1",
	"ff02::1",
	"ff0e::1",
	"2001::1",
	"2001:0:1234::5",
	// Azure's WireServer, the same address on every GitHub runner; also as an IPv4-mapped IPv6 address.
	"168.63.129.16",
	"::ffff:168.63.129.16",
];

const PUBLIC = [
	"8.8.8.8",
	// The addresses on either side of Azure's WireServer.
	"168.63.129.15",
	"168.63.129.17",
	"172.15.255.255",
	"172.32.0.1",
	"192.169.0.1",
	"100.63.255.255",
	"100.128.0.1",
	"2606:4700::1111",
	"2001:db8::1",
	"2001:4860:4860::8888",
	"::ffff:8.8.8.8",
];

for (const address of LOCAL) {
	test(`security: ${address} is on this machine or a private network`, () => {
		assert.equal(isLocalAddress(address), true);
	});
}

for (const address of PUBLIC) {
	test(`security: ${address} is on the public internet`, () => {
		assert.equal(isLocalAddress(address), false);
	});
}

test("security: a host name is not an address", () => {
	assert.equal(isLocalAddress("example.com"), false);
	assert.equal(isLocalAddress("localhost"), false);
});

test('security: a URL host of "localhost", a ".localhost" name, a bracketed local IPv6 address or a private address is local, and a public host is not', () => {
	assert.equal(isLocalHost("localhost"), true);
	assert.equal(isLocalHost("LOCALHOST."), true);
	assert.equal(isLocalHost("liminal-test.localhost"), true);
	assert.equal(isLocalHost("[::1]"), true);
	assert.equal(isLocalHost("10.0.0.1"), true);
	assert.equal(isLocalHost("example.com"), false);
	assert.equal(isLocalHost("[2606:4700::1111]"), false);
});
