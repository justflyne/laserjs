'use strict';

const { PacketWriter } = require('../../protocol');

function encode({ mapId = [0, 0], teamType = 0, eventSlot = -1, field_98 = -1 } = {}) {
    const payload = new PacketWriter().writeLong(...mapId).writeVInt(teamType)
        .writeVInt(eventSlot).writeVInt(field_98).finish();
    return { payload, fields: { mapId, teamType, eventSlot, field_98 } };
}

module.exports = { name: 'TeamCreateMessage', messageType: 12541, messageVersion: 0,
    direction: 'client', nativeEncoder: '0xf34324', encode };
