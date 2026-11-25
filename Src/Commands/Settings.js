const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { validPrefix, snowflake } = require('../Config');
const { check } = require('../Handler/Runtime');
const { display } = require('../Handler/Media');
const { embed, setupPanel } = require('../Handler/Panels');
const { log } = require('../Utility/Console');
const { command } = require('./Music');

const admin = { admin: true };
const is = (value, ...values) => values.includes(value);
const identifier = (value, syntax) => {
    if (typeof value !== 'string') return undefined;
    return snowflake.test(value) ? value : syntax.exec(value)?.[1];
};
const stamp = value => /^\d{10}$/.test(value) ? ` · Updated <t:${value}:R>` : '';

const commands = [
    command('prefix', [], 'View or change the server’s command prefix.', async (ctx, [action, value]) => {
        const store = ctx.client.settings;
        const id = ctx.guild.id;
        const data = await store.get('prefix', id);
        const prefix = validPrefix(data?.prefix) ? data.prefix : ctx.client.config.prefix;
        const oldPrefix = validPrefix(data?.oldPrefix) ? data.oldPrefix : ctx.client.config.prefix;
        if (!action || is(action, 'info', 'stats', 'status')) {
            return ctx.say(`Current prefix ${display(prefix)} · Previous prefix ${display(oldPrefix)}${stamp(data?.lastUpdated)}`, 'Prefix');
        }
        if (is(action, 'clear', 'delete', 'd')) {
            await store.remove('prefix', id);
            return ctx.say(`Restored the default prefix ${display(ctx.client.config.prefix)}.`);
        }
        const restore = is(action, 'reset', 'restore', 'r');
        check(restore || is(action, 'set', 's', 'change'), 'Use prefix set <value>, prefix restore, or prefix clear.');
        const target = restore ? oldPrefix : value;
        check(validPrefix(target), 'Use a prefix of one to three visible characters without spaces.');
        if (target !== prefix) await store.update('prefix', id, ctx.user.id, { prefix: target, oldPrefix: prefix });
        await ctx.say(`The prefix is ${display(target)}.`);
    }, { ...admin, usage: '[info|set|restore|clear] [value]' }),

    command('dj', [], 'Configure DJ roles and show who has access.', async (ctx, [action, target]) => {
        const store = ctx.client.settings;
        const id = ctx.guild.id;
        const data = await store.get('dj', id);
        const roles = [...new Set(Array.isArray(data?.roles) ? data.roles.filter(role => snowflake.test(role)) : [])];

        if (is(action, 'add', 'a', 'set', 's')) {
            const role = ctx.guild.roles.cache.get(identifier(target, /^<@&(\d{17,20})>$/));
            check(role && role.id !== id, 'Provide a server role mention or ID other than @everyone.');
            check(data?.mode !== false, 'Enable DJ mode before adding a role.');
            check(roles.length < 250 || roles.includes(role.id), 'The DJ role list is full.');
            if (!roles.includes(role.id)) {
                await store.update('dj', id, ctx.user.id, { mode: true, roles: [...roles, role.id] });
            }
            return ctx.say(`<@&${role.id}> can use DJ controls.`);
        }
        if (is(action, 'toggle', 't')) {
            check(data, 'Add a DJ role first.');
            await store.update('dj', id, ctx.user.id, { mode: !data.mode }, false);
            return ctx.say(`DJ mode is ${data.mode ? 'off' : 'on'}.`);
        }
        if (is(action, 'clear', 'reset')) {
            await store.remove('dj', id);
            return ctx.say('Cleared DJ roles and disabled DJ mode.');
        }
        if (is(action, 'remove', 'delete')) {
            const roleId = identifier(target, /^<@&(\d{17,20})>$/) ||
                (/^\d{1,3}$/.test(target) ? roles[Number(target) - 1] : undefined);
            check(roles.includes(roleId), 'Choose a role by mention, ID, or its number in the DJ role list.');
            await store.update('dj', id, ctx.user.id, { roles: roles.filter(role => role !== roleId) }, false);
            return ctx.say('Removed the DJ role.');
        }
        if (is(action, 'list', 'roles')) {
            check(roles.length, 'There are no DJ roles.');
            const pages = [];
            for (let i = 0; i < roles.length; i += 15) {
                const lines = roles.slice(i, i + 15).map((role, index) =>
                    `${i + index + 1}. ${ctx.guild.roles.cache.has(role) ? `<@&${role}>` : `Deleted role ${role}`}`);
                pages.push(embed(lines.join('\n'), 'DJ roles'));
            }
            return ctx.client.panels.pages(ctx, pages);
        }
        if (is(action, 'members', 'users', 'm')) {
            check(ctx.client.config.membersIntent, 'The bot operator must enable the Server Members intent to list DJs.');
            const members = await ctx.guild.members.fetch({ time: 8000 });
            const visible = [];
            for (const member of members.values()) {
                if (roles.some(role => member.roles.cache.has(role))) visible.push(member.id);
                if (visible.length >= 51) break;
            }
            const result = visible.slice(0, 50).map(member => `<@${member}>`).join(', ');
            return ctx.say(result ? result + (visible.length > 50 ? ' …' : '') : 'No members have a DJ role.', 'DJ members');
        }
        check(!action || is(action, 'info', 'stats'), 'Use dj add, remove, toggle, list, members, info, or clear.');
        await ctx.say(`DJ mode is ${data?.mode === true ? 'on' : 'off'} · ${roles.length} configured roles${stamp(data?.lastUpdated)}.\nMembers with Manage Server or Mute Members can use DJ controls.`, 'DJ settings');
    }, { ...admin, usage: '[add|remove|toggle|list|members|info|clear] [role]' }),

    command('announce', [], 'Configure track-start announcements.', async (ctx, [action, target]) => {
        const store = ctx.client.settings;
        const id = ctx.guild.id;
        const data = await store.get('announce', id);
        let fields;
        if (!action || is(action, 'on', 'off')) {
            fields = { mode: action ? action === 'on' : data?.mode === false };
        } else if (is(action, 'set', 'change')) {
            const channel = ctx.guild.channels.cache.get(identifier(target, /^<#(\d{17,20})>$/));
            const permissions = channel?.permissionsFor(ctx.guild.members.me);
            check(channel?.isSendable() && permissions?.has([
                PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks,
                channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages,
            ]), 'Choose a channel where Hydra can send embeds.');
            fields = { channel: channel.id, mode: true };
        } else if (is(action, 'prune', 'pruning', 'prunning', 'p')) {
            fields = { prunning: data?.prunning !== true, mode: data?.mode ?? true };
        } else if (is(action, 'info', 'stats')) {
            return ctx.say(`Announcements are ${data?.mode === false ? 'off' : 'on'}. ${data?.channel ? `Channel <#${data.channel}>.` : 'Using the playback channel.'} Pruning is ${data?.prunning ? 'on' : 'off'}.`);
        } else {
            check(false, 'Use announce [on|off|set #channel|prune|info].');
        }
        const updated = await store.update('announce', id, ctx.user.id, fields);
        await ctx.say(`Announcements are ${updated.mode ? 'on' : 'off'}${updated.channel ? ` in <#${updated.channel}>` : ''}. Pruning is ${updated.prunning ? 'on' : 'off'}.`);
    }, { ...admin, usage: '[on|off|set|prune|info] [channel]' }),

    command('247', ['24/7', '24h'], 'Keep Hydra connected between tracks.', async (ctx, [action], existing) => {
        const { settings, music } = ctx.client;
        const id = ctx.guild.id;
        const data = await settings.get('stay', id);
        check(!action || is(action, 'on', 'off', 'info'), 'Use 247 [on|off|info].');
        if (action === 'info') return ctx.say(`24/7 mode is ${data?.mode === true ? 'on' : 'off'}.`);
        const enable = action ? action === 'on' : data?.mode !== true;
        if (!enable) {
            await settings.update('stay', id, ctx.user.id, { mode: false, textChannel: null, voiceChannel: null });
            if (existing) music.evaluate(existing);
            return ctx.say('24/7 mode is off.');
        }
        const voice = music.voiceFor(ctx, true);
        const player = await music.join(ctx.guild, voice, ctx.channelId);
        try {
            await settings.update('stay', id, ctx.user.id, { mode: true, textChannel: ctx.channelId, voiceChannel: voice.id });
        } catch (error) {
            if (!existing) await player.destroy().catch(failure => log('24/7 player cleanup failed', failure));
            throw error;
        }
        await ctx.say(`24/7 mode is on in <#${voice.id}>.`);
    }, { ...admin, usage: '[on|off|info]' }),

    command('setup', [], 'Create or disable a dedicated song request channel.', async (ctx, [action]) => {
        const { settings, music } = ctx.client;
        const id = ctx.guild.id;
        const data = await settings.get('setup', id);
        if (is(action, 'clear', 'delete', 'reset')) {
            check(data, 'This server has no request channel.');
            await settings.remove('setup', id);
            const channel = ctx.guild.channels.cache.get(data.channel);
            if (channel?.isSendable()) {
                await channel.messages.edit(data.message, { content: 'Song requests are disabled.', embeds: [], components: [], attachments: [] })
                    .catch(error => log('Could not disable the old panel', error));
            }
            return ctx.say('Disabled the song request channel.');
        }
        if (is(action, 'info', 'stats')) {
            check(data, 'This server has no request channel.');
            const channel = ctx.guild.channels.cache.get(data.channel);
            const hint = channel && !channel.permissionsFor(ctx.guild.members.me)?.has(PermissionFlagsBits.AttachFiles)
                ? ' Grant Hydra **Attach Files** there so it can upload the panel image.'
                : '';
            return ctx.say(`Request channel <#${data.channel}>${stamp(data.lastUpdated)}.${hint}`);
        }
        check(!action || action === 'create', 'Use setup [create|info|clear].');
        check(!data || !ctx.guild.channels.cache.has(data.channel), 'This server already has a song request channel.');
        check(ctx.guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels), 'Hydra needs Manage Channels to create the request channel.');
        const channel = await ctx.guild.channels.create({ name: 'hydra-song-requests', type: ChannelType.GuildText });
        try {
            check(channel.permissionsFor(ctx.guild.members.me)?.has(PermissionFlagsBits.AttachFiles),
                'Hydra needs Attach Files to show the request channel image.');
            const panel = await channel.send(setupPanel(music.get(id)));
            await settings.update('setup', id, ctx.user.id, { channel: channel.id, message: panel.id, setuped: true });
        } catch (error) {
            await channel.delete('Hydra: could not complete channel setup').catch(failure => log('Setup cleanup failed', failure));
            throw error;
        }
        await ctx.say(`Song requests are ready in <#${channel.id}>.`);
    }, { ...admin, usage: '[create|info|clear]' }),
];

module.exports = commands;
