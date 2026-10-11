'use strict';

module.exports = { name: 'TeamLeftMessage', messageType: 24125, messageVersion: 0,
    direction: 'server', nativeDecoder: '0xf35c58',
    decode: (reader, fields) => { fields.reason = reader.int(); },
    exportFields: [{ type: 'Int', name: 'reason' }] };
