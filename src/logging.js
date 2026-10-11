'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { randomUUID } = crypto;
const { execFile } = require('node:child_process');
const { messageName, savePacketExport } = require('./protocol/messageFactory');
const { extractScFiles, fileName } = require('./protocol/protocol');

const DEFAULT_BANNER = [
    '   __   ___   ___________     ______',
    '  / /  / _ | / __/ __/ _ \\__ / / __/',
    ' / /__/ __ |_\\ \\/ _// , _/ // /\\ \\  ',
    '/____/_/ |_/___/___/_/|_|\\___/___/',
];

class ConsoleLogger {
    constructor({ color = 'auto', verbose = false, hex = false, brand = 'laserjs',
        banner = DEFAULT_BANNER, showBanner = true, output = process.stdout } = {}) {
        this.output = output;
        this.verbose = verbose;
        this.hex = hex;
        this.brand = brand;
        this.banner = banner;
        this.showBanner = showBanner;
        this.color = color === 'always' || (color === 'auto' && !('NO_COLOR' in process.env)
            && (Boolean(output.isTTY) || (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0')));
    }
    paint(code, text) { return this.color ? `\x1b[${code}m${text}\x1b[0m` : String(text); }
    number(value) { return this.paint('1;33', value); }
    line(text) { this.output.write(`${text}\n`); }
    start() {
        if (!this.showBanner) return;
        this.line('');
        const lines = Array.isArray(this.banner) ? this.banner : String(this.banner || this.brand).split('\n');
        for (const line of lines) this.line(this.paint('1;94', line));
        this.line('');
        this.line(this.paint('1;92', `${this.brand} · made by t.me/justflyne (design of logs by tailsjs)`));
        this.line('');
    }
    info(scope, message, level = 'info') {
        const code = level === 'error' ? '1;91' : level === 'warn' ? '1;95' : '1;96';
        this.line(`${this.paint(code, `${scope}:`)} ${this.paint('1;37', message)}`);
    }
    packet(event) {
        if (event.id === 10108 || event.id === 20108) return;
        const sending = event.direction === 'TX';
        const method = sending ? 'Messaging::send' : 'Messaging::nextMessage';
        const action = sending ? 'sent' : 'received';
        const detail = `${action} ${event.name || messageName(event.id)} with type ${this.number(event.id)}`;
        this.info(method, detail);
        if (this.verbose) {
            this.info('Messaging::packet', `${event.direction} v${event.version}, ${event.length} wire bytes, ${event.plainLength ?? '?'} plain bytes`);
            if (event.fields) this.info('Messaging::fields', JSON.stringify(event.fields));
        }
        if (this.hex) {
            this.info('Messaging::wire', event.payloadHex);
            if (event.plainHex !== undefined) this.info('Messaging::plain', event.plainHex);
            if (event.envelopeHex !== undefined) this.info('Messaging::envelope', event.envelopeHex);
        }
    }
}

class PacketJournal {
    constructor(file) {
        this.session = randomUUID();
        this.sequence = 0;
        this.file = file;
        this.fd = null;
        if (file) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            this.fd = fs.openSync(file, 'a', 0o600);
        }
    }
    record(event) {
        const entry = { at: new Date().toISOString(), session: this.session,
            sequence: ++this.sequence, ...event };
        if (this.fd !== null) fs.writeFileSync(this.fd, JSON.stringify(entry) + '\n');
        return entry;
    }
    close() {
        if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
    }
}

class PacketDump {
    constructor(directory, { code = true,
        nativeLibrary = path.resolve(__dirname, '../../v69.230_arm64.so'),
        onEvent = () => {} } = {}) {
        this.directory = directory || null;
        this.code = code;
        this.nativeLibrary = nativeLibrary;
        this.onEvent = onEvent;
        this.pending = Promise.resolve();
        this.generations = new Map();
        this.children = new Set();
        this.cancelled = false;
        this.failures = 0;
        if (this.directory) fs.mkdirSync(this.directory, { recursive: true });
    }

    save(id, plain, { version = 0, frame = null, fields = null } = {}) {
        if (!this.directory) return null;
        if (!Number.isInteger(id) || id < 0 || id > 0xffff) throw new Error('Invalid dump packet ID');
        plain = Buffer.from(plain);
        const file = path.join(this.directory, `${id}.bin`);
        const generation = (this.generations.get(id) || 0) + 1;
        this.generations.set(id, generation);
        fs.writeFileSync(file, plain, { mode: 0o600 });
        if (frame) fs.writeFileSync(path.join(this.directory, `${id}.frame.bin`), frame, { mode: 0o600 });
        if (this.code) {
            const context = { version, fields, header: frame ? { id, version,
                wireLength: frame.length - 7, headerHex: frame.subarray(0, 7).toString('hex'),
                frameFile: `${id}.frame.bin` } : null };
            fs.rmSync(path.join(this.directory, `${id}.trace.json`), { force: true });
            savePacketExport(file, id, plain, null, { ...context, parseStatus: 'pending' });
            this.pending = this.pending.then(() => this.analyze(id, plain, file, generation, context))
                .catch(error => {
                    this.failures++;
                    this.onEvent({ id, kind: 'error', error: error.message });
                });
        }
        return file;
    }

    nativeTrace(id, plain, version) {
        return new Promise((resolve, reject) => {
            const root = path.resolve(__dirname, '..');
            const pythonPath = [path.join(root, '.analysis-python'), process.env.PYTHONPATH]
                .filter(Boolean).join(path.delimiter);
            const child = execFile('python3', [path.join(root, 'tools/trace-ohd.py'), '-',
                this.nativeLibrary, '-', '--id', String(id), '--version', String(version)],
            { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
                env: { ...process.env, PYTHONPATH: pythonPath } }, (error, stdout, stderr) => {
                this.children.delete(child);
                if (error) return reject(new Error(stderr.trim() || error.message));
                try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
            });
            this.children.add(child);
            child.stdin.on('error', () => {});
            child.stdin.end(plain);
        });
    }

    async analyze(id, plain, file, generation, context) {
        if (this.generations.get(id) !== generation) return;
        let trace = null, error = null;
        if (!this.cancelled) {
            try { trace = await this.nativeTrace(id, plain, context.version); }
            catch (failure) { error = failure.message; }
        }
        if (this.generations.get(id) !== generation) return;
        let exported;
        try {
            exported = savePacketExport(file, id, plain, trace, { ...context,
                ...(this.cancelled ? { parseStatus: 'cancelled' } : error ? { parseStatus: 'partial', error } : {}) });
        } catch (failure) {
            error = failure.message;
            trace = null;
            exported = savePacketExport(file, id, plain, null, { ...context, parseStatus: 'partial', error });
        }
        if (trace) fs.writeFileSync(path.join(this.directory, `${id}.trace.json`),
            JSON.stringify(trace) + '\n', { mode: 0o600 });
        if (exported.parseStatus !== 'complete') this.failures++;
        this.onEvent({ kind: 'analyzed', ...exported });
    }

    drain() { return this.pending; }

    cancel() {
        this.cancelled = true;
        for (const child of this.children) child.kill();
    }
}

const DEFAULT_SC_URLS = Object.freeze(['https://event-assets.brawlstars.com',
    'https://event-assets-2.brawlstars.com']);
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const sha1 = bytes => crypto.createHash('sha1').update(bytes).digest('hex');

function eventAssetUrls(payload) {
    const urls = new Set();
    for (let offset = 0; offset + 4 < payload.length; offset++) {
        const length = payload.readInt32BE(offset);
        if (length < 8 || length > 1024 || offset + 4 + length > payload.length) continue;
        const value = payload.subarray(offset + 4, offset + 4 + length).toString('utf8');
        if (!value.startsWith('https://')) continue;
        try {
            const url = new URL(value);
            if (/^event-assets(?:-\d+)?\./i.test(url.hostname)) urls.add(value.replace(/\/+$/, ''));
        } catch {   }
    }
    return [...urls];
}

function assetUrl(base, name) {
    const url = new URL(base);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('SC URL must use HTTP or HTTPS');
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${name.split('/').map(encodeURIComponent).join('/')}`;
    return url.href;
}

class ScFileDump {
    constructor({ directory, urls = null, timeoutMs = 15000, onEvent = () => {} }) {
        this.directory = path.resolve(directory);
        this.urls = urls?.length ? [...urls] : [...DEFAULT_SC_URLS];
        this.configuredUrls = !!urls?.length;
        this.timeoutMs = timeoutMs;
        this.onEvent = onEvent;
        this.pending = Promise.resolve();
        this.controllers = new Set();
        this.cancelled = false;
        this.failures = 0;
    }

    observeLogin(payload) {
        if (this.configuredUrls) return;
        const urls = eventAssetUrls(payload);
        if (urls.length) this.urls = urls;
    }

    enqueue(payload) {
        const files = extractScFiles(payload);
        if (!Object.keys(files).length) return 0;
        this.pending = this.pending.then(() => this.save(files)).catch(error => {
            this.failures++;
            this.onEvent({ kind: 'error', message: error.message });
        });
        return Object.keys(files).length;
    }

    async save(files) {
        if (this.cancelled) return;
        fs.mkdirSync(this.directory, { recursive: true });
        const indexFile = path.join(this.directory, 'index.json');
        const existing = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
        const merged = new Map();
        for (const [name, hash] of Object.entries(existing)) {
            if (fileName(name) === name && typeof hash === 'string' && /^[a-f0-9]{40}$/i.test(hash))
                merged.set(name, hash.toLowerCase());
        }
        for (const entry of Object.entries(files)) merged.set(...entry);
        const index = Object.fromEntries([...merged].sort(([a], [b]) => a.localeCompare(b)));
        this.writeFile(indexFile, Buffer.from(`${JSON.stringify(index, null, 2)}\n`));
        this.onEvent({ kind: 'index', path: indexFile, count: Object.keys(files).length });
        const entries = Object.entries(files);
        let next = 0;
        const worker = async () => {
            while (!this.cancelled && next < entries.length) {
                const [name, hash] = entries[next++];
                await this.download(name, hash);
            }
        };
        const results = await Promise.allSettled(Array.from({ length: Math.min(3, entries.length) }, worker));
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
    }

    writeFile(file, bytes) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.${crypto.randomUUID()}.part`;
        try {
            fs.writeFileSync(temporary, bytes, { mode: 0o600 });
            fs.renameSync(temporary, file);
        } finally {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
    }

    async download(name, hash) {
        const file = path.join(this.directory, name);
        if (fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size <= MAX_FILE_BYTES
            && sha1(fs.readFileSync(file)) === hash) {
            this.onEvent({ kind: 'cached', name, hash, path: file });
            return;
        }
        let lastError;
        for (const base of this.urls) {
            if (this.cancelled) return;
            const controller = new AbortController();
            this.controllers.add(controller);
            const timer = setTimeout(() => controller.abort(new Error('SC download timed out')), this.timeoutMs);
            let url = base;
            try {
                url = assetUrl(base, name);
                const response = await fetch(url, { signal: controller.signal });
                if (!response.ok) {
                    await response.body?.cancel();
                    throw new Error(`HTTP ${response.status}`);
                }
                if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES)
                    throw new Error('SC file exceeds 64 MiB');
                const chunks = [];
                let length = 0;
                for await (const chunk of response.body) {
                    length += chunk.length;
                    if (length > MAX_FILE_BYTES) throw new Error('SC file exceeds 64 MiB');
                    chunks.push(Buffer.from(chunk));
                }
                const bytes = Buffer.concat(chunks, length);
                const actual = sha1(bytes);
                if (actual !== hash) throw new Error(`SHA-1 mismatch: expected ${hash}, received ${actual}`);
                this.writeFile(file, bytes);
                this.onEvent({ kind: 'saved', name, hash, path: file, url, length });
                return;
            } catch (error) {
                lastError = `${url}: ${error.message}`;
                controller.abort();
            } finally {
                clearTimeout(timer);
                this.controllers.delete(controller);
            }
        }
        if (!this.cancelled) {
            this.failures++;
            this.onEvent({ kind: 'error', name, hash, message: lastError || 'No SC asset URLs configured' });
        }
    }

    drain() { return this.pending; }
    cancel() {
        this.cancelled = true;
        for (const controller of this.controllers) controller.abort();
    }
}

module.exports = { ConsoleLogger, DEFAULT_BANNER, PacketJournal, PacketDump, ScFileDump, extractScFiles, eventAssetUrls, DEFAULT_SC_URLS };
