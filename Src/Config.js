const { isIP } = require('node:net');
const { AutoPlayPlatform, SearchPlatform } = require('pulsifyy');

class ConfigError extends Error {
    constructor(field) {
        super(`Check the ${field} configuration.`);
        this.name = 'ConfigError';
    }
}

const snowflake = /^\d{17,20}$/;
const hostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const validPrefix = value => typeof value === 'string' && /^[^\s`<>\p{C}]{1,3}$/u.test(value);

function readNodes(value) {
    const field = 'LAVALINK_NODES';
    let nodes;
    try { nodes = JSON.parse(value ?? 'null'); } catch { throw new ConfigError(field); }
    if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > 10) throw new ConfigError(field);
    const used = new Set();
    return nodes.map(node => {
        const { identifier, host, port, password, useSSL = true } = node ?? {};
        if (typeof identifier !== 'string' || !/^[\w-]{1,40}$/.test(identifier) || used.has(identifier) ||
            typeof host !== 'string' || host.length > 253 || !(hostname.test(host) || /^\[[a-f\d:]+\]$/i.test(host) && isIP(host.slice(1, -1)) === 6) ||
            !Number.isInteger(port) || port < 1 || port > 65535 || typeof useSSL !== 'boolean' ||
            typeof password !== 'string' || password.trim().length === 0 || /\p{Cc}/u.test(password)) {
            throw new ConfigError(field);
        }
        used.add(identifier);
        return { identifier, host, port, password, useSSL, enableSessionResumeOption: true, apiRequestTimeoutMs: 8000, maxRetryAttempts: 10, retryDelayMs: 1000 };
    });
}

function readConfig(env = process.env) {
    const token = env.DISCORD_TOKEN?.trim();
    if (!token || /\s/.test(token)) throw new ConfigError('DISCORD_TOKEN');
    const mongoUri = env.MONGODB_URI?.trim();
    if (!mongoUri || !/^mongodb(?:\+srv)?:\/\/[^\s]+$/.test(mongoUri)) throw new ConfigError('MONGODB_URI');
    const prefix = env.HYDRA_PREFIX ?? '!';
    if (!validPrefix(prefix)) throw new ConfigError('HYDRA_PREFIX');
    const owners = new Set(list(env.HYDRA_OWNER_IDS));
    if ([...owners].some(id => !snowflake.test(id))) throw new ConfigError('HYDRA_OWNER_IDS');
    const searchPlatform = env.HYDRA_SEARCH_PLATFORM || SearchPlatform.SoundCloud;
    if (!Object.values(SearchPlatform).some(name => name === searchPlatform)) throw new ConfigError('HYDRA_SEARCH_PLATFORM');
    const autoplayPlatforms = list(env.HYDRA_AUTOPLAY_PLATFORMS ?? AutoPlayPlatform.SoundCloud);
    if (autoplayPlatforms.some(name => !Object.values(AutoPlayPlatform).some(platform => platform === name))) {
        throw new ConfigError('HYDRA_AUTOPLAY_PLATFORMS');
    }
    const mediaHosts = list(env.HYDRA_MEDIA_HOSTS).map(host => host.toLowerCase());
    if (mediaHosts.some(host => !hostname.test(host) || !host.includes('.') || isIP(host))) throw new ConfigError('HYDRA_MEDIA_HOSTS');
    const membersIntent = env.HYDRA_MEMBERS_INTENT ?? 'false';
    if (!['true', 'false'].includes(membersIntent)) throw new ConfigError('HYDRA_MEMBERS_INTENT');
    return {
        token, mongoUri, prefix, owners, searchPlatform, autoplayPlatforms, mediaHosts,
        membersIntent: membersIntent === 'true', nodes: readNodes(env.LAVALINK_NODES),
    };
}

function list(value = '') {
    return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
}

module.exports = { readConfig, ConfigError, validPrefix, snowflake };
