'use strict';

const { PacketWriter } = require('../../protocol');

function encode({ message }) {
    if (typeof message !== 'string' || !message.trim()) throw new Error('Chat message is empty');
    if (Buffer.byteLength(message) > 4096) throw new Error('Chat message exceeds 4096 UTF-8 bytes');
    return { payload: new PacketWriter().writeString(message).finish(), fields: { message } };
}

module.exports = { name: 'TeamChatMessage', messageType: 14049, messageVersion: 0,
    direction: 'client', nativeEncoder: '0xf3405c', encode };
