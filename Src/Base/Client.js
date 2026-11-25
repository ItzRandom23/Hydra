const {
    Client, GatewayIntentBits, Events, MessageFlags, Partials, PermissionFlagsBits,
} = require('discord.js');
const { AbortController } = globalThis;
const { Music } = require('./Music');
const { Settings } = require('../Models/Settings');
const { Panels, embed } = require('../Handler/Panels');
const { display } = require('../Handler/Media');
const { GuildTasks, ExpiringMap, UserError, check } = require('../Handler/Runtime');
const { commands, commandList } = require('../Commands');
const { log } = require('../Utility/Console');
const { deployOnReady } = require('../Scripts/Slash');

const allowedMentions = { parse: [], repliedUser: false };
const confirmationLifetime = 5000;

function parseMessage(content, prefix, userId) {
    const text = content.trim();
    const mention = [`<@${userId}>`, `<@!${userId}>`].find(value => text.startsWith(value));
    const matched = mention ?? (text.startsWith(prefix) ? prefix : undefined);
    if (!matched) return undefined;
    const [name = '', ...args] = text.slice(matched.length).trim().split(/\s+/);
    return { name: name.toLowerCase(), args, directMention: Boolean(mention && !name) };
}

class Hydra extends Client {
    constructor(config, sessionDataPath = undefined) {
        const intents = [
            GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
        ];
        if (config.membersIntent) intents.push(GatewayIntentBits.GuildMembers);
        super({ intents, allowedMentions, shards: 'auto', partials: [Partials.Message], rest: { timeout: 8000, retries: 1 } });
        this.config = config;
        this.commands = commands;
        this.commandList = commandList;
        this.settings = new Settings(config.prefix);
        this.tasks = new GuildTasks();
        this.cooldowns = new ExpiringMap(20_000, 2000);
        this.panels = new Panels(this);
        this.music = new Music(this, sessionDataPath);
        this.confirmationTimers = new Set();
        this.slashDeployment = new AbortController();
        this.closing = false;
        this.bindEvents();
    }

    bindEvents() {
        this.once(Events.ClientReady, client => {
            if (this.closing) return;
            client.user.setActivity(`${this.config.prefix}help`);
            this.music.manager.init(client.user.id);
            log('Discord gateway ready');
            const { signal } = this.slashDeployment;
            this.slashDeploymentTask = deployOnReady(client.rest, client.application.id, signal)
                .then(result => log(`Synced ${result.count} global slash commands (${result.changed} updated)`))
                .catch(error => {
                    if (!signal.aborted) log('Global slash command sync failed', error);
                });
        });
        this.on(Events.Raw, packet => {
            if (this.closing || !['VOICE_STATE_UPDATE', 'VOICE_SERVER_UPDATE'].includes(packet.t)) return;
            void this.music.manager.updateVoiceState(packet).catch(error => log('Discord voice update failed', error));
        });
        this.on(Events.MessageCreate, message => {
            void this.handleMessage(message).catch(error => log('Message handler failed', error));
        });
        this.on(Events.InteractionCreate, interaction => {
            void this.handleInteraction(interaction).catch(error => log('Interaction handler failed', error));
        });
        this.on(Events.VoiceStateUpdate, (oldState, newState) => this.music.voiceChanged(oldState, newState));
        this.on(Events.GuildAvailable, guild => {
            this.music.run(guild.id, () => this.music.restoreGuild(guild));
            this.panels.refresh(guild.id);
        });
        this.on(Events.GuildDelete, guild => this.music.run(guild.id, () => this.music.manager.destroy(guild.id)));
        this.on(Events.ChannelDelete, channel => {
            if (!('guild' in channel) || !channel.guild) return;
            const guildId = channel.guild.id;
            this.music.run(guildId, async () => {
                const actions = [this.settings.remove('setup', guildId, { channel: channel.id })];
                const player = this.music.get(guildId);
                if (player?.voiceChannelId === channel.id) actions.push(player.destroy());
                await Promise.all(actions);
            });
        });
        this.on(Events.MessageDelete, message => {
            if (!message.guildId) return;
            void this.settings.get('setup', message.guildId).then(setup => {
                if (setup?.channel === message.channelId && setup.message === message.id) this.panels.refresh(message.guildId);
            }).catch(error => log('Deleted message lookup failed', error));
        });
        this.on(Events.Error, error => log('Discord client error', error));
        this.on(Events.ShardError, error => log('Discord shard error', error));
        this.on(Events.ShardDisconnect, (_event, shard) => log(`Discord shard disconnected (${shard})`));
        this.on(Events.ShardResume, shard => log(`Discord shard resumed (${shard})`));
    }

    canRespond(channel, guild) {
        const permissions = channel?.permissionsFor?.(guild.members.me);
        return permissions?.has([
            PermissionFlagsBits.ViewChannel,
            channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages,
        ]);
    }

    context(origin, reply) {
        return {
            client: this,
            guild: origin.guild,
            member: origin.member,
            user: origin.author ?? origin.user,
            channel: origin.channel,
            channelId: origin.channelId,
            reply,
            say: (text, title) => reply({ embeds: [embed(text, title)] }),
            control: false,
        };
    }

    admit(ctx) {
        const key = `${ctx.guild.id}:${ctx.user.id}`;
        if (this.cooldowns.get(key)) return false;
        return this.cooldowns.set(key, true);
    }

    async authorize(ctx, rules) {
        check(!rules.owner || this.config.owners.has(ctx.user.id), 'This command is restricted to the configured bot owners.');
        check(ctx.member?.permissions, 'This server member is unavailable.');
        const permissions = ctx.member.permissions;
        const admin = permissions.has(PermissionFlagsBits.ManageGuild);
        check(!rules.admin || admin, 'You need Manage Server to use this command.');
        if (rules.voice) this.music.voiceFor(ctx);
        const player = this.music.get(ctx.guild.id);
        check(!rules.player || player, 'There is no player in this server.');
        check(!rules.track || player?.queue.current, 'There is no current track.');
        if (rules.dj && !admin && !permissions.has(PermissionFlagsBits.MuteMembers)) {
            const dj = await this.settings.get('dj', ctx.guild.id);
            const roles = Array.isArray(dj?.roles) ? dj.roles : [];
            check(dj?.mode !== true || roles.some(role => role !== ctx.guild.id && ctx.member.roles.cache.has(role)),
                'You need a DJ role, Mute Members, or Manage Server to use these controls.');
        }
        return player;
    }

    async runCommand(ctx, name, args, { control = false } = {}) {
        const item = this.commands.get(name);
        check(item, 'This command is unavailable.');
        if (control) check(this.music.get(ctx.guild.id)?.queue.current, 'There is no current track.');
        const player = await this.authorize(ctx, item);
        ctx.control = control;
        await item.execute(ctx, args, player);
        if (item.player) this.panels.refresh(ctx.guild.id);
    }

    async respondToError(ctx, error, status) {
        if (!(error instanceof UserError)) log('Request failed', error);
        if (!status.replied) {
            const response = error instanceof UserError ? error.message : 'Hydra could not complete that request. Please try again shortly.';
            await ctx.reply({ content: response }).catch(failure => log('Could not send an error response', failure));
        }
    }

    expireRequestConfirmation(message) {
        if (this.closing || !message?.deletable) return;
        const timer = setTimeout(() => {
            this.confirmationTimers.delete(timer);
            void message.delete().catch(error => {
                if (error.code !== 10008) log('Could not delete a song request confirmation', error);
            });
        }, confirmationLifetime);
        timer.unref();
        this.confirmationTimers.add(timer);
    }

    async handleMessage(message) {
        if (this.closing || !this.user || !message.inGuild() || message.author.bot || message.webhookId ||
            !message.content?.trim() || !this.canRespond(message.channel, message.guild)) return;
        let prefix;
        let setup;
        try {
            [prefix, setup] = await Promise.all([
                this.settings.prefix(message.guildId), this.settings.get('setup', message.guildId),
            ]);
        } catch (error) {
            if (parseMessage(message.content, this.config.prefix, this.user.id)) {
                const ctx = this.context(message, options => message.reply(options));
                if (this.admit(ctx)) await message.reply('Server settings are temporarily unavailable.').catch(failure => log('Could not report settings outage', failure));
            }
            throw error;
        }

        const parsed = parseMessage(message.content, prefix, this.user.id);
        const request = setup?.channel === message.channelId && !parsed;
        if (!request && !parsed?.directMention && !this.commands.has(parsed?.name)) return;
        const status = { replied: false };
        let confirmation;
        const ctx = this.context(message, async options => {
            const result = await (request ? message.channel.send(options) : message.reply(options));
            if (request) confirmation = result;
            status.replied = true;
            return result;
        });
        if (!this.admit(ctx)) return;
        if (!message.channel.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.EmbedLinks)) {
            await ctx.reply({ content: 'Hydra needs Embed Links in this channel.' });
            return;
        }

        try {
            await this.tasks.run(message.guildId, async () => {
                if (parsed?.directMention) {
                    await ctx.say(`The server prefix is ${display(prefix)}. Try ${display(prefix + 'help')}.`, 'Hydra');
                } else if (request) {
                    const current = await this.settings.get('setup', message.guildId);
                    check(current?.channel === message.channelId, 'Song requests are disabled in this channel.');
                    await this.runCommand(ctx, 'play', [message.content]);
                    this.expireRequestConfirmation(confirmation);
                    if (message.deletable) await message.delete().catch(error => log('Could not delete a processed request', error));
                } else if (parsed) {
                    await this.runCommand(ctx, parsed.name, parsed.args);
                }
            });
        } catch (error) {
            await this.respondToError(ctx, error, status);
        }
    }

    async handleInteraction(interaction) {
        if (!interaction.inCachedGuild()) return;
        const slash = interaction.isChatInputCommand();
        const component = (interaction.isButton() || interaction.isStringSelectMenu()) && this.panels.handles(interaction.customId);
        if (!slash && !component) return;
        await interaction.deferReply({ flags: component ? MessageFlags.Ephemeral : undefined });
        const status = { replied: false };
        const ctx = this.context(interaction, async options => {
            const message = await interaction.editReply(options);
            status.replied = true;
            return message;
        });
        try {
            check(!this.closing, 'Hydra is restarting. Try again shortly.');
            check(this.admit(ctx), 'Wait a moment before using another command.');
            check(this.canRespond(interaction.channel, interaction.guild) &&
                interaction.appPermissions?.has(PermissionFlagsBits.EmbedLinks),
            'Hydra needs permission to send messages and embeds in this channel.');
            await this.tasks.run(ctx.guild.id, async () => {
                if (slash) {
                    const command = this.commands.get(interaction.commandName);
                    check(command && !command.owner && command.name === interaction.commandName, 'This slash command is unavailable.');
                    const input = interaction.options.getString('input')?.trim();
                    await this.runCommand(ctx, command.name, input ? input.split(/\s+/) : []);
                } else {
                    await this.panels.handle(ctx, interaction);
                }
            });
        } catch (error) {
            await this.respondToError(ctx, error, status);
        }
    }

    async close() {
        this.closing = true;
        this.slashDeployment.abort();
        for (const timer of this.confirmationTimers) clearTimeout(timer);
        this.confirmationTimers.clear();
        try {
            await this.slashDeploymentTask;
            await this.tasks.close();
            await this.music.close();
        } finally {
            await this.destroy();
        }
    }
}

module.exports = { Hydra, parseMessage };
