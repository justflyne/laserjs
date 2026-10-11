'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PacketReader, PacketWriter } = require('./protocol');
const { createUnknownMessage } = require('./messages/UnknownMessage');

const messageFactory = Object.freeze({
    10100: require('./messages/client/ClientHelloMessage'),
    10101: require('./messages/client/LoginMessage'),
    10108: require('./messages/client/KeepAliveMessage'),
    10212: require('./messages/client/ChangeAvatarNameMessage'),
    10555: require('./messages/client/ClientInputMessage'),
    12541: require('./messages/client/TeamCreateMessage'),
    14049: require('./messages/client/TeamChatMessage'),
    14102: require('./messages/client/EndClientTurnMessage'),
    14104: require('./messages/client/StartSpectateMessage'),
    14107: require('./messages/client/StopSpectateMessage'),
    14353: require('./messages/client/TeamLeaveMessage'),
    14358: require('./messages/client/TeamJoinMessage'),
    14778: require('./messages/client/SetTeamChatMutedMessage'),
    20100: require('./messages/server/ServerHelloMessage'),
    20103: require('./messages/server/LoginFailedMessage'),
    20104: require('./messages/server/LoginOkMessage'),
    20105: require('./messages/server/FriendListMessage'),
    20108: require('./messages/server/KeepAliveOkMessage'),
    20205: require('./messages/server/AvatarNameChangeFailedMessage'),
    20559: require('./messages/server/StartLoadingMessage'),
    20300: require('./messages/server/AvatarNameCheckResponseMessage'),
    24101: require('./messages/server/OwnHomeDataMessage'),
    24105: require('./messages/server/SpectateFailedMessage'),
    24109: require('./messages/server/VisionUpdateMessage'),
    24111: require('./messages/server/AvailableServerCommandMessage'),
    24112: require('./messages/server/UdpConnectionInfoMessage'),
    24124: require('./messages/server/TeamMessage'),
    23456: require('./messages/server/BattleEndMessage'),
    24125: require('./messages/server/TeamLeftMessage'),
    24129: require('./messages/server/TeamErrorMessage'),
    24131: require('./messages/server/TeamStreamMessage'),
    24399: require('./messages/server/ServerMessage24399'),
    49001: require('./messages/server/ServerMessage49001'),
});

for (const [id, message] of Object.entries(messageFactory)) {
    if (message.messageType !== Number(id)) throw new Error(`Message factory ID mismatch: ${message.name}`);
    Object.freeze(message);
}

const TYPES = Object.freeze({ CLIENT_HELLO: 10100, LOGIN: 10101, KEEP_ALIVE: 10108,
    CHANGE_AVATAR_NAME: 10212, AVATAR_NAME_CHANGE_FAILED: 20205,
    AVATAR_NAME_CHECK_RESPONSE: 20300, AVAILABLE_SERVER_COMMAND: 24111,
    END_CLIENT_TURN: 14102, START_SPECTATE: 14104, STOP_SPECTATE: 14107, CLIENT_INPUT: 10555,
    SERVER_HELLO: 20100, LOGIN_FAILED: 20103, LOGIN_OK: 20104, FRIEND_LIST: 20105,
    KEEP_ALIVE_OK: 20108, OWN_HOME_DATA: 24101, SPECTATE_FAILED: 24105,
    UDP_CONNECTION_INFO: 24112, VISION_UPDATE: 24109, START_LOADING: 20559, BATTLE_END: 23456,
    SERVER_MESSAGE_24399: 24399, SERVER_MESSAGE_49001: 49001,
    TEAM_CREATE: 12541, TEAM_CHAT: 14049, TEAM_LEAVE: 14353, TEAM_JOIN: 14358, SET_TEAM_CHAT_MUTED: 14778,
    TEAM: 24124, TEAM_LEFT: 24125, TEAM_ERROR: 24129, TEAM_STREAM: 24131 });

function getMessage(id) {
    if (!Number.isInteger(id) || id < 0 || id > 0xffff) throw new Error('Invalid message ID');
    return messageFactory[id] || createUnknownMessage(id);
}

function messageName(id) { return getMessage(id).name; }

function encodeMessage(id, config = {}) {
    const message = getMessage(id);
    if (typeof message.encode !== 'function') throw new Error(`${message.name} has no encoder`);
    const encoded = message.encode(config);
    if (!Buffer.isBuffer(encoded.payload)) throw new Error(`${message.name} encoder must return a Buffer payload`);
    return { ...encoded, id: message.messageType, version: encoded.version ?? message.messageVersion };
}

function decodeMessage(id, payload, version = getMessage(id).messageVersion) {
    const message = getMessage(id);
    const reader = new PacketReader(payload);
    const fields = {};
    if (typeof message.decode !== 'function') return { decoded: false, unreadBytes: reader.remaining };
    try { message.decode(reader, fields, { version }); }
    catch (error) { fields.parseError = error.message; }
    fields.unreadBytes = reader.remaining;
    return fields;
}

const sha256 = payload => crypto.createHash('sha256').update(payload).digest('hex');

function rawOperations(payload, start, end = payload.length, comment = 'opaque bytes') {
    const operations = [];
    for (let offset = start; offset < end; offset += 64) {
        const bytes = payload.subarray(offset, Math.min(offset + 64, end));
        operations.push({ method: 'writeRaw', type: 'Unknown', decoded: false,
            args: [bytes], offset, length: bytes.length, comment });
    }
    return operations;
}

function applyOperations(operations) {
    const stream = new PacketWriter();
    for (const operation of operations) stream[operation.method](...operation.args);
    return stream.finish();
}

function exactOperation(payload, method, args, offset, length, comment) {
    const operation = { method, type: method.slice(5), decoded: true, args, offset, length, comment };
    if (applyOperations([operation]).equals(payload.subarray(offset, offset + length))) return operation;
    return { method: 'writeRaw', type: operation.type, decoded: true, values: args,
        args: [payload.subarray(offset, offset + length)], offset, length,
        comment: `${comment}; ${operation.type} ${args.map(value => Buffer.isBuffer(value)
            ? '<binary>' : JSON.stringify(value)).join(', ')}; original encoding preserved` };
}

function defaultOperations(id, payload) {
    const operations = [];
    const reader = new PacketReader(payload);
    for (const { type, name } of getMessage(id).exportFields || []) {
        const offset = reader.offset;
        try {
            let args;
            switch (type) {
                case 'Long': args = reader.long(); break;
                case 'DataReference': args = reader.reference(); break;
                case 'VInt': args = [reader.vint()]; break;
                case 'Int': args = [reader.int()]; break;
                case 'String': args = [reader.string()]; break;
                case 'Bytes': args = [reader.bytes()]; break;
                default: throw new Error(`Unsupported export field ${type}`);
            }
            operations.push(exactOperation(payload, `write${type}`, args, offset, reader.offset - offset, name));
        } catch { reader.offset = offset; break; }
    }
    const end = operations.length ? operations.at(-1).offset + operations.at(-1).length : 0;
    return [...operations, ...rawOperations(payload, end)];
}

function readPrimitive(payload, record) {
    const reader = new PacketReader(payload);
    reader.offset = record.offset;
    let method = `write${record.type}`;
    let args;
    switch (record.type) {
        case 'VInt': args = [reader.vint()]; break;
        case 'Int': args = [reader.int()]; break;
        case 'Long': args = reader.long(); break;
        case 'String': args = [reader.string()]; break;
        case 'Byte': args = [reader.byte()]; break;
        case 'Short': args = [reader.raw(2).readInt16BE()]; break;
        case 'UnsignedShort': args = [reader.raw(2).readUInt16BE()]; break;
        case 'Int24': args = [reader.raw(3).readIntBE(0, 3)]; break;
        case 'Bytes': method = 'writeRaw'; args = [reader.raw(record.length)]; break;
        default: throw new Error(`Unsupported native reader ${record.type} at ${record.offset}`);
    }
    const operation = exactOperation(payload, method, args, record.offset, reader.offset - record.offset,
        `native ${record.caller}, reader ${record.reader}`);
    if (record.type === 'Bytes') Object.assign(operation, { type: 'Bytes', decoded: true,
        comment: `Bytes(${record.length}); ${operation.comment}` });
    return operation;
}

function tracedOperations(id, payload, trace) {
    if (trace.id !== id || trace.payloadSha256 !== sha256(payload))
        throw new Error('Native trace does not belong to this packet');
    if (!Number.isInteger(trace.prefixBytes) || trace.prefixBytes < 0 || trace.prefixBytes > payload.length
        || !Array.isArray(trace.reads)) throw new Error('Invalid native trace');
    const operations = [];
    let cursor = 0;
    for (let i = 0; i < trace.reads.length; i++) {
        const record = trace.reads[i];
        if (record.offset !== cursor)
            throw new Error(`Native trace has a gap or overlap at ${record.offset}; expected ${cursor}`);
        if (record.type === 'Boolean') {
            const group = [];
            const start = cursor;
            for (; i < trace.reads.length && trace.reads[i].type === 'Boolean'; i++) {
                const flag = trace.reads[i];
                const bit = group.length % 8;
                const offset = start + Math.floor(group.length / 8);
                const expectedOffset = offset + (bit === 0 ? 0 : 1);
                if (flag.bit !== bit || flag.offset !== expectedOffset)
                    throw new Error(`Unexpected Boolean bit position at ${flag.offset}`);
                if (offset >= trace.prefixBytes) throw new Error('Boolean exceeds native prefix');
                group.push({ method: 'writeBoolean', type: 'Boolean', decoded: true,
                    args: [!!(payload[offset] & (1 << bit))],
                    offset, length: bit === 0 ? 1 : 0,
                    comment: `bit ${bit}; native ${flag.caller}` });
            }
            i--;
            cursor += Math.ceil(group.length / 8);
            if (applyOperations(group).equals(payload.subarray(start, cursor))) operations.push(...group);
            else operations.push({ method: 'writeRaw', type: 'Boolean', decoded: true,
                values: group.map(op => op.args[0]), args: [payload.subarray(start, cursor)],
                offset: start, length: cursor - start,
                comment: `Boolean bits ${group.map(op => Number(op.args[0])).join(',')}; unused bits preserved` });
        } else {
            const operation = readPrimitive(payload, record);
            cursor += operation.length;
            if (cursor > trace.prefixBytes) throw new Error('Reader exceeds native prefix');
            operations.push(operation);
            if (record.type === 'Long' && record.reader === '0x5b6498') {
                for (let member = 0; member < 2; member++) {
                    const nested = trace.reads[++i];
                    if (!nested || nested.type !== 'Int' || nested.offset !== record.offset + member * 4)
                        throw new Error('Incomplete native Long trace');
                }
            }
        }
    }
    if (cursor !== trace.prefixBytes) throw new Error('Native trace prefix length mismatch');
    return [...operations, ...rawOperations(payload, cursor, payload.length,
        'untraced tail; original bytes')];
}

function literal(value) {
    if (Buffer.isBuffer(value)) return `Buffer.from('${value.toString('hex')}', 'hex')`;
    return JSON.stringify(value);
}

function exportPacket(id, payload, trace = null, context = {}) {
    if (!Number.isInteger(id) || id < 0 || id > 0xffff) throw new Error('Invalid packet ID');
    payload = Buffer.from(payload);
    const operations = trace ? tracedOperations(id, payload, trace) : defaultOperations(id, payload);
    const rebuilt = applyOperations(operations);
    if (!rebuilt.equals(payload)) throw new Error('Packet builder did not reproduce the original bytes');
    const digest = sha256(payload);
    const typedCalls = operations.filter(op => op.method !== 'writeRaw').length;
    const rawBytes = operations.filter(op => op.method === 'writeRaw').reduce((sum, op) => sum + op.length, 0);
    const unreadBytes = operations.filter(op => !op.decoded).reduce((sum, op) => sum + op.length, 0);
    const parseStatus = context.parseStatus || (trace
        ? (trace.status === 'complete' && unreadBytes === 0 ? 'complete' : trace.status || 'partial')
        : (unreadBytes === 0 && id === 20100 ? 'complete' : 'partial'));
    const metadata = { id, name: messageName(id), length: payload.length, sha256: digest,
        typedCalls, rawBytes, decodedBytes: payload.length - unreadBytes, unreadBytes, parseStatus,
        roundTrip: 'exact byte match',
        ...(context.version !== undefined ? { version: context.version } : {}),
        ...(context.error ? { parseError: context.error } : {}),
        schema: trace ? 'native byte-reader trace' : 'confirmed wire fields; unknown bytes preserved' };
    const source = ["'use strict';", '',
        `// ${metadata.name} (${id}); decrypted body, without a TCP header.`,
        `// ${payload.length} bytes; SHA-256 ${digest}`,
        `// ${typedCalls} typed calls; ${rawBytes} bytes preserved as HEX.`,
        `// Parse: ${parseStatus}; ${unreadBytes} unparsed bytes.`,
        ...(trace ? [`// Native decoder: ${trace.decoder || trace.boundary || 'provided trace'}; ${trace.prefixBytes} bytes consumed.`,
            '// Native types and call sites are recorded; field meanings are not inferred.'] : []),
        '// writeRaw appends bytes directly; it MUST NOT write a length prefix.',
        '// writeBoolean packs consecutive flags into low-to-high bits of a byte.',
        '', 'function encode(stream) {',
        ...operations.map(operation => `    stream.${operation.method}(${operation.args.map(literal).join(', ')});`
            + ` // 0x${operation.offset.toString(16).padStart(6, '0')}, ${operation.length}B; ${operation.comment}`),
        '    return stream;', '}', '',
        `module.exports = { ...${JSON.stringify(metadata)}, encode };`, ''].join('\n');
    const jsonValue = value => Buffer.isBuffer(value) ? { hex: value.toString('hex') } : value;
    const namedFields = Object.fromEntries(Object.entries(context.fields || {})
        .filter(([key]) => !['decoded', 'unreadBytes', 'parseError'].includes(key)));
    const parsed = { ...metadata, ...(context.header ? { header: context.header } : {}),
        ...(Object.keys(namedFields).length ? { namedFields } : {}),
        ...(trace ? { native: { decoder: trace.decoder, librarySha256: trace.librarySha256,
            resourceLookups: trace.resourceLookups } } : {}),
        operations: operations.map(op => ({ offset: op.offset, length: op.length, type: op.type,
            decoded: op.decoded, method: op.method, args: op.args.map(jsonValue),
            ...(op.values ? { values: op.values.map(jsonValue) } : {}), comment: op.comment })) };
    return { hex: `${payload.toString('hex')}\n`, source, metadata, parsed };
}

function savePacketExport(file, id, payload, trace = null, context = {}) {
    const exported = exportPacket(id, payload, trace, context);
    const base = file.endsWith('.bin') ? file.slice(0, -4) : file;
    const files = { hex: `${base}.hex`, source: `${base}.js`, json: `${base}.json` };
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(files.hex, exported.hex, { mode: 0o600 });
    fs.writeFileSync(files.source, exported.source, { mode: 0o600 });
    fs.writeFileSync(files.json, JSON.stringify(exported.parsed, null, 2) + '\n', { mode: 0o600 });
    return { ...exported.metadata, files };
}

module.exports = { messageFactory, TYPES, getMessage, messageName, encodeMessage, decodeMessage, exportPacket, savePacketExport };
