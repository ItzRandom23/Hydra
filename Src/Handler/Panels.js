const {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, DiscordAPIError, EmbedBuilder, PermissionFlagsBits,
    StringSelectMenuBuilder,
} = require('discord.js');
const path = require('node:path');
const { ExpiringMap, check } = require('./Runtime');
const { display, duration, trackName } = require('./Media');
const { log } = require('../Utility/Console');

const color = 0xf50a83;
const bannerName = 'hydra-song-requests.png';
const bannerPath = path.join(__dirname, '..', '..', 'anime.png');
const controlIds = {
    pause_but: 'pause', skipbut_but: 'skip', stop_but: 'stop', loopmodesbut_but: 'loop', shuffle_but: 'shuffle',
};
const own = (object, key) => Object.hasOwn(object, key);

function embed(text, title) {
    const result = new EmbedBuilder().setColor(color).setDescription(text);
    if (title) result.setTitle(title);
    return result;
}

function button(id, label, disabled = false) {
    return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
}

function trackArtwork(track) {
    const url = typeof track?.artworkUrl === 'string' ? URL.parse(track.artworkUrl) : null;
    if (url?.protocol === 'https:' && !url.username && !url.password) return url.href;
}

function hasIdleBanner(message) {
    const image = message.embeds[0]?.image?.url;
    const url = typeof image === 'string' ? URL.parse(image) : null;
    return message.attachments.size === 0 && message.embeds.length === 1 &&
        message.embeds[0].title === 'Song requests' && url?.origin === 'https://cdn.discordapp.com' &&
        url.pathname.startsWith('/attachments/') && url.pathname.endsWith(`/${bannerName}`);
}

function setupPanel(player, { canUpload = true } = {}) {
    const track = player?.queue.current;
    const labels = [player?.paused ? 'Resume' : 'Pause', 'Skip', 'Stop', 'Loop', 'Shuffle'];
    const controls = Object.keys(controlIds).map((id, index) => button(id, labels[index], !track));
    const body = track ? `${trackName(track)} · ${track.isStream ? 'Live' : duration(track.duration)}` :
        'Join a voice channel and send a song name or supported link here.';
    const info = embed(body, track ? 'Now playing' : 'Song requests');
    const uploadBanner = !track && canUpload;
    const image = uploadBanner ? `attachment://${bannerName}` : trackArtwork(track);
    if (image) info.setImage(image);
    if (track) {
        const queue = player.queue.slice(0, 5).map((item, index) => `${index + 1}. ${display(item.title, 80)}`).join('\n');
        if (queue) info.addFields({ name: 'Up next', value: queue });
        const loop = player.trackRepeat ? 'Track' : player.queueRepeat ? 'Queue' : 'Off';
        info.setFooter({ text: `${player.queue.length} queued · ${player.volume}% volume · Loop ${loop}` });
    }
    return {
        embeds: [info],
        components: [new ActionRowBuilder().addComponents(controls)],
        ...(uploadBanner ? { files: [new AttachmentBuilder(bannerPath, { name: bannerName })] } : {}),
    };
}

class Panels {
    constructor(client) {
        this.client = client;
        this.sessions = new ExpiringMap(1000, 60_000);
        this.refreshing = new Set();
        this.pruned = new WeakMap();
    }

    async choose(ctx, prompt, choices, action, { select = false, player = undefined } = {}) {
        const components = select ? [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('hydra:select').setPlaceholder('Select a track')
                .addOptions(choices.map((label, index) => ({
                    label: String(label || 'Unknown').replace(/\p{Cc}/gu, ' ').slice(0, 100), value: String(index),
                }))),
        )] : [new ActionRowBuilder().addComponents(choices.map((label, index) => button(`hydra:pick:${index}`, label)))];
        const message = await ctx.reply({ embeds: [embed(prompt)], components });
        this.sessions.set(message.id, { userId: ctx.user.id, guildId: ctx.guild.id, choices, action, player, select });
    }

    async pages(ctx, pages) {
        const payload = index => {
            const info = pages[index].setFooter({ text: `Page ${index + 1} of ${pages.length}` });
            const row = new ActionRowBuilder().addComponents(
                button('hydra:first', 'First', index === 0), button('hydra:back', 'Previous', index === 0),
                button('hydra:close', 'Close'), button('hydra:next', 'Next', index === pages.length - 1),
                button('hydra:last', 'Last', index === pages.length - 1),
            );
            return { embeds: [info], components: pages.length > 1 ? [row] : [] };
        };
        const message = await ctx.reply(payload(0));
        if (pages.length > 1) this.sessions.set(message.id, { userId: ctx.user.id, guildId: ctx.guild.id, payload, index: 0, count: pages.length });
    }

    handles(id) {
        return own(controlIds, id) || id.startsWith('hydra:') ||
            /^(?:SEARCH_SELECT_MENU|(?:queue_cmd|previous_but_help|next_but_help|dj_roles_list|speed_button|bb_button)_|cqueue$|cfilter$|addprevious$|playprevious$)/.test(id);
    }

    async handle(ctx, interaction) {
        const id = interaction.customId;
        if (own(controlIds, id)) {
            const setup = await this.client.settings.get('setup', ctx.guild.id);
            check(setup?.channel === ctx.channelId && setup.message === interaction.message.id, 'This player panel has expired.');
            await this.client.runCommand(ctx, controlIds[id], [], { control: true });
            return;
        }

        const message = interaction.message;
        const session = this.sessions.get(message.id);
        check(session?.guildId === ctx.guild.id, 'This menu has expired. Run the command again.');
        check(session.userId === ctx.user.id, 'Only the member who opened this menu can use it.');
        if (session.payload) {
            const offsets = { 'hydra:first': -Infinity, 'hydra:back': -1, 'hydra:next': 1, 'hydra:last': Infinity };
            if (id === 'hydra:close') {
                this.sessions.delete(message.id);
                await message.edit({ components: [] });
            } else {
                check(own(offsets, id), 'That option is unavailable.');
                const index = Math.max(0, Math.min(session.index + offsets[id], session.count - 1));
                await message.edit(session.payload(index));
                session.index = index;
            }
            await interaction.deleteReply();
            return;
        }

        check(!session.player || this.client.music.get(ctx.guild.id) === session.player, 'That player session has ended.');
        const value = session.select && interaction.isStringSelectMenu() && id === 'hydra:select' ? interaction.values[0] :
            !session.select && interaction.isButton() && id.startsWith('hydra:pick:') ? id.slice(11) : '';
        check(typeof value === 'string' && /^\d+$/.test(value) && Number(value) < session.choices.length, 'That option is unavailable.');
        await session.action(ctx, Number(value));
        this.sessions.delete(message.id);
        await message.edit({ components: [] }).catch(error => log('Could not close a completed music menu', error));
    }

    refresh(guildId) {
        if (this.client.closing || this.refreshing.has(guildId)) return;
        this.refreshing.add(guildId);
        void this.client.tasks.run(guildId, async () => {
            this.refreshing.delete(guildId);
            await this.update(guildId);
        }, true).catch(error => {
            this.refreshing.delete(guildId);
            log('Could not update a song request panel', error);
        });
    }

    async update(guildId) {
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild?.available) return;
        const setup = await this.client.settings.get('setup', guildId);
        if (!setup?.channel || !setup.message) return;
        const match = { channel: setup.channel, message: setup.message };
        const channel = guild.channels.cache.get(setup.channel);
        if (!channel?.isSendable()) {
            await this.client.settings.remove('setup', guildId, match);
            return;
        }
        try {
            const message = await channel.messages.fetch(setup.message);
            const player = this.client.music.get(guildId);
            if (!player?.queue.current && hasIdleBanner(message)) return;
            const canUpload = channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.AttachFiles) ?? false;
            const payload = setupPanel(player, { canUpload });
            const updated = await channel.messages.edit(message, { content: null, attachments: [], ...payload });
            channel.messages.cache.set(updated.id, updated);
        } catch (error) {
            if (error instanceof DiscordAPIError && (error.code === 10008 || error.code === 10003)) {
                await this.client.settings.remove('setup', guildId, match);
            }
            else throw error;
        }
    }

    async announce(player, track, title) {
        const before = this.pruned.get(player);
        this.pruned.delete(player);
        if (before?.deletable) await before.delete().catch(error => log('Could not prune the track announcement', error));
        const guild = this.client.guilds.cache.get(player.guildId);
        if (!guild?.available) return;
        const [setup, config] = await Promise.all([
            this.client.settings.get('setup', player.guildId), this.client.settings.get('announce', player.guildId),
        ]);
        if (config?.mode === false || this.client.music.get(player.guildId) !== player || player.queue.current !== track) return;
        const channelId = config?.channel || player.textChannelId;
        if (channelId === setup?.channel) return;
        const channel = guild.channels.cache.get(channelId);
        if (!channel?.isSendable()) return;
        const message = await channel.send({ embeds: [embed(title, 'Started playing')] });
        if (config?.prunning) this.pruned.set(player, message);
    }

    async prune(player) {
        const message = this.pruned.get(player);
        this.pruned.delete(player);
        if (message?.deletable) await message.delete().catch(error => log('Could not prune the track announcement', error));
    }
}

module.exports = { Panels, embed, setupPanel };
