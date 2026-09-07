#!/usr/bin/env python3
"""Convert a BCH CashAddr to legacy Base58Check without external packages.

Used only for CKPool's configured Testnet4 fallback payout. The dashboard keeps
and displays the user's original bchtest: address.
"""
import hashlib
import sys

CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
CHARSET_MAP = {c: i for i, c in enumerate(CHARSET)}
B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
SIZE_MAP = [20, 24, 28, 32, 40, 48, 56, 64]


def polymod(values):
    c = 1
    gen = [0x98F2BC8E61, 0x79B76D99E2, 0xF33E5FB3C4, 0xAE2EABE2A8, 0x1E4F43E470]
    for d in values:
        c0 = c >> 35
        c = ((c & 0x07FFFFFFFF) << 5) ^ d
        for i, g in enumerate(gen):
            if (c0 >> i) & 1:
                c ^= g
    return c ^ 1


def prefix_expand(prefix):
    return [ord(x) & 0x1F for x in prefix] + [0]


def convertbits(data, frombits, tobits, pad=False):
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << tobits) - 1
    max_acc = (1 << (frombits + tobits - 1)) - 1
    for value in data:
        if value < 0 or (value >> frombits):
            raise ValueError('invalid data value')
        acc = ((acc << frombits) | value) & max_acc
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad:
        if bits:
            ret.append((acc << (tobits - bits)) & maxv)
    elif bits >= frombits or ((acc << (tobits - bits)) & maxv):
        raise ValueError('invalid padding')
    return bytes(ret)


def b58check(version, payload):
    raw = bytes([version]) + payload
    raw += hashlib.sha256(hashlib.sha256(raw).digest()).digest()[:4]
    zeroes = len(raw) - len(raw.lstrip(b'\0'))
    n = int.from_bytes(raw, 'big')
    out = ''
    while n:
        n, rem = divmod(n, 58)
        out = B58[rem] + out
    return '1' * zeroes + (out or '1')


def decode_cashaddr(address):
    if address.lower() != address and address.upper() != address:
        raise ValueError('mixed-case CashAddr')
    address = address.lower()
    if ':' not in address:
        raise ValueError('CashAddr prefix required')
    prefix, payload = address.split(':', 1)
    if not prefix or len(payload) < 9:
        raise ValueError('invalid CashAddr')
    try:
        values = [CHARSET_MAP[c] for c in payload]
    except KeyError as exc:
        raise ValueError('invalid CashAddr character') from exc
    if polymod(prefix_expand(prefix) + values) != 0:
        raise ValueError('invalid CashAddr checksum')
    data = values[:-8]
    decoded = convertbits(data, 5, 8, False)
    if not decoded:
        raise ValueError('empty CashAddr payload')
    version = decoded[0]
    if version & 0x80:
        raise ValueError('reserved CashAddr version bit set')
    addr_type = (version >> 3) & 0x0F
    size_code = version & 0x07
    h = decoded[1:]
    if len(h) != SIZE_MAP[size_code]:
        raise ValueError('CashAddr payload length mismatch')
    return prefix, addr_type, h


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: cashaddr_to_legacy.py <cashaddr>')
    prefix, addr_type, h = decode_cashaddr(sys.argv[1])
    if prefix != 'bchtest':
        raise SystemExit('only bchtest: conversion is supported here')
    if len(h) != 20 or addr_type not in (0, 1):
        raise SystemExit('only standard 20-byte P2PKH/P2SH CashAddr is supported')
    print(b58check(0x6F if addr_type == 0 else 0xC4, h))


if __name__ == '__main__':
    main()
