class UserError extends Error {}

/** @param {unknown} condition @param {string} message */
function check(condition, message) {
    if (!condition) throw new UserError(message);
}

class GuildTasks {
    constructor(limit = 5) {
        this.limit = limit;
        this.pending = new Map();
        this.closed = false;
    }

    run(id, work, internal = false) {
        const previous = this.pending.get(id);
        if (this.closed || (!internal && previous?.count >= this.limit)) {
            return Promise.reject(new UserError('Hydra is busy. Please try again shortly.'));
        }
        const job = Promise.resolve(previous?.tail).then(work);
        const entry = { count: (previous?.count ?? 0) + 1, tail: job.catch(() => {}) };
        this.pending.set(id, entry);
        void entry.tail.then(() => {
            const current = this.pending.get(id);
            current.count--;
            if (!current.count) this.pending.delete(id);
        });
        return job;
    }

    async close() {
        this.closed = true;
        await Promise.all([...this.pending.values()].map(entry => entry.tail));
    }
}

class ExpiringMap {
    constructor(max, ttl) {
        this.max = max;
        this.ttl = ttl;
        this.entries = new Map();
    }

    get(key, now = Date.now()) {
        const entry = this.entries.get(key);
        if (entry?.until > now) return entry.value;
        this.delete(key);
    }

    set(key, value, now = Date.now()) {
        this.delete(key);
        if (this.entries.size >= this.max) this.delete(this.entries.keys().next().value);
        this.entries.set(key, { value, until: now + this.ttl });
        return value;
    }

    delete(key) {
        this.entries.delete(key);
    }
}

module.exports = { UserError, check, GuildTasks, ExpiringMap };
