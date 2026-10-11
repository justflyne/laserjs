#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ScFileDump } = require('../src/logging');

async function main(args) {
    if (!args.length || args.includes('--help')) {
        console.log(`SC из расшифрованного OwnHomeData (24101):
  node tools/dump-sc.js dumps/24101.bin
  node tools/dump-sc.js dumps/24101.bin --out ./sc --url https://event-assets.brawlstars.com

Результат: sc/index.json в директории клиента (имя .sc → SHA-1) и сами .sc файлы.
Повторный --url добавляет резервный CDN. Хэш проверяется до сохранения файла.`);
        return;
    }
    const packet = path.resolve(args[0]);
    let directory = path.resolve(__dirname, '..', 'sc'), urls = null;
    for (let i = 1; i < args.length; i++) {
        const option = args[i], value = args[++i];
        if (value === undefined) throw new Error(`Missing value for ${option}`);
        if (option === '--out') directory = path.resolve(value);
        else if (option === '--url') {
            if (!['http:', 'https:'].includes(new URL(value).protocol)) throw new Error('SC URL must use HTTP or HTTPS');
            (urls ||= []).push(value);
        } else throw new Error(`Unknown option ${option}`);
    }
    const dump = new ScFileDump({ directory, urls, onEvent: event => {
        if (event.kind === 'index') console.log(`SC::index: ${event.count} files → ${event.path}`);
        else if (event.kind === 'error') console.error(`SC::error: ${event.name || ''} ${event.message}`);
        else console.log(`SC::${event.kind}: ${event.name} (${event.hash})${event.length ? ` ${event.length} bytes` : ''}`);
    } });
    const interrupt = () => { dump.cancel(); process.exitCode = 130; };
    process.once('SIGINT', interrupt);
    try {
        const login = path.join(path.dirname(packet), '20104.bin');
        if (fs.existsSync(login)) dump.observeLogin(fs.readFileSync(login));
        const count = dump.enqueue(fs.readFileSync(packet));
        if (!count) console.log('SC::index: no .sc references found in this packet');
        await dump.drain();
        if (dump.failures) process.exitCode = 1;
    } finally { process.removeListener('SIGINT', interrupt); }
}

main(process.argv.slice(2)).catch(error => {
    console.error(`SC dump: ${error.message}`);
    process.exitCode = 1;
});
