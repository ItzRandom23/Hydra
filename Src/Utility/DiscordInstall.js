const { URL, URLSearchParams } = require('node:url');
const { ApplicationIntegrationType, OAuth2Scopes, PermissionFlagsBits, PermissionsBitField } = require('discord.js');

function serverInvite(applicationId) {
    const permissions = PermissionsBitField.resolve([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak,
    ]);
    const invite = new URL('https://discord.com/oauth2/authorize');
    invite.search = new URLSearchParams({
        client_id: applicationId,
        integration_type: String(ApplicationIntegrationType.GuildInstall),
        permissions: String(permissions),
        scope: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands].join(' '),
    }).toString();
    return invite.href;
}

function installationFindings(application) {
    const findings = [];
    const installs = application.integration_types_config;
    if (installs && !Object.hasOwn(installs, ApplicationIntegrationType.GuildInstall)) {
        findings.push('Guild Install is disabled. Enable it under Installation in the Discord Developer Portal.');
    }
    if (application.bot_public === false) {
        findings.push('Public Bot is off. Only the application owner can add Hydra to servers.');
    }
    if (application.bot_require_code_grant === true) {
        findings.push('Requires OAuth2 Code Grant is enabled. Hydra’s direct invite requires this setting to be off.');
    }
    return findings;
}

module.exports = { serverInvite, installationFindings };
