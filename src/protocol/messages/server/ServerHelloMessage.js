'use strict';

function decode(reader, fields) {
    const token = reader.bytes(4096);
    if (!token?.length) throw new Error('ServerHello has no session token');
    fields.tokenLength = token.length;
    fields.tokenHex = token.toString('hex');
}

const exportFields = [{ type: 'Bytes', name: 'ServerHello.challenge' }];

module.exports = { name: 'ServerHelloMessage', messageType: 20100, messageVersion: 0,
    direction: 'server', nativeDecoder: '0x79f4e0', decode, exportFields };
