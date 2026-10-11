'use strict';

function decode(reader, fields) {
    const command = fields.command = { type: reader.vint() };
    if (command.type === 221) {
        command.name = 'LogicTeamChatMuteStateChangedCommand';
        command.muted = reader.boolean();
    } else if (command.type === 201) {
        command.name = 'LogicChangeAvatarNameCommand';
        command.avatarName = reader.string(60);
        command.changeNameCost = reader.vint();
        command.string_30 = reader.string();
    } else {
        fields.decoded = false;
        return;
    }
    command.sequence = reader.vint();
    command.field_10 = reader.vint();
    command.field_0c = reader.vint();
    command.id = [reader.vint() >>> 0, reader.vint() >>> 0];
}

module.exports = { name: 'AvailableServerCommandMessage', messageType: 24111, messageVersion: 0,
    direction: 'server', nativeDecoder: '0xf4ad90', decode };
