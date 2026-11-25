const { check } = require('../Handler/Runtime');
const { command, active } = require('./Music');

const bass = { None: 0, Low: 0.10, Medium: 0.15, High: 0.25 };
const treble = [0.6, 0.67, 0.67, 0, -0.5, 0.15, -0.25, 0.23, 0.35, 0.45, 0.55, 0.6, 0.55];
const band = (gain, index) => ({ band: index, gain });

async function filter(ctx, args, player, options) {
    const pick = async (selection, index) => {
        await ctx.client.authorize(selection, active);
        const label = options.choices[index];
        await options.apply(player.filters, label);
        await selection.say(`${options.name} set to ${label}.`);
    };
    if (!args.length) {
        return ctx.client.panels.choose(ctx, `Set ${options.name.toLowerCase()}.`, options.choices, pick, { player });
    }
    let value = args[0].toLowerCase();
    if (options.name === 'Speed') value = value.replace(/x$/, '');
    const index = options.choices.findIndex(label => label.toLowerCase().replace(/x$/, '') === value);
    check(index >= 0, `Choose ${options.choices.join(', ')}.`);
    await pick(ctx, index);
}

function togglePreset(name, isActive, apply) {
    return command(name, [], `Toggle the ${name} filter.`, async (ctx, _args, player) => {
        const on = !isActive(player.filters);
        await apply(player.filters, on);
        await ctx.say(`${name} is ${on ? 'on' : 'off'}.`);
    }, active);
}

module.exports = [
    command('bassboost', ['bb'], 'Apply a bass boost preset.', (ctx, args, player) => filter(ctx, args, player, {
        name: 'Bass boost', choices: Object.keys(bass),
        apply: (filters, label) => filters.setEqualizer(bass[label] ? Array(3).fill(bass[label]).map(band) : []),
    }), { ...active, usage: '[none|low|medium|high]' }),
    command('speed', [], 'Set playback speed.', (ctx, args, player) => filter(ctx, args, player, {
        name: 'Speed', choices: ['1x', '2x', '3x', 'Reset'],
        apply: (filters, label) => filters.setTimescale({ speed: label === 'Reset' ? 1 : Number.parseInt(label, 10) }),
    }), { ...active, usage: '[1|2|3|reset]' }),
    togglePreset('nightcore', filters => filters.timescale?.speed === 1.3 && filters.timescale?.pitch === 1.3,
        (filters, on) => filters.setTimescale(on ? { speed: 1.3, pitch: 1.3 } : { speed: 1, pitch: 1 })),
    togglePreset('vaporwave', filters => filters.timescale?.speed === 0.85 && filters.timescale?.pitch === 0.8,
        (filters, on) => filters.setTimescale(on ? { speed: 0.85, pitch: 0.8 } : { speed: 1, pitch: 1 })),
    togglePreset('treblebass', filters => filters.equalizer?.some(item => item.band === 1 && item.gain === 0.67),
        (filters, on) => filters.setEqualizer(on ? treble.map(band) : [])),
];
