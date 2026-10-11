'use strict';
const fs = require('node:fs');
const net = require('node:net');
const { randomInt } = require('node:crypto');
const { PepperSession } = require('./crypto');
const { PacketDump, ScFileDump } = require('./logging');
const { FrameDecoder, encodeFrame } = require('./protocol/protocol');
const { TYPES, messageName, encodeMessage, decodeMessage } = require('./protocol/messageFactory');
const { RoomCommands } = require('./commands');
const { PiarBot, SpectateBot } = require('./bots');

class AccountManager {
    constructor(config) {
        this.accountId = [config.hi, config.lo];
        this.token = config.token;
        this.newAccountRequested = !config.token && config.hi === 0 && config.lo === 0 && !config.loginPayload;
    }
    init(logger) {
        logger.info('AccountManager::init', this.token
            ? `account ${this.accountId.join('-')} configured`
            : 'AccountManager initialized! New account requested.');
    }
    acceptLogin(fields) {
        if (fields.accountId) this.accountId = fields.accountId;
        if (fields.loginToken !== undefined) this.token = fields.loginToken;
    }
}

function readNames(file) {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '').split(/\r?\n/u)
        .map(line => line.trim()).filter(Boolean);
}

class AccountName {
    constructor(client) {
        this.client = client;
        this.attempted = false;
        this.pending = null;
        this.remainingNames = [];
        this.failure = null;
    }
    status(message, level = 'info') { this.client.status('AccountManager::setName', message, level); }

    onPacket(id, fields) {
        if (this.client.state !== 'authenticated' || fields.parseError) return;
        if (id === TYPES.OWN_HOME_DATA && !this.attempted && this.client.account.newAccountRequested) {
            this.attempted = true;
            if (!this.client.config.namesFile) return;
            try {
                this.remainingNames = [...new Set(this.client.names ?? readNames(this.client.config.namesFile))];
                if (!this.remainingNames.length) throw new Error(`No names in ${this.client.config.namesFile}`);
                this.requestNext();
            } catch (error) {
                this.clear();
                this.failure = error.message;
                this.status(this.failure, 'warn');
            }
        } else if (id === TYPES.AVAILABLE_SERVER_COMMAND && fields.command?.type === 201) {
            if (fields.unreadBytes > 0 || fields.decoded === false) return;
            const pending = this.clear();
            this.client.account.name = fields.command.avatarName;
            this.failure = null;
            if (pending) this.status(`name set to ${JSON.stringify(fields.command.avatarName)}; server confirmed with command 201 (24111)`);
        } else if (id === TYPES.AVATAR_NAME_CHANGE_FAILED && this.pending) {
            if (fields.unreadBytes > 0) return;
            const rejected = this.clear();
            this.failure = `name ${JSON.stringify(rejected.name)} rejected: errorCode ${fields.errorCode} (20205)`;
            this.status(this.failure, 'warn');
            if (fields.errorCode === 1 && this.remainingNames.length) {
                try { this.requestNext(); }
                catch (error) { this.clear(); this.failure = error.message; this.status(this.failure, 'warn'); }
            }
        } else if (id === TYPES.AVATAR_NAME_CHECK_RESPONSE && this.pending) {
            if (fields.flag_90 || fields.errorCode !== 0) {
                this.clear();
                this.failure = `name rejected: errorCode ${fields.errorCode}, message ${JSON.stringify(fields.message)}`;
                this.status(this.failure, 'warn');
            }
        }
    }

    requestNext() {
        const [name] = this.remainingNames.splice(randomInt(this.remainingNames.length), 1);
        const packet = encodeMessage(TYPES.CHANGE_AVATAR_NAME, { name, initial: true });
        const pending = this.pending = { name };
        this.failure = null;
        pending.timer = setTimeout(() => {
            if (this.pending !== pending) return;
            this.clear();
            this.failure = `no name confirmation from the server after ${this.client.config.timeoutMs} ms`;
            this.status(this.failure, 'warn');
            this.client.rooms?.resumeNameRequest?.();
        }, this.client.config.timeoutMs);
        pending.timer.unref();
        this.client.sendMessage(packet.id, packet.payload, packet.fields, packet.version);
        this.status(`requested ${JSON.stringify(name)} from ${this.client.config.namesFile}; waiting for server confirmation`);
    }

    clear() {
        const pending = this.pending;
        if (pending) clearTimeout(pending.timer);
        this.pending = null;
        return pending;
    }

    close() {
        if (this.clear()) this.status('connection closed before name confirmation', 'warn');
    }
}

class ServerCommands {
    constructor(client) {
        this.client = client;
        this.tick = 0;
        this.lastSequence = -1;
        this.ageRequested = false;
    }

    sendTurn(command) {
        const executionTick = this.tick + 1;
        const packet = encodeMessage(TYPES.END_CLIENT_TURN, { tick: executionTick + 1,
            commands: [{ ...command, executionTick }] });
        this.client.sendMessage(packet.id, packet.payload, packet.fields, packet.version);
        this.tick = executionTick + 1;
    }

    setAge() {
        if (this.ageRequested || !this.client.account.newAccountRequested) return;
        const age = this.client.config.age === undefined ? 18 : this.client.config.age;
        if (age === null) return;
        this.sendTurn({ type: 530, age });
        this.ageRequested = true;
        this.client.status('AccountManager::setAge',
            `requested age ${age} with command 530; chat permissions still require server confirmation`);
    }

    onPacket(id, fields) {
        if (this.client.state !== 'authenticated' || fields.parseError) return;
        if (id === TYPES.OWN_HOME_DATA) { this.setAge(); return; }
        if (id !== TYPES.AVAILABLE_SERVER_COMMAND || fields.unreadBytes !== 0 || fields.decoded === false) return;
        const command = fields.command;
        if (![201, 221].includes(command?.type)) return;
        if (command.sequence <= this.lastSequence) return;
        this.sendTurn(command);
        this.lastSequence = command.sequence;
        this.client.status('MessageManager::onServerCommand',
            `applied ${command.name}, sequence ${command.sequence}; EndClientTurn tick ${this.tick}`, 'info', true);
    }
}

const KEEP_ALIVE_INTERVAL_MS = 6000;

class ProtocolClient {
    constructor({ config, logger, journal, account, piarRooms = null, names = null }) {
        Object.assign(this, { config, logger, journal, account, piarRooms, names });
        this.pepper = new PepperSession(config.serverPublicKey);
        this.decoder = new FrameDecoder();
        this.packetDump = new PacketDump(config.dump ? config.dumpDirectory : null,
            { code: config.dumpCode, nativeLibrary: config.nativeLibrary,
                onEvent: event => this.reportPacketAnalysis(event) });
        this.scDump = config.dumpSc ? new ScFileDump({ directory: config.scDirectory,
            urls: config.scAssetUrls, onEvent: event => this.reportScFile(event) }) : null;
        this.state = 'created';
        this.result = { exitCode: 2, loginOk: false, outcome: 'incomplete', sent: 0, received: 0 };
        this.stopping = false;
        this.finished = false;
        this.socket = null;
        this.keepAliveTimer = null;
        this.receiveQueue = Promise.resolve();
        this.rooms = new RoomCommands(this);
        this.accountName = new AccountName(this);
        this.serverCommands = new ServerCommands(this);
        this.piarBot = config.piar ? new PiarBot(this) : null;
        this.spectateBot = config.spectateTarget ? new SpectateBot(this) : null;
    }

    status(scope, message, level = 'info', verboseOnly = false) {
        this.journal.record({ kind: 'status', scope, level, message, state: this.state });
        if (!verboseOnly || this.config.verbose) this.logger.info(scope, message, level);
    }

    run() {
        if (this.state !== 'created') throw new Error('A client session can only be run once');
        this.state = 'connecting';
        if (this.packetDump.directory)
            this.status('PacketDump::open', `BIN, HEX, JS, JSON and native analysis: ${this.packetDump.directory}`, 'info', true);
        if (this.scDump) this.status('SCFileDump::open', `resource files and index: ${this.scDump.directory}`, 'info', true);
        this.status('Messaging::connect', `connecting to ${this.config.host}:${this.config.port}`);
        return new Promise(resolve => {
            this.socket = net.createConnection({ host: this.config.host, port: this.config.port });
            this.connectTimer = setTimeout(() => {
                this.result = { ...this.result, exitCode: 2, outcome: 'connect-timeout' };
                this.status('Messaging::onTimeout', `connection timed out after ${this.config.timeoutMs} ms`, 'warn');
                this.stop();
            }, this.config.timeoutMs);
            this.socket.on('connect', () => {
                clearTimeout(this.connectTimer);
                this.socket.setTimeout(this.config.timeoutMs);
                this.socket.setNoDelay(true);
                this.state = 'awaiting-server-hello';
                this.status('Messaging::onConnect', `connected to ${this.config.host}:${this.config.port}`);
                try {
                    const hello = encodeMessage(TYPES.CLIENT_HELLO, this.config);
                    this.sendMessage(hello.id, hello.payload, hello.fields, hello.version);
                } catch (error) { this.fail(error); }
            });
            this.socket.on('data', chunk => {
                try {
                    const frames = this.decoder.push(chunk);
                    this.receiveQueue = this.receiveQueue.then(async () => {
                        for (const frame of frames) {
                            if (this.stopping) break;
                            await this.receive(frame);
                        }
                    }).catch(error => this.fail(error));
                } catch (error) { this.fail(error); }
            });
            this.socket.on('timeout', () => {
                const reason = this.state === 'preparing-login' ? 'session response provider did not finish'
                    : this.state === 'awaiting-login' ? 'no reply completing Login'
                    : this.state === 'awaiting-server-hello' ? 'no ServerHello' : 'no further packets';
                if (!this.result.loginOk) this.result.outcome = 'login-timeout';
                this.status('Messaging::onTimeout', `idle for ${this.config.timeoutMs} ms (${reason}); closing`, 'warn');
                this.stop();
            });
            this.socket.on('error', error => this.fail(error));
            this.socket.on('close', async () => {
                clearTimeout(this.connectTimer);
                clearTimeout(this.stopTimer);
                this.stopKeepAlive();
                this.commandConsole?.close();
                this.rooms.close();
                this.accountName.close();
                this.piarBot?.close();
                this.spectateBot?.close();
                if (this.decoder.pending.length && !this.stopping) {
                    this.result.exitCode = 1;
                    this.result.outcome = 'truncated-frame';
                    this.status('Messaging::onError', `connection ended with ${this.decoder.pending.length} bytes of an incomplete frame`, 'error');
                }
                this.stopping = true;
                const finalState = this.state;
                this.state = 'closed';
                if (this.result.outcome === 'incomplete') this.result.outcome = 'server-closed-before-login';
                await Promise.all([this.packetDump.drain(), this.scDump?.drain()]);
                if (this.packetDump.directory) this.result.dumpPacketsIncomplete = this.packetDump.failures;
                if (this.scDump) this.result.scFilesFailed = this.scDump.failures;
                this.status('Messaging::onClose', `connection closed; ${this.result.outcome}; TX ${this.result.sent}, RX ${this.result.received}`);
                this.journal.record({ kind: 'result', ...this.result, finalState });
                this.finished = true;
                resolve({ ...this.result });
            });
        });
    }

    sendMessage(id, payload, fields = null, version = 0) {
        if (!this.socket || this.stopping || this.socket.destroyed) throw new Error('Connection is closed');
        const wire = this.pepper.seal(id, payload);
        const frame = encodeFrame(id, wire, version);
        this.socket.write(frame);
        this.result.sent++;
        const event = this.journal.record({ kind: 'packet', direction: 'TX', name: messageName(id),
            id, version, length: wire.length, plainLength: payload.length, state: this.state,
            frameHex: frame.toString('hex'), payloadHex: wire.toString('hex'),
            plainHex: payload.toString('hex'), fields,
            ...(id === TYPES.LOGIN ? { envelopeHex: this.pepper.loginEnvelope.toString('hex') } : {}) });
        if (!this.config.piar || id !== TYPES.TEAM_JOIN) this.logger.packet(event);
    }

    async receive({ id, version, payload: wire, frame }) {
        let plain;
        let fields;
        let decryptError;
        try {
            plain = this.pepper.loginSent ? this.pepper.open(wire) : wire;
            fields = decodeMessage(id, plain, version);
        } catch (error) { decryptError = error; fields = { decryptError: error.message }; }
        this.result.received++;
        const event = this.journal.record({ kind: 'packet', direction: 'RX', name: messageName(id),
            id, version, length: wire.length, plainLength: plain?.length, state: this.state,
            frameHex: frame.toString('hex'), payloadHex: wire.toString('hex'),
            plainHex: plain?.toString('hex'), fields });
        if (!this.config.piar || id !== TYPES.TEAM_ERROR) this.logger.packet(event);
        if (decryptError) return this.fail(decryptError);
        const dumpPath = this.packetDump.save(id, plain, { version, frame, fields });
        if (dumpPath) {
            this.journal.record({ kind: 'dump', direction: 'RX', id, path: dumpPath,
                length: plain.length, state: this.state });
            if (this.config.verbose) this.logger.info('PacketDump::save', `${id}: ${dumpPath} (${plain.length} bytes)`);
        }
        if (id === TYPES.OWN_HOME_DATA && this.state === 'authenticated') this.scDump?.enqueue(plain);
        if (fields.parseError) {
            if (!this.config.piar || id !== TYPES.TEAM_ERROR)
                this.status('MessageManager::decode', `${messageName(id)}: ${fields.parseError}`, 'warn');
            if (id === TYPES.SERVER_HELLO || id === TYPES.LOGIN_OK)
                return this.fail(new Error(`Cannot process ${messageName(id)}: invalid payload`));
        }
        switch (id) {
            case TYPES.SERVER_HELLO:
                if (this.state !== 'awaiting-server-hello') throw new Error('Unexpected ServerHello');
                if (this.config.helloOnly) {
                    this.result.exitCode = 0;
                    this.result.outcome = 'server-hello';
                    this.status('Messaging::onServerHello', 'ServerHello received; hello-only mode complete');
                    this.stop();
                } else {
                    await this.prepareLogin(Buffer.from(fields.tokenHex, 'hex'));
                }
                break;
            case TYPES.LOGIN_FAILED:
                this.state = 'rejected';
                this.result.exitCode = 3;
                this.result.outcome = 'login-failed';
                this.status('MessageManager::onLoginFailedReceived',
                    `login rejected with error ${fields.errorCode ?? '?'}`, 'error');
                this.reportLoginFailed(fields);
                if (fields.fingerprintData) {
                    const fingerprint = fields.fingerprintData;
                    this.status('Client::fingerprint',
                        `server fingerprint ${fingerprint.version} (${fingerprint.sha}), ${fingerprint.files ?? '?'} files`);
                }
                this.stop();
                break;
            case TYPES.LOGIN_OK:
                if (this.state !== 'awaiting-login' || !this.pepper.serverNonce)
                    throw new Error('Unexpected LoginOk before an encrypted Login exchange');
                this.state = 'authenticated';
                this.result.exitCode = 0;
                this.result.loginOk = true;
                this.result.outcome = 'login-ok';
                this.account.acceptLogin(fields);
                this.scDump?.observeLogin(plain);
                this.status('MessageManager::onLoginOkReceived',
                    `logged in as (${fields.accountId.join('-')}) passToken: ${fields.loginToken ?? 'null'}`);
                if (fields.serverEnvironment != null)
                    this.status('MessageManager::onLoginOkReceived', `server environment: ${fields.serverEnvironment}`);
                if (this.config.exitOnLogin) this.stop();
                else {
                    this.startKeepAlive();
                    this.rooms.onLogin();
                }
                break;
        }
        this.serverCommands.onPacket(id, fields);
        this.accountName.onPacket(id, fields);
        this.rooms.onPacket(id, fields);
        this.piarBot?.onPacket(id, fields);
        this.spectateBot?.onPacket(id, fields);
    }

    reportLoginFailed(fields) {
        if (!this.config.verbose) return;
        for (const name of ['redirect', 'updateUrl', 'message', 'assetUrl', 'assetUrls',
            'secondsLeft', 'booleanFlag']) {
            const value = !Object.hasOwn(fields, name) ? '<not included in packet>'
                : fields[name] === null ? 'null (not provided by server)' : JSON.stringify(fields[name]);
            this.status('LoginFailedMessage::details', `${name}: ${value}`);
        }
    }

    reportScFile(event) {
        this.journal.record({ ...event, kind: 'sc', action: event.kind, state: this.state });
        if (!this.config.verbose) return;
        if (event.kind === 'index') this.logger.info('SCFileDump::index', `${event.count} references: ${event.path}`);
        else if (event.kind === 'saved') this.logger.info('SCFileDump::download',
            `${event.name}: saved ${event.length} bytes, SHA-1 ${event.hash}`);
        else if (event.kind === 'error') this.logger.info('SCFileDump::download',
            `${event.name ? `${event.name}: ` : ''}${event.message}`, 'warn');
        else if (this.config.verbose) this.logger.info('SCFileDump::cache', `${event.name}: SHA-1 ${event.hash} verified`);
    }

    async prepareLogin(challenge) {
        this.state = 'preparing-login';
        let file;
        try { file = require.resolve('./attestation'); }
        catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') throw error;
            throw new Error('Local attestation module is missing: src/attestation.js (excluded from Git)');
        }
        return require(file).prepareLogin(this, challenge);
    }

    startKeepAlive() {
        if (this.keepAliveTimer || this.stopping || this.state !== 'authenticated') return;
        this.keepAliveTimer = setInterval(() => {
            if (this.stopping || this.state !== 'authenticated' || this.socket?.destroyed)
                return this.stopKeepAlive();
            try {
                const message = encodeMessage(TYPES.KEEP_ALIVE);
                this.sendMessage(message.id, message.payload, message.fields, message.version);
            } catch (error) { this.fail(error); }
        }, KEEP_ALIVE_INTERVAL_MS);
        this.keepAliveTimer.unref();
    }

    stopKeepAlive() {
        if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
    }

    fail(error) {
        if (this.stopping) return;
        this.state = 'failed';
        this.result.exitCode = 1;
        this.result.outcome = 'error';
        this.status('Messaging::onError', `${error.code ? `${error.code}: ` : ''}${error.message}`, 'error');
        this.stop();
    }

    reportPacketAnalysis(event) {
        this.journal.record({ ...event, kind: 'dump-analysis', action: event.kind, state: this.state });
        if (!this.config.verbose) return;
        if (event.kind === 'error') {
            this.logger.info('PacketDump::decode', `${event.id}: ${event.error}`, 'warn');
            return;
        }
        const summary = `${event.id}: ${event.parseStatus}; ${event.decodedBytes}/${event.length} bytes decoded; `
            + `${event.unreadBytes} unread; ${event.typedCalls} typed calls`;
        this.logger.info('PacketDump::decode', summary, event.parseStatus === 'complete' ? 'info' : 'warn');
        if (event.parseError && this.config.verbose)
            this.logger.info('PacketDump::decode', event.parseError, 'warn');
    }

    stop(graceful = false) {
        this.stopping = true;
        this.stopKeepAlive();
        this.commandConsole?.close();
        this.rooms.close();
        this.accountName.close();
        this.piarBot?.close();
        this.spectateBot?.close();
        if (this.socket) {
            if (graceful && !this.socket.destroyed) {
                this.socket.end();
                this.stopTimer = setTimeout(() => this.socket.destroy(), 1000);
                this.stopTimer.unref();
            } else this.socket.destroy();
        }
    }
    interrupt() {
        if (this.finished || (this.stopping && !this.scDump && !this.packetDump.directory)) return;
        this.scDump?.cancel();
        this.packetDump.cancel();
        this.result.exitCode = 130;
        this.result.outcome = 'interrupted';
        this.status('Messaging::onInterrupt', 'interrupted by user');
        this.stop(this.spectateBot?.stopWatching() ?? false);
    }
}

module.exports = { ProtocolClient, AccountManager, AccountName, readNames, ServerCommands };
