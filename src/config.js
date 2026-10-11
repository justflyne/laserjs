'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_BANNER } = require('./logging');
const { playerId } = require('./protocol/protocol');

const ROOT = path.resolve(__dirname, '..');
const DEFAULTS = Object.freeze({
    host: 'game.brawlstarsgame.com', port: 9339, timeoutMs: 15000,
    major: 69, minor: 230, build: 0, protocolVersion: 2, cryptoVersion: 59,
    loginMessageVersion: 10,
    hash: '', serverPublicKey: '5f4bfa1dc7b58fac0611f34dbaf3847b376f968530f76a9a202849017aa9510a',
    hi: 0, lo: 0, token: null, deviceModel: 'Android', androidVersion: '14',
    namesFile: path.join(ROOT, 'names.txt'), age: 18,
    androidId: '', locale: 'en-US', appVersion: null, loginBlob: null, loginPayload: null,
    sessionResponse: null, sessionResponseProvider: null,
    helloOnly: false, exitOnLogin: false, color: 'auto', verbose: false, hex: false,
    piar: false, piarBots: 0, piarDelayMs: 1000, piarMessage: null, piarMessagesFile: null,
    piarRoomCooldownMs: 30000,
    spectatePlayer: null, spectateBots: 0, spectateBrawlTv: false, spectateDelayMs: 0, spectateRetryMs: 500,
    dump: false, dumpCode: false, dumpDirectory: path.join(ROOT, 'dumps'),
    nativeLibrary: path.resolve(ROOT, '../v69.230_arm64.so'),
    dumpSc: false, scDirectory: path.join(ROOT, 'sc'), scAssetUrls: null,
    brand: 'laserjs', banner: DEFAULT_BANNER, showBanner: true,
    logPath: path.join(ROOT, 'logs/traffic.jsonl'),
});

const VALUE_OPTIONS = {
    '--host': ['host', String], '--port': ['port', Number],
    '--piar-bots': ['piarBots', value => value.toLowerCase() === 'unlimited' ? 0 : Number(value)],
};

function parseConfig(args) {
    let configFile = path.join(ROOT, 'settings.json');
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--config') {
            if (args[i + 1] === undefined) throw new Error('Missing value for --config');
            configFile = path.resolve(args[++i]);
        }
    }
    const settings = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings))
        throw new Error('Settings must be a JSON object');
    const config = { ...DEFAULTS, ...settings, configFile };
    let positional = 0;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const value = () => {
            if (++i >= args.length || args[i].startsWith('--')) throw new Error(`Missing value for ${arg}`);
            return args[i];
        };
        if (Object.hasOwn(VALUE_OPTIONS, arg)) {
            const [field, convert] = VALUE_OPTIONS[arg];
            config[field] = convert(value());
            continue;
        }
        switch (arg) {
            case '--config': value(); break;
            case '--piar': config.piar = true; break;
            case '--no-log': config.logPath = null; break;
            case '--verbose': config.verbose = true; break;
            case '--dump': config.dump = true; break;
            case '--dump-sc': config.dumpSc = true; break;
            case '--no-color': config.color = 'never'; break;
            default:
                if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}. Use --help; advanced options belong in settings.json`);
                if (positional === 0) config.host = arg;
                else if (positional === 1) config.port = Number(arg);
                else throw new Error(`Unexpected argument: ${arg}`);
                positional++;
        }
    }
    loadBinarySettings(config);
    for (const name of ['piarBots', 'spectateBots'])
        if (typeof config[name] === 'string' && config[name].toLowerCase() === 'unlimited') config[name] = 0;
    validate(config);
    return config;
}

function loadBinarySettings(config) {
    const resolve = value => path.resolve(path.dirname(config.configFile), value);
    for (const [field, fileField, hexField] of [
        ['loginBlob', 'loginBlobFile', null],
        ['loginPayload', 'loginFile', 'loginHex'],
        ['sessionResponse', 'sessionResponseFile', 'sessionResponseHex'],
    ]) {
        const file = config[fileField], hex = hexField ? config[hexField] : null;
        if (file != null && hex != null) throw new Error(`Choose ${fileField} or ${hexField}`);
        if (file != null) {
            if (typeof file !== 'string' || !file) throw new Error(`${fileField} must be a path`);
            config[field] = fs.readFileSync(resolve(file));
        } else if (hex != null) {
            if (typeof hex !== 'string' || !/^(?:[\da-f]{2})*$/i.test(hex))
                throw new Error(`${hexField} must contain complete hex bytes`);
            config[field] = Buffer.from(hex, 'hex');
        }
    }
}

function validate(config) {
    const integer = (name, min, max) => {
        if (!Number.isInteger(config[name]) || config[name] < min || config[name] > max)
            throw new Error(`${name} must be an integer in ${min}..${max}`);
    };
    integer('port', 1, 65535);
    integer('timeoutMs', 1, 2147483647);
    integer('loginMessageVersion', 0, 0xffff);
    integer('piarBots', 0, Number.MAX_SAFE_INTEGER);
    integer('piarDelayMs', 1, 2147483647);
    integer('piarRoomCooldownMs', 1, 2147483647);
    integer('spectateBots', 0, Number.MAX_SAFE_INTEGER);
    integer('spectateDelayMs', 0, 2147483647);
    integer('spectateRetryMs', 1, 2147483647);
    if (typeof config.spectateBrawlTv !== 'boolean') throw new Error('spectateBrawlTv must be a boolean');
    config.spectateTarget = config.spectatePlayer === null ? null : playerId(config.spectatePlayer);
    if (config.spectateTarget && config.piar)
        throw new Error('spectatePlayer cannot be combined with --piar');
    if (config.spectateTarget) {
        if (config.helloOnly || config.exitOnLogin || config.loginPayload !== null)
            throw new Error('spectatePlayer requires a normal Login and fresh bot accounts');
        if (!config.namesFile) throw new Error('spectatePlayer requires namesFile');
    }
    if (config.piarMessage !== null && (typeof config.piarMessage !== 'string' || !config.piarMessage.trim()))
        throw new Error('piarMessage must be a nonempty string or null');
    if (config.piarMessagesFile !== null) {
        if (typeof config.piarMessagesFile !== 'string' || !config.piarMessagesFile)
            throw new Error('piarMessagesFile must be a path or null');
        config.piarMessagesFile = path.resolve(path.dirname(config.configFile), config.piarMessagesFile);
        if (config.piarMessage !== null) throw new Error('Choose piarMessage or piarMessagesFile');
    }
    if (typeof config.piar !== 'boolean') throw new Error('piar must be a boolean');
    if (config.piar) {
        if (config.helloOnly || config.exitOnLogin)
            throw new Error('--piar cannot be combined with helloOnly or exitOnLogin');
        if (config.loginPayload !== null)
            throw new Error('--piar creates new accounts and cannot use loginFile or loginHex');
        if (!config.namesFile) throw new Error('--piar requires namesFile');
    }
    for (const name of ['major', 'minor', 'build', 'protocolVersion', 'cryptoVersion'])
        integer(name, 0, 0x7fffffff);
    for (const name of ['hi', 'lo']) integer(name, 0, 0xffffffff);
    if (config.age !== null) integer('age', 1, 100);
    if (typeof config.host !== 'string' || !config.host.trim()) throw new Error('host must be a nonempty string');
    if (!/^[\da-f]{64}$/i.test(config.serverPublicKey)) throw new Error('serverPublicKey must be 32 hex bytes');
    if (typeof config.hash !== 'string') throw new Error('hash must be a string');
    if (!['auto', 'always', 'never'].includes(config.color)) throw new Error('color must be auto, always, or never');
    for (const name of ['deviceModel', 'androidVersion', 'androidId', 'locale', 'brand']) {
        if (typeof config[name] !== 'string') throw new Error(`${name} must be a string`);
    }
    if (config.token !== null && typeof config.token !== 'string') throw new Error('token must be a string or null');
    if (config.namesFile !== null) {
        if (typeof config.namesFile !== 'string' || !config.namesFile)
            throw new Error('namesFile must be a path or null');
        config.namesFile = path.resolve(path.dirname(config.configFile), config.namesFile);
    }
    if (typeof config.dump !== 'boolean') throw new Error('dump must be a boolean');
    if (typeof config.dumpCode !== 'boolean') throw new Error('dumpCode must be a boolean');
    if (config.dumpCode) config.dump = true;
    if (config.dump) config.dumpCode = true;
    if (typeof config.dumpSc !== 'boolean') throw new Error('dumpSc must be a boolean');
    if (config.dump) config.dumpSc = true;
    if (typeof config.dumpDirectory !== 'string' || !config.dumpDirectory)
        throw new Error('dumpDirectory must be a nonempty path');
    config.dumpDirectory = path.resolve(path.dirname(config.configFile), config.dumpDirectory);
    if (typeof config.nativeLibrary !== 'string' || !config.nativeLibrary)
        throw new Error('nativeLibrary must be a nonempty path');
    config.nativeLibrary = path.resolve(path.dirname(config.configFile), config.nativeLibrary);
    if (typeof config.scDirectory !== 'string' || !config.scDirectory)
        throw new Error('scDirectory must be a nonempty path');
    config.scDirectory = path.resolve(path.dirname(config.configFile), config.scDirectory);
    if (config.scAssetUrls !== null) {
        if (!Array.isArray(config.scAssetUrls) || !config.scAssetUrls.length)
            throw new Error('scAssetUrls must be a nonempty array of HTTP(S) URLs');
        for (const value of config.scAssetUrls) {
            if (typeof value !== 'string' || !['https:', 'http:'].includes(new URL(value).protocol))
                throw new Error('scAssetUrls must contain HTTP(S) URLs');
        }
    }
    if (config.appVersion !== null && typeof config.appVersion !== 'string') throw new Error('appVersion must be a string or null');
    for (const name of ['loginPayload', 'loginBlob']) {
        if (config[name] !== null && !Buffer.isBuffer(config[name]))
            throw new Error(`${name} must be supplied through its file/hex setting`);
        if (config[name] && (config[name].length === 0 && name === 'loginPayload'
            || config[name].length > 3 * 1024 * 1024)) throw new Error(`${name} has an invalid size`);
    }
    if (config.logPath !== null) {
        if (typeof config.logPath !== 'string' || !config.logPath) throw new Error('logPath must be a path or null');
        config.logPath = path.resolve(path.dirname(config.configFile), config.logPath);
    }
    if (config.loginRuntime != null && (typeof config.loginRuntime !== 'object' || Array.isArray(config.loginRuntime)))
        throw new Error('loginRuntime must be an object');
    if (config.sessionResponse !== null && (!Buffer.isBuffer(config.sessionResponse) || config.sessionResponse.length > 255))
        throw new Error('sessionResponse must be supplied as at most 255 bytes through its file/hex setting');
    if (config.sessionResponseProvider !== null) {
        if (typeof config.sessionResponseProvider !== 'string' || !config.sessionResponseProvider)
            throw new Error('sessionResponseProvider must be a module path or null');
        config.sessionResponseProvider = path.resolve(path.dirname(config.configFile), config.sessionResponseProvider);
        if (config.sessionResponse !== null) throw new Error('Choose a session response file/hex or a provider');
    }
}

function help() {
    return `LASERJS — v69 protocol client

Usage: node index.js [host [port]] [options]

  --host HOST / --port N  Server
  --config FILE          JSON settings (settings.json)
  --piar                 Bot flow visiting rooms with a message from names.txt
  --piar-bots N          Concurrent bots; 0/unlimited — no limit
  --dump                 Save packets and decode them
  --dump-sc              Download SC from OwnHomeData and save the hash index
  --no-log               Disable the packet journal
  --verbose              Verbose output
  --no-color             Disable colors
  --help                 This help

Nicknames, versions, tokens, delays and dump settings live in settings.json.

Terminal commands after LoginOk:
  /createRoom                 Create a room
  /joinRoom X...|HIGH-LOW|ID   Join a room
  /room                       Current room and members
  /chat TEXT                  Send a message
  /leaveRoom                  Leave
  /spectate #TAG N true|false  Start viewers with the Brawl TV flag
  /spectate stop              Stop viewers
  /help                       List commands`;
}

module.exports = { parseConfig, help };
