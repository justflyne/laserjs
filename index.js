#!/usr/bin/env node
'use strict';
const { parseConfig, help } = require('./src/config');
const { ConsoleLogger, PacketJournal } = require('./src/logging');
const { ProtocolClient, AccountManager } = require('./src/client');
const { PiarRunner } = require('./src/bots');
const { SpectateCommands, CommandConsole } = require('./src/commands');

async function main(args = process.argv.slice(2)) {    
    if (args.includes('--help') || args.includes('-h')) {
        process.stdout.write(help() + '\n');
        return 0;
    }
    if (args.includes('--piar') || args.includes('-piar-bots')) {
        process.stdout.write('supercell fixed that thing\n');
        return 0;
    }
    let journal;
    let logger;
    let interrupt;
    let commandConsole;
    let specCommands;
    try {
        const config = parseConfig(args);
        logger = new ConsoleLogger(config);
        logger.start();
        if (config.piar || config.spectateTarget) {
            const runner = new PiarRunner(config, logger);
            interrupt = () => runner.interrupt();
            process.once('SIGINT', interrupt);
            process.once('SIGTERM', interrupt);
            return await runner.run();
        }
        journal = new PacketJournal(config.logPath);
        journal.record({ kind: 'session', brand: config.brand, host: config.host, port: config.port,
            version: `${config.major}.${config.minor}.${config.build}`, hash: config.hash,
            cryptoVersion: config.cryptoVersion, serverPublicKey: config.serverPublicKey,
            configFile: config.configFile });
        const account = new AccountManager(config);
        account.init(logger);
        if (config.logPath && config.verbose) logger.info('PacketJournal::open', `full traffic: ${config.logPath}`);
        const client = new ProtocolClient({ config, logger, journal, account });
        specCommands = new SpectateCommands(client, logger, PiarRunner);
        commandConsole = client.commandConsole = new CommandConsole(specCommands);
        interrupt = () => { specCommands.runner?.interrupt(); client.interrupt(); };
        process.once('SIGINT', interrupt);
        const session = client.run();
        commandConsole.start();
        const result = await session;
        return result.exitCode;
    } catch (error) {
        (logger || new ConsoleLogger({ showBanner: false })).info('Client::onError', error.message, 'error');
        return 1;
    } finally {
        if (interrupt) process.removeListener('SIGINT', interrupt);
        if (interrupt) process.removeListener('SIGTERM', interrupt);
        commandConsole?.close();
        await specCommands?.close();
        if (journal) journal.close();
    }
}

module.exports = { main, ProtocolClient };

if (require.main === module) {
    main().then(code => { process.exitCode = code; }, error => {
        process.stderr.write(`Client::onError: ${error.message}\n`);
        process.exitCode = 1;
    });
}
