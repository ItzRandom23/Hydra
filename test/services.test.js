const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { test } = require('node:test');
const mongoose = require('mongoose');
const { Manager, ManagerEventTypes } = require('pulsifyy');
const { Settings, models } = require('../Src/Models/Settings');
const { GuildTasks } = require('../Src/Handler/Runtime');

const mongoAddress = process.env.HYDRA_TEST_MONGO;
const lavaPort = process.env.HYDRA_TEST_LAVALINK_PORT;
const guildId = '100000000000000031';
const userId = '100000000000000032';
const channelId = '100000000000000033';
const messageId = '100000000000000034';

test('real MongoDB preserves legacy collections and recovers from a disconnected client', { skip: !mongoAddress, timeout: 15_000 }, async t => {
    assert.match(mongoAddress, /^127\.0\.0\.1:\d{1,5}$/);
    const dbName = `hydra_test_${randomUUID().replaceAll('-', '')}`;
    const uri = `mongodb://${mongoAddress}/${dbName}`;
    const options = { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 };
    await mongoose.connect(uri, options);
    t.after(async () => {
        if (mongoose.connection.name === dbName && mongoose.connection.readyState === 1) {
            await mongoose.connection.dropDatabase();
        }
        await mongoose.disconnect();
    });
    assert.deepEqual(Object.values(models).map(model => model.collection.name),
        ['prefix-schemas', 'dj-schemas', 'announce_schemas', '247-schemas', 'setup-schemas']);
    const prefix = mongoose.connection.collection('prefix-schemas');
    await prefix.insertOne({ _id: guildId, prefix: '?', oldPrefix: '!', moderator: userId, lastUpdated: 'NaN' });
    const settings = new Settings('!');
    assert.equal(await settings.prefix(guildId), '?');

    const jobs = new GuildTasks();
    await Promise.all(Array.from({ length: 5 }, (_, index) => jobs.run(guildId, () =>
        settings.update('prefix', guildId, userId, { prefix: String(index), oldPrefix: '?' }),
    )));
    assert.equal(await prefix.countDocuments({ _id: guildId }), 1);
    assert.equal(await settings.prefix(guildId), '4');
    await assert.rejects(settings.update('prefix', guildId, userId, { prefix: 'too-long' }), { name: 'ValidationError' });
    assert.equal(await settings.prefix(guildId), '4');

    await settings.update('setup', guildId, userId, { channel: channelId, message: messageId, setuped: true });
    await settings.remove('setup', guildId, { message: channelId });
    assert.equal((await settings.get('setup', guildId)).message, messageId);
    await settings.remove('setup', guildId, { message: messageId });
    assert.equal(await settings.get('setup', guildId), null);
    await settings.update('stay', guildId, userId, { mode: true, textChannel: channelId, voiceChannel: channelId });
    assert.deepEqual(await settings.staying([guildId]), [{ _id: guildId }]);

    const freshGuild = '100000000000000035';
    await mongoose.disconnect();
    await assert.rejects(settings.get('prefix', freshGuild));
    await mongoose.connect(uri, options);
    assert.equal(await settings.prefix(freshGuild), '!');
});

function wave() {
    const samples = 8000;
    const header = Buffer.alloc(44 + samples * 2);
    header.write('RIFF');
    header.writeUInt32LE(header.length - 8, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(samples, 24);
    header.writeUInt32LE(samples * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(samples * 2, 40);
    return header;
}

test('real Lavalink v4 authenticates, opens a resumable session and loads a local audio fixture',
    { skip: !lavaPort, timeout: 15_000 }, async t => {
        assert.match(lavaPort, /^\d{1,5}$/);
        const dir = await mkdtemp(path.join(tmpdir(), 'hydra-lavalink-fixture-'));
        const manager = new Manager({
            send: () => {}, sessionDataPath: dir,
            nodes: [{
                identifier: 'test', host: '127.0.0.1', port: Number(lavaPort),
                password: process.env.HYDRA_TEST_LAVALINK_PASSWORD, useSSL: false,
                enableSessionResumeOption: true, apiRequestTimeoutMs: 2000, maxRetryAttempts: 0,
            }],
        });
        t.after(async () => {
            try { await manager.handleShutdown(); }
            finally { await rm(dir, { recursive: true, force: true }); }
        });
        const ready = once(manager, ManagerEventTypes.NodeConnect);
        manager.init(userId);
        const [node] = await ready;
        assert(node.connected);
        assert.equal(node.info.version.major, 4);
        assert(node.info.sourceManagers.includes('local'));
        const file = path.join(dir, 'fixture.wav');
        await writeFile(file, wave());
        const result = await node.rest.get('/v4/loadtracks?identifier=' + encodeURIComponent(file));
        assert.equal(result.loadType, 'track');
        const track = await manager.decodeTrack(result.data.encoded);
        assert.equal(track.info.length, 1000);
    });
