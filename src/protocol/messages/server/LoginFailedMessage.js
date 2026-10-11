'use strict';

const { inflateSync } = require('node:zlib');

function decode(reader, fields) {
    fields.errorCode = reader.int();
    for (const name of ['fingerprint', 'redirect', 'assetUrl', 'updateUrl', 'message']) {
        if (reader.remaining === 0) return;
        fields[name] = reader.string();
    }
    if (reader.remaining === 0) return;
    fields.secondsLeft = reader.int();
    fields.booleanFlag = (reader.byte() & 1) !== 0;
    if (reader.remaining === 0) return;
    const packed = reader.bytes();
    if (packed) {
        if (packed.length < 4) throw new Error('Compressed fingerprint lacks its length');
        const expected = packed.readUInt32LE(0);
        if (expected > 8 * 1024 * 1024) throw new Error('Fingerprint exceeds 8 MiB');
        const unpacked = inflateSync(packed.subarray(4), { maxOutputLength: 8 * 1024 * 1024 });
        if (unpacked.length !== expected) throw new Error('Fingerprint size mismatch');
        const fingerprint = JSON.parse(unpacked.toString('utf8'));
        fields.fingerprintData = { sha: fingerprint.sha, version: fingerprint.version,
            files: Array.isArray(fingerprint.files) ? fingerprint.files.length : undefined };
    }
    if (reader.remaining === 0) return;
    const count = reader.int();
    if (count < 0) { fields.assetUrls = null; return; }
    if (count > 100) throw new Error(`Too many asset URLs: ${count}`);
    fields.assetUrls = Array.from({ length: count }, () => reader.string());
}

module.exports = { name: 'LoginFailedMessage', messageType: 20103, messageVersion: 11,
    direction: 'server', nativeDecoder: '0xf293bc', decode };
