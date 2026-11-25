# Hydra

Hydra is a self-hosted Discord music bot powered by Pulsify and Lavalink. It supports prefix and slash commands, playlists, a dedicated song request channel, per-server DJ roles, filters, and 24/7 mode. Discord owns voice membership, Pulsify handles playback and recovery, and MongoDB stores guild settings.

## Requirements

- Node.js 24.15 or newer in the Node 24 line and npm. The lockfile pins Discord.js 14.28.1, Pulsify 0.1.2, and Mongoose 9.13.1.
- MongoDB 8.x. Use a dedicated database and a user with read/write access to that database.
- Lavalink v4 with a supported Java runtime and the sources you plan to use. Lavalink 4.2.2 was tested with Java 17. [Lavalink installation](https://lavalink.dev/getting-started/index.html)
- A Discord bot application. Enable **Message Content Intent** for prefix commands and song requests. Enable **Server Members Intent** only if you turn on `HYDRA_MEMBERS_INTENT` to use `dj members`. Discord's intent approval requirements can apply to verified apps. [Discord Gateway intents](https://docs.discord.com/developers/events/gateway#gateway-intents)

## Run locally

1. Start MongoDB. Start Lavalink with an `application.yml` based on [lavalink.application.example.yml](lavalink.application.example.yml). Set a unique password. The example listens on loopback and uses Lavalink's built-in SoundCloud search.
2. Enable **Guild Install** in the Discord Developer Portal and install Hydra in each server where it should operate. Use the `bot` and `applications.commands` scopes. Enable **Public Bot** if other server admins should be able to install it. Give it **View Channel**, **Send Messages**, **Embed Links**, **Read Message History**, **Connect**, and **Speak** where it operates. Add **Send Messages in Threads** if needed. For the request channel, grant **Manage Channels** to create it and **Manage Messages** there if Hydra should remove processed requests. Stage channels also need **Request to Speak** or **Mute Members** so the bot can speak. [Discord installation guide](https://docs.discord.com/developers/quick-start/getting-started#setting-up-an-install-link)
3. Install and configure the bot.

   ```sh
   npm ci
   cp .env.example .env
   npm start
   ```

   In PowerShell, use `Copy-Item .env.example .env`. Fill in `DISCORD_TOKEN`, `MONGODB_URI`, and `LAVALINK_NODES` before running `npm start`. Wait for both the Discord gateway and a Lavalink node to report readiness, then join voice and run `!play song name`.

4. Hydra automatically syncs its global slash commands when Discord becomes ready. Look for `Synced 36 global slash commands` in the log. Use a slash command's `input` field for arguments.

   To sync manually, run `npm run register`. To test definitions in one server, use `npm run register -- --guild YOUR_TEST_SERVER_ID`. Sync creates missing Hydra commands and updates changed definitions in the selected scope.

## Install Hydra in another server

Run the installation check with `DISCORD_TOKEN` configured to inspect the Discord application's settings and print its server install link.

```sh
npm run check:discord
```

The person opening the link needs **Manage Server** on the destination server. Enable **Guild Install** in the Developer Portal. Enable **Public Bot** if people other than the application owner should be able to install Hydra. Turn off **Requires OAuth2 Code Grant** when using Hydra's direct invite. [Discord installation guide](https://docs.discord.com/developers/quick-start/getting-started#choosing-installation-contexts) · [Application settings](https://docs.discord.com/developers/resources/application#application-object)

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Discord bot token |
| `MONGODB_URI` | MongoDB connection URI |
| `LAVALINK_NODES` | JSON array with `identifier`, `host`, `port`, `password`, and optional `useSSL` (defaults to true). Use bare hosts or bracketed IPv6 addresses. |
| `HYDRA_PREFIX` | Default prefix, one to three visible characters without spaces. Defaults to `!`. |
| `HYDRA_OWNER_IDS` | Comma-separated Discord user IDs for owner commands. Empty disables owner commands. |
| `HYDRA_SEARCH_PLATFORM` | Pulsify source prefix, such as `scsearch`, `ytsearch`, or `dzsearch`. Defaults to `scsearch`. |
| `HYDRA_AUTOPLAY_PLATFORMS` | Ordered comma-separated providers for recommendations. Defaults to `soundcloud`. Set an empty value to disable. |
| `HYDRA_MEDIA_HOSTS` | Optional comma-separated exact HTTPS hosts for trusted providers. |
| `HYDRA_MEMBERS_INTENT` | Enables `dj members` with Discord's Server Members Intent. Defaults to `false`. |

Pulsify can search and play only the providers enabled on your nodes. SoundCloud and Bandcamp work with the matching built-in sources. YouTube and YouTube Music require the appropriate Lavalink plugin. Spotify and additional providers require a compatible plugin such as PulseLink and its documented provider configuration. Install the same source configuration on failover nodes. If a node exhausts its reconnect attempts, Hydra brings it back into rotation after a cooldown. [Pulsify usage](https://github.com/ItzRandom23/Pulsify), [Lavalink sources](https://lavalink.dev/configuration/config/file)

Hydra accepts song names and HTTPS links from approved media providers. Keep Lavalink's unrestricted HTTP and local-file sources disabled in production. Apply outbound network policy to Lavalink and its plugins so provider redirects or DNS changes cannot reach private networks, loopback, or cloud metadata services. Use a private network for the bot-to-node connection, and TLS for remote nodes. Use content you have permission to play.

## Commands

Use the server prefix or mention Hydra. Run `!help <command>` for arguments and aliases. Slash commands share the same checks and feature handlers.

| Area | Commands |
| --- | --- |
| Playback | `play`, `search`, `join`, `leave`, `stop`, `pause`, `resume`, `skip [position]`, `previous [add|play]`, `replay` |
| Queue and player | `queue`, `nowplaying`, `player`, `shuffle`, `remove track <number>`, `remove user <user>`, `remove dupes`, `clear [queue|filters]`, `loop [track|queue|off]`, `autoplay` |
| Audio | `volume [0–100]`, `seek <time>`, `forward [time]`, `rewind [time]`, `bassboost [none|low|medium|high]`, `speed [1|2|3|reset]`, `nightcore`, `vaporwave`, `treblebass` |
| Server settings | `setup [create|info|clear]`, `prefix [info|set|restore|clear]`, `dj [add|remove|toggle|list|members|info|clear]`, `announce [on|off|set|prune|info]`, `247 [on|off|info]` |
| General | `help`, `invite`, `ping`, `stats` |
| Owner-only prefix commands | `node`, `getinvite [current server ID]`. The invite command also requires Manage Server and Create Invite. |

Playback controls require the same voice channel as Hydra. With DJ mode on, those controls also require a configured DJ role, Mute Members, or Manage Server. Server settings require Manage Server. Removing another member's queued tracks requires Mute Members or Manage Server.

## Operate and troubleshoot

- Run one Hydra process per bot token and let Discord.js assign shards. Use a supervisor with restart backoff. Give Hydra at least 25 seconds to process a stop signal. Mount persistent private storage for `.hydra-state/` so Pulsify can restore recent playback after a graceful restart. Use the same bot identity and stable Lavalink node identifiers across restarts.
- Hydra releases empty or idle players after about a minute unless 24/7 is on. A 24/7 server stores the chosen voice channel and attempts to rejoin when a node becomes ready or the guild returns. Use `247 off` to prevent automatic restoration after manually disconnecting Hydra.
- For a blank request panel, run `setup info` and verify that Hydra can view the channel, read message history, send embeds, and attach files. If the panel was deleted, clear the old configuration if needed and run `setup create`.
- The request panel shows the bundled banner while idle and the current track's artwork when the provider supplies it. Successful queue confirmations disappear after five seconds. Hydra also removes the original request when it has **Manage Messages** in that channel.
- If a track never starts, check the node's password and v4 compatibility, provider plugin and credentials, Discord channel overrides, server mute, and stage suppression. If only one node can play a provider, match the provider configuration across your fleet.
- The existing MongoDB collection names and fields are retained. Back up the database before updating. Older invalid prefixes fall back to the configured default and can be replaced with `prefix set`. Historic invalid timestamps are omitted from status output. No migration script is required for these settings.
- Keep your local `.env`, Lavalink configuration, and Pulsify session snapshots out of version control. Use `.env.example` as the shareable configuration template.

## Verify locally

```sh
npm run build
npm test
npm audit
```

The default suite uses a local simulated Lavalink and Discord gateway. To also test real services, set `HYDRA_TEST_MONGO=127.0.0.1:<port>` for an isolated local MongoDB instance and `HYDRA_TEST_LAVALINK_PORT` and `HYDRA_TEST_LAVALINK_PASSWORD` for a local Lavalink test node. Enable the Lavalink local-file source on the isolated test node for the generated WAV fixture. The MongoDB test owns its randomly named test database and cleans it up.

Hydra is released under the [MIT license](LICENSE), with original copyright © 2022 Abhijit. [Pulsify](https://github.com/ItzRandom23/Pulsify) is distributed separately under Apache-2.0.
