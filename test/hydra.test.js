const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { ChannelType, Events, PermissionsBitField } = require('discord.js');
const { ManagerEventTypes } = require('pulsifyy');
const { Hydra } = require('../Src/Base/Client');
const { readConfig } = require('../Src/Config');
const { createLavalinkFixture } = require('./support/lavalink');

const guildId = '100000000000000011';
const botId = '100000000000000012';
const userId = '100000000000000013';
const roleId = '100000000000000014';
const voiceId = '100000000000000015';
const textId = '100000000000000016';
const requestId = '100000000000000017';
const perms = new PermissionsBitField(PermissionsBitField.All);

async function eventually(check) {
    for (let i = 0; i < 150; i++) {
        if (check()) return;
        await delay(20);
    }
    assert.fail('The expected condition was not reached');
}

function fakeGuild(client, id) {
    const messages = new Map();
    const responses = [];
    let uniqueId = 100000000000000100n;
    const makeMessage = payload => {
        const attachments = new Map();
        const addFiles = options => {
            for (const file of options.files ?? []) {
                const id = String(uniqueId++);
                const imageEmbed = options.embeds?.find(item => item.data.image?.url === `attachment://${file.name}`);
                if (imageEmbed) imageEmbed.setImage(`https://cdn.discordapp.com/attachments/10/${id}/${file.name}`);
                else attachments.set(id, { id, name: file.name });
            }
        };
        addFiles(payload);
        const message = {
            id: String(uniqueId++), deletable: true, payload, attachments,
            get embeds() { return this.payload.embeds?.map(item => item.data ?? item) ?? []; },
            async edit(options) {
                if (options.attachments) {
                    const retained = new Set(options.attachments.map(attachment => attachment.id));
                    for (const id of attachments.keys()) if (!retained.has(id)) attachments.delete(id);
                }
                addFiles(options);
                this.lastEdit = options;
                this.payload = { ...this.payload, ...options };
                return this;
            },
            async delete() { messages.delete(this.id); },
        };
        messages.set(message.id, message);
        responses.push(message);
        return message;
    };
    const channel = channelId => ({
        id: channelId, type: ChannelType.GuildText, isThread: () => false, isSendable: () => true, isVoiceBased: () => false,
        permissionsFor: () => perms, send: async payload => makeMessage(payload),
        messages: {
            cache: messages,
            fetch: async id => messages.get(id),
            edit: async (message, payload) => (typeof message === 'string' ? messages.get(message) : message).edit(payload),
        },
        createInvite: async opts => ({ url: 'https://discord.gg/fixture', opts }),
    });
    const voice = { id: voiceId, type: ChannelType.GuildVoice, isVoiceBased: () => true, permissionsFor: () => perms, members: new Map() };
    voice.members.some = predicate => [...voice.members.values()].some(predicate);
    const text = channel(textId);
    const requests = channel(requestId);
    const member = { permissions: perms, voice: { channel: voice, channelId: voiceId }, roles: { cache: new Map() } };
    voice.members.set(userId, { ...member, id: userId, user: { id: userId, bot: false } });
    const packets = [];
    const guild = {
        id, available: true, memberCount: 2,
        members: { me: { permissions: perms, voice: { channelId: voiceId } }, fetch: async () => voice.members },
        roles: { cache: new Map([[roleId, { id: roleId }]]) },
        channels: {
            cache: new Map([[voice.id, voice], [text.id, text]]),
            create: async () => { guild.channels.cache.set(requests.id, requests); return requests; },
        },
        shard: { ping: 5, send: packet => packets.push(packet) },
    };
    client.guilds.cache.set(id, guild);
    const context = () => ({
        client, guild, user: { id: userId }, member, channel: text, channelId: text.id,
        reply: async value => makeMessage(value),
        say: async (body, title) => makeMessage({ body, title }),
    });
    return { guild, context, messages, responses, packets, text, voice, requests, makeMessage };
}

function fakeSettings() {
    const store = new Map();
    const get = async (name, id) => store.get(`${name}:${id}`);
    return {
        get,
        prefix: async id => (await get('prefix', id))?.prefix ?? '!',
        staying: async () => [],
        async update(name, id, moderator, fields) {
            const record = { ...await get(name, id), _id: id, moderator, ...fields };
            store.set(`${name}:${id}`, record);
            return record;
        },
        async remove(name, id, match = {}) {
            const key = `${name}:${id}`;
            const record = store.get(key);
            if (record && Object.entries(match).every(([field, value]) => record[field] === value)) store.delete(key);
        },
    };
}

test('Hydra connects commands, settings and Discord events to Pulsify', { timeout: 30_000 }, async t => {
    const lavalink = await createLavalinkFixture();
    const state = await mkdtemp(path.join(tmpdir(), 'hydra-state-fixture-'));
    const config = readConfig({
        DISCORD_TOKEN: 'fixture', MONGODB_URI: 'mongodb://localhost/hydra',
        LAVALINK_NODES: JSON.stringify([{ identifier: 'fixture', host: '127.0.0.1', port: lavalink.port,
            password: 'fixture-placeholder', useSSL: false }]),
        HYDRA_OWNER_IDS: userId, HYDRA_MEMBERS_INTENT: 'true', HYDRA_AUTOPLAY_PLATFORMS: 'deezer',
    });
    const client = new Hydra(config, state);
    client.user = { id: botId };
    client.settings = fakeSettings();
    client.application = { id: botId };
    const first = fakeGuild(client, guildId);
    const second = fakeGuild(client, '100000000000000021');
    const run = (name, args = [], fixture = first) => client.tasks.run(fixture.guild.id, () => client.runCommand(fixture.context(), name, args));
    const player = () => client.music.get(guildId);
    t.after(async () => {
        try { await client.close(); }
        finally {
            await lavalink.close();
            await rm(state, { recursive: true, force: true });
        }
    });
    await assert.rejects(run('play', ['playlist']), /No audio node/);
    const connected = once(client.music.manager, ManagerEventTypes.NodeConnect);
    client.music.manager.init(botId);
    await connected;

    await t.test('prefix play, playlist capacity semantics, two guilds, and both Discord voice updates', async () => {
        await run('join');
        await Promise.all([run('play', ['playlist']), run('play', ['playlist'], second)]);
        assert.equal(player().queue.current.title, 'Track alpha');
        assert.equal(player().queue.length, 3);
        assert.equal(client.music.get(second.guild.id).queue.length, 3);
        assert.equal(first.packets.length, 1);
        assert.equal(first.packets[0].d.channel_id, voiceId);
        assert.equal(second.packets.length, 1);
        client.emit(Events.Raw, { t: 'VOICE_SERVER_UPDATE', d: { guild_id: guildId, endpoint: 'voice.example', token: 'fixture-voice' } });
        client.emit(Events.Raw, { t: 'VOICE_STATE_UPDATE', d: { guild_id: guildId, user_id: botId, channel_id: voiceId, session_id: 'voice-session' } });
        await eventually(() => lavalink.audioRequests.some(request => request.body.voice?.sessionId === 'voice-session'));
        await assert.rejects(run('play', ['empty']), /No tracks/);
        await assert.rejects(run('play', ['failed']), /could not load/);
    });

    await t.test('loop modes, skip position, history, queue order and isolation', async () => {
        await run('loop', ['track']);
        assert(player().trackRepeat);
        await run('loop', ['queue']);
        assert(player().queueRepeat);
        assert(!player().trackRepeat);
        await run('loop', ['off']);
        const original = [...player().queue];
        await run('shuffle');
        await run('shuffle');
        assert.deepEqual([...player().queue], original);
        const started = once(client.music.manager, ManagerEventTypes.TrackStart);
        await run('skip', ['2']);
        await started;
        assert.equal(player().queue.current.title, 'Track gamma');
        await run('previous', ['add']);
        assert.equal(player().queue.at(-1).title, 'Track alpha');
        await run('previous', ['play']);
        assert.equal(player().queue.current.title, 'Track alpha');
        await run('remove', ['track', '1']);
        await run('remove', ['user', userId]);
        assert.equal(player().queue.length, 0);
        await run('play', ['playlist']);
        await run('play', ['playlist']);
        await run('remove', ['dupes']);
        assert.equal(new Set(player().queue.map(track => track.identifier)).size, player().queue.length);
        assert.equal(client.music.get(second.guild.id).queue.current.title, 'Track alpha');
    });

    await t.test('volume, seek, replay, server mute, filters and safe recovery from HTTP failure', async () => {
        await run('autoplay');
        assert.equal(player().isAutoplay, true);
        await run('autoplay');
        assert.equal(player().isAutoplay, false);
        await run('volume', ['50']);
        assert.equal(player().volume, 50);
        lavalink.failUpdate();
        await assert.rejects(run('volume', ['30']));
        assert.equal(player().volume, 50);
        await run('seek', ['0:35']);
        await run('forward', ['5']);
        await run('rewind', ['10']);
        assert.equal(player().position, 30_000);
        await assert.rejects(run('seek', ['20:00']), /before/);
        await run('replay');
        assert.equal(player().position, 0);
        await run('pause');
        assert(player().paused);
        await run('resume');
        assert(!player().paused);
        const old = { id: botId, guild: first.guild, channelId: voiceId, serverMute: false };
        client.emit(Events.VoiceStateUpdate, old, { ...old, serverMute: true });
        await eventually(() => player().paused);
        client.emit(Events.VoiceStateUpdate, { ...old, serverMute: true }, old);
        await eventually(() => !player().paused);
        for (const [name, args] of [
            ['bassboost', ['high']], ['speed', ['2']], ['nightcore', []], ['nightcore', []],
            ['vaporwave', []], ['vaporwave', []], ['treblebass', []], ['treblebass', []],
        ]) await run(name, args);
        assert(lavalink.audioRequests.some(request => request.body.filters?.timescale?.speed === 2));
        await run('speed', ['2']);
        lavalink.failUpdate();
        await assert.rejects(run('speed', ['3']));
        assert.equal(player().filters.timescale.speed, 2);
        await run('clear', ['filters']);
        await run('clear', ['queue']);
        await run('queue');
        await run('nowplaying');
        await run('player');
        assert.equal(player().queue.length, 0);
    });

    await t.test('server configuration, prefix and request entry points, and early interaction acknowledgement', async () => {
        await run('prefix', ['set', '$']);
        assert.equal(await client.settings.prefix(guildId), '$');
        await run('prefix', ['restore']);
        assert.equal(await client.settings.prefix(guildId), '!');
        await run('dj', ['add', roleId]);
        await run('dj', ['list']);
        await run('dj', ['members']);
        await run('dj', ['remove', '1']);
        await run('dj', ['clear']);
        await run('announce', ['set', textId]);
        await run('announce', ['prunning']);
        await run('247', ['on']);
        assert.equal((await client.settings.get('stay', guildId)).mode, true);
        await run('247', ['off']);
        assert.equal((await client.settings.get('stay', guildId)).mode, false);
        await run('setup');
        await run('setup', ['info']);
        const setup = await client.settings.get('setup', guildId);
        assert.equal(setup.channel, requestId);
        const setupMessage = first.messages.get(setup.message);
        assert.equal(setupMessage.payload.embeds[0].data.image.url, 'https://covers.example/alpha.jpg');
        assert.equal(setupMessage.attachments.size, 0);
        setupMessage.attachments.set('old-banner', { id: 'old-banner', name: 'hydra-song-requests.png' });
        const refresh = () => client.tasks.run(guildId, () => client.panels.update(guildId));
        await refresh();
        assert.deepEqual(setupMessage.lastEdit.attachments, []);
        assert.equal(setupMessage.lastEdit.files, undefined);
        assert.equal(setupMessage.attachments.size, 0);
        for (const name of ['help', 'invite', 'ping', 'stats', 'node', 'getinvite']) await run(name);

        const member = first.context().member;
        let removed = 0;
        const request = {
            inGuild: () => true, guild: first.guild, guildId, member,
            channel: first.requests, channelId: requestId, content: 'playlist', author: { id: userId },
            deletable: true, delete: async () => { removed++; },
        };
        await client.handleMessage(request);
        assert.equal(removed, 1);
        assert.equal(player().queue.length, 4);
        const confirmation = first.responses.findLast(item => item.payload.embeds?.[0]?.data.description?.startsWith('Queued'));
        assert(first.messages.has(confirmation.id));
        client.cooldowns.delete(`${guildId}:${userId}`);
        let prefixReplies = 0;
        await client.handleMessage({ ...request, channel: first.text, channelId: textId, content: '!ping',
            reply: async payload => { prefixReplies++; return first.makeMessage(payload); } });
        assert.equal(prefixReplies, 1);
        client.cooldowns.delete(`${guildId}:${userId}`);
        const interactionCalls = [];
        const interaction = {
            ...request, author: undefined, user: { id: userId }, inCachedGuild: () => true,
            isChatInputCommand: () => false, isButton: () => true, isStringSelectMenu: () => false,
            customId: 'pause_but', message: first.messages.get(setup.message),
            appPermissions: perms, deferReply: async options => interactionCalls.push(options),
            editReply: async payload => { interactionCalls.push(payload); return first.makeMessage(payload); },
        };
        await client.handleInteraction(interaction);
        assert.equal(interactionCalls.length, 2);
        assert.equal(interactionCalls[0].flags, 64);
        assert(player().paused);

        client.cooldowns.delete(`${guildId}:${userId}`);
        const search = { ...interaction, isChatInputCommand: () => true, isButton: () => false,
            channel: first.text, channelId: textId, commandName: 'search', options: { getString: () => 'playlist' } };
        await client.handleInteraction(search);
        const menu = first.responses.at(-1);
        assert.equal(menu.payload.components[0].toJSON().components[0].custom_id, 'hydra:select');
        client.cooldowns.delete(`${guildId}:${userId}`);
        await client.handleInteraction({
            ...interaction, customId: 'hydra:select', values: ['2'], message: menu,
            isButton: () => false, isStringSelectMenu: () => true, channel: first.text, channelId: textId,
        });
        assert.deepEqual(menu.payload.components, []);
        assert.equal(player().queue.at(-1).title, 'Track gamma');
        await run('setup', ['clear']);
        assert.equal(await client.settings.get('setup', guildId), undefined);
        assert.equal(setupMessage.attachments.size, 0);
        await delay(5100);
        assert(!first.messages.has(confirmation.id));
        assert.equal(client.confirmationTimers.size, 0);
    });

    await t.test('track finish advances autoplay and the queue cap holds under repeated requests', async () => {
        await run('clear', ['queue']);
        await run('resume');
        await run('autoplay');
        lavalink.event(guildId, 'TrackEndEvent', { reason: 'finished' });
        await eventually(() => player().queue.current?.identifier === 'recommended' && player().playing);
        await run('autoplay');
        const repeated = Array.from({ length: 300 }, () => player().queue.current);
        await client.tasks.run(guildId, () => client.music.enqueue(first.context(), repeated));
        assert.equal(player().queue.totalSize, 300);
        await assert.rejects(run('play', ['playlist']), /queue is full/);
        await run('clear', ['queue']);
    });

    await t.test('node reconnection, Discord disconnect and idempotent player cleanup', async () => {
        const disconnected = once(client.music.manager, ManagerEventTypes.NodeDisconnect);
        const newConnection = once(client.music.manager, ManagerEventTypes.NodeConnect);
        lavalink.reconnect();
        await disconnected;
        await newConnection;
        assert(player());
        await client.music.manager.updateVoiceState({ t: 'VOICE_STATE_UPDATE', d: {
            guild_id: guildId, user_id: botId, channel_id: null, session_id: 'voice-session',
        } });
        assert.equal(player(), undefined);
        assert(client.music.get(second.guild.id));
        await run('stop', [], second);
        assert.equal(client.music.get(second.guild.id), undefined);
        await run('join', [], second);
        await run('leave', [], second);
        assert.equal(client.music.get(second.guild.id), undefined);
        assert.equal(client.music.timers.size, 0);
    });

    await t.test('24/7 players survive idle cleanup and stop persisting after the setting is disabled', async () => {
        await run('247', ['on']);
        const current = player();
        client.music.cancel(current, 'idle');
        client.music.schedule(current, 'idle', 10);
        await eventually(() => !client.music.timers.get(current)?.has('idle'));
        await client.tasks.run(guildId, () => {});
        assert.equal(player(), current);
        await run('247', ['off']);
        client.music.cancel(current, 'idle');
        client.music.schedule(current, 'idle', 10);
        await eventually(() => !player());
    });

    await t.test('the panel swaps between one idle banner and the current track artwork', async () => {
        await run('setup');
        const setup = await client.settings.get('setup', guildId);
        const message = first.messages.get(setup.message);
        assert.equal(message.attachments.size, 0);
        const idleUrl = message.embeds[0].image.url;
        assert.match(idleUrl, /hydra-song-requests\.png$/);
        message.attachments.set('old-banner', { id: 'old-banner', name: 'hydra-song-requests.png' });
        await client.tasks.run(guildId, () => client.panels.update(guildId));
        assert.equal(message.attachments.size, 0);
        assert.notEqual(message.embeds[0].image.url, idleUrl);
        const repair = message.lastEdit;
        await client.tasks.run(guildId, () => client.panels.update(guildId));
        assert.equal(message.lastEdit, repair);

        const refreshPanel = () => client.tasks.run(guildId, () => client.panels.update(guildId));
        await run('play', ['playlist']);
        await refreshPanel();
        assert.equal(message.embeds[0].image.url, 'https://covers.example/alpha.jpg');

        await run('skip', ['1']);
        await eventually(() => player()?.queue.current?.identifier === 'beta' && player().playing);
        await refreshPanel();
        assert.equal(message.embeds[0].image.url, 'https://covers.example/beta.jpg');

        await run('skip', ['2']);
        await eventually(() => player()?.queue.current?.identifier === 'delta' && player().playing);
        await refreshPanel();
        assert.equal(message.embeds[0].image, undefined);

        await run('stop');
        await refreshPanel();
        assert.match(message.embeds[0].image.url, /hydra-song-requests\.png$/);
        assert.equal(message.attachments.size, 0);
    });
});

test('Pulsify fails over to a second node and restores local state after graceful restart', { timeout: 12_000 }, async t => {
    const primary = await createLavalinkFixture();
    const secondary = await createLavalinkFixture();
    const state = await mkdtemp(path.join(tmpdir(), 'hydra-state-recovery-'));
    const config = readConfig({
        DISCORD_TOKEN: 'fixture', MONGODB_URI: 'mongodb://localhost/hydra',
        LAVALINK_NODES: JSON.stringify([primary, secondary].map((server, index) => ({
            identifier: `node-${index + 1}`, host: '127.0.0.1', port: server.port,
            password: 'fixture-placeholder', useSSL: false,
        }))),
    });
    for (const node of config.nodes) node.maxRetryAttempts = 0;
    const createClient = conf => {
        const client = new Hydra(conf, state);
        client.user = { id: botId };
        client.settings = fakeSettings();
        const fixture = fakeGuild(client, guildId);
        return { client, fixture };
    };
    let activeClient;
    t.after(async () => {
        try { await activeClient?.close(); }
        finally {
            await Promise.all([primary.close(), secondary.close()]);
            await rm(state, { recursive: true, force: true });
        }
    });
    const { client, fixture } = createClient(config);
    activeClient = client;
    const manager = client.music.manager;
    manager.init(botId);
    await eventually(() => [...manager.nodes.values()].every(node => node.connected));
    let player = await client.music.join(fixture.guild, fixture.voice, textId);
    assert.equal(player.node.options.identifier, 'node-1');
    await client.runCommand(fixture.context(), 'play', ['playlist']);
    for (const packet of [
        { t: 'VOICE_SERVER_UPDATE', d: { guild_id: guildId, endpoint: 'voice.example', token: 'fixture-voice' } },
        { t: 'VOICE_STATE_UPDATE', d: { guild_id: guildId, user_id: botId, channel_id: voiceId, session_id: 'fixture-session' } },
    ]) await manager.updateVoiceState(packet);

    primary.reconnect();
    await eventually(() => player.node.options.identifier === 'node-2' && secondary.players.get(guildId)?.track);
    assert.equal(player.queue.current.identifier, 'alpha');
    assert.equal(player.queue.length, 3);
    await eventually(() => client.music.nodeRetries.has('node-1'));
    await client.runCommand(fixture.context(), '247', ['on']);
    await player.seek(5000);
    await client.close();
    assert.equal(client.music.nodeRetries.size, 0);

    const restarted = createClient({ ...config, nodes: config.nodes.slice(1) });
    activeClient = restarted.client;
    const ready = once(activeClient.music.manager, ManagerEventTypes.NodeConnect);
    activeClient.music.manager.init(botId);
    await ready;
    player = activeClient.music.get(guildId);
    assert(player);
    assert.equal(player.node.options.identifier, 'node-2');
    assert.equal(player.queue.current.identifier, 'alpha');
    assert.equal(player.position, 5000);
    assert.equal(player.queue.length, 3);
});
