'use strict';

const { list, count, teamMember, teamInvite, playerMap } = require('../../protocol');
const { roomCode, decimalRoomId } = require('../../protocol');

function decode(reader, fields) {
    const team = fields.team = { type: reader.vint(), flag_04: reader.boolean(),
        capacity: reader.vint(), id: reader.long() };
    team.code = roomCode(team.id);
    team.decimalId = decimalRoomId(team.id);
    team.field_18 = reader.vint();
    team.flag_05 = reader.boolean();
    team.flag_06 = reader.boolean();
    team.field_1c = reader.vint();
    team.eventSlot = reader.vint();
    team.field_60 = reader.vint();
    team.location = reader.reference();
    team.map = reader.boolean() ? playerMap(reader) : null;
    team.members = list(reader, 'team members', teamMember, 100);
    team.invites = list(reader, 'team invites', teamInvite, 100);
    const requests = count(reader, 'join requests', 100);
    team.joinRequestCount = requests;
    if (requests) {
        fields.decoded = false;
        return;
    }
    team.joinRequests = [];
    team.disabledBots = list(reader, 'disabled bots', r => r.vint(), 100);
    team.values_58 = list(reader, 'team values', r => [r.vint(), r.vint()]);
    team.flag_48 = reader.boolean();
    team.enabledChat = reader.boolean();
    team.flag_4a = reader.boolean();
    team.modifiers = list(reader, 'modifiers', r => r.vint(), 100);
}

module.exports = { name: 'TeamMessage', messageType: 24124, messageVersion: 0,
    direction: 'server', nativeDecoder: '0xf368f0', decode };
