const path = require('node:path');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { Manager, LoadTypes, StateTypes, ManagerEventTypes } = require('pulsifyy');
const { UserError, check } = require('../Handler/Runtime');
const { searchInput, trackName } = require('../Handler/Media');
const { log } = require('../Utility/Console');

const idleDelay = 60_000;
const queueLimit = 300;

class Music {
    constructor(client, sessionDataPath = path.resolve('.hydra-state')) {
        this.client = client;
        this.timers = new Map();
        this.nodeRetries = new Map();
        this.closed = false;
        this.manager = new Manager({
            nodes: client.config.nodes,
            clientName: 'Hydra/1.1.0',
            defaultSearchPlatform: client.config.searchPlatform,
            autoPlaySearchPlatforms: client.config.autoplayPlatforms,
            sessionDataPath,
            maxQueueSize: queueLimit,
            maxPreviousTracks: 20,
            trackCacheMaxEntries: 128,
            playerInactivityTimeoutMs: 0,
            playNextOnEnd: true,
            send: (guildId, packet) => client.guilds.cache.get(guildId)?.shard.send(packet),
        });
        this.bindEvents();
    }

    get(guildId) {
        return this.manager.get(guildId);
    }

    voiceFor(ctx, requireSpeak = false) {
        const voice = ctx.member?.voice?.channel;
        check(voice, 'Join a voice channel first.');
        const current = ctx.guild.members.me?.voice.channelId || this.get(ctx.guild.id)?.voiceChannelId;
        check(!current || current === voice.id, 'Join the voice channel Hydra is using.');
        if (requireSpeak) this.assertVoicePermissions(voice);
        return voice;
    }

    assertVoicePermissions(voice) {
        const permissions = voice.permissionsFor(this.client.user);
        check(permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]),
            'Hydra needs View Channel and Connect in that voice channel.');
        if (voice.type === ChannelType.GuildStageVoice) {
            check(permissions.has(PermissionFlagsBits.MuteMembers) || permissions.has(PermissionFlagsBits.RequestToSpeak),
                'Hydra needs permission to request to speak in that stage channel.');
        } else {
            check(permissions.has(PermissionFlagsBits.Speak), 'Hydra needs Speak in that voice channel.');
        }
    }

    async search(input, user) {
        const query = searchInput(input, this.client.config.mediaHosts);
        check(this.manager.useableNode, 'No audio node is available. Please try again shortly.');
        try {
            const result = await this.manager.search(query, { id: user.id });
            if (result.loadType === LoadTypes.Error) throw new Error('Track load failed');
            check(result.tracks.length > 0, 'No tracks matched that request.');
            return result;
        } catch (error) {
            if (error instanceof UserError) throw error;
            log('Lavalink search failed', error);
            throw new UserError('The audio source could not load that request.');
        }
    }

    async join(guild, voice, textChannelId) {
        const existing = this.get(guild.id);
        if (existing) {
            check(existing.voiceChannelId === voice.id && existing.state !== StateTypes.Destroying,
                'The voice connection is changing. Please try again shortly.');
            return existing;
        }
        check(this.manager.useableNode, 'No audio node is available. Please try again shortly.');
        const player = this.manager.create({ guildId: guild.id, voiceChannelId: voice.id, textChannelId, selfDeafen: true });
        try {
            player.connect();
        } catch (error) {
            await player.destroy().catch(failure => log('Player cleanup failed', failure));
            throw error;
        }
        this.schedule(player, 'join', 15_000);
        this.evaluate(player);
        return player;
    }

    async enqueue(ctx, tracks) {
        const voice = this.voiceFor(ctx, true);
        const previous = this.get(ctx.guild.id);
        const player = await this.join(ctx.guild, voice, ctx.channelId);
        const queue = player.queue;
        const available = queueLimit - queue.totalSize;
        check(available > 0, 'The queue is full.');
        const toAdd = tracks.slice(0, available);
        const oldCurrent = queue.current;
        const oldLength = queue.length;
        queue.add(toAdd);
        try {
            if (!player.playing && !player.paused) await player.play();
            if (player.textChannelId !== ctx.channelId) player.setTextChannelId(ctx.channelId);
        } catch (error) {
            if (!previous) await player.destroy().catch(failure => log('Player cleanup failed', failure));
            else {
                queue.current = oldCurrent;
                queue.splice(oldLength);
                this.evaluate(player);
            }
            throw error;
        }
        this.evaluate(player);
        this.client.panels.refresh(ctx.guild.id);
        return toAdd.length;
    }

    evaluate(player) {
        if (this.closed || this.get(player.guildId) !== player || player.state === StateTypes.Destroying) return;
        const guild = this.client.guilds.cache.get(player.guildId);
        const voice = guild?.channels.cache.get(player.voiceChannelId);
        const alone = voice && !voice.members.some(member => !member.user.bot);
        if (alone) this.schedule(player, 'empty');
        else this.cancel(player, 'empty');
        if (player.queue.current) this.cancel(player, 'idle');
        else this.schedule(player, 'idle');
    }

    schedule(player, reason, delay = idleDelay) {
        if (this.closed) return;
        const timers = this.timers.get(player) ?? new Map();
        if (timers.has(reason)) return;
        const timer = setTimeout(() => {
            this.cancel(player, reason);
            this.run(player.guildId, async () => {
                if (this.get(player.guildId) !== player || player.state === StateTypes.Destroying) return;
                const guild = this.client.guilds.cache.get(player.guildId);
                if (!guild?.available || !player.node.connected) {
                    this.schedule(player, reason);
                    return;
                }
                if (reason === 'join') {
                    if (guild.members.me?.voice.channelId !== player.voiceChannelId) await player.destroy();
                    return;
                }
                try {
                    const stay = await this.client.settings.get('stay', player.guildId);
                    if (stay?.mode === true) return;
                } catch (error) {
                    this.schedule(player, reason);
                    throw error;
                }
                const voice = guild.channels.cache.get(player.voiceChannelId);
                const alone = voice && !voice.members.some(member => !member.user.bot);
                if ((reason === 'idle' && !player.queue.current) || (reason === 'empty' && alone)) {
                    await player.destroy();
                }
            });
        }, delay);
        timer.unref();
        timers.set(reason, timer);
        this.timers.set(player, timers);
    }

    cancel(player, reason) {
        const timers = this.timers.get(player);
        if (!timers) return;
        clearTimeout(timers.get(reason));
        timers.delete(reason);
        if (!timers.size) this.timers.delete(player);
    }

    run(guildId, operation) {
        if (!this.closed && !this.client.closing) {
            void this.client.tasks.run(guildId, operation, true).catch(error => log('Music lifecycle operation failed', error));
        }
    }

    voiceChanged(oldState, newState) {
        const player = this.get(newState.guild.id);
        if (!player) return;
        if (oldState.channelId === newState.channelId && oldState.serverMute === newState.serverMute) return;
        this.evaluate(player);
        if (newState.id !== this.client.user.id) return;
        this.run(player.guildId, async () => {
            if (this.get(player.guildId) !== player || !newState.channelId) return;
            if (newState.channelId === player.voiceChannelId) this.cancel(player, 'join');
            if (newState.channel?.type === ChannelType.GuildStageVoice && newState.suppress &&
                oldState.channelId !== newState.channelId) {
                const permissions = newState.channel.permissionsFor(this.client.user);
                if (permissions?.has(PermissionFlagsBits.MuteMembers)) await newState.setSuppressed(false);
                else if (permissions?.has(PermissionFlagsBits.RequestToSpeak)) await newState.setRequestToSpeak(true);
            }
            if (newState.serverMute && player.playing && !player.paused) {
                await player.pause(true);
                player.set('hydraServerPaused', true);
            } else if (!newState.serverMute && player.get('hydraServerPaused')) {
                await player.pause(false);
                player.set('hydraServerPaused', false);
            }
            this.client.panels.refresh(player.guildId);
        });
    }

    async restoreGuild(guild) {
        if (this.closed || !guild?.available || !this.manager.useableNode || this.get(guild.id)) return;
        const stay = await this.client.settings.get('stay', guild.id);
        if (stay?.mode !== true) return;
        const voice = guild.channels.cache.get(stay.voiceChannel);
        if (!voice?.isVoiceBased()) return;
        try { this.assertVoicePermissions(voice); }
        catch (error) {
            if (error instanceof UserError) return;
            throw error;
        }
        await this.join(guild, voice, stay.textChannel);
    }

    restoreConfigured() {
        if (this.restoring || this.closed) return;
        this.restoring = this.restoreAll().catch(error => log('24/7 restoration failed', error))
            .finally(() => { this.restoring = undefined; });
    }

    async restoreAll() {
        const ids = [...this.client.guilds.cache.keys()];
        for (let i = 0; i < ids.length && !this.closed && !this.client.closing; i += 100) {
            const records = await this.client.settings.staying(ids.slice(i, i + 100));
            for (const stay of records) {
                if (this.closed || this.client.closing) return;
                await this.client.tasks.run(stay._id, () => this.restoreGuild(this.client.guilds.cache.get(stay._id)), true)
                    .catch(error => log('24/7 player restoration failed', error));
            }
        }
    }

    retryNode(identifier) {
        if (this.closed || this.client.closing || this.nodeRetries.has(identifier)) return;
        const config = this.client.config.nodes.find(node => node.identifier === identifier);
        if (!config) return;
        const timer = setTimeout(() => {
            this.nodeRetries.delete(identifier);
            if (this.closed || this.client.closing) return;
            try { this.manager.createNode(config); }
            catch (error) {
                log('Lavalink node restart failed', error);
                this.retryNode(identifier);
            }
        }, 60_000);
        timer.unref();
        this.nodeRetries.set(identifier, timer);
    }

    bindEvents() {
        const { manager, client } = this;
        manager.on(ManagerEventTypes.NodeConnect, node => {
            log(`Lavalink node connected (${node.options.identifier})`);
            for (const player of manager.players.values()) {
                if (player.node === node) {
                    this.evaluate(player);
                    client.panels.refresh(player.guildId);
                }
            }
            this.restoreConfigured();
        });
        manager.on(ManagerEventTypes.NodeDisconnect, node => log(`Lavalink node disconnected (${node.options.identifier})`));
        manager.on(ManagerEventTypes.NodeDestroy, node => this.retryNode(node.options.identifier));
        manager.on(ManagerEventTypes.NodeError, (_node, error) => log('Lavalink node error', error));
        manager.on(ManagerEventTypes.TrackStuck, () => log('Lavalink reported a stuck track'));
        manager.on(ManagerEventTypes.TrackError, () => log('Lavalink reported a track failure'));
        manager.on(ManagerEventTypes.TrackStart, (player, track) => {
            this.evaluate(player);
            client.panels.refresh(player.guildId);
            this.run(player.guildId, async () => {
                if (this.get(player.guildId) !== player || player.queue.current !== track) return;
                const guild = client.guilds.cache.get(player.guildId);
                if (guild?.members.me?.voice.serverMute && !player.paused) {
                    await player.pause(true);
                    player.set('hydraServerPaused', true);
                    client.panels.refresh(player.guildId);
                }
                await client.panels.announce(player, track, trackName(track));
            });
        });
        manager.on(ManagerEventTypes.TrackEnd, player => {
            if (!player.queue.current) this.evaluate(player);
            client.panels.refresh(player.guildId);
        });
        manager.on(ManagerEventTypes.QueueEnd, player => {
            this.evaluate(player);
            client.panels.refresh(player.guildId);
            this.run(player.guildId, () => client.panels.prune(player));
        });
        manager.on(ManagerEventTypes.PlayerMove, player => this.evaluate(player));
        manager.on(ManagerEventTypes.PlayerDestroy, player => {
            for (const timer of this.timers.get(player)?.values() ?? []) clearTimeout(timer);
            this.timers.delete(player);
            client.panels.refresh(player.guildId);
            this.run(player.guildId, () => client.panels.prune(player));
        });
    }

    async close() {
        this.closed = true;
        for (const timers of this.timers.values()) {
            for (const timer of timers.values()) clearTimeout(timer);
        }
        this.timers.clear();
        for (const timer of this.nodeRetries.values()) clearTimeout(timer);
        this.nodeRetries.clear();
        await this.restoring;
        await this.manager.handleShutdown();
    }
}

module.exports = { Music };
