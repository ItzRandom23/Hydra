const { PermissionFlagsBits } = require('discord.js');
const { LoadTypes } = require('pulsifyy');
const { check } = require('../Handler/Runtime');
const { display, duration, trackName, timeInput, integer } = require('../Handler/Media');
const { embed } = require('../Handler/Panels');

const voice = { voice: true };
const control = { voice: true, player: true, dj: true };
const active = { ...control, track: true };
const readonly = { player: true, track: true };
/** @typedef {{voice?: boolean, player?: boolean, track?: boolean, dj?: boolean, admin?: boolean, owner?: boolean, usage?: string}} CommandRules */
/** @param {CommandRules} [options] */
const command = (name, aliases, description, execute, options = {}) =>
    ({ name, aliases, description, execute, ...options });

const repeat = player => player.trackRepeat ? 'track' : player.queueRepeat ? 'queue' : 'off';

async function enqueue(ctx, tracks) {
    const count = await ctx.client.music.enqueue(ctx, tracks);
    if (tracks.length === 1) return ctx.say(`Queued ${trackName(tracks[0])}.`);
    return ctx.say(`Queued ${count} of ${tracks.length} tracks.`);
}

function toggleShuffle(player) {
    const queue = player.queue;
    const previous = player.get('hydraShuffleOrder');
    if (previous) {
        // Restore only surviving entries. Keep tracks queued after the shuffle in their relative order.
        const remaining = new Map();
        for (const track of queue) remaining.set(track, (remaining.get(track) || 0) + 1);
        const ordered = [];
        for (const track of [...previous, ...queue]) {
            const count = remaining.get(track);
            if (!count) continue;
            remaining.set(track, count - 1);
            ordered.push(track);
        }
        queue.splice(0, queue.length, ...ordered);
        player.set('hydraShuffleOrder', undefined);
        return 'Restored the queue order.';
    }
    check(queue.length >= 2, 'Queue at least two tracks to shuffle.');
    player.set('hydraShuffleOrder', [...queue]);
    queue.shuffle();
    return 'Shuffled the queue.';
}

function seekWithin(player, time) {
    const track = player.queue.current;
    check(track.isSeekable && !track.isStream, 'This track cannot seek.');
    check(time < track.duration, `Choose a position before ${duration(track.duration)}.`);
    return player.seek(Math.max(0, time));
}

async function skip(ctx, args, player) {
    const index = args.length ? integer(args[0], 1, player.queue.length, 'Choose a track number from the queue.') : 1;
    const name = trackName(player.queue.current);
    await player.stop(index);
    await ctx.say(`Skipped ${name}.`);
}

async function setPaused(ctx, player, state) {
    check(state || !ctx.guild.members.me?.voice.serverMute, 'A moderator must unmute Hydra before playback can resume.');
    await player.pause(state);
    player.set('hydraServerPaused', false);
    await ctx.say(state ? 'Playback paused.' : 'Playback resumed.');
}

const commands = [
    command('play', ['p'], 'Queue a song or playlist.', async (ctx, args) => {
        ctx.client.music.voiceFor(ctx, true);
        const result = await ctx.client.music.search(args.join(' '), ctx.user);
        await enqueue(ctx, result.loadType === LoadTypes.Playlist ? result.tracks : result.tracks.slice(0, 1));
    }, { ...voice, usage: '<song or link>' }),
    command('search', ['se'], 'Select a track from search results.', async (ctx, args) => {
        ctx.client.music.voiceFor(ctx, true);
        const { tracks } = await ctx.client.music.search(args.join(' '), ctx.user);
        const choices = tracks.slice(0, 10);
        await ctx.client.panels.choose(ctx, 'Choose a track to queue.', choices.map(track => track.title),
            (selection, index) => enqueue(selection, [choices[index]]), { select: true });
    }, { ...voice, usage: '<song or link>' }),
    command('join', ['connect'], 'Join your voice channel.', async ctx => {
        const channel = ctx.client.music.voiceFor(ctx, true);
        await ctx.client.music.join(ctx.guild, channel, ctx.channelId);
        await ctx.say(`Joining <#${channel.id}>.`);
    }, voice),
    command('leave', ['destroy', 'disconnect', 'dc'], 'Disconnect the player.', async (ctx, _args, player) => {
        await player.destroy();
        await ctx.say('Disconnected.');
    }, control),
    command('stop', ['end'], 'Stop playback and disconnect.', async (ctx, _args, player) => {
        await player.destroy();
        await ctx.say('Playback stopped.');
    }, control),
    command('pause', ['pau'], 'Pause playback.', (ctx, _args, player) => setPaused(ctx, player, ctx.control ? !player.paused : true), active),
    command('resume', ['res'], 'Resume playback.', (ctx, _args, player) => setPaused(ctx, player, false), active),
    command('skip', ['s'], 'Skip the current track or jump to a queue position.', skip, { ...active, usage: '[queue position]' }),
    command('loop', ['lp', 'repeat'], 'Toggle track or queue repeat.', async (ctx, args, player) => {
        const mode = repeat(player);
        const cycle = { off: 'track', track: 'queue', queue: 'off' };
        let goal = args[0]?.toLowerCase() ?? cycle[mode];
        check(['track', 'queue', 'off'].includes(goal), 'Choose track, queue, or off.');
        if (args.length && goal === mode) goal = 'off';
        if (goal === 'track') player.setTrackRepeat(true);
        else player.setQueueRepeat(goal === 'queue');
        await ctx.say(`Loop mode is ${goal}.`);
    }, { ...control, usage: '[track|queue|off]' }),
    command('volume', ['sound', 'vol'], 'Read or set the player volume.', async (ctx, args, player) => {
        if (args.length) await player.setVolume(integer(args[0], 0, 100, 'Enter an integer volume from 0 to 100.'));
        await ctx.say(`Volume is ${player.volume}%.`);
    }, { ...control, usage: '[0–100]' }),
    command('seek', ['sk'], 'Seek to an absolute track position.', async (ctx, args, player) => {
        await seekWithin(player, timeInput(args[0]));
        await ctx.say(`Position is ${duration(player.position)}.`);
    }, { ...active, usage: '<seconds or m:ss>' }),
    ...[{ name: 'forward', aliases: ['f'], direction: 1 }, { name: 'rewind', aliases: ['backward'], direction: -1 }].map(({ name, aliases, direction }) =>
        command(name, aliases, `Move ${name} in the track.`, async (ctx, args, player) => {
            const delta = args.length ? timeInput(args[0]) : 10_000;
            await seekWithin(player, player.position + delta * direction);
            await ctx.say(`Position is ${duration(player.position)}.`);
        }, { ...active, usage: '[seconds or m:ss]' })),
    command('replay', ['rep'], 'Restart the current track.', async (ctx, _args, player) => {
        check(!ctx.guild.members.me?.voice.serverMute, 'A moderator must unmute Hydra before playback can resume.');
        await player.restart();
        await ctx.say('Restarted the current track.');
    }, active),
    command('previous', ['adp'], 'Add or play the previous track.', async (ctx, args, player) => {
        const previous = player.queue.previous.at(-1);
        check(previous, 'There is no previous track.');
        const pick = async (selection, index) => {
            await ctx.client.authorize(selection, commands.find(item => item.name === 'previous'));
            check(player.queue.previous.at(-1) === previous, 'The previous track changed. Run the command again.');
            if (index === 0) {
                check(player.queue.totalSize < ctx.client.music.manager.options.maxQueueSize, 'The queue is full.');
                player.queue.add(previous);
            } else {
                check(!selection.guild.members.me?.voice.serverMute, 'A moderator must unmute Hydra before playback can resume.');
                await player.previous();
            }
            ctx.client.panels.refresh(ctx.guild.id);
            await selection.say(index === 0 ? 'Added the previous track.' : 'Playing the previous track.');
        };
        if (!args.length) return ctx.client.panels.choose(ctx, 'What should Hydra do with the previous track?',
            ['Add previous', 'Play previous'], pick, { player });
        check(['add', 'play'].includes(args[0]), 'Choose add or play.');
        await pick(ctx, args[0] === 'add' ? 0 : 1);
    }, { ...active, usage: '[add|play]' }),
    command('shuffle', ['mix'], 'Shuffle or restore the upcoming queue order.', async (ctx, _args, player) => {
        await ctx.say(toggleShuffle(player));
    }, control),
    command('clear', ['c'], 'Clear the upcoming queue or audio filters.', async (ctx, args, player) => {
        const pick = async (selection, index) => {
            await ctx.client.authorize(selection, control);
            if (index === 0) {
                player.queue.clear();
                player.set('hydraShuffleOrder', undefined);
            } else {
                await player.filters.clearFilters();
            }
            ctx.client.panels.refresh(ctx.guild.id);
            await selection.say(index === 0 ? 'Cleared the upcoming queue.' : 'Cleared all audio filters.');
        };
        if (!args.length) return ctx.client.panels.choose(ctx, 'What should Hydra clear?', ['Queue', 'Filters'], pick, { player });
        check(['queue', 'filter', 'filters'].includes(args[0]), 'Choose queue or filters.');
        await pick(ctx, args[0] === 'queue' ? 0 : 1);
    }, { ...control, usage: '[queue|filters]' }),
    command('autoplay', ['ap'], 'Toggle recommendations when the queue ends.', async (ctx, _args, player) => {
        check(ctx.client.config.autoplayPlatforms.length, 'Autoplay is disabled by the bot operator.');
        player.setAutoplay(!player.isAutoplay, ctx.client.user, 2);
        await ctx.say(`Autoplay is ${player.isAutoplay ? 'on' : 'off'}.`);
    }, control),
    command('remove', ['rem'], 'Remove queued tracks by position, requester, or duplicates.', async (ctx, args, player) => {
        const [action, target] = args;
        const queue = player.queue;
        const size = queue.length;
        check(size, 'There are no upcoming tracks.');
        if (['track', 'song', 't', 's'].includes(action) || /^\d+$/.test(action ?? '')) {
            const position = integer(target ?? action, 1, size, 'Choose a track number from the queue.');
            queue.remove(position - 1);
        } else if (['user', 'u', 'user_tracks', 'ut'].includes(action)) {
            check(ctx.member.permissions.has(PermissionFlagsBits.MuteMembers) || ctx.member.permissions.has(PermissionFlagsBits.ManageGuild),
                'You need Mute Members or Manage Server to remove another member’s requests.');
            const id = /^(?:<@!?(\d{17,20})>|(\d{17,20}))$/.exec(target);
            const requester = id?.[1] || id?.[2];
            check(requester, 'Provide a user mention or ID.');
            queue.splice(0, size, ...queue.filter(track => track.requester?.id !== requester));
        } else if (['dupes', 'dupe', 'd'].includes(action)) {
            const seen = new Set();
            queue.splice(0, size, ...queue.filter(track => {
                const key = track.uri ?? track.track;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }));
        } else {
            check(false, 'Use remove track <number>, remove user <user>, or remove dupes.');
        }
        await ctx.say(`Removed ${size - queue.length} queued tracks.`);
    }, { ...control, usage: '<track|user|dupes> [value]' }),
    command('queue', ['q'], 'Show the current and upcoming tracks.', async (ctx, _args, player) => {
        const queue = player.queue;
        const pages = [];
        const pageSize = 8;
        for (let i = 0; i < Math.max(queue.length, 1); i += pageSize) {
            const lines = queue.slice(i, i + pageSize).map((track, j) => `${i + j + 1}. ${display(track.title, 110)} · ${duration(track.duration)}`);
            pages.push(embed(`Now playing ${trackName(queue.current)}\n\n${lines.join('\n') || 'No upcoming tracks.'}`, 'Queue'));
        }
        await ctx.client.panels.pages(ctx, pages);
    }, readonly),
    command('nowplaying', ['np'], 'Show the current track and position.', async (ctx, _args, player) => {
        const track = player.queue.current;
        const progress = track.isStream ? 'Live' : `${duration(player.position)} / ${duration(track.duration)}`;
        await ctx.say(`${trackName(track)}\n${progress}${player.paused ? ' · Paused' : ''}`, 'Now playing');
    }, readonly),
    command('player', ['playerinfo'], 'Show player and queue settings.', async (ctx, _args, player) => {
        await ctx.say(`${player.queue.length} queued · ${player.volume}% volume\nLoop ${repeat(player)} · Autoplay ${player.isAutoplay ? 'on' : 'off'}`, 'Player');
    }, { player: true }),
];

module.exports = { commands, command, active };
