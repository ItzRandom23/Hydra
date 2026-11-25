const { ApplicationCommandOptionType, InteractionContextType, PermissionFlagsBits, ApplicationIntegrationType } = require('discord.js');
const { commands: music } = require('./Music');
const filters = require('./Filters');
const info = require('./Info');
const settings = require('./Settings');

const commandList = Object.entries({ Music: music, Filters: filters, General: info, Settings: settings })
    .flatMap(([category, items]) => items.map(item => ({ ...item, category })));
const commands = new Map();
for (const item of commandList) {
    for (const name of [item.name, ...item.aliases]) {
        if (commands.has(name)) throw new Error(`Duplicate command name ${name}`);
        commands.set(name, item);
    }
}

function slashCommands(guildScope = false) {
    return commandList.filter(item => !item.owner).map(item => {
        const options = item.usage ? [
            {
                type: ApplicationCommandOptionType.String, name: 'input',
                description: `Arguments ${item.usage}`.slice(0, 100), required: item.usage.startsWith('<'), max_length: 500,
            },
        ] : [];
        return {
            name: item.name, description: item.description, options,
            ...(!guildScope ? { contexts: [InteractionContextType.Guild], integration_types: [ApplicationIntegrationType.GuildInstall] } : {}),
            ...(item.admin ? { default_member_permissions: String(PermissionFlagsBits.ManageGuild) } : {}),
        };
    });
}

module.exports = { commands, commandList, slashCommands };
