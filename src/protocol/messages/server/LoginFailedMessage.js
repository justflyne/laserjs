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
    fields.booleanFlag = reader.boolean();
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
    if (count < 0) fields.assetUrls = null;
    else {
        if (count > 100) throw new Error(`Too many asset URLs: ${count}`);
        fields.assetUrls = Array.from({ length: count }, () => reader.string());
    }
    if (reader.remaining === 0) return;
    fields.value09c = reader.int();
    fields.value098 = reader.int();
    fields.string0d0 = reader.string();
    fields.value0f8 = reader.int();
    fields.flag0c9 = reader.boolean();
    fields.flag0e8 = reader.boolean();
    if (reader.remaining === 0) return;
    fields.string100 = reader.string();
    fields.value110 = reader.vint();
    fields.string118 = reader.string();
    fields.struct128Present = reader.boolean();
    if (fields.struct128Present || reader.remaining === 0) return;
    for (const offset of ['130', '138', '140', '148']) {
        const present = fields[`string${offset}Present`] = reader.boolean();
        fields[`string${offset}`] = present ? reader.string() : null;
    }
}

module.exports = { name: 'LoginFailedMessage', messageType: 20103, messageVersion: 11,
    direction: 'server', nativeDecoder: '0xf293bc', decode };
