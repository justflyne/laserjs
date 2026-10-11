'use strict';

function decode(reader, fields) {
    fields.port = reader.vint();
    fields.host = reader.string();
    const header = reader.bytes(10);
    const key = reader.bytes(80);
    fields.headerSize = header?.length ?? 0;
    fields.headerHex = header?.toString('hex') ?? '';
    fields.encryptionKeyHex = key?.toString('hex') ?? '';
    if (header?.length === 10) {
        fields.sessionId = [header.readUInt32BE(0), header.readUInt32BE(4)];
        fields.unknownShort = header.readUInt16BE(8);
    }
    if (!Number.isInteger(fields.port) || fields.port < 1 || fields.port > 65535
        || header?.length !== 10 || fields.sessionId.every(part => part === 0)
        || (key?.length && key.length !== 80) || reader.remaining !== 0)
        throw new Error('Invalid UDP spectator connection info');
}

module.exports = { name: 'UdpConnectionInfoMessage', messageType: 24112, messageVersion: 0,
    direction: 'server', nativeEncoder: '0xf82e2c', nativeDecoder: '0xf82e80', decode };
