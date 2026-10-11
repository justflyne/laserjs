'use strict';

function decode(reader, fields) {
    fields.flag_90 = reader.boolean();
    fields.errorCode = reader.int();
    fields.message = reader.string();
}

module.exports = { name: 'AvatarNameCheckResponseMessage', messageType: 20300, messageVersion: 0,
    direction: 'server', nativeDecoder: '0xf3c1e4', decode };
