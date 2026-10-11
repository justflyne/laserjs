'use strict';

const { PacketWriter } = require('../../protocol');
const { parseRoom } = require('../../protocol');

function encode({ code, teamId, mode = 1 }) {
    const room = parseRoom(code ?? teamId?.join('-'));
    const payload = new PacketWriter().writeVInt(room.id[0]).writeVInt(room.id[1])
        .writeVInt(mode).finish();
    return { payload, fields: { code: room.code, teamId: room.id, mode } };
}

module.exports = { name: 'TeamJoinMessage', messageType: 14358, messageVersion: 0,
    direction: 'client', nativeEncoder: '0xf377fc', encode };
