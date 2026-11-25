const http = require('node:http');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

function fixtureTrack(id) {
    return {
        encoded: `track-${id}`, info: {
            identifier: id, isSeekable: true, author: 'Test artist', length: 120_000, isStream: false,
            position: 0, title: `Track ${id}`, uri: `https://www.deezer.com/track/${id}`,
            artworkUrl: id === 'delta' ? null : `https://covers.example/${id}.jpg`, isrc: null, sourceName: 'deezer',
        }, pluginInfo: {}, userData: {},
    };
}

async function createLavalinkFixture() {
    const players = new Map();
    const audioRequests = [];
    const wss = new WebSocketServer({ noServer: true });
    let sessions = 0;
    let rejectNext = false;

    function emit(data) {
        for (const ws of wss.clients) ws.send(JSON.stringify(data));
    }

    function event(guildId, type, details = {}, track = players.get(guildId)?.track) {
        emit({ op: 'event', guildId, type, track, ...details });
    }

    const server = http.createServer(async (request, response) => {
        try {
            const pieces = [];
            for await (const chunk of request) pieces.push(chunk);
            const body = pieces.length ? JSON.parse(Buffer.concat(pieces).toString()) : null;
            const url = new URL(request.url, 'http://localhost');
            const send = (data, status = 200) => {
                response.writeHead(status, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(data));
            };
            if (request.headers.authorization !== 'fixture-placeholder') return send({}, 401);
            if (url.pathname === '/v4/info') return send({ sourceManagers: ['soundcloud', 'deezer'], plugins: [] });
            if (url.pathname === '/v4/loadtracks') {
                const query = url.searchParams.get('identifier');
                if (query.endsWith('empty')) return send({ loadType: 'empty', data: {} });
                if (query.endsWith('failed')) return send({ loadType: 'error', data: {} });
                if (query.startsWith('dzrec:')) return send({ loadType: 'track', data: fixtureTrack('recommended') });
                return send({
                    loadType: 'playlist',
                    data: { info: { name: 'Fixture playlist' }, tracks: ['alpha', 'beta', 'gamma', 'delta'].map(fixtureTrack) },
                });
            }
            if (/^\/v4\/sessions\/fixture-\d+$/.test(url.pathname)) return send({ resuming: true, timeout: 60 });
            if (url.pathname.endsWith('/players') && request.method === 'GET') return send([...players.values()]);
            const guildId = url.pathname.split('/').at(-1);
            if (request.method === 'DELETE') {
                players.delete(guildId);
                response.writeHead(204).end();
                return;
            }
            if (request.method !== 'PATCH') return send({}, 404);
            audioRequests.push({ guildId, body });
            if (rejectNext) {
                rejectNext = false;
                return send({}, 503);
            }
            const old = players.get(guildId);
            const player = { ...old, ...body, guildId };
            if (body?.track) {
                if (body.track.encoded) {
                    player.track = {
                        ...fixtureTrack(body.track.encoded.replace(/^track-/, '')),
                        userData: body.track.userData,
                    };
                    event(guildId, 'TrackStartEvent', {}, player.track);
                } else {
                    player.track = null;
                    if (old?.track) event(guildId, 'TrackEndEvent', { reason: 'stopped' }, old.track);
                }
            }
            players.set(guildId, player);
            send(player);
        } catch {
            response.writeHead(500).end();
        }
    });

    server.on('upgrade', (request, socket, head) => {
        if (request.headers.authorization !== 'fixture-placeholder') {
            socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
            return;
        }
        wss.handleUpgrade(request, socket, head, ws => {
            sessions++;
            ws.send(JSON.stringify({ op: 'ready', resumed: false, sessionId: `fixture-${sessions}` }));
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    return {
        port: server.address().port, players, audioRequests, event,
        failUpdate() { rejectNext = true; },
        reconnect() { for (const ws of wss.clients) ws.terminate(); },
        async close() {
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
    };
}

module.exports = { createLavalinkFixture };
