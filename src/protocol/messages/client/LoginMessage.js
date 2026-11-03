'use strict';

const { BinaryWriter } = require('../../protocol');

function encode(config) {
    const version = config.loginMessageVersion ?? 10;
    if (config.host === '144.31.166.185' && Number(config.port) === 1111) {
        // Requested v30.242 prefix only; the stock formatVersion=1 Login has more fields.
        const fields = {
            accountId: [config.hi, config.lo], token: config.token,
            major: config.major, formatVersion: 1, minor: config.minor, hash: config.hash,
        };
        const payload = new BinaryWriter().long(...fields.accountId).string(fields.token)
            .int(fields.major).int(fields.formatVersion).int(fields.minor).string(fields.hash).finish();
        return { payload, fields, version };
    }
    if (config.loginPayload) return { payload: Buffer.from(config.loginPayload), version,
        fields: { format: 'supplied plaintext Login payload', messageVersion: version } };
    const runtime = config.loginRuntime || {};
    const apkSize = config.nb ? config['nb-apkSize'] ?? null : null;
    const fields = {
        accountId: [config.hi, config.lo], token: config.token,
        major: config.major, formatVersion: 1, minor: config.minor, hash: config.hash,
        deviceModel: config.deviceModel, dataReference: runtime.dataReference || [1, 0],
        locale: config.locale, androidVersion: config.androidVersion, androidClient: true,
        deviceString: '', androidId: config.androidId, runtimeFlag: runtime.flag ?? false,
        emptyDeviceString: '', runtimeInt: runtime.integer ?? 0,
        clientMode: apkSize === null ? 2 : apkSize ^ 4330295,
        appVersion: config.appVersion ?? `${config.major}.${config.minor}`,
        string148: runtime.string148 ?? '', string158: runtime.string158 ?? '',
        value168: runtime.value168 ?? 0,
        string178: runtime.string178 ?? '', string188: runtime.string188 ?? '',
        string198: runtime.string198 ?? '',
        blob170Hex: config.loginBlob ? config.loginBlob.toString('hex') : null,
        flag1a8: runtime.flag1a8 ?? false,
        tailStrings: Array.from({ length: 6 }, (_, i) => runtime.tailStrings?.[i] ?? ''),
        inheritedStrings: ['', ''],
        schema: 'libg.so v69.230 Login::encode at 0xf29d0c',
        messageVersion: version,
        runtimeComplete: false,
    };
    const out = new BinaryWriter().long(...fields.accountId).string(fields.token)
        .int(fields.major).int(fields.formatVersion).int(fields.minor).string(fields.hash)
        .string(fields.deviceModel).reference(...fields.dataReference)
        .string(fields.locale).string(fields.androidVersion).bool(true)
        .string(fields.deviceString).string(fields.androidId).bool(fields.runtimeFlag)
        .string(fields.emptyDeviceString).int(fields.runtimeInt).vint(fields.clientMode)
        .string(fields.appVersion).string(fields.string148).string(fields.string158)
        .vint(fields.value168).string(fields.string178).string(fields.string188)
        .string(fields.string198).bytes(config.loginBlob).bool(fields.flag1a8);
    for (const value of [...fields.tailStrings, ...fields.inheritedStrings]) out.string(value);
    return { payload: out.finish(), fields, version };
}

module.exports = { name: 'LoginMessage', messageType: 10101, messageVersion: 10,
    direction: 'client', encode };
