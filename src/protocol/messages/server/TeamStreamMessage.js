'use strict';

const { count, vlong, displayData } = require('../../protocol');

function decodeEntry(reader, entry) {
    switch (entry.type) {
        case 2:
            entry.message = reader.string();
            entry.flag_38 = reader.boolean();
            break;
        case 3:
            entry.string_30 = reader.string();
            entry.string_40 = reader.string();
            entry.field_38 = reader.vint();
            entry.displayData = displayData(reader);
            break;
        case 4:
            entry.field_48 = reader.vint();
            entry.field_4c = reader.vint();
            if (reader.boolean()) {
                entry.targetId = vlong(reader);
                entry.targetName = reader.string();
            }
            entry.field_40 = reader.vint();
            entry.field_44 = reader.raw(2).readUInt16BE();
            break;
        case 5:
            entry.field_2c = reader.vint();
            entry.id_30 = reader.long();
            entry.flag_38 = reader.boolean();
            entry.string_48 = reader.string();
            entry.string_40 = reader.string();
            entry.string_50 = reader.string();
            for (const offset of ['60', '64', '68']) entry[`field_${offset}`] = reader.vint();
            break;
        case 6:
            entry.reference_30 = reader.reference();
            break;
        case 8:
            entry.reference_30 = reader.reference();
            entry.id_38 = reader.boolean() ? reader.long() : null;
            entry.string_40 = reader.string();
            entry.field_48 = reader.vint();
            entry.field_4c = reader.vint();
            break;
        case 77:
            entry.id_30 = reader.long();
            for (const offset of ['38', '3c', '40']) entry[`field_${offset}`] = reader.vint();
            break;
    }
}

function decode(reader, fields) {
    fields.teamId = vlong(reader);
    const size = count(reader, 'team stream', 1000, true);
    fields.entryCount = size;
    fields.entries = size === -1 ? null : [];
    for (let i = 0; i < size; i++) {
        const type = reader.vint();
        if (![2, 3, 4, 5, 6, 8, 77].includes(type)) {
            fields.unknownEntryType = type;
            fields.decoded = false;
            return;
        }
        const entry = { type, id: vlong(reader), accountId: vlong(reader), name: reader.string(),
            field_20: reader.vint(), field_24: reader.vint(), flag_28: reader.boolean() };
        decodeEntry(reader, entry);
        fields.entries.push(entry);
    }
}

module.exports = { name: 'TeamStreamMessage', messageType: 24131, messageVersion: 0,
    direction: 'server', nativeDecoder: '0xf37b10', decode };
