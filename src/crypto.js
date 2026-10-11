'use strict';
const { randomBytes, timingSafeEqual, generateKeyPairSync, createPublicKey, diffieHellman } = require('node:crypto');
const nacl = require('../vendor/tweetnacl/nacl');
const blake2b = require('../vendor/blakejs/blake2b');

const X25519_PUBLIC_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const SALSA_CONSTANT = Buffer.from('expand 32-byte k');

function nonceHash(...parts) {
    const hash = blake2b.blake2bInit(24);
    for (const part of parts) blake2b.blake2bUpdate(hash, part);
    return Buffer.from(blake2b.blake2bFinal(hash));
}

function incrementNonce(nonce) {
    const result = Buffer.from(nonce);
    let carry = 2;
    for (let i = 0; i < result.length && carry; i++) {
        carry += result[i];
        result[i] = carry & 0xff;
        carry >>>= 8;
    }
    if (carry) throw new Error('Pepper nonce exhausted');
    return result;
}

class PepperSession {
    constructor(serverPublicKey) {
        this.serverPublic = Buffer.from(serverPublicKey, 'hex');
        if (this.serverPublic.length !== 32) throw new Error('Server public key must contain 32 bytes');
        const { privateKey, publicKey } = generateKeyPairSync('x25519');
        const peer = createPublicKey({ key: Buffer.concat([X25519_PUBLIC_PREFIX, this.serverPublic]),
            format: 'der', type: 'spki' });
        this.clientPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
        const shared = diffieHellman({ privateKey, publicKey: peer });
        this.key = Buffer.alloc(32);
        nacl.lowlevel.crypto_core_hsalsa20(this.key, Buffer.alloc(16), shared, SALSA_CONSTANT);
        shared.fill(0);
        this.clientNonce = randomBytes(24);
        this.clientNonce[0] &= 0xfe;
        this.serverNonce = null;
        this.token = null;
        this.sessionResponse = null;
        this.loginSent = false;
    }

    acceptHello(token, sessionResponse = Buffer.alloc(0)) {
        if (this.token) throw new Error('Duplicate ServerHello');
        if (!token || !token.length) throw new Error('ServerHello contains an empty token');
        this.token = Buffer.from(token);
        this.sessionResponse = Buffer.from(sessionResponse);
        if (this.sessionResponse.length > 255)
            throw new Error('Native Login session response must fit in one length byte');
    }

    seal(id, plain) {
        if (id === 10100) return Buffer.from(plain);
        if (id === 10101) {
            if (!this.token || this.loginSent) throw new Error('Login requires one ServerHello');
            const inner = Buffer.concat([Buffer.from([this.sessionResponse.length]),
                this.sessionResponse, this.clientNonce, plain]);
            this.loginEnvelope = inner;
            const encrypted = nacl.secretbox(inner,
                nonceHash(this.clientPublic, this.serverPublic), this.key);
            this.loginSent = true;
            return Buffer.concat([this.clientPublic, encrypted]);
        }
        if (!this.serverNonce) throw new Error('Cannot send an encrypted message before the Login response');
        this.clientNonce = incrementNonce(this.clientNonce);
        return Buffer.from(nacl.secretbox(plain, this.clientNonce, this.key));
    }

    open(wire) {
        if (!this.loginSent) throw new Error('Encrypted server response arrived before Login');
        const first = this.serverNonce === null;
        const nonce = first ? nonceHash(this.clientNonce, this.clientPublic, this.serverPublic)
            : incrementNonce(this.serverNonce);
        const plain = nacl.secretbox.open(wire, nonce, this.key);
        if (!plain) throw new Error('Pepper authentication failed: cannot decrypt the server response');
        if (first) {
            if (plain.length < 56) throw new Error('Truncated Pepper session header');
            this.serverNonce = Buffer.from(plain.subarray(0, 24));
            this.key = Buffer.from(plain.subarray(24, 56));
            return Buffer.from(plain.subarray(56));
        }
        this.serverNonce = nonce;
        return Buffer.from(plain);
    }
}

class UdpCipher {
    constructor(material) {
        if (!Buffer.isBuffer(material) || material.length !== 80)
            throw new Error('UDP encryption requires 80 bytes of key material');
        this.key = Buffer.from(material.subarray(0, 32));
        this.inboundNonce = Buffer.from(material.subarray(32, 56));
        this.outboundNonce = Buffer.from(material.subarray(56, 80));
        this.counter = randomBytes(4).readUInt32LE(0);
        this.sent = 0;
    }

    nonce(base, tag) {
        const nonce = Buffer.from(base);
        for (let i = 0; i < nonce.length; i++) nonce[i] ^= tag[i & 3];
        return nonce;
    }

    seal(plain) {
        if (this.sent >= 0x100000000) throw new Error('UDP nonce exhausted');
        const tag = Buffer.allocUnsafe(4);
        tag.writeUInt32LE((this.counter + this.sent++) >>> 0);
        const sealed = Buffer.from(nacl.secretbox(plain, this.nonce(this.outboundNonce, tag), this.key));
        return Buffer.concat([tag, sealed.subarray(12)]);
    }

    open(wire) {
        if (wire.length < 8) return null;
        const nonce = this.nonce(this.inboundNonce, wire.subarray(0, 4));
        const ciphertext = wire.subarray(8);
        const stream = Buffer.alloc(32 + ciphertext.length), mac = Buffer.alloc(16);
        nacl.lowlevel.crypto_stream(stream, 0, stream.length, nonce, this.key);
        nacl.lowlevel.crypto_onetimeauth(mac, 0, ciphertext, 0, ciphertext.length, stream.subarray(0, 32));
        if (!timingSafeEqual(mac.subarray(12), wire.subarray(4, 8))) return null;
        const plain = stream.subarray(32);
        for (let i = 0; i < plain.length; i++) plain[i] ^= ciphertext[i];
        return plain;
    }

    close() {
        this.key.fill(0);
        this.inboundNonce.fill(0);
        this.outboundNonce.fill(0);
        this.sent = 0x100000000;
    }
}

module.exports = { PepperSession, UdpCipher };
