'use strict';

const { PacketWriter, playerId } = require('../../protocol');

function encode({ targetId, brawlTv = false }) {
    if (typeof brawlTv !== 'boolean') throw new TypeError('brawlTv must be a boolean');
    const id = playerId(targetId);
    return { payload: new PacketWriter().writeLong(...id).writeBoolean(brawlTv).finish(),
        fields: { targetId: id, brawlTv } };
}

module.exports = { name: 'StartSpectateMessage', messageType: 14104, messageVersion: 0,
    direction: 'client', nativeEncoder: '0xf6a130', nativeDecoder: '0xf6a164', encode };
