'use strict';

function decode(reader, fields) {
    fields.accountId = reader.long();
    fields.homeId = reader.long();
    fields.loginToken = reader.string();
    if (!reader.remaining) return;
    fields.platformIdA = reader.string();
    fields.platformIdB = reader.string();
    fields.serverMajor = reader.int();
    fields.serverMinor = reader.int();
    fields.serverBuild = reader.int();
    fields.serverEnvironment = reader.string();
}

const exportFields = [
    ['Long', 'accountId'], ['Long', 'homeId'], ['String', 'passToken'],
    ['String', 'platformId1'], ['String', 'platformId2'], ['Int', 'serverMajor'],
    ['Int', 'serverMinor'], ['Int', 'serverBuild'], ['String', 'serverEnvironment'],
].map(([type, name]) => ({ type, name }));

module.exports = { name: 'LoginOkMessage', messageType: 20104, messageVersion: 1,
    direction: 'server', nativeDecoder: '0xf2ae50', decode, exportFields };
