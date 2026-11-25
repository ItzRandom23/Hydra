const { escapeMarkdown } = require('discord.js');
const { check, UserError } = require('./Runtime');

const providers = new Set([
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
    'open.spotify.com', 'soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com',
    'deezer.com', 'www.deezer.com', 'link.deezer.com', 'music.apple.com',
    'jiosaavn.com', 'www.jiosaavn.com', 'tidal.com', 'listen.tidal.com',
    'audiomack.com', 'www.audiomack.com', 'gaana.com', 'www.gaana.com',
    'vk.com', 'vk.ru', 'vk.music', 'music.vk.com', 'bandcamp.com',
]);

function approvedMediaLink(value, extraHosts = []) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
    if (/(?:^|\.)youtube\.com$/.test(url.hostname) && !/^\/(?:watch|playlist|(?:shorts|live|embed|v)\/[^/]+)\/?$/.test(url.pathname)) {
        return null;
    }
    if (providers.has(url.hostname) || /^[a-z0-9-]+\.bandcamp\.com$/.test(url.hostname) ||
        extraHosts.includes(url.hostname)) return url;
    return null;
}

function searchInput(input, extraHosts) {
    let query = input.trim();
    check(query.length > 0 && query.length <= 500, 'Enter a song name or supported link up to 500 characters.');
    if (query.startsWith('<') && query.endsWith('>')) query = query.slice(1, -1);
    if (/^(?:[a-z][a-z0-9+.-]*:\/\/|https?:|\/\/|www\.)/i.test(query)) {
        const url = approvedMediaLink(query, extraHosts);
        if (!url || /\s|\\/.test(query)) throw new UserError('Use an HTTPS link from a supported music provider.');
        return url.href;
    }
    return query;
}

function display(value, length = 140) {
    return escapeMarkdown(String(value ?? 'Unknown').replace(/\p{Cc}+/gu, ' ').slice(0, length));
}

function trackName(track) {
    return `**${display(track.title)}** · ${display(track.author, 90)}`;
}

function duration(ms) {
    const total = Math.floor(Math.max(ms || 0, 0) / 1000);
    const parts = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
    if (!parts[0]) parts.shift();
    return parts.map(part => String(part).padStart(2, '0')).join(':');
}

function timeInput(value) {
    check(typeof value === 'string' && /^\d{1,7}(?::[0-5]\d){0,2}$/.test(value), 'Enter seconds, m:ss, or h:mm:ss.');
    return value.split(':').reduce((acc, part) => acc * 60 + Number(part), 0) * 1000;
}

function integer(value, min, max, message) {
    check(typeof value === 'string' && /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max, message);
    return Number(value);
}

module.exports = { approvedMediaLink, searchInput, display, trackName, duration, timeInput, integer };
