const { ApplicationCommandType, REST, Routes } = require('discord.js');
const { setTimeout: delay } = require('node:timers/promises');
const { isDeepStrictEqual, parseArgs } = require('node:util');
const { slashCommands } = require('../Commands');
const { ConfigError, snowflake } = require('../Config');
const { log } = require('../Utility/Console');
const { installationFindings, serverInvite } = require('../Utility/DiscordInstall');

function targetGuild(args) {
    const usage = new ConfigError('registration scope (--guild <server ID> or --global)');
    let values;
    try {
        ({ values } = parseArgs({ args, options: { global: { type: 'boolean' }, guild: { type: 'string' } } }));
    } catch {
        throw usage;
    }
    if (values.guild !== undefined && (values.global || !snowflake.test(values.guild))) throw usage;
    return values.guild;
}

const createRest = token => new REST({ version: '10', timeout: 8000, retries: 1 }).setToken(token);

function configuredRest(env, restForToken) {
    const token = env.DISCORD_TOKEN?.trim();
    if (!token) throw new ConfigError('DISCORD_TOKEN');
    return restForToken(token);
}

async function getApplication(rest) {
    const app = await rest.get(Routes.currentApplication());
    if (!app || typeof app !== 'object' || !('id' in app) || typeof app.id !== 'string' || !snowflake.test(app.id)) {
        throw new Error('Could not identify the Discord application');
    }
    return app;
}

function optionFields(option) {
    return {
        name: option.name, type: option.type, description: option.description,
        required: option.required ?? false, autocomplete: option.autocomplete ?? false,
        min_length: option.min_length ?? 0, max_length: option.max_length ?? null,
        choices: option.choices ?? [], options: (option.options ?? []).map(optionFields),
    };
}

function commandFields(command) {
    return {
        description: command.description,
        default_member_permissions: command.default_member_permissions ?? null,
        options: (command.options ?? []).map(optionFields),
        integration_types: command.integration_types ?? [],
        contexts: command.contexts ?? [],
    };
}

/**
 * @param {REST} rest
 * @param {string} applicationId
 * @param {string} [guild]
 * @param {AbortSignal} [signal]
 */
async function syncCommands(rest, applicationId, guild, signal) {
    const route = guild ? Routes.applicationGuildCommands(applicationId, guild) : Routes.applicationCommands(applicationId);
    const commands = slashCommands(Boolean(guild));
    const current = await rest.get(route, { signal });
    if (!Array.isArray(current)) throw new Error('Discord returned an invalid command list');
    const registered = new Map(current.filter(command => command.type === ApplicationCommandType.ChatInput)
        .map(command => [command.name, command]));
    let changed = 0;
    for (const command of commands) {
        signal?.throwIfAborted();
        const existing = registered.get(command.name);
        if (!existing) {
            await rest.post(route, { body: command, signal });
        } else if (!isDeepStrictEqual(commandFields(command), commandFields(existing))) {
            const updateRoute = guild ? Routes.applicationGuildCommand(applicationId, guild, existing.id) :
                Routes.applicationCommand(applicationId, existing.id);
            await rest.patch(updateRoute, {
                body: { ...command, default_member_permissions: command.default_member_permissions ?? null }, signal,
            });
        } else {
            continue;
        }
        changed++;
    }
    return { count: commands.length, changed, guild };
}

async function deployOnReady(rest, applicationId, signal) {
    for (const backoff of [2000, 5000]) {
        try { return await syncCommands(rest, applicationId, undefined, signal); }
        catch (error) {
            signal.throwIfAborted();
            const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
            if (status >= 400 && status < 500 && status !== 429) throw error;
            await delay(backoff, undefined, { signal, ref: false });
        }
    }
    return syncCommands(rest, applicationId, undefined, signal);
}

async function register(args = process.argv.slice(2), env = process.env, restForToken = createRest) {
    const guild = targetGuild(args);
    const rest = configuredRest(env, restForToken);
    const { id } = await getApplication(rest);
    return syncCommands(rest, id, guild);
}

async function checkInstallation(env = process.env, restForToken = createRest) {
    const app = await getApplication(configuredRest(env, restForToken));
    return { findings: installationFindings(app), invite: serverInvite(app.id) };
}

async function main() {
    if (process.argv.length === 3 && process.argv[2] === '--check-install') {
        const { findings, invite } = await checkInstallation();
        for (const finding of findings) log(finding);
        if (!findings.length) log('Discord reported no app-level installation blockers in the checked settings.');
        log(`Server install link ${invite}`);
        return;
    }
    const { count, changed, guild } = await register();
    log(`Synced ${count} slash commands ${guild ? `for test server ${guild}` : 'globally'} (${changed} updated)`);
}

if (require.main === module) {
    void main().catch(error => {
        log(error instanceof ConfigError ? error.message : 'Discord request failed. Verify the token and application installation settings', error);
        process.exitCode = 1;
    });
}

module.exports = { register, checkInstallation, deployOnReady };
