'use strict';

const { list } = require('../../protocol');

function decode(reader, fields) {
    fields.errorCode = reader.vint();
    fields.reason = reader.vint();
    fields.values = list(reader, 'team error values', r => r.vint());
    fields.messages = list(reader, 'team error strings', r => r.string());
}

module.exports = { name: 'TeamErrorMessage', messageType: 24129, messageVersion: 0,
    direction: 'server', nativeDecoder: '0xf345d0', decode };
