'use strict';

function decode(reader, fields) {
    fields.listType = reader.int();
    fields.flag_9c = reader.boolean();
    fields.flag_9d = reader.boolean();
    const count = reader.int();
    if (count < -1 || count > 10000) throw new Error(`Invalid friend count: ${count}`);
    fields.friendCount = count;
    if (count === -1) fields.friends = null;
    else if (count === 0) fields.friends = [];
    else fields.decoded = false;
}

const exportFields = [{ type: 'Int', name: 'FriendList.listType' }];

module.exports = { name: 'FriendListMessage', messageType: 20105, messageVersion: 0,
    direction: 'server', nativeDecoder: '0xf46810', decode, exportFields };
