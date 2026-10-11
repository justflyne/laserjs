'use strict';

function decode(reader, fields) {
    fields.field_90 = reader.vint();
    fields.hasObject = reader.boolean();
    if (fields.hasObject) {
        fields.reference_98 = reader.reference();
        fields.decoded = false;
        return;
    }
    fields.flag_a8 = reader.boolean();
    fields.field_ac = reader.vint();
    if (fields.field_ac >= 1) fields.field_b0 = reader.vint();
    fields.flag_b4 = reader.boolean();
}

const exportFields = [{ type: 'VInt', name: 'ServerMessage24399.field_90' }];

module.exports = { name: 'ServerMessage24399', messageType: 24399, messageVersion: 0,
    direction: 'server', nativeDecoder: '0xf30b04', decode, exportFields };
