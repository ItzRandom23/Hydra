const { model, Schema } = require('mongoose');
const { validPrefix, snowflake } = require('../Config');
const { ExpiringMap } = require('../Handler/Runtime');

const id = { type: String, match: snowflake };
const common = {
    _id: { ...id, required: true },
    moderator: { ...id, required: true },
    lastUpdated: String,
};
const prefix = { type: String, required: true, validate: validPrefix };
const options = { bufferCommands: false };

// Keep the original model names to retain their MongoDB collection names.
const models = {
    prefix: model('prefix-schema', new Schema({ ...common, prefix, oldPrefix: prefix }, options)),
    dj: model('dj-schema', new Schema({ ...common, mode: Boolean, roles: [id] }, options)),
    announce: model('announce_schema', new Schema({ ...common, mode: Boolean, prunning: Boolean, channel: id }, options)),
    stay: model('247-schema', new Schema({ ...common, mode: Boolean, textChannel: id, voiceChannel: id }, options)),
    setup: model('setup-schema', new Schema({
        ...common, channel: { ...id, required: true }, message: { ...id, required: true }, setuped: Boolean,
    }, options)),
};

class Settings {
    constructor(defaultPrefix, database = models) {
        this.defaultPrefix = defaultPrefix;
        this.database = database;
        this.cache = new ExpiringMap(5000, 30_000);
    }

    get(name, guildId) {
        const key = `${name}:${guildId}`;
        const cached = this.cache.get(key);
        if (cached) return cached;
        const read = this.database[name].findById(guildId).lean().maxTimeMS(3000).exec();
        this.cache.set(key, read);
        void read.catch(() => {
            if (this.cache.get(key) === read) this.cache.delete(key);
        });
        return read;
    }

    async prefix(guildId) {
        const data = await this.get('prefix', guildId);
        return validPrefix(data?.prefix) ? data.prefix : this.defaultPrefix;
    }

    async staying(guildIds) {
        return this.database.stay.find({ _id: { $in: guildIds }, mode: true }, { _id: 1 }).lean().maxTimeMS(3000).exec();
    }

    async update(name, guildId, moderator, fields, upsert = true) {
        try {
            return await this.database[name].findOneAndUpdate(
                { _id: guildId },
                { $set: { ...fields, moderator, lastUpdated: String(Math.floor(Date.now() / 1000)) } },
                { upsert, runValidators: true, returnDocument: 'after', maxTimeMS: 3000 },
            ).lean().exec();
        } finally {
            this.cache.delete(`${name}:${guildId}`);
        }
    }

    async remove(name, guildId, match = {}) {
        try {
            return await this.database[name].deleteOne({ _id: guildId, ...match }).maxTimeMS(3000).exec();
        } finally {
            this.cache.delete(`${name}:${guildId}`);
        }
    }
}

module.exports = { Settings, models };
