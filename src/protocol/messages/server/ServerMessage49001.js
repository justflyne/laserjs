'use strict';

const exportFields = ['00', '04', '08', '0c', '10', '14', '18']
    .map(offset => ({ type: 'VInt', name: `ServerMessage49001.field_${offset}` }));

function decode(reader, fields) {
    for (const offset of ['00', '04', '08', '0c', '10', '14', '18'])
        fields[`field_${offset}`] = reader.vint();
    fields.flag_1c = reader.boolean();
    fields.flag_1d = reader.boolean();
    fields.flag_30 = reader.boolean();
    fields.field_20 = reader.vint();
    fields.string_28 = reader.string();
    fields.bytes_40 = reader.bytes()?.toString('hex') ?? null;
    fields.bytes_50 = reader.bytes()?.toString('hex') ?? null;
    fields.field_5c = reader.vint();
    fields.field_60 = reader.vint();
    fields.hasBytes68 = reader.boolean();
    if (fields.hasBytes68) fields.bytes_68 = reader.bytes()?.toString('hex') ?? null;
    if (fields.flag_30) {
        fields.field_34 = reader.vint();
        fields.string_38 = reader.string();
    }
}

module.exports = { name: 'ServerMessage49001', messageType: 49001, messageVersion: 0,
    direction: 'server', nativeDecoder: '0xadee34', decode, exportFields };
