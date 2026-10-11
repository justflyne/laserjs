'use strict';

function encode() {
    return { payload: Buffer.alloc(0), fields: {} };
}

module.exports = { name: 'KeepAliveMessage', messageType: 10108, messageVersion: 0,
    direction: 'client', nativeEncoder: '0xae1768', encode };
