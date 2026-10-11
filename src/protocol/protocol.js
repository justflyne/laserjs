'use strict';

class BinaryWriter {
    constructor() { this.parts = []; }

    raw(value) { this.parts.push(Buffer.from(value)); return this; }
    byte(value) { return this.raw([value & 0xff]); }
    bool(value) { return this.byte(value ? 1 : 0); }
    int(value) {
        const bytes = Buffer.allocUnsafe(4);
        bytes.writeInt32BE(value);
        return this.raw(bytes);
    }
    uint(value) {
        const bytes = Buffer.allocUnsafe(4);
        bytes.writeUInt32BE(value);
        return this.raw(bytes);
    }
    long(hi, lo) { return this.uint(hi).uint(lo); }
    bytes(value) {
        if (value == null) return this.int(-1);
        const bytes = Buffer.from(value);
        return this.int(bytes.length).raw(bytes);
    }
    string(value) { return this.bytes(value == null ? null : Buffer.from(String(value), 'utf8')); }
    vint(value) {
        if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
            throw new RangeError('VInt must fit a signed 32-bit integer');
        const sign = value < 0 ? 0x40 : 0;
        let next = value >> 6;
        const stop = value < 0 ? -1 : 0;
        this.byte((value & 0x3f) | sign | (next === stop ? 0 : 0x80));
        while (next !== stop) {
            const part = next & 0x7f;
            next >>= 7;
            this.byte(part | (next === stop ? 0 : 0x80));
        }
        return this;
    }
    reference(table, item = 0) {
        this.vint(table);
        if (table !== 0) this.vint(item);
        return this;
    }
    finish() { return Buffer.concat(this.parts); }
}

class BinaryReader {
    constructor(bytes) { this.buffer = Buffer.from(bytes); this.offset = 0; }
    get remaining() { return this.buffer.length - this.offset; }
    raw(size) {
        if (!Number.isInteger(size) || size < 0 || size > this.remaining)
            throw new RangeError(`Truncated payload at ${this.offset}: need ${size}, have ${this.remaining}`);
        const value = this.buffer.subarray(this.offset, this.offset + size);
        this.offset += size;
        return value;
    }
    byte() { return this.raw(1)[0]; }
    bool() { return this.byte() !== 0; }
    int() { return this.raw(4).readInt32BE(0); }
    uint() { return this.raw(4).readUInt32BE(0); }
    long() { return [this.uint(), this.uint()]; }
    bytes(limit = 4 * 1024 * 1024) {
        const size = this.int();
        if (size === -1) return null;
        if (size < 0 || size > limit) throw new RangeError(`Invalid byte array length ${size}`);
        return this.raw(size);
    }
    string(limit = 1024 * 1024) {
        const value = this.bytes(limit);
        return value === null ? null : value.toString('utf8');
    }
    vint() {
        let byte = this.byte();
        const negative = (byte & 0x40) !== 0;
        let value = byte & 0x3f;
        let bits = 6;
        while (byte & 0x80) {
            if (bits >= 34) throw new RangeError('VInt is too long');
            byte = this.byte();
            value += (byte & 0x7f) * 2 ** bits;
            bits += 7;
        }
        if (negative) value -= 2 ** bits;
        if (value < -0x80000000 || value > 0x7fffffff)
            throw new RangeError('VInt exceeds signed 32-bit range');
        return value;
    }
}

class PacketReader extends BinaryReader {
    constructor(bytes) { super(bytes); this.booleanBit = 0; this.booleanByte = 0; }
    raw(size) { this.booleanBit = 0; return super.raw(size); }
    boolean() {
        if (this.booleanBit === 0) this.booleanByte = this.byte();
        const value = !!(this.booleanByte & (1 << this.booleanBit));
        this.booleanBit = (this.booleanBit + 1) % 8;
        return value;
    }
    reference() {
        const table = this.vint();
        return [table, table === 0 ? 0 : this.vint()];
    }
    vint() {
        const first = this.byte();
        let byte = first, value = BigInt(first & 0x3f), bits = 6;
        while (byte & 0x80 && bits < 34) {
            byte = this.byte();
            value |= BigInt(byte & 0x7f) << BigInt(bits);
            bits += 7;
        }
        if (first & 0x40 && bits < 32) value -= 1n << BigInt(bits);
        return Number(BigInt.asIntN(32, value));
    }
}

class PacketWriter extends BinaryWriter {
    constructor() { super(); this.booleanBit = 0; this.booleanByte = null; }

    raw(value) {
        this.booleanBit = 0;
        this.booleanByte = null;
        return super.raw(value);
    }

    writeRaw(value) { return this.raw(value); }
    writeVInt(value) { return this.vint(value); }
    writeInt(value) { return this.int(value); }
    writeString(value) { return this.string(value); }
    writeByte(value) { return this.byte(value); }
    writeLong(hi, lo) { return this.long(hi, lo); }
    writeDataReference(table, item = 0) { return this.reference(table, item); }
    writeBytes(value) { return this.bytes(value); }

    writeBoolean(value) {
        if (this.booleanBit === 0) {
            this.booleanByte = Buffer.alloc(1);
            this.parts.push(this.booleanByte);
        }
        if (value) this.booleanByte[0] |= 1 << this.booleanBit;
        this.booleanBit = (this.booleanBit + 1) % 8;
        return this;
    }

    writeShort(value) {
        const bytes = Buffer.allocUnsafe(2);
        bytes.writeInt16BE(value);
        return this.raw(bytes);
    }
    writeUnsignedShort(value) {
        const bytes = Buffer.allocUnsafe(2);
        bytes.writeUInt16BE(value);
        return this.raw(bytes);
    }
    writeInt24(value) {
        const bytes = Buffer.allocUnsafe(3);
        bytes.writeIntBE(value, 0, 3);
        return this.raw(bytes);
    }
}

const HEADER_SIZE = 7;
const MAX_PAYLOAD = 4 * 1024 * 1024;

function encodeFrame(id, payload, version = 0) {
    if (!Number.isInteger(id) || id < 0 || id > 0xffff)
        throw new RangeError('Message id must fit 16 bits');
    if (!Number.isInteger(version) || version < 0 || version > 0xffff)
        throw new RangeError('Message version must fit 16 bits');
    if (payload.length > MAX_PAYLOAD) throw new RangeError('Payload exceeds 4 MiB');
    const frame = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
    frame.writeUInt16BE(id, 0);
    frame.writeUIntBE(payload.length, 2, 3);
    frame.writeUInt16BE(version, 5);
    Buffer.from(payload).copy(frame, HEADER_SIZE);
    return frame;
}

class FrameDecoder {
    constructor() { this.pending = Buffer.alloc(0); }
    push(chunk) {
        this.pending = Buffer.concat([this.pending, chunk]);
        const frames = [];
        let offset = 0;
        while (this.pending.length - offset >= HEADER_SIZE) {
            const size = this.pending.readUIntBE(offset + 2, 3);
            if (size > MAX_PAYLOAD) throw new RangeError(`Invalid frame length ${size}`);
            if (this.pending.length - offset < HEADER_SIZE + size) break;
            const frame = this.pending.subarray(offset, offset + HEADER_SIZE + size);
            frames.push({ id: frame.readUInt16BE(0), version: frame.readUInt16BE(5),
                payload: frame.subarray(HEADER_SIZE), frame });
            offset += frame.length;
        }
        this.pending = this.pending.subarray(offset);
        return frames;
    }
}

const TAG_ALPHABET = '0289PYLQGRJCUV';
const MAX_ID = (1n << 64n) - 1n;
const MAX_TAG = (0x7fffffffn << 8n) | 255n;

function playerId(value) {
    if (Array.isArray(value) && value.length === 2 && value.every(part => Number.isInteger(part)
        && part >= 0 && part <= 0xffffffff) && value.some(Boolean)) return [...value];
    if (typeof value !== 'string') throw new Error('Player must be a #TAG, high-low ID, or decimal ID');
    const text = value.trim().toUpperCase();
    if (/^\d+-\d+$/.test(text)) {
        const parts = text.split('-').map(Number);
        if (parts.every(part => Number.isInteger(part) && part >= 0 && part <= 0xffffffff)
            && parts.some(Boolean)) return parts;
    } else if (/^\d+$/.test(text)) {
        const id = BigInt(text);
        if (id > 0n && id <= MAX_ID) return [Number(id >> 32n), Number(id & 0xffffffffn)];
    } else if (/^#[0289PYLQGRJCUV]{1,12}$/.test(text)) {
        let packed = 0n;
        for (const character of text.slice(1)) packed = packed * BigInt(TAG_ALPHABET.length)
            + BigInt(TAG_ALPHABET.indexOf(character));
        if (packed > 0n && packed <= MAX_TAG)
            return [Number(packed & 255n), Number(packed >> 8n)];
    }
    throw new Error('Player must be a valid #TAG, high-low ID, or decimal ID');
}

const ROOM_ALPHABET = 'QWERTYUPASDFGHJKLZCVBNM23456789';
const BASE = BigInt(ROOM_ALPHABET.length);
const MAX_PACKED = (0x7fffffffn << 8n) | 255n;

function roomId(value) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isInteger)
        || value[0] < 0 || value[0] > 255 || value[1] < 0 || value[1] > 0x7fffffff)
        throw new Error('Room ID must have high 0..255 and low 0..2147483647');
    return [...value];
}

function roomCode(value) {
    const [hi, lo] = roomId(value);
    let packed = (BigInt(lo) << 8n) | BigInt(hi), code = '';
    do { code = ROOM_ALPHABET[Number(packed % BASE)] + code; packed /= BASE; } while (packed);
    return 'X' + code;
}

function parseRoom(value) {
    const text = String(value).trim().toUpperCase();
    if (/^\d+-\d+$/.test(text)) {
        const id = roomId(text.split('-').map(Number));
        return { id, code: roomCode(id) };
    }
    if (/^\d+$/.test(text)) {
        const raw = BigInt(text);
        if (raw > 0xffffffffffffffffn) throw new Error('Room ID exceeds 64 bits');
        const id = roomId([Number(raw >> 32n), Number(raw & 0xffffffffn)]);
        return { id, code: roomCode(id) };
    }
    const code = text.replace(/^#/, '');
    if (code[0] !== 'X' || code.length < 2 || code.length > 13)
        throw new Error('Use a room code X..., an ID high-low, or a decimal 64-bit ID');
    let packed = 0n;
    for (const symbol of code.slice(1)) {
        const digit = ROOM_ALPHABET.indexOf(symbol);
        if (digit < 0) throw new Error(`Invalid room code character: ${symbol}`);
        packed = packed * BASE + BigInt(digit);
        if (packed > MAX_PACKED) throw new Error('Room code exceeds the native ID range');
    }
    const id = [Number(packed & 255n), Number(packed >> 8n)];
    return { id, code: roomCode(id) };
}

function decimalRoomId(id) {
    const [hi, lo] = roomId(id);
    return ((BigInt(hi) << 32n) | BigInt(lo)).toString();
}

function count(reader, label, max = 1000, nullable = false) {
    const value = reader.vint();
    if ((nullable && value === -1) || (value >= 0 && value <= max)) return value;
    throw new Error(`Invalid ${label} count: ${value}`);
}

function list(reader, label, decode, max = 1000, nullable = false) {
    const size = count(reader, label, max, nullable);
    return size === -1 ? null : Array.from({ length: size }, () => decode(reader));
}

function vlong(reader) { return [reader.vint() >>> 0, reader.vint() >>> 0]; }

function displayData(reader) {
    return { name: reader.string(), displayValue: reader.vint(), thumbnailId: reader.vint(),
        nameColorId: reader.vint(), highNameColorId: reader.vint(),
        flag_20: reader.boolean(), field_24: reader.vint(), field_28: reader.vint() };
}

function teamMember(reader) {
    const member = { isOwner: reader.boolean(), accountId: reader.long(),
        character: reader.reference(), skin: reader.reference(), field_20: reader.vint(),
        trophies: reader.vint(), highestTrophies: reader.vint(), level: reader.vint(),
        state: reader.vint(), field_34: reader.vint(), isReady: reader.boolean(),
        teamIndex: reader.vint(), difficulty: reader.vint() };
    for (const offset of ['40', '44', '48', '4c', '50']) member[`field_${offset}`] = reader.vint();
    member.displayData = displayData(reader);
    for (const offset of ['60', '68', '70', '78', '80', '88', '90', 'a8', 'b0'])
        member[`reference_${offset}`] = reader.reference();
    member.field_b8 = reader.vint();
    member.references_98 = list(reader, 'member references', r => r.reference());
    member.field_d8 = reader.vint();
    member.field_dc = reader.vint();
    member.values_e0 = list(reader, 'member values e0', r => r.vint());
    member.values_f0 = list(reader, 'member values f0', r => r.vint());
    member.field_100 = reader.vint();
    for (const offset of ['108', 'c0', 'c8', 'd0']) member[`reference_${offset}`] = reader.reference();
    return member;
}

function teamInvite(reader) {
    return { accountId: reader.long(), inviterId: reader.long(), name: reader.string(),
        field_18: reader.vint(), slot: reader.vint(), flag_20: reader.boolean() };
}

function playerMap(reader) {
    return { id: vlong(reader), name: reader.string(), field_10: reader.vint(),
        reference_18: reader.reference(), reference_20: reader.reference(),
        dataHex: reader.bytes()?.toString('hex') ?? null, creatorId: vlong(reader),
        creatorName: reader.string(), field_40: reader.vint(),
        ids: list(reader, 'map IDs', vlong, 1000, true) };
}

const HASH_LENGTH = Buffer.from([0, 0, 0, 40]);

function fileName(remote) {
    const name = remote.replace(/^\/+/, '');
    if (!name || /[\\\x00-\x1f\x7f]/.test(name) || !/\.sc$/i.test(name)
        || name.split('/').some(part => !part || part === '.' || part === '..')) return null;
    return name;
}

function extractScFiles(payload) {
    payload = Buffer.from(payload);
    const files = new Map();
    let offset = 0;
    while ((offset = payload.indexOf(HASH_LENGTH, offset)) !== -1) {
        const start = offset;
        offset++;
        if (start + 48 > payload.length) continue;
        const hash = payload.subarray(start + 4, start + 44).toString('latin1');
        if (!/^[a-f0-9]{40}$/i.test(hash)) continue;
        const length = payload.readInt32BE(start + 44);
        if (length < 3 || length > 1024 || start + 48 + length > payload.length) continue;
        const raw = payload.subarray(start + 48, start + 48 + length);
        const remote = raw.toString('utf8');
        if (!Buffer.from(remote, 'utf8').equals(raw)) continue;
        const name = fileName(remote);
        if (name) files.set(name, hash.toLowerCase());
    }
    return Object.fromEntries(files);
}

module.exports = { BinaryWriter, BinaryReader, PacketReader, PacketWriter, encodeFrame, FrameDecoder, playerId, ROOM_ALPHABET, roomCode, parseRoom, roomId, decimalRoomId, count, list, vlong, displayData, teamMember, teamInvite, playerMap, fileName, extractScFiles };
