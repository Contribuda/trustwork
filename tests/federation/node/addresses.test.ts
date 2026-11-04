import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress } from '../../../apps/api/src/modules/federation/node/transport.js';

/** FED-001: the address a peer's name resolves to is connected to only when it is publicly routable, whatever its form. */
test('isPublicAddress: public unicast only; every IPv6 form that embeds an IPv4 address is judged by the address it carries', () => {
  const publicOnes = [
    '203.0.113.10', '198.51.100.7', '8.8.8.8', '2001:4860:4860::8888', '2606:4700::1111', '2a00:1450:4001:80e::200e',
    '::ffff:203.0.113.10', '::ffff:cb00:710a', '::203.0.113.10', '::cb00:710a', '64:ff9b::203.0.113.10', '64:ff9b::cb00:710a', '2002:cb00:710a::1',
  ];
  for (const address of publicOnes) assert.equal(isPublicAddress(address), true, address);
  const refused = [
    // IPv4: this network, private, loopback, carrier-grade NAT, link local, IETF assignments, multicast, broadcast.
    '0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.0.1', '100.127.255.254', '169.254.1.1', '172.16.0.1', '172.31.255.255', '192.168.0.9', '192.0.0.1', '224.0.0.1', '255.255.255.255',
    // IPv6 of its own: unspecified, loopback, unique local, link local, multicast, documentation, Teredo, discard-only.
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'FE80::1', 'ff02::1', '2001:db8::5', '2001::1', '100::1',
    // IPv4-compatible (::/96) carrying a loopback or private address, dotted and hexadecimal.
    '::127.0.0.1', '::7f00:1', '::10.0.0.1', '::a00:1', '::0.0.0.0', '0:0:0:0:0:0:127.0.0.1',
    // IPv4-mapped (::ffff:0:0/96), dotted and hexadecimal, upper case, long form.
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:10.0.0.1', '::ffff:a00:1', '0:0:0:0:0:ffff:192.168.0.1', '::ffff:169.254.1.1', '::ffff:c0a8:1',
    // SIIT (::ffff:0:0:0/96), NAT64 well-known and local-use prefixes, 6to4 carrying a private address.
    '::ffff:0:127.0.0.1', '::ffff:0:7f00:1', '64:ff9b::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b:1::cb00:710a', '2002:7f00:1::1', '2002:c0a8:1::1',
    // Not an address at all.
    'austin.example.org', '', '1.2.3', '::ffff:999.1.1.1', 'fe80::1%eth0', '[2001:db8::1]',
  ];
  for (const address of refused) assert.equal(isPublicAddress(address), false, address);
});
