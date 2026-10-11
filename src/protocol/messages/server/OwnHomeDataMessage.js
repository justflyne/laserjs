'use strict';

const { extractScFiles } = require('../../protocol');

const exportFields = [
    ...['OwnHomeData.field_a0', 'OwnHomeData.field_a4',
        ...['00', '04', '08', '0c', '10', '14', '1c'].map(offset => `home.state.field_${offset}`)]
        .map(name => ({ type: 'VInt', name })),
    { type: 'DataReference', name: 'home.state.reference_28' },
    { type: 'DataReference', name: 'home.state.reference_30' },
];

function decode(reader, fields) {
    fields.decoded = false;
    fields.scFiles = extractScFiles(reader.buffer);
    for (const field of exportFields) {
        if (!reader.remaining) return;
        fields[field.name] = field.type === 'DataReference' ? reader.reference() : reader.vint();
    }
}

module.exports = { name: 'OwnHomeDataMessage', messageType: 24101, messageVersion: 0,
    direction: 'server', nativeDecoder: '0xf64d70', decode, exportFields };
