'use strict';

const { BinaryWriter } = require('../../protocol');

function encode(config) {
    const fields = { protocolVersion: config.protocolVersion, cryptoVersion: config.cryptoVersion,
        major: config.major, build: config.build, minor: config.minor, hash: config.hash,
        deviceType: 2, appStore: 2 };
    const payload = new BinaryWriter().int(fields.protocolVersion).int(fields.cryptoVersion)
        .int(fields.major).int(fields.build).int(fields.minor).string(fields.hash)
        .int(fields.deviceType).int(fields.appStore).finish();
    return { payload, fields };
}

module.exports = { name: 'ClientHelloMessage', messageType: 10100, messageVersion: 0,
    direction: 'client', encode };
