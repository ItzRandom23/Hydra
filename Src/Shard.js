const mongoose = require('mongoose');
const { Hydra } = require('./Base/Client');
const { ConfigError, readConfig } = require('./Config');
const { log } = require('./Utility/Console');

async function start() {
    const config = readConfig();
    /** @type {InstanceType<typeof Hydra> | undefined} */
    let client;
    let shutdown;
    let stopping = false;
    const stop = code => {
        stopping = true;
        process.exitCode = Math.max(Number(process.exitCode) || 0, code);
        shutdown ??= (async () => {
            const deadline = setTimeout(() => {
                log('Shutdown deadline exceeded');
                process.exit(1);
            }, 25_000);
            deadline.unref();
            try { await client?.close(); }
            catch (error) {
                log('Discord or audio shutdown failed', error);
                process.exitCode = 1;
            } finally {
                try { await mongoose.disconnect(); }
                catch (error) {
                    log('MongoDB shutdown failed', error);
                    process.exitCode = 1;
                }
                clearTimeout(deadline);
            }
        })();
        return shutdown;
    };

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => { void stop(0); });
    }
    mongoose.connection.on('error', error => log('MongoDB connection error', error));
    mongoose.connection.on('disconnected', () => { if (!stopping) log('MongoDB disconnected'); });
    mongoose.connection.on('reconnected', () => {
        log('MongoDB reconnected');
        if (!stopping) client?.music.restoreConfigured();
    });
    try {
        await mongoose.connect(config.mongoUri, {
            serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000,
            socketTimeoutMS: 8000, waitQueueTimeoutMS: 5000, maxPoolSize: 20, autoIndex: false,
        });
        if (stopping) return;
        log('MongoDB connected');
        client = new Hydra(config);
        await client.login(config.token);
    } catch (error) {
        if (!stopping) log('Startup failed. Verify MongoDB availability and the Discord application settings', error);
        await stop(stopping ? 0 : 1);
    }
}

if (require.main === module) {
    void start().catch(error => {
        log(error instanceof ConfigError ? error.message : 'Startup failed', error);
        process.exitCode = 1;
    });
}

module.exports = { start };
