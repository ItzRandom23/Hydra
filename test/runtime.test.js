const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { readConfig } = require('../Src/Config');
const { Hydra, parseMessage } = require('../Src/Base/Client');
const { GuildTasks, ExpiringMap } = require('../Src/Handler/Runtime');
const { searchInput, timeInput, integer } = require('../Src/Handler/Media');
const { commandList, commands, slashCommands } = require('../Src/Commands');
const { Panels, setupPanel, embed } = require('../Src/Handler/Panels');

const guildId = '100000000000000001';
const ownerId = '100000000000000002';
const memberId = '100000000000000003';
const roleId = '100000000000000004';

test('configuration accepts explicit local nodes and redacts invalid values', () => {
    const env = {
        DISCORD_TOKEN: 'local-fixture', MONGODB_URI: 'mongodb://127.0.0.1/hydra',
        LAVALINK_NODES: '[{"identifier":"local","host":"127.0.0.1","port":2333,"password":"fixture","useSSL":false}]',
        HYDRA_OWNER_IDS: ownerId,
    };
    const config = readConfig(env);
    assert.equal(config.prefix, '!');
    assert.equal(config.nodes[0].apiRequestTimeoutMs, 8000);
    assert(config.owners.has(ownerId));
    assert.equal(readConfig({ ...env, HYDRA_AUTOPLAY_PLATFORMS: '' }).autoplayPlatforms.length, 0);
    for (const [key, value] of [
        ['DISCORD_TOKEN', ''], ['MONGODB_URI', 'fixture-invalid'], ['LAVALINK_NODES', 'fixture-invalid'],
        ['HYDRA_SEARCH_PLATFORM', 'fixture-invalid'], ['HYDRA_AUTOPLAY_PLATFORMS', 'fixture-invalid'],
        ['HYDRA_PREFIX', ' four'], ['HYDRA_MEMBERS_INTENT', 'yes'], ['HYDRA_OWNER_IDS', 'fixture-invalid'],
        ['HYDRA_MEDIA_HOSTS', 'http://foo.test'],
    ]) {
        assert.throws(() => readConfig({ ...env, [key]: value }), { message: `Check the ${key} configuration.` });
    }
});

test('prefix and mention parsing handle punctuation, whitespace and case', () => {
    assert.deepEqual(parseMessage(' .?   PLAY  local music ', '.?', ownerId),
        { name: 'play', args: ['local', 'music'], directMention: false });
    assert.equal(parseMessage(`<@!${ownerId}>`, '.', ownerId).directMention, true);
    assert.equal(parseMessage('ordinary chat', '.', ownerId), undefined);
    assert.equal(parseMessage('?', '?', ownerId).name, '');
});

test('media search accepts approved providers and refuses arbitrary URL schemes and hosts', () => {
    assert.equal(searchInput('<https://youtu.be/music>', []), 'https://youtu.be/music');
    assert.equal(searchInput('Late night jazz', []), 'Late night jazz');
    assert.equal(searchInput('https://media.example/song', ['media.example']), 'https://media.example/song');
    for (const url of [
        'http://youtube.com/music', 'https://outside.example/media', 'https://www.youtube.com:8443/music',
        'https://user@www.youtube.com/watch', 'https://www.youtube.com.example/watch', 'ftp://media.example/song',
        'https://www.youtube.com/redirect',
    ]) assert.throws(() => searchInput(url, []), /supported music provider/);
    assert.throws(() => searchInput(' ', []), /song name/);
    assert.equal(timeInput('1:02:03'), 3_723_000);
    assert.throws(() => timeInput('1:90'), /seconds/);
    assert.throws(() => integer('5.5', 0, 100, 'Invalid volume'), /Invalid volume/);
});

test('guild tasks isolate guilds, recover after failure and reject excess work', async () => {
    const gate = new GuildTasks(2);
    const started = [];
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const first = gate.run('a', async () => { started.push('a1'); await pending; throw new Error('fixture'); });
    const second = gate.run('a', () => { started.push('a2'); });
    await assert.rejects(gate.run('a', () => {}), /busy/);
    await gate.run('b', () => { started.push('b1'); });
    assert.deepEqual(started, ['a1', 'b1']);
    release();
    await assert.rejects(first, /fixture/);
    await second;
    assert.deepEqual(started, ['a1', 'b1', 'a2']);
    await gate.close();
    assert.equal(gate.pending.size, 0);
    await assert.rejects(gate.run('b', () => {}), /busy/);
});

test('guild scheduler preserves ordering across 1,000 operations', async () => {
    const gate = new GuildTasks(10);
    const counts = new Map();
    await Promise.all(Array.from({ length: 100 }, (_, guild) => Promise.all(Array.from({ length: 10 }, (_, count) =>
        gate.run(String(guild), async () => {
            await Promise.resolve();
            assert.equal(counts.get(guild) ?? 0, count);
            counts.set(guild, count + 1);
        }),
    ))));
    assert.equal(gate.pending.size, 0);
    assert.equal(counts.size, 100);
});

test('bounded maps evict and expire entries', () => {
    const cache = new ExpiringMap(2, 30);
    cache.set('a', 1, 0);
    cache.set('b', 2, 0);
    cache.set('c', 3, 20);
    assert.equal(cache.get('a', 25), undefined);
    assert.equal(cache.get('b', 30), undefined);
    assert.equal(cache.get('c', 30), 3);
});

test('all commands have unique aliases and owner commands are absent from slash registration', () => {
    assert.equal(commandList.length, 38);
    assert(!commands.has('eval'));
    assert(!commands.has('e'));
    for (const item of commandList) {
        assert.equal(typeof item.execute, 'function');
        assert.equal(commands.get(item.name), item);
        for (const alias of item.aliases) assert.equal(commands.get(alias), item);
    }
    const global = slashCommands();
    assert.equal(global.length, 36);
    for (const item of global) {
        assert.match(item.name, /^[-_\p{L}\p{N}]{1,32}$/u);
        assert(item.description.length >= 1 && item.description.length <= 100);
        assert.deepEqual(item.contexts, [0]);
        assert(!commands.get(item.name).owner);
    }
    assert.equal(global.find(item => item.name === 'setup').default_member_permissions, String(PermissionFlagsBits.ManageGuild));
    assert.equal(global.find(item => item.name === 'search').options[0].required, true);
    assert.equal(slashCommands(true)[0].contexts, undefined);
});

test('owner, DJ, admin, and voice gates are enforced together', async () => {
    const player = { queue: { current: {} } };
    const auth = {
        config: { owners: new Set([ownerId]) },
        music: {
            get: () => player,
            voiceFor: ctx => {
                if (!ctx.member.voice.channel) throw new Error('Join voice');
            },
        },
        settings: { get: async () => ({ mode: true, roles: [roleId, guildId] }) },
    };
    const ctx = {
        user: { id: memberId }, guild: { id: guildId },
        member: { permissions: new PermissionsBitField(), roles: { cache: new Map([[guildId, true]]) }, voice: {} },
    };
    const authorize = rules => Hydra.prototype.authorize.call(auth, ctx, rules);
    await assert.rejects(authorize({ owner: true }), /bot owners/);
    await assert.rejects(authorize({ admin: true }), /Manage Server/);
    await assert.rejects(authorize({ dj: true }), /DJ role/);
    await assert.rejects(authorize({ voice: true }), /Join voice/);
    ctx.member.roles.cache.set(roleId, true);
    ctx.member.voice.channel = {};
    assert.equal(await authorize({ dj: true, voice: true, track: true }), player);
    ctx.member.roles.cache.delete(roleId);
    ctx.member.permissions = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
    ctx.user.id = ownerId;
    assert.equal(await authorize({ owner: true, dj: true, admin: true }), player);
});

test('panel selections are bound to the author and expire after use', async () => {
    const panels = new Panels({});
    const edits = [];
    const message = { id: 'menu', edit: async value => edits.push(value) };
    const ctx = { guild: { id: guildId }, user: { id: memberId }, reply: async value => { edits.push(value); return message; } };
    let chosen;
    await panels.choose(ctx, 'Select', ['Queue', 'Filters'], (_ctx, index) => { chosen = index; });
    const press = { customId: 'hydra:pick:1', message, isButton: () => true };
    await assert.rejects(panels.handle({ ...ctx, user: { id: ownerId } }, press), /opened/);
    assert.equal(chosen, undefined);
    await panels.handle(ctx, press);
    assert.equal(chosen, 1);
    assert.equal(edits[0].components[0].toJSON().components[1].custom_id, 'hydra:pick:1');
    assert.deepEqual(edits[1], { components: [] });
    await assert.rejects(panels.handle(ctx, press), /expired/);
    assert(setupPanel().components[0].toJSON().components.every(button => button.disabled));
});

test('paginator acknowledges navigation and handles the last and first buttons', async () => {
    const panels = new Panels({});
    const edits = [];
    const message = { id: 'pages', edit: async value => edits.push(value) };
    const ctx = { guild: { id: guildId }, user: { id: memberId }, reply: async () => message };
    let acknowledgementCount = 0;
    await panels.pages(ctx, ['one', 'two', 'three'].map(page => embed(page)));
    for (const customId of ['hydra:last', 'hydra:back', 'hydra:first', 'hydra:close']) {
        await panels.handle(ctx, { customId, message, deleteReply: async () => { acknowledgementCount++; } });
    }
    assert.deepEqual(edits.slice(0, 3).map(payload => payload.embeds[0].data.description), ['three', 'two', 'one']);
    assert.equal(acknowledgementCount, 4);
});

test('request panel has no broken image placeholder when it cannot upload', () => {
    const restricted = setupPanel(undefined, { canUpload: false });
    assert.equal(restricted.embeds[0].data.image, undefined);
    assert.equal(restricted.files, undefined);
});

test('request panel uses track artwork during playback and uploads the default only while idle', () => {
    const idle = setupPanel();
    assert.equal(idle.embeds[0].data.image.url, 'attachment://hydra-song-requests.png');
    assert.equal(idle.files.length, 1);

    const player = { queue: Object.assign([], { current: { title: 'A song', duration: 120_000 } }), volume: 100 };
    for (const artworkUrl of [null, 'file:///tmp/cover.png', 'https://covers.example/art.jpg']) {
        player.queue.current.artworkUrl = artworkUrl;
        const playing = setupPanel(player);
        assert.equal(playing.embeds[0].data.image?.url, artworkUrl?.startsWith('https:') ? artworkUrl : undefined);
        assert.equal(playing.files, undefined);
    }
});
