'use strict';

const { PacketWriter } = require('../../protocol');

function encode({ name, initial = true }) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Account name is empty');
    if (Buffer.byteLength(name, 'utf8') > 60) throw new Error('Account name exceeds 60 UTF-8 bytes');
    if (/[\x00-\x1f\x7f]/u.test(name)) throw new Error('Account name contains control characters');
    if (typeof initial !== 'boolean') throw new Error('Initial name flag must be a Boolean');
    return { payload: new PacketWriter().writeString(name).writeBoolean(initial).finish(),
        fields: { name, initial } };
}

module.exports = { name: 'ChangeAvatarNameMessage', messageType: 10212, messageVersion: 0,
    direction: 'client', nativeEncoder: '0xf3c2b8', encode };
