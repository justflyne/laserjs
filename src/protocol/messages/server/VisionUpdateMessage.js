'use strict';

const { PacketReader } = require('../../protocol');

function readVision(reader, modern) {
    const fields = { tick: reader.vint(), handledInputs: reader.vint(),
        unknownVInt160: reader.vint(), viewers: reader.vint(), format: modern ? 'v69' : 'legacy' };
    if (modern) {
        fields.unknownVInt168 = reader.vint();
        fields.unknownVInt188 = reader.vint();
    }
    fields.flag172 = reader.boolean();
    if (modern) {
        fields.flag173 = reader.boolean();
        if (fields.flag173) fields.unknownVInt176 = reader.vint();
        fields.flag3 = reader.boolean();
        if (fields.flag3) {
            fields.unknownVInt184 = reader.vint();
            fields.unknownVInt180 = reader.vint();
        }
    }
    const vision = reader.bytes(900000);
    if (vision === null || reader.remaining !== 0 || fields.tick < 0 || fields.tick > 16382
        || fields.handledInputs < -1 || fields.viewers < 0)
        throw new Error('Invalid spectator vision update');
    fields.visionSize = vision.length;
    return fields;
}

function decode(reader, fields) {
    const payload = reader.buffer.subarray(reader.offset);
    let parsed;
    try { parsed = readVision(new PacketReader(payload), true); }
    catch { parsed = readVision(new PacketReader(payload), false); }
    reader.raw(payload.length);
    Object.assign(fields, parsed);
}

module.exports = { name: 'VisionUpdateMessage', messageType: 24109, messageVersion: 0,
    direction: 'server', nativeEncoder: '0xf49494', nativeDecoder: '0xf49700', decode };
