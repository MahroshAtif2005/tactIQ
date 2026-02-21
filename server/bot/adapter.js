const { CloudAdapter, ConfigurationBotFrameworkAuthentication } = require('botbuilder');

const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication({
  MicrosoftAppId: process.env.MICROSOFT_APP_ID || '',
  MicrosoftAppPassword: process.env.MICROSOFT_APP_PASSWORD || '',
  MicrosoftAppType: process.env.MICROSOFT_APP_TYPE || 'MultiTenant',
  MicrosoftAppTenantId: process.env.MICROSOFT_APP_TENANT_ID || '',
});

const adapter = new CloudAdapter(botFrameworkAuthentication);

adapter.onTurnError = async (context, error) => {
  console.error('[BotAdapter] Unhandled bot error', error);
  await context.sendActivity('Bot runtime error. Check server logs.');
};

module.exports = {
  adapter,
};

