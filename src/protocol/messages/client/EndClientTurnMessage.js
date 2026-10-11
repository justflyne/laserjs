'use strict';

const { PacketWriter } = require('../../protocol');

function encode({ tick, commands = [] }) {
    if (!Number.isInteger(tick) || tick < 1 || tick > 0x7fffffff) throw new Error('Invalid home tick');
    if (!Array.isArray(commands) || commands.length > 512) throw new Error('Invalid command list');
    const writer = new PacketWriter().writeBoolean(false).writeVInt(tick).writeVInt(commands.length);
    for (const command of commands) {
        if (![201, 221, 530].includes(command.type)) throw new Error(`Unsupported home command ${command.type}`);
        if (!Number.isInteger(command.executionTick) || command.executionTick < 0 || command.executionTick >= tick)
            throw new Error('Command execution tick must precede EndClientTurn tick');
        writer.writeVInt(command.type);
        if (command.type === 530) {
            if (!Number.isInteger(command.age) || command.age < 1 || command.age > 100)
                throw new Error('Age must be an integer in 1..100');
            const id = command.id ?? [0, 0];
            if (!Array.isArray(id) || id.length !== 2 || !id.every(part => Number.isInteger(part)
                && part >= 0 && part <= 0xffffffff)) throw new Error('Invalid command ID');
            writer.writeVInt(command.executionTick).writeVInt(command.executionTick)
                .writeVInt(id[0] | 0).writeVInt(id[1] | 0).writeInt(command.age);
            continue;
        }
        if (command.type === 201) writer.writeString(command.avatarName).writeVInt(command.changeNameCost).writeString(command.string_30);
        else writer.writeBoolean(command.muted);
        writer.writeVInt(command.sequence).writeVInt(command.executionTick).writeVInt(command.executionTick)
            .writeVInt(command.id[0] | 0).writeVInt(command.id[1] | 0);
    }
    writer.bytes(null);
    return { payload: writer.finish(), fields: { tick, commands, flag_a8: false, bytes_a0: null } };
}

module.exports = { name: 'EndClientTurnMessage', messageType: 14102, messageVersion: 0,
    direction: 'client', nativeEncoder: '0xf4edc4', encode };
