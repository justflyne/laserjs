'use strict';

const readline = require('node:readline');
const { TYPES, encodeMessage } = require('./protocol/messageFactory');
const { parseRoom, playerId } = require('./protocol/protocol');

const sameId = (a, b) => Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
const HELP = '/createRoom | /joinRoom X... or high-low or decimal ID | /room | /chat text | /leaveRoom | /spectate #TAG N true|false | /spectate stop | /help';

class RoomCommands {
    constructor(client) {
        this.client = client;
        this.team = null;
        this.pending = null;
        this.seenEntries = new Set();
        this.chatMuted = null;
    }

    status(message, level = 'info') { this.client.status('RoomCommands', message, level); }

    onLogin() { if (!this.client.config.piar && !this.client.config.spectateTarget) this.status(`commands: ${HELP}`); }

    execute(line) {
        line = line.trim();
        if (!line) return;
        const [, command, argument = ''] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(line);
        const name = command.toLowerCase();
        if (name === '/help') { this.status(HELP); return; }
        try {
            if (!['/createroom', '/joinroom', '/room', '/chat', '/leaveroom'].includes(name))
                throw new Error(`Unknown command ${command}. Use /help`);
            if (this.client.state !== 'authenticated' || this.client.stopping)
                throw new Error('Wait for LoginOk before using room commands');
            if (name === '/room') {
                if (argument) throw new Error('Usage: /room');
                if (this.team) this.reportTeam(this.team);
                else this.status('No current room');
                return;
            }
            if (this.pending) throw new Error(`Waiting for the server to finish ${this.pending.command}`);
            if (name === '/createroom') {
                if (argument) throw new Error('Usage: /createRoom');
                if (this.team) throw new Error('Already in a room; use /leaveRoom first');
                this.request('/createRoom', TYPES.TEAM_CREATE, {}, null, 'creating a room');
            } else if (name === '/joinroom') {
                if (!argument || /\s/.test(argument)) throw new Error('Usage: /joinRoom X... or high-low or decimal ID');
                const room = parseRoom(argument);
                if (this.team) throw new Error('Already in a room; use /leaveRoom first');
                this.request('/joinRoom', TYPES.TEAM_JOIN, { code: room.code }, room.id,
                    `joining ${room.code}, ID ${room.id.join('-')}`);
            } else if (name === '/leaveroom') {
                if (argument) throw new Error('Usage: /leaveRoom');
                if (!this.team) throw new Error('No current room');
                this.request('/leaveRoom', TYPES.TEAM_LEAVE, {}, this.team.id,
                    `leaving ${this.team.code}`);
            } else if (name === '/chat') {
                this.chat(argument);
            }
        } catch (error) { this.status(error.message, 'warn'); }
    }

    chat(message) {
        if (!this.team) throw new Error('Join or create a room before sending chat');
        if (this.pending) throw new Error(`Waiting for the server to finish ${this.pending.command}`);
        encodeMessage(TYPES.TEAM_CHAT, { message });
        if (this.team.enabledChat !== true || this.chatMuted !== false) {
            this.request('/chat', TYPES.SET_TEAM_CHAT_MUTED, { disabled: false }, this.team.id,
                'chat unmute requested; waiting for server confirmation', message, 'awaiting-chat-enabled');
        } else {
            this.request('/chat', TYPES.TEAM_CHAT, { message }, this.team.id,
                'chat message sent; waiting for the server echo', message);
        }
        return this.pending;
    }

    unmuteChat() {
        const packet = encodeMessage(TYPES.SET_TEAM_CHAT_MUTED, { disabled: false });
        this.client.sendMessage(packet.id, packet.payload, packet.fields, packet.version);
        this.client.status('RoomCommands', 'chat unmute requested: SetTeamChatMutedMessage disabled=false', 'info', true);
    }

    request(command, id, fields, targetId, message, chatText = null, phase = null) {
        const packet = encodeMessage(id, fields);
        const waitingForName = [TYPES.TEAM_CREATE, TYPES.TEAM_JOIN].includes(id)
            && this.client.account.newAccountRequested && this.client.config.namesFile
            && this.client.accountName && !this.client.account.name;
        const pending = this.pending = { command, targetId, chatText,
            phase: waitingForName ? 'awaiting-name' : phase, packet, message };
        this.armRequestTimeout(pending);
        try {
            if (waitingForName) {
                this.resumeNameRequest();
                if (this.pending === pending) this.status(`${command}: waiting for profile name confirmation`);
            } else this.sendRequest(pending);
        } catch (error) {
            this.finishRequest();
            throw error;
        }
    }

    armRequestTimeout(pending) {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
            if (this.pending !== pending) return;
            this.pending = null;
            if (!this.client.config.piar)
                this.status(pending.phase === 'awaiting-name'
                    ? `${pending.command}: profile name was not confirmed; check ${this.client.config.namesFile}`
                    : `${pending.command}: no confirmation from the server after ${this.client.config.timeoutMs} ms`, 'warn');
        }, this.client.config.timeoutMs);
        pending.timer.unref();
    }

    sendRequest(pending) {
        const packet = pending.packet;
        this.client.sendMessage(packet.id, packet.payload, packet.fields, packet.version);
        if (!this.client.config.piar || pending.command !== '/joinRoom')
            this.status(`${pending.command}: ${pending.message}`);
    }

    resumeNameRequest() {
        const pending = this.pending;
        if (pending?.phase !== 'awaiting-name' || this.client.stopping) return;
        if (this.client.account.name) {
            pending.phase = null;
            this.armRequestTimeout(pending);
            try { this.sendRequest(pending); }
            catch (error) { this.finishRequest(); this.status(`${pending.command}: ${error.message}`, 'warn'); }
        } else if (this.client.accountName.failure) {
            this.finishRequest();
            this.status(`${pending.command}: profile name was not confirmed; ${this.client.accountName.failure}; check ${this.client.config.namesFile}`, 'warn');
        }
    }

    finishRequest() {
        const pending = this.pending;
        if (pending) clearTimeout(pending.timer);
        this.pending = null;
        return pending;
    }

    onPacket(id, fields) {
        if (this.client.state !== 'authenticated' || fields.parseError) return;
        if ([TYPES.OWN_HOME_DATA, TYPES.AVAILABLE_SERVER_COMMAND, TYPES.AVATAR_NAME_CHANGE_FAILED,
            TYPES.AVATAR_NAME_CHECK_RESPONSE].includes(id)) this.resumeNameRequest();
        if (id === TYPES.TEAM) {
            const team = fields.team;
            if (!team?.members) return;
            if (!team.members.some(member => sameId(member.accountId, this.client.account.accountId))) return;
            const enteringRoom = !sameId(this.team?.id, team.id);
            if (enteringRoom) { this.seenEntries.clear(); this.chatMuted = null; }
            const changed = JSON.stringify(this.team) !== JSON.stringify(team);
            this.team = team;
            const pending = this.pending;
            if (pending && (pending.command === '/createRoom'
                || (pending.command === '/joinRoom' && sameId(pending.targetId, team.id)))) {
                this.finishRequest();
                this.status(`${pending.command}: ${pending.command === '/createRoom' ? 'room created' : 'joined room'}; server confirmed with TeamMessage (24124)`);
                this.reportTeam(team);
                if (pending.command === '/createRoom') this.status(`join this room: /joinRoom ${team.code} (room ID ${team.id.join('-')})`);
            } else if (changed) this.reportTeam(team);
            if (enteringRoom && !this.client.config.piar) this.unmuteChat();
            this.sendWaitingChat();
        } else if (id === TYPES.AVAILABLE_SERVER_COMMAND && fields.command?.type === 221) {
            this.chatMuted = fields.command.muted;
            this.client.status('RoomCommands', `personal chat muted=${this.chatMuted}; server confirmed with command 221 (24111)`, 'info', true);
            this.sendWaitingChat();
        } else if (id === TYPES.TEAM_ERROR) {
            const pending = this.finishRequest();
            if (!this.client.config.piar) this.status(`${pending?.command ?? 'team'}: server rejected the request; errorCode ${fields.errorCode}, reason ${fields.reason}`
                + (pending?.targetId ? `; target ID ${pending.targetId.join('-')}` : '')
                + (fields.messages?.length ? `; ${JSON.stringify(fields.messages)}` : '')
                + (fields.values?.length ? `; values ${JSON.stringify(fields.values)}` : ''), 'warn');
        } else if (id === TYPES.TEAM_LEFT) {
            const pending = this.pending?.command === '/leaveRoom' ? this.finishRequest() : null;
            if (!pending && this.pending) {
                const cancelled = this.finishRequest();
                this.status(`${cancelled.command}: cancelled because the server removed us from the room`, 'warn');
            }
            this.team = null;
            this.seenEntries.clear();
            this.status(`${pending?.command ?? 'team'}: left room; server reason ${fields.reason}`);
        } else if (id === TYPES.TEAM_STREAM && sameId(fields.teamId, this.team?.id)) {
            for (const entry of fields.entries ?? []) {
                const key = entry.id.join('-');
                if (this.seenEntries.has(key)) continue;
                this.seenEntries.add(key);
                if (this.seenEntries.size > 1000) this.seenEntries.delete(this.seenEntries.values().next().value);
                if (entry.type !== 2) continue;
                this.status(`chat ${this.team.code}: ${JSON.stringify(entry.name)} (${entry.accountId.join('-')}): ${JSON.stringify(entry.message)}`);
                const pending = this.pending;
                if (pending?.command === '/chat' && sameId(entry.accountId, this.client.account.accountId)
                    && entry.message === pending.chatText) {
                    this.finishRequest();
                    this.status('/chat: delivery confirmed by TeamStreamMessage (24131)');
                }
            }
        }
    }

    sendWaitingChat() {
        if (this.pending?.phase !== 'awaiting-chat-enabled' || this.team?.enabledChat !== true
            || this.chatMuted !== false || !sameId(this.pending.targetId, this.team.id)) return;
        const waiting = this.finishRequest();
        this.request('/chat', TYPES.TEAM_CHAT, { message: waiting.chatText }, this.team.id,
            'chat enabled by server; message sent, waiting for the server echo', waiting.chatText);
    }

    reportTeam(team) {
        const owner = team.members.find(member => member.isOwner);
        this.status(`room ${team.code}; ID ${team.id.join('-')} (${team.decimalId}); `
            + `type ${team.type}; eventSlot ${team.eventSlot}; location ${team.location.join('-')}; `
            + `members ${team.members.length}/${team.capacity}; owner ${owner?.accountId.join('-') ?? 'unknown'}; `
            + `chat ${team.enabledChat === undefined ? 'unknown' : team.enabledChat ? 'enabled' : 'disabled'}`);
        for (const member of team.members) this.status(`member ${member.accountId.join('-')}: `
            + `${JSON.stringify(member.displayData.name)}; character ${member.character.join('-')}; `
            + `trophies ${member.trophies}; ready ${member.isReady}; state ${member.state}`
            + `${member.isOwner ? '; owner' : ''}`);
    }

    close() {
        const pending = this.finishRequest();
        if (pending && !this.client.config.piar)
            this.status(`${pending.command}: connection closed before server confirmation`, 'warn');
    }
}

const SPECTATE_USAGE = 'Usage: /spectate #TAG N true|false (N: positive integer, 0 or unlimited); /spectate stop';

function parseSpectate(line) {
    const parts = line.trim().split(/\s+/);
    if (parts[0]?.toLowerCase() !== '/spectate') return null;
    if (parts.length === 2 && parts[1].toLowerCase() === 'stop') return { stop: true };
    if (parts.length !== 4) throw new Error(SPECTATE_USAGE);
    const targetId = playerId(parts[1]);
    const count = parts[2].toLowerCase() === 'unlimited' ? 0
        : /^\d+$/.test(parts[2]) ? Number(parts[2]) : NaN;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(SPECTATE_USAGE);
    const flag = parts[3].toLowerCase();
    if (flag !== 'true' && flag !== 'false') throw new Error(SPECTATE_USAGE);
    return { player: parts[1], targetId, count, brawlTv: flag === 'true' };
}

class SpectateCommands {
    constructor(client, logger, Runner) {
        this.client = client;
        this.logger = logger;
        this.Runner = Runner;
        this.runner = null;
        this.task = null;
    }

    status(message, level = 'info') { this.logger.info('SpectateCommands', message, level); }

    execute(line) {
        let command;
        try { command = parseSpectate(line); }
        catch (error) { this.status(error.message, 'warn'); return; }
        if (!command) return this.client.rooms.execute(line);
        if (command.stop) {
            if (!this.runner) return this.status('No spectator bots are running');
            this.runner.interrupt();
            this.status('Stopping spectator bots');
            return;
        }
        if (this.client.state !== 'authenticated' || this.client.stopping)
            return this.status('Wait for LoginOk before using /spectate', 'warn');
        if (this.runner) return this.status('Spectator bots are already running; use /spectate stop first', 'warn');
        if (this.client.config.loginPayload !== null)
            return this.status('/spectate requires normal Login; --login-file/--login-hex reuse one account', 'warn');
        try {
            const config = { ...this.client.config, piar: false, hi: 0, lo: 0, token: null,
                spectatePlayer: command.player, spectateTarget: command.targetId,
                spectateBots: command.count, spectateBrawlTv: command.brawlTv };
            const runner = new this.Runner(config, this.logger);
            this.runner = runner;
            this.status(`Starting ${command.count || 'unlimited'} spectator bots for ${command.player}; Brawl TV: ${command.brawlTv}`);
            this.task = runner.run().catch(error => this.status(error.message, 'error')).finally(() => {
                if (this.runner === runner) this.runner = null;
            });
        } catch (error) { this.status(error.message, 'warn'); }
    }

    async close() {
        this.runner?.interrupt();
        await this.task;
    }
}

class CommandConsole {
    constructor(commands, input = process.stdin) { this.commands = commands; this.input = input; this.reader = null; }
    start() {
        this.reader = readline.createInterface({ input: this.input, terminal: false, crlfDelay: Infinity });
        this.reader.on('line', line => this.commands.execute(line));
        this.reader.on('error', error => this.commands.status(`stdin: ${error.message}`, 'warn'));
    }
    close() { this.reader?.close(); this.input.pause(); this.reader = null; }
}

module.exports = { RoomCommands, SpectateCommands, CommandConsole, sameId, parseSpectate, SPECTATE_USAGE };
