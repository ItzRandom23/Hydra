const { ChannelType, PermissionFlagsBits, version } = require('discord.js');
const { check } = require('../Handler/Runtime');
const { display, duration } = require('../Handler/Media');
const { embed } = require('../Handler/Panels');
const { command } = require('./Music');
const { serverInvite } = require('../Utility/DiscordInstall');

module.exports = [
    command('help', ['h', 'commands', 'cmds'], 'List commands or show command usage.', async (ctx, [name]) => {
        const client = ctx.client;
        const prefix = await client.settings.prefix(ctx.guild.id);
        const canSee = item => !item.owner || client.config.owners.has(ctx.user.id);
        if (name) {
            const item = client.commands.get(name.toLowerCase());
            check(item && canSee(item), 'That command is unavailable.');
            const aliases = item.aliases.length ? `\nAliases ${item.aliases.map(alias => display(alias)).join(', ')}` : '';
            return ctx.say(`${item.description}\n\n${display(prefix + item.name)} ${display(item.usage ?? '')}${aliases}`, item.name);
        }
        const categories = new Map();
        for (const item of client.commandList.filter(canSee)) {
            const items = categories.get(item.category) ?? [];
            items.push(item.name);
            categories.set(item.category, items);
        }
        const info = embed(`Use ${display(prefix)} or mention Hydra to run prefix commands. Use ${display(prefix + 'help')} followed by a command for details.`, 'Hydra commands');
        for (const [name, items] of categories) info.addFields({ name, value: items.map(item => `\`${item}\``).join(' · ') });
        await ctx.reply({ embeds: [info] });
    }, { usage: '[command]' }),
    command('invite', ['addme', 'add'], 'Show Hydra’s installation link.', async ctx => {
        const url = serverInvite(ctx.client.application.id);
        await ctx.say(`[Add Hydra to a server](${url})`);
    }),
    command('ping', ['pong'], 'Show Discord gateway latency.', async ctx => {
        const ping = ctx.guild.shard.ping;
        await ctx.say(ping >= 0 ? `Discord gateway latency is ${Math.round(ping)} ms.` : 'Discord gateway latency is unavailable.');
    }),
    command('stats', ['info'], 'Show server count, uptime, and runtime versions.', async ctx => {
        const client = ctx.client;
        const guilds = client.guilds.cache.filter(guild => guild.available);
        const members = guilds.reduce((total, guild) => total + guild.memberCount, 0);
        await ctx.say(`Servers ${guilds.size} · Members ${members} · Players ${client.music.manager.players.size}\nUptime ${duration(process.uptime() * 1000)} · Node.js ${process.version} · Discord.js ${version}`, 'Hydra statistics');
    }),
    command('node', ['lavalink'], 'Show configured audio node health.', async ctx => {
        const rows = [...ctx.client.music.manager.nodes.values()].map(node =>
            `${display(node.options.identifier)} · ${node.connected ? 'Connected' : 'Offline'} · ${node.stats?.playingPlayers ?? 0} playing`);
        await ctx.say(rows.join('\n') || 'No Lavalink nodes are configured.', 'Audio nodes');
    }, { owner: true }),
    command('getinvite', ['gi'], 'Create a limited-use invite for this server.', async (ctx, [guildId]) => {
        check(!guildId || guildId === ctx.guild.id, 'Run this command in the server you want to invite someone to.');
        check(ctx.channel.type === ChannelType.GuildText, 'Use a server text channel to create the invite.');
        check(ctx.channel.permissionsFor(ctx.member)?.has(PermissionFlagsBits.CreateInstantInvite) &&
            ctx.channel.permissionsFor(ctx.guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite),
        'You and Hydra both need Create Invite in this channel.');
        const invite = await ctx.channel.createInvite({ maxAge: 900, maxUses: 1, unique: true, reason: 'Hydra owner invite command' });
        await ctx.say(`[One-use invite](${invite.url}) · Expires in 15 minutes.`);
    }, { owner: true, admin: true, usage: '[current server ID]' }),
];
