'use strict';
const path = require('node:path');
const dgram = require('node:dgram');
const { isIP } = require('node:net');
const { randomBytes, randomInt } = require('node:crypto');
const { TYPES, encodeMessage, decodeMessage } = require('./protocol/messageFactory');
const { PacketReader, PacketWriter, roomId } = require('./protocol/protocol');
const { sameId } = require('./commands');
const { PacketJournal } = require('./logging');
const { UdpCipher } = require('./crypto');

const keyOf = id => id.join('-');

class PiarRooms {
    constructor({ cooldownMs = 30000, knownTtlMs = 120000, maxEntries = 10000, now = Date.now } = {}) {
        Object.assign(this, { cooldownMs, knownTtlMs, maxEntries, now });
        this.known = new Map();
        this.blocked = new Map();
        this.rejectedIds = new Set();
        this.claims = new Map();
        this.owners = new Map();
        this.recent = new Map();
        this.accounts = new Map();
        this.accountCounts = new Map();
    }

    remember(map, key, value) {
        map.delete(key);
        map.set(key, value);
        while (map.size > this.maxEntries) map.delete(map.keys().next().value);
    }

    register(owner, accountId) {
        const key = keyOf(accountId);
        if (this.accounts.get(owner) === key) return;
        this.unregister(owner);
        this.accounts.set(owner, key);
        this.accountCounts.set(key, (this.accountCounts.get(key) ?? 0) + 1);
    }

    unregister(owner) {
        this.release(owner);
        const key = this.accounts.get(owner);
        if (key !== undefined) {
            const count = this.accountCounts.get(key) - 1;
            if (count) this.accountCounts.set(key, count);
            else this.accountCounts.delete(key);
            this.accounts.delete(owner);
        }
        this.recent.delete(owner);
    }

    seed(id) {
        const key = keyOf(roomId(id));
        this.known.delete(key);
        this.remember(this.blocked, key, { until: this.now() + this.knownTtlMs, seed: true });
    }

    available(key, owner) {
        if (this.rejectedIds.has(key)) return false;
        const blocked = this.blocked.get(key);
        if (blocked) {
            if (blocked.until > this.now()) return false;
            this.blocked.delete(key);
        }
        const recent = this.recent.get(owner);
        if (recent?.key === key && recent.until > this.now()) return false;
        const room = this.known.get(key), visitors = this.claims.get(key);
        if (!room) return !visitors?.size;
        const occupied = new Set(room.members);
        for (const visitor of visitors ?? []) occupied.add(this.accounts.get(visitor) ?? visitor);
        return occupied.size < room.capacity;
    }

    claim(id, owner) {
        const key = keyOf(roomId(id));
        if (this.owners.has(owner) || !this.available(key, owner)) return false;
        const visitors = this.claims.get(key) ?? new Set();
        visitors.add(owner);
        this.claims.set(key, visitors);
        this.owners.set(owner, key);
        return true;
    }

    next(owner, traversal) {
        for (const [key, room] of this.known) {
            if (room.seenAt + this.knownTtlMs <= this.now()) { this.known.delete(key); continue; }
            if (this.claim(room.id, owner)) return { id: [...room.id], source: 'confirmed room' };
        }
        for (let skipped = 0; skipped < 256; skipped++) {
            const id = traversal.next();
            if (!id) return { exhausted: true };
            if (this.claim(id, owner)) return { id, source: 'neighbor scan' };
        }
        return { deferred: true };
    }

    observe(team) {
        const id = roomId(team.id), key = keyOf(id);
        if (this.rejectedIds.has(key)) return;
        if (this.blocked.get(key)?.seed && this.blocked.get(key).until > this.now()) return;
        const peers = team.members.filter(member => !this.accountCounts.has(keyOf(member.accountId)));
        if (!peers.length || !Number.isInteger(team.capacity) || team.capacity < 1) {
            this.known.delete(key);
            return;
        }
        this.remember(this.known, key, { id, seenAt: this.now(), capacity: team.capacity,
            members: new Set(team.members.map(member => keyOf(member.accountId))) });
    }

    rejected(owner, id) {
        const key = keyOf(roomId(id));
        this.release(owner);
        this.known.delete(key);
        this.rejectedIds.add(key);
        this.blocked.delete(key);
    }

    release(owner) {
        const key = this.owners.get(owner);
        if (key === undefined) return;
        this.owners.delete(owner);
        const visitors = this.claims.get(key);
        visitors.delete(owner);
        if (!visitors.size) this.claims.delete(key);
        const room = this.known.get(key);
        if (room) {
            room.members.delete(this.accounts.get(owner));
            this.recent.set(owner, { key, until: this.now() + this.cooldownMs });
        } else if (!this.rejectedIds.has(key)) {
            this.remember(this.blocked, key, { until: this.now() + this.cooldownMs });
        }
    }
}

function nextRoomId(id) {
    const [hi, lo] = roomId(id);
    if (lo < 0x7fffffff) return [hi, lo + 1];
    return hi < 255 ? [hi + 1, 0] : null;
}

function previousRoomId(id) {
    const [hi, lo] = roomId(id);
    if (lo > 0) return [hi, lo - 1];
    return hi > 0 ? [hi - 1, 0x7fffffff] : null;
}

class RoomTraversal {
    constructor(seed) { this.lower = roomId(seed); this.upper = roomId(seed); this.lowerNext = true; }
    next() {
        for (let attempt = 0; attempt < 2; attempt++) {
            const lower = this.lowerNext;
            this.lowerNext = !this.lowerNext;
            const key = lower ? 'lower' : 'upper';
            if (!this[key]) continue;
            this[key] = lower ? previousRoomId(this[key]) : nextRoomId(this[key]);
            if (this[key]) return [...this[key]];
        }
        return null;
    }
}

class PiarBot {
    constructor(client) {
        this.client = client;
        this.phase = 'awaiting-login';
        this.timer = null;
        this.visitTimer = null;
        this.targetId = null;
        this.attempts = 0;
        this.visits = 0;
        this.delivered = 0;
        this.roomPool = client.piarRooms;
    }

    status(message, level = 'info') { this.client.status('PiarBot', message, level); }

    clearTimer() { clearTimeout(this.timer); this.timer = null; }

    clearVisitTimer() { clearTimeout(this.visitTimer); this.visitTimer = null; }

    wait(phase) {
        this.clearTimer();
        this.phase = phase;
        this.timer = setTimeout(() => {
            if (phase === 'chatting' && this.client.rooms.team) {
                this.client.rooms.finishRequest();
                this.rest();
            } else this.fail(`no confirmation for ${phase} after ${this.client.config.timeoutMs} ms`, phase === 'joining');
        }, this.client.config.timeoutMs);
        this.timer.unref();
    }

    schedule(action, delayMs = this.client.config.piarDelayMs) {
        this.clearTimer();
        this.phase = 'delay';
        this.timer = setTimeout(() => {
            this.timer = null;
            if (this.client.stopping) return;
            try { action(); } catch (error) { this.fail(error.message); }
        }, delayMs);
        this.timer.unref();
    }

    request(phase, command, id, fields, targetId, message) {
        this.wait(phase);
        try { this.client.rooms.request(command, id, fields, targetId, message); }
        catch (error) { this.fail(error.message); }
    }

    onPacket(id, fields) {
        if (this.client.stopping || this.client.state !== 'authenticated' || fields.parseError) return;
        if (id === TYPES.LOGIN_OK && this.phase === 'awaiting-login') {
            this.roomPool?.register(this, this.client.account.accountId);
            this.wait('awaiting-home');
        } else if (id === TYPES.OWN_HOME_DATA && this.phase === 'awaiting-home') {
            this.name = this.client.accountName.pending?.name;
            if (!this.name) return this.fail('could not request a name from the TXT file');
            this.wait('awaiting-name');
        } else if (id === TYPES.AVAILABLE_SERVER_COMMAND && fields.command?.type === 201
            && this.phase === 'awaiting-name' && fields.unreadBytes === 0 && fields.decoded !== false) {
            if (fields.command.avatarName !== this.name) return this.fail('server confirmed a different name');
            this.schedule(() => this.request('creating', '/createRoom', TYPES.TEAM_CREATE, {}, null, 'creating a seed room'));
        } else if (id === TYPES.AVATAR_NAME_CHECK_RESPONSE && this.phase === 'awaiting-name'
            && (fields.flag_90 || fields.errorCode !== 0)) {
            this.fail('server rejected the name');
        } else if (id === TYPES.AVATAR_NAME_CHANGE_FAILED && this.phase === 'awaiting-name') {
            this.name = this.client.accountName.pending?.name;
            if (this.name) this.wait('awaiting-name');
            else this.fail('server rejected the name');
        } else if (id === TYPES.TEAM && this.client.rooms.team === fields.team) {
            if (this.phase === 'creating' && !this.client.rooms.pending) {
                this.targetId = roomId(fields.team.id);
                this.traversal = new RoomTraversal(this.targetId);
                this.roomPool?.seed(this.targetId);
                this.status(`seed room ID ${this.targetId.join('-')}; visiting lower and higher IDs alternately`);
                this.schedule(() => this.leave(true));
            } else if (this.phase === 'joining' && sameId(fields.team.id, this.targetId)
                && !this.client.rooms.pending) {
                this.roomPool?.observe(fields.team);
                this.visits++;
                this.startVisit();
            } else if (sameId(fields.team.id, this.targetId)) {
                this.roomPool?.observe(fields.team);
            }
        } else if (id === TYPES.TEAM_LEFT) {
            this.clearVisitTimer();
            this.roomPool?.release(this);
            if (['leaving-seed', 'leaving', 'chatting', 'visiting'].includes(this.phase)) this.schedule(() => this.joinNext());
            else if (this.phase === 'joining') this.fail('removed from a room before join confirmation');
        } else if (id === TYPES.TEAM_ERROR) {
            if (this.phase === 'joining' && !this.client.rooms.team) {
                this.roomPool?.rejected(this, this.targetId);
                this.schedule(() => this.joinNext());
            }
            else if (this.phase === 'chatting') {
                this.roomPool?.rejected(this, this.targetId);
                this.rest();
            }
            else if (['creating', 'joining', 'leaving-seed', 'leaving'].includes(this.phase))
                this.fail(`server rejected ${this.phase}: errorCode ${fields.errorCode}, reason ${fields.reason}`, true);
        }
        if (this.phase === 'chatting') {
            if (id === TYPES.TEAM_STREAM && sameId(fields.teamId, this.targetId) && !this.client.rooms.pending
                && fields.entries?.some(entry => entry.type === 2 && sameId(entry.accountId, this.client.account.accountId)
                    && entry.message === this.message)) {
                this.delivered++;
                this.status(`chat delivery confirmed in ${this.targetId.join('-')}; delivered ${this.delivered}`);
                this.rest();
            } else if (this.client.rooms.pending && this.client.rooms.pending !== this.chatRequest) {
                this.chatRequest = this.client.rooms.pending;
                this.wait('chatting');
            }
        }
    }

    startVisit() {
        this.clearVisitTimer();
        const stayMs = randomInt(2000, 4001);
        this.visitTimer = setTimeout(() => {
            this.visitTimer = null;
            if (this.client.stopping) return;
            this.clearTimer();
            this.client.rooms.finishRequest();
            try { this.leave(false); } catch (error) { this.fail(error.message); }
        }, stayMs);
        this.visitTimer.unref();
        this.chat();
    }

    rest() { this.clearTimer(); this.phase = 'visiting'; }

    chat() {
        if (!this.client.rooms.team) return this.schedule(() => this.joinNext());
        const messages = this.client.config.piarMessages;
        this.message = this.client.config.piarMessage ?? (messages?.length ? messages[randomInt(messages.length)] : this.name);
        this.wait('chatting');
        try { this.chatRequest = this.client.rooms.chat(this.message); }
        catch (error) {
            this.rest();
        }
    }

    leave(seed) {
        const team = this.client.rooms.team;
        if (!team) return this.schedule(() => this.joinNext());
        this.request(seed ? 'leaving-seed' : 'leaving', '/leaveRoom', TYPES.TEAM_LEAVE,
            {}, team.id, `leaving ${team.code}`);
    }

    joinNext() {
        if (this.client.rooms.team) return this.fail('cannot join the next ID before leaving the current room');
        const choice = this.roomPool?.next(this, this.traversal);
        if (choice?.deferred) return this.schedule(() => this.joinNext());
        const next = choice ? choice.id : this.traversal.next();
        if (!next) {
            this.client.result.outcome = 'piar-range-complete';
            this.status('exhausted the supported room ID range; replacing this bot');
            return this.client.stop();
        }
        this.targetId = next;
        this.attempts++;
        this.request('joining', '/joinRoom', TYPES.TEAM_JOIN, { teamId: next }, next,
            `joining ID ${next.join('-')}; attempt ${this.attempts}, visits ${this.visits}`
            + (choice?.source ? `; source: ${choice.source}` : ''));
    }

    fail(message, quiet = false) {
        if (this.client.stopping) return;
        if (['joining', 'chatting', 'visiting', 'leaving'].includes(this.phase) && this.targetId)
            this.roomPool?.rejected(this, this.targetId);
        if (!quiet) this.status(message, 'warn');
        this.client.result.exitCode = 1;
        this.client.result.outcome = 'piar-error';
        this.client.stop();
    }

    close() {
        this.clearTimer();
        this.clearVisitTimer();
        this.roomPool?.unregister(this);
        this.phase = 'closed';
    }
}

const UDP_POLL_MS = 1000;
const UDP_BIND_POLL_MS = 100;
const UDP_IDLE_MS = 30000;
const SPECTATE_REQUEST_TIMEOUT_MS = 2000;
const SPECTATE_LAUNCH_BATCH = 16;

function spectatorInput(header, tick = 0, acknowledgedTick = -1) {
    if (Array.isArray(header))
        header = new PacketWriter().writeLong(...header).writeUnsignedShort(0).finish();
    if (!Buffer.isBuffer(header) || header.length !== 10)
        throw new Error('Invalid spectator UDP header');
    const message = encodeMessage(TYPES.CLIENT_INPUT, { tick, acknowledgedTick });
    return new PacketWriter().writeRaw(header).writeVInt(message.id)
        .writeVInt(message.payload.length).writeRaw(message.payload).finish();
}

class SpectateBot {
    constructor(client) {
        this.client = client;
        this.phase = 'awaiting-login';
        this.timer = null;
        this.udpTimer = null;
        this.udpPollMs = null;
        this.udp = null;
        this.requested = false;
        this.reportedUnavailable = false;
        this.inputTick = 0;
        this.acknowledgedTick = -1;
    }

    status(message, level = 'info') { this.client.status('SpectateBot', message, level); }

    schedule(phase, ms, action) {
        clearTimeout(this.timer);
        this.phase = phase;
        this.timer = setTimeout(() => {
            this.timer = null;
            if (!this.client.stopping) {
                try { action(); } catch (error) { this.fail(error.message); }
            }
        }, ms);
        this.timer.unref();
    }

    wait(phase) {
        const timeout = this.client.config.timeoutMs;
        let ms = phase === 'awaiting-home' ? timeout
            : Math.max(1, timeout - Math.min(1000, Math.ceil(timeout / 4)));
        if (phase === 'starting') ms = Math.min(ms, SPECTATE_REQUEST_TIMEOUT_MS);
        this.schedule(phase, ms, () => {
            if (phase === 'awaiting-home')
                this.fail(`no confirmation for ${phase}`);
            else if (phase === 'connecting' || phase === 'binding')
                this.retry('no UDP vision updates; check the advertised UDP host and port');
            else this.retry('player has no available battle or the server did not confirm spectating');
        });
    }

    onPacket(id, fields) {
        if (this.client.stopping || this.client.state !== 'authenticated') return;
        if (fields.parseError) {
            if (id === TYPES.UDP_CONNECTION_INFO && this.requested)
                this.retry(`invalid UDP connection info: ${fields.parseError}`);
            return;
        }
        if (id === TYPES.LOGIN_OK && this.phase === 'awaiting-login') {
            this.wait('awaiting-home');
        } else if (id === TYPES.OWN_HOME_DATA && this.phase === 'awaiting-home') {
            if (!this.client.accountName.pending?.name) return this.fail('could not request a name from names.txt');
            this.start();
        } else if (id === TYPES.SPECTATE_FAILED
            && ['starting', 'loading', 'connecting', 'binding', 'watching'].includes(this.phase)) {
            this.retry(`server rejected spectating (reason ${fields.reason})`);
        } else if (id === TYPES.START_LOADING && this.phase === 'starting') {
            this.wait('loading');
        } else if (id === TYPES.UDP_CONNECTION_INFO
            && this.requested && ['starting', 'loading', 'connecting', 'binding', 'watching'].includes(this.phase)) {
            this.connectUdp(fields);
        } else if (id === TYPES.VISION_UPDATE && this.requested) {
            this.onVision(fields, 'TCP');
        } else if (id === TYPES.BATTLE_END && this.requested) {
            this.retry('battle ended');
        }
    }

    start() {
        const message = encodeMessage(TYPES.START_SPECTATE,
            { targetId: this.client.config.spectateTarget, brawlTv: this.client.config.spectateBrawlTv ?? false });
        this.client.sendMessage(message.id, message.payload, message.fields, message.version);
        this.requested = true;
        this.wait('starting');
    }

    connectUdp(fields) {
        const host = fields.host || this.client.config.host;
        const header = Buffer.from(fields.headerHex, 'hex');
        if (this.udp && this.udpHost === host && this.udpPort === fields.port && header.equals(this.udpHeader)
            && this.udpKeyHex === fields.encryptionKeyHex) return;
        this.closeUdp();
        this.udpKeyHex = fields.encryptionKeyHex;
        this.udpCipher = fields.encryptionKeyHex ? new UdpCipher(Buffer.from(fields.encryptionKeyHex, 'hex')) : null;
        const socket = dgram.createSocket(isIP(host) === 6 ? 'udp6' : 'udp4');
        this.udp = socket;
        this.udpHeader = header;
        this.udpHost = host;
        this.udpPort = fields.port;
        this.inputTick = 0;
        this.acknowledgedTick = -1;
        this.wait('connecting');
        socket.on('error', error => {
            if (this.udp === socket && !this.client.stopping) this.retry(`UDP: ${error.message}`);
        });
        socket.on('message', packet => { if (this.udp === socket) this.onUdpPacket(packet); });
        socket.connect(fields.port, host, () => {
            if (this.udp !== socket || this.client.stopping) return;
            try {
                this.lastUdpAt = Date.now();
                this.wait('binding');
                this.sendUdpInput();
                this.pollUdp(UDP_BIND_POLL_MS);
            } catch (error) { this.retry(`UDP: ${error.message}`); }
        });
    }

    onUdpPacket(packet) {
        try {
            if (packet.length < 10 || !packet.subarray(0, 10).equals(this.udpHeader)) return;
            const payload = this.udpCipher ? this.udpCipher.open(packet.subarray(10)) : packet.subarray(10);
            if (payload === null) return;
            const reader = new PacketReader(payload);
            const type = reader.vint(), length = reader.vint();
            if (type !== TYPES.VISION_UPDATE || length < 1 || length !== reader.remaining) return;
            const fields = decodeMessage(type, reader.raw(length));
            if (fields.parseError || fields.unreadBytes !== 0) return;
            this.lastUdpAt = Date.now();
            this.onVision(fields, 'UDP');
        } catch {}
    }

    pollUdp(ms) {
        clearInterval(this.udpTimer);
        this.udpTimer = null;
        this.udpPollMs = null;
        if (!this.udp || this.client.stopping) return;
        this.udpPollMs = ms;
        this.udpTimer = setInterval(() => {
            if (Date.now() - this.lastUdpAt >= UDP_IDLE_MS) this.retry('UDP stream stopped');
            else {
                try { this.sendUdpInput(); } catch (error) { this.retry(`UDP: ${error.message}`); }
            }
        }, ms);
        this.udpTimer.unref();
    }

    onVision(fields, transport) {
        this.acknowledgedTick = Math.max(this.acknowledgedTick, fields.tick);
        if (this.phase === 'watching') {
            if (transport === 'UDP' && this.udpPollMs === UDP_BIND_POLL_MS) {
                this.sendUdpInput();
                this.pollUdp(UDP_POLL_MS);
            }
            return;
        }
        clearTimeout(this.timer);
        this.timer = null;
        this.phase = 'watching';
        this.reportedUnavailable = false;
        this.status(`watching player ${this.client.config.spectatePlayer}; ${transport} vision confirmed`);
        if (this.udp && transport === 'UDP') {
            this.sendUdpInput();
            this.pollUdp(UDP_POLL_MS);
        } else if (!this.udp) {
            this.sendTcpInput();
            this.udpTimer = setInterval(() => this.sendTcpInput(), UDP_POLL_MS);
            this.udpTimer.unref();
        }
    }

    sendTcpInput() {
        if (this.client.stopping || !this.requested) return;
        try {
            const message = encodeMessage(TYPES.CLIENT_INPUT,
                { tick: this.inputTick++ & 16383, acknowledgedTick: this.acknowledgedTick });
            this.client.sendMessage(message.id, message.payload, message.fields, message.version);
        } catch (error) { this.fail(error.message); }
    }

    sendUdpInput() {
        const socket = this.udp;
        if (!socket || this.client.stopping) return;
        const input = spectatorInput(this.udpHeader, this.inputTick++ & 16383, this.acknowledgedTick);
        const wire = this.udpCipher ? Buffer.concat([this.udpHeader, this.udpCipher.seal(input.subarray(10))]) : input;
        socket.send(wire, error => {
            if (error && !this.client.stopping && this.udp === socket)
                this.retry(`UDP: ${error.message}`);
        });
    }

    closeUdp() {
        clearInterval(this.udpTimer);
        this.udpTimer = null;
        this.udpPollMs = null;
        this.udpCipher?.close();
        this.udpCipher = null;
        const socket = this.udp;
        this.udp = null;
        if (socket) {
            try { socket.close(); } catch {}
        }
    }

    retry(reason) {
        if (this.client.stopping) return;
        if (!this.reportedUnavailable) {
            this.status(`${reason}; will retry`, 'warn');
            this.reportedUnavailable = true;
        }
        clearTimeout(this.timer);
        this.closeUdp();
        if (this.requested && !this.stopWatching())
            return this.fail('could not stop the spectator session');
        this.schedule('waiting-retry', this.client.config.spectateRetryMs, () => this.start());
    }

    stopWatching() {
        if (!this.requested || this.client.stopping) return false;
        const message = encodeMessage(TYPES.STOP_SPECTATE);
        try {
            this.client.sendMessage(message.id, message.payload, message.fields, message.version);
            this.requested = false;
            return true;
        } catch { return false; }
    }

    fail(message) {
        if (this.client.stopping) return;
        this.status(message, 'warn');
        this.client.result.exitCode = 1;
        this.client.result.outcome = 'spectate-error';
        this.client.stop(this.stopWatching());
    }

    close() {
        clearTimeout(this.timer);
        this.timer = null;
        this.closeUdp();
        this.requested = false;
        this.phase = 'closed';
    }
}

class PiarRunner {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.spectate = config.spectateTarget !== null && config.spectateTarget !== undefined;
        this.scope = this.spectate ? 'SpectateRunner' : 'PiarRunner';
        this.botCount = this.spectate ? config.spectateBots : config.piarBots;
        this.delayMs = this.spectate ? config.spectateDelayMs : config.piarDelayMs;
        this.stopping = false;
        this.clients = new Set();
        this.workers = new Set();
        this.pauses = new Map();
        this.rooms = this.spectate ? null : new PiarRooms({ cooldownMs: config.piarRoomCooldownMs });
        const { readNames } = require('./client');
        this.names = readNames(config.namesFile);
        if (!this.names.length) throw new Error(`No names in ${config.namesFile}`);
        for (const name of this.names) encodeMessage(TYPES.CHANGE_AVATAR_NAME, { name, initial: true });
        this.messages = !this.spectate && config.piarMessagesFile ? readNames(config.piarMessagesFile) : null;
        if (this.messages && !this.messages.length) throw new Error(`No messages in ${config.piarMessagesFile}`);
        for (const message of this.messages ?? (this.spectate || config.piarMessage === null ? [] : [config.piarMessage]))
            encodeMessage(TYPES.TEAM_CHAT, { message });
    }

    pause(ms) {
        if (this.stopping) return Promise.resolve();
        return new Promise(resolve => {
            const timer = setTimeout(() => { this.pauses.delete(timer); resolve(); }, ms);
            this.pauses.set(timer, resolve);
        });
    }

    async run() {
        const unlimited = this.botCount === 0;
        this.logger.info(this.scope, `${unlimited ? 'unlimited' : this.botCount} bots; ${this.delayMs} ms between launches; names: ${this.config.namesFile}`
            + (this.spectate ? `; target: ${this.config.spectatePlayer}; Brawl TV: ${this.config.spectateBrawlTv === true}` : ''));
        for (let number = 1; !this.stopping && (unlimited || number <= this.botCount); number++) {
            const worker = this.worker(number);
            this.workers.add(worker);
            worker.then(() => this.workers.delete(worker), error => {
                this.workers.delete(worker);
                this.error = error;
                this.interrupt();
            });
            if ((unlimited || number < this.botCount)
                && (this.delayMs > 0 || number % SPECTATE_LAUNCH_BATCH === 0)) await this.pause(this.delayMs);
        }
        await Promise.allSettled([...this.workers]);
        if (this.error) throw this.error;
        return 130;
    }

    async worker(number) {
        const { ProtocolClient, AccountManager } = require('./client');
        let generation = 0;
        const logger = {
            info: (scope, message, level) => this.logger.info(`bot ${number}.${generation} ${scope}`, message, level),
            packet: event => this.logger.packet({ ...event, name: `bot ${number}.${generation} ${event.name}` }),
        };
        while (!this.stopping) {
            generation++;
            let journal, client;
            try {
                journal = new PacketJournal(this.config.logPath);
                const config = { ...this.config, hi: 0, lo: 0, token: null, androidId: randomBytes(8).toString('hex'),
                    piarMessages: this.messages,
                    dumpDirectory: path.join(this.config.dumpDirectory, journal.session),
                    scDirectory: path.join(this.config.scDirectory, journal.session) };
                journal.record({ kind: 'session', mode: this.spectate ? 'spectate' : 'piar', bot: number, generation,
                    brand: config.brand, host: config.host, port: config.port,
                    version: `${config.major}.${config.minor}.${config.build}`, hash: config.hash,
                    configFile: config.configFile });
                const account = new AccountManager(config);
                account.init(logger);
                client = new ProtocolClient({ config, logger, journal, account, piarRooms: this.rooms, names: this.names });
                this.clients.add(client);
                await client.run();
            } catch (error) {
                logger.info(this.scope, error.message, 'error');
                client?.stop();
            } finally {
                this.clients.delete(client);
                journal?.close();
            }
            if (!this.stopping) await this.pause(this.spectate ? this.config.spectateRetryMs : this.delayMs);
        }
    }

    interrupt() {
        if (this.stopping) return;
        this.stopping = true;
        this.logger.info(this.scope, 'stopping all bots');
        for (const [timer, resolve] of this.pauses) { clearTimeout(timer); resolve(); }
        this.pauses.clear();
        for (const client of this.clients) client.interrupt();
    }
}

module.exports = { PiarRooms, PiarBot, nextRoomId, previousRoomId, RoomTraversal, SpectateBot, spectatorInput, PiarRunner };
