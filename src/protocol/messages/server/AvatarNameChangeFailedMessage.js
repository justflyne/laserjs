'use strict';

function decode(reader, fields) {
    fields.errorCode = reader.int();
}

module.exports = { name: 'AvatarNameChangeFailedMessage', messageType: 20205, messageVersion: 0,
    direction: 'server', nativeDecoder: '0xf3bf50', decode,
    exportFields: [{ type: 'Int', name: 'errorCode' }] };
