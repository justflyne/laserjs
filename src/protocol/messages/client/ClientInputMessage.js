'use strict';

function encode({ tick = 0, acknowledgedTick = -1 } = {}) {
    if (!Number.isInteger(tick) || tick < 0 || tick > 16383
        || !Number.isInteger(acknowledgedTick) || acknowledgedTick < -1 || acknowledgedTick > 16382)
        throw new RangeError('Spectator ticks must fit the v69 input header');
    const payload = Buffer.alloc(12);
    let offset = 0;
    for (const [value, bits] of [[tick, 14], [acknowledgedTick + 1, 14], [0, 10], [0, 13],
        [0, 10], [0, 10], [0, 10], [0, 10], [0, 5]]) {
        for (let bit = 0; bit < bits; bit++, offset++)
            payload[offset >>> 3] |= ((value >>> bit) & 1) << (offset & 7);
    }
    return { payload, fields: { tick, acknowledgedTick, inputCount: 0 } };
}

module.exports = { name: 'ClientInputMessage', messageType: 10555, messageVersion: 0,
    direction: 'client', nativeEncoder: '0xf47a74', nativeDecoder: '0xf47bf4', encode };
