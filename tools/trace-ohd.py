#!/usr/bin/env python3
"""Trace a complete packet through the supplied ARM64 message factory/decoder.

Records primitive wire types and call sites. CSV references use inert objects;
this does not recreate game logic or give semantic names to unknown fields.
Requires Python package unicorn. The historical filename remains compatible.
"""

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

EXPECTED_LIBRARY_SHA256 = '090d71be3b04fa5d260c7baa94d1cf29834dd9202e4d7f9fd20535afae4ca95b'
READERS = {
    0x5b6b74: 'VInt', 0x5b629c: 'Int', 0x5b66c4: 'Int',
    0x5b5d6c: 'Boolean', 0x5b594c: 'String', 0x5b5a80: 'String',
    0x5b6380: 'Byte', 0x5b630c: 'Short', 0x5b639c: 'UnsignedShort',
    0x5b6340: 'Int24', 0x5b6498: 'Long', 0x5b6714: 'Bytes',
}


def trace_packet(library, payload, packet_id=24101, version=0):
    try:
        from unicorn import Uc, UC_ARCH_ARM64, UC_MODE_ARM, UC_HOOK_CODE
        from unicorn.arm64_const import (
            UC_ARM64_REG_X0, UC_ARM64_REG_X1, UC_ARM64_REG_X2,
            UC_ARM64_REG_SP, UC_ARM64_REG_LR, UC_ARM64_REG_PC,
            UC_ARM64_REG_CPACR_EL1,
        )
    except ImportError as error:
        raise RuntimeError('Native tracing requires Python unicorn: python3 -m pip install unicorn') from error
    digest = hashlib.sha256(library).hexdigest()
    if digest != EXPECTED_LIBRARY_SHA256:
        raise ValueError('Unsupported .so: these decoder addresses apply only to the supplied v69.230_arm64.so')
    if len(payload) > 3 * 1024 * 1024:
        raise ValueError('Packet body exceeds 3145728 bytes')
    if not 0 <= packet_id <= 65535 or not 0 <= version <= 65535:
        raise ValueError('Invalid packet ID or version')

    machine = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
    machine.mem_map(0, 0x1350000)
    phoff = struct.unpack_from('<Q', library, 32)[0]
    phnum = struct.unpack_from('<H', library, 56)[0]
    for i in range(phnum):
        kind, _, offset, address, _, size, _, _ = struct.unpack_from('<IIQQQQQQ', library, phoff + i * 56)
        if kind == 1:
            machine.mem_write(address, library[offset:offset + size])
    heap_start, heap_end = 0x21000000, 0x25000000
    machine.mem_map(0x20000000, 0x1000000)
    machine.mem_map(heap_start, heap_end - heap_start)
    machine.mem_map(0x40000000, 0x200000)
    machine.mem_map(0x50000000, 0x1000)
    machine.reg_write(UC_ARM64_REG_CPACR_EL1, 0x300000)
    factory, stream, buffer = 0x20010000, None, 0x20020000
    heap_cursor = heap_start
    reads = []
    references = {}

    def put32(address, value):
        machine.mem_write(address, struct.pack('<I', value & 0xffffffff))

    def put64(address, value):
        machine.mem_write(address, struct.pack('<Q', value))

    def get32(address):
        return struct.unpack('<I', machine.mem_read(address, 4))[0]

    def allocate(size):
        nonlocal heap_cursor
        if size > 1024 * 1024:
            raise ValueError(f'Unexpected native allocation: {size} bytes')
        address = heap_cursor
        heap_cursor += (max(16, size) + 15) & ~15
        if heap_cursor > heap_end:
            raise ValueError('Native trace exceeded its heap limit')
        return address

    def external(uc, address, _size, _data):
        a0, a1, a2 = [uc.reg_read(reg) for reg in (UC_ARM64_REG_X0, UC_ARM64_REG_X1, UC_ARM64_REG_X2)]
        if address in (0x11a1b40, 0x11a1900):
            uc.reg_write(UC_ARM64_REG_X0, allocate(a0))
        elif address in (0x11a19b0, 0x11a1990):
            if a2 > 4 * 1024 * 1024:
                raise ValueError('Native copy exceeded its limit')
            uc.mem_write(a0, bytes(uc.mem_read(a1, a2)))
            uc.reg_write(UC_ARM64_REG_X0, a0)
        elif address == 0x11a19a0:
            if a2 > 4 * 1024 * 1024:
                raise ValueError('Native memset exceeded its limit')
            uc.mem_write(a0, bytes([a1 & 255]) * a2)
            uc.reg_write(UC_ARM64_REG_X0, a0)
        elif address in (0x11a1980, 0x11a2770):
            limit = min(a1 if address == 0x11a2770 else 65536, 65536)
            value = bytes(uc.mem_read(a0, limit)).split(b'\0', 1)[0]
            uc.reg_write(UC_ARM64_REG_X0, len(value))
        elif address == 0x11a2360:
            uc.reg_write(UC_ARM64_REG_X0, 1700000000)
        elif address in (0xe17e08, 0xe17da0):
            table = (a0 & 0xffffffff) // 1000000
            if not 1 <= table <= 156 or (address == 0xe17da0 and table != a1):
                uc.reg_write(UC_ARM64_REG_X0, 0)
                uc.reg_write(UC_ARM64_REG_PC, uc.reg_read(UC_ARM64_REG_LR))
                return
            if a0 not in references:
                references[a0] = allocate(0x1000)
                put32(references[a0] + 8, a0)
            result = references[a0]
            uc.reg_write(UC_ARM64_REG_X0, result)
        uc.reg_write(UC_ARM64_REG_PC, uc.reg_read(UC_ARM64_REG_LR))

    for address in (0x11a1b40, 0x11a1900, 0x11a1b30, 0x11a18f0,
                    0x11a19b0, 0x11a1990, 0x11a19a0, 0x11a1980,
                    0x11a2770, 0x11a2360, 0xe17e08, 0xe17da0):
        machine.hook_add(UC_HOOK_CODE, external, begin=address, end=address)

    def observe(uc, address, _size, _data):
        if uc.reg_read(UC_ARM64_REG_X0) != stream:
            return
        if READERS[address] == 'Bytes' and uc.reg_read(UC_ARM64_REG_X1) & 0x80000000:
            return
        offset = get32(stream + 0x14)
        packed_flag = (READERS[address] == 'Boolean' and get32(stream + 0x1c) != 0
                       and offset == len(payload))
        empty_bytes = (READERS[address] == 'Bytes' and uc.reg_read(UC_ARM64_REG_X1) == 0
                       and offset == len(payload))
        if offset >= len(payload) and not packed_flag and not empty_bytes:
            raise ValueError(f'Native decoder reached the end at offset {offset}')
        record = {'type': READERS[address], 'offset': offset, 'bit': get32(stream + 0x1c),
                  'caller': hex(uc.reg_read(UC_ARM64_REG_LR) - 4), 'reader': hex(address)}
        if address == 0x5b6714:
            record['length'] = uc.reg_read(UC_ARM64_REG_X1) & 0xffffffff
        reads.append(record)

    for address in READERS:
        machine.hook_add(UC_HOOK_CODE, observe, begin=address, end=address)

    for position in range(0x8548, 0x8548 + 1598736, 24):
        offset, info, addend = struct.unpack_from('<QQq', library, position)
        if info & 0xffffffff == 1027:
            put64(offset, addend)

    def run(address, x0, x1=0):
        machine.reg_write(UC_ARM64_REG_X0, x0)
        machine.reg_write(UC_ARM64_REG_X1, x1)
        machine.reg_write(UC_ARM64_REG_SP, 0x401fff00)
        machine.reg_write(UC_ARM64_REG_LR, 0x50000000)
        machine.emu_start(address, 0x50000000, timeout=15000000, count=20000000)
        if machine.reg_read(UC_ARM64_REG_PC) != 0x50000000:
            raise ValueError('Native trace exceeded its execution limit')
        return machine.reg_read(UC_ARM64_REG_X0)

    message = run(0xf20430, factory, packet_id)
    common = {'id': packet_id, 'version': version, 'librarySha256': digest,
              'payloadSha256': hashlib.sha256(payload).hexdigest(),
              'resourceLookups': 'inert references for valid tables; no CSV data loaded'}
    if not message:
        return {**common, 'status': 'unsupported', 'prefixBytes': 0,
                'tailBytes': len(payload), 'reads': []}
    stream = message + 8
    vtable = struct.unpack('<Q', machine.mem_read(message, 8))[0]
    decoder = struct.unpack('<Q', machine.mem_read(vtable + 0x18, 8))[0]
    put32(message + 0x88, version)
    machine.mem_write(buffer, payload)
    put64(stream + 0x30, buffer)
    put64(stream + 0x38, buffer)
    put32(stream + 0x28, len(payload))
    put32(stream + 0x18, len(payload))
    put32(stream + 0x14, 0)
    run(decoder, message)
    prefix = get32(stream + 0x14)
    if prefix > len(payload):
        raise ValueError('Native decoder exceeded the payload')
    return {**common, 'status': 'complete' if prefix == len(payload) else 'partial',
            'decoder': hex(decoder), 'decoderReturned': True,
            'prefixBytes': prefix, 'tailBytes': len(payload) - prefix, 'reads': reads}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('packet', help='Body filename, or - for stdin')
    parser.add_argument('library', type=Path)
    parser.add_argument('output', help='Trace filename, or - for stdout')
    parser.add_argument('--id', type=int, default=24101)
    parser.add_argument('--version', type=int, default=0)
    args = parser.parse_args()
    try:
        payload = sys.stdin.buffer.read(3 * 1024 * 1024 + 1) if args.packet == '-' else Path(args.packet).read_bytes()
        result = trace_packet(args.library.read_bytes(), payload, args.id, args.version)
        if args.output == '-':
            print(json.dumps(result, separators=(',', ':')))
            return 0
        import os
        descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            json.dump(result, output, separators=(',', ':'))
            output.write('\n')
    except Exception as error:
        print(f'Native packet trace: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
