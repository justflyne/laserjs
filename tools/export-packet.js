#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { savePacketExport } = require('../src/protocol/messageFactory');
const { PacketWriter } = require('../src/protocol/protocol');

function main(args) {
    if (args.includes('--help') || args.length === 0) {
        console.log(`Экспорт расшифрованного тела пакета в HEX и JS:
  node tools/export-packet.js dumps/24101.bin
  node tools/export-packet.js dumps/24101.bin --native ../v69.230_arm64.so
  node tools/export-packet.js dumps/24101.bin --trace dumps/24101.trace.json
  node tools/export-packet.js packet.bin --id 24101 --out dumps/24101.bin

Сборка тела из редактируемых writeVInt/writeInt/writeString/writeRaw:
  node tools/export-packet.js --build dumps/24101.js dumps/24101.rebuilt.bin

--native требует Python 3 и unicorn; выполняет полный нативный декодер пакета.
HEX и JS всегда проверяются побайтовой обратной сборкой. TCP-заголовок не добавляется.`);
        return;
    }
    if (args[0] === '--build') {
        if (args.length !== 3) throw new Error('--build requires a JS builder and an output .bin');
        const builder = require(path.resolve(args[1]));
        if (typeof builder.encode !== 'function') throw new Error('Builder must export encode(stream)');
        const stream = new PacketWriter();
        builder.encode(stream);
        const body = stream.finish();
        fs.writeFileSync(args[2], body, { mode: 0o600 });
        console.log(`Built ${builder.id ?? '?'}: ${body.length} bytes → ${args[2]}`);
        return;
    }
    const file = path.resolve(args[0]);
    let id = /^\d+\.bin$/.test(path.basename(file)) ? Number(path.basename(file, '.bin')) : null;
    let out = file, library = null, traceFile = null, version = 0;
    for (let i = 1; i < args.length; i++) {
        const option = args[i];
        const value = args[++i];
        if (value === undefined) throw new Error(`Missing value for ${option}`);
        switch (option) {
            case '--id': id = Number(value); break;
            case '--out': out = path.resolve(value); break;
            case '--native': library = path.resolve(value); break;
            case '--trace': traceFile = path.resolve(value); break;
            case '--version': version = Number(value); break;
            default: throw new Error(`Unknown option ${option}`);
        }
    }
    if (!Number.isInteger(id) || id < 0 || id > 65535) throw new Error('Specify the packet ID with --id');
    if (library && traceFile) throw new Error('Choose --native or --trace');
    const body = fs.readFileSync(file);
    if (library) {
        traceFile = `${out.endsWith('.bin') ? out.slice(0, -4) : out}.trace.json`;
        fs.mkdirSync(path.dirname(traceFile), { recursive: true });
        fs.rmSync(traceFile, { force: true });
        const analysisPath = path.resolve(__dirname, '..', '.analysis-python');
        const pythonPath = [analysisPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
        const result = spawnSync('python3', [path.join(__dirname, 'trace-ohd.py'), file, library, traceFile,
            '--id', String(id), '--version', String(version)],
            { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
                env: { ...process.env, PYTHONPATH: pythonPath } });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(result.stderr.trim() || 'Native tracing failed');
    }
    const trace = traceFile ? JSON.parse(fs.readFileSync(traceFile, 'utf8')) : null;
    const exported = savePacketExport(out, id, body, trace, { version });
    console.log(`${exported.name}: ${exported.length} bytes; ${exported.typedCalls} typed calls; ${exported.rawBytes} raw bytes`);
    console.log(`Parse: ${exported.parseStatus}; ${exported.unreadBytes} unread bytes`);
    console.log(`HEX: ${exported.files.hex}\nJS:  ${exported.files.source}\nJSON: ${exported.files.json}\nRound-trip: exact byte match`);
}

try { main(process.argv.slice(2)); }
catch (error) { console.error(`Packet export: ${error.message}`); process.exitCode = 1; }
