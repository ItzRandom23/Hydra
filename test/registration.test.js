const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ApplicationCommandType, ApplicationIntegrationType, Events, InteractionContextType, PermissionFlagsBits, Routes } = require('discord.js');
const { Hydra } = require('../Src/Base/Client');
const { readConfig } = require('../Src/Config');
const { register, checkInstallation } = require('../Src/Scripts/Slash');

const applicationId = '100000000000000031';
const guildId = '100000000000000032';
const globalRoute = Routes.applicationCommands(applicationId);
const guildRoute = Routes.applicationGuildCommands(applicationId, guildId);
const env = { DISCORD_TOKEN: 'fixture-token', HYDRA_COMMAND_GUILD: guildId };

function fixture(application = {}) {
    const calls = [];
    const commands = new Map([[globalRoute, []], [guildRoute, []]]);
    let nextId = 0;
    const transport = {
        async get(route) {
            calls.push({ method: 'get', route });
            if (route === Routes.currentApplication()) return { id: applicationId, ...application };
            assert(commands.has(route));
            return structuredClone(commands.get(route));
        },
        async post(route, { body }) {
            calls.push({ method: 'post', route, body });
            commands.get(route).push({ ...body, type: ApplicationCommandType.ChatInput, id: String(++nextId) });
        },
        async patch(route, { body }) {
            calls.push({ method: 'patch', route, body });
            const sep = route.lastIndexOf('/');
            const existing = commands.get(route.slice(0, sep)).find(item => item.id === route.slice(sep + 1));
            Object.assign(existing, body);
        },
    };
    function createRest(token) {
        assert.equal(token, env.DISCORD_TOKEN);
        return transport;
    }
    return { createRest, transport, calls, commands };
}

test('global registration ignores an old test guild setting and skips up-to-date commands', async () => {
    const { createRest, calls, commands } = fixture();
    assert.deepEqual(await register([], env, createRest), { count: 36, changed: 36, guild: undefined });
    assert.deepEqual(await register(['--global'], env, createRest), { count: 36, changed: 0, guild: undefined });
    assert.equal(calls.filter(call => call.method === 'post').length, 36);
    assert(commands.get(globalRoute).every(command => command.contexts[0] === InteractionContextType.Guild &&
        command.integration_types[0] === ApplicationIntegrationType.GuildInstall));
    assert.equal(commands.get(guildRoute).length, 0);
});

test('sync patches changed commands and preserves unrelated commands and existing IDs', async () => {
    const { createRest, calls, commands } = fixture();
    await register([], env, createRest);
    const globals = commands.get(globalRoute);
    const play = globals.find(command => command.name === 'play');
    const help = globals.find(command => command.name === 'help');
    play.description = 'Old description';
    play.default_member_permissions = '32';
    help.options[0].autocomplete = false;
    help.options[0].min_length = 0;
    const unrelated = { id: '1000', name: 'unrelated', type: ApplicationCommandType.ChatInput };
    const messageCommand = { id: '1001', name: 'play', type: ApplicationCommandType.Message };
    globals.push(unrelated, messageCommand);
    calls.length = 0;

    assert.deepEqual(await register([], env, createRest), { count: 36, changed: 1, guild: undefined });
    const writes = calls.filter(call => call.method !== 'get');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, 'patch');
    assert.equal(writes[0].route, Routes.applicationCommand(applicationId, play.id));
    assert.equal(writes[0].body.default_member_permissions, null);
    assert(globals.includes(unrelated));
    assert(globals.includes(messageCommand));
});

test('an explicit test guild uses the guild endpoint and payload schema', async () => {
    const { createRest, commands } = fixture();
    assert.deepEqual(await register(['--guild', guildId], env, createRest), { count: 36, changed: 36, guild: guildId });
    assert.equal(commands.get(globalRoute).length, 0);
    assert(commands.get(guildRoute).every(command =>
        !Object.hasOwn(command, 'contexts') && !Object.hasOwn(command, 'integration_types')));
});

test('registration rejects conflicting scope, invalid guild IDs, and missing credentials before making requests', async () => {
    const unused = () => assert.fail('Invalid registration must stop before creating a Discord client');
    await assert.rejects(register(['--guild', guildId, '--global'], env, unused), /registration scope/);
    await assert.rejects(register(['--guild', 'invalid'], env, unused), /registration scope/);
    await assert.rejects(register([], {}, unused), /DISCORD_TOKEN/);
});

test('installation diagnostics report Portal blockers and build a selectable server invite without writes', async () => {
    const { createRest, calls } = fixture({
        bot_public: false, bot_require_code_grant: true, integration_types_config: { 1: {} },
    });
    const { findings, invite } = await checkInstallation(env, createRest);
    assert.equal(findings.length, 3);
    assert(findings.some(text => text.includes('Guild Install')));
    assert(findings.some(text => text.includes('Public Bot')));
    assert(findings.some(text => text.includes('Requires OAuth2 Code Grant')));
    const { hostname, searchParams } = new URL(invite);
    assert.equal(hostname, 'discord.com');
    assert.equal(searchParams.get('client_id'), applicationId);
    assert.equal(searchParams.get('integration_type'), '0');
    assert.equal(searchParams.get('scope'), 'bot applications.commands');
    assert.equal(searchParams.has('guild_id'), false);
    assert.equal(searchParams.has('disable_guild_select'), false);
    assert.equal(BigInt(searchParams.get('permissions')) & PermissionFlagsBits.Administrator, 0n);
    assert.deepEqual(calls, [{ method: 'get', route: Routes.currentApplication() }]);
});

test('Discord startup automatically syncs global commands once, without starting Lavalink in the test', async t => {
    const config = readConfig({
        ...env, MONGODB_URI: 'mongodb://127.0.0.1/hydra',
        LAVALINK_NODES: '[{"identifier":"fixture","host":"127.0.0.1","port":2333,"password":"fixture","useSSL":false}]',
    });
    const client = new Hydra(config);
    t.after(() => client.close());
    const { transport, calls, commands } = fixture();
    Object.assign(client.rest, transport);
    client.user = { id: applicationId, setActivity() {} };
    client.application = { id: applicationId };
    let musicStarts = 0;
    client.music.manager.init = () => { musicStarts++; };

    client.emit(Events.ClientReady, client);
    assert(client.slashDeploymentTask);
    await client.slashDeploymentTask;
    client.emit(Events.ClientReady, client);
    assert.equal(musicStarts, 1);
    assert.equal(commands.get(globalRoute).length, 36);
    assert.equal(calls.filter(call => call.method === 'get').length, 1);
});
