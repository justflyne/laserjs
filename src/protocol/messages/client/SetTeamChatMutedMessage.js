'use strict';

const { PacketWriter } = require('../../protocol');

function encode({ disabled = false } = {}) {
    if (typeof disabled !== 'boolean') throw new Error('Chat mute state must be a Boolean');
    return { payload: new PacketWriter().writeBoolean(disabled).finish(), fields: { disabled } };
}

module.exports = { name: 'SetTeamChatMutedMessage', messageType: 14778, messageVersion: 0,
    direction: 'client', nativeEncoder: '0xf68860', encode };
