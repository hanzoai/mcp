/**
 * connectors — Unified App, Vault & Social Connectors with 3-Tier Execution:
 *   Tier 1: Native REST API / Streamable-HTTP MCP (`https://post.hanzo.ai/mcp`) using in-memory Hanzo KMS secrets
 *   Tier 2: Signed-in Agentic Browser Fallback over ZAP (`hanzo.read` / `hanzo.snapshot` / `hanzo.act`)
 *   Tier 3: Automatic KMS Browser Auto-Login (`browserAutoLogin`) & Interactive OAuth / Token Configurator
 *
 * Covers all 16 compatible business apps, LastPass, Hanzo Post, and 15 social & developer publishing channels.
 * Secrets and session cookie values NEVER leave memory — only cookie names and boolean auth state are reported.
 */

import { execFile as nodeExecFile } from 'child_process';
import { Tool, ToolResult } from '../types/index.js';
import * as zap from '../zap.js';
import {
  browserAutoLogin,
  kmsGetSecret,
  kmsListSecrets,
  kmsSetSecret,
  sealAppCredentials,
  slugifyApp,
} from './vault.js';

export type ConnectorCategory =
  | 'vault'
  | 'productivity'
  | 'crm'
  | 'developer'
  | 'commerce'
  | 'marketing'
  | 'finance'
  | 'analytics'
  | 'social'
  | 'publishing';

export interface ConnectorSpec {
  id: string;
  name: string;
  category: ConnectorCategory;
  compatibleApp?: boolean;
  apiBase: string;
  secondaryApiBases?: Record<string, string>;
  authScheme: 'bearer' | 'klaviyo' | 'basic' | 'api_key_header' | 'bot_token' | 'telegram_bot' | 'lastpass_enterprise' | 'postiz_mcp';
  apiKeyHeader?: string;
  extraHeaders?: Record<string, string>;
  kmsPath: string;
  fallbackKmsPaths?: string[];
  kmsTokenKeys: string[];
  mcpEndpoint?: string;
  webUrl: string;
  loginUrl: string;
  setupUrl: string;
  cookieDomains: string[];
  authCookies: string[];
}

const GOOGLE_AUTH_COOKIES = ['SID', '__Secure-1PSID', '__Secure-3PSID', 'SAPISID', '__Secure-3PAPISID'];
const POSTIZ_MCP_URL = 'https://post.hanzo.ai/mcp';
const POSTIZ_LAUNCHES_URL = 'https://post.hanzo.ai/launches';

export const CONNECTORS: Record<string, ConnectorSpec> = {
  // ── 1. LastPass Vault & Enterprise ─────────────────────────────────────────
  lastpass: {
    id: 'lastpass',
    name: 'LastPass',
    category: 'vault',
    apiBase: 'https://lastpass.com/enterpriseapi.php',
    authScheme: 'lastpass_enterprise',
    kmsPath: 'credentials/lastpass',
    kmsTokenKeys: ['LASTPASS_CID', 'LASTPASS_PROVISIONING_HASH', 'API_KEY'],
    webUrl: 'https://lastpass.com/?ac=1',
    loginUrl: 'https://lastpass.com/?ac=1',
    setupUrl: 'https://admin.lastpass.com/advanced/enterprise-api',
    cookieDomains: ['lastpass.com'],
    authCookies: ['PHPSESSID', 'lpsession', 'LPMS'],
  },

  // ── 2–17. All 16 Compatible Business & Productivity Apps ───────────────────
  gmail: {
    id: 'gmail',
    name: 'Gmail',
    category: 'productivity',
    compatibleApp: true,
    apiBase: 'https://gmail.googleapis.com/gmail/v1/users/me',
    authScheme: 'bearer',
    kmsPath: 'credentials/gmail',
    fallbackKmsPaths: ['credentials/google'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    webUrl: 'https://mail.google.com/mail/u/0/',
    loginUrl: 'https://accounts.google.com/ServiceLogin?service=mail&continue=https://mail.google.com/mail/',
    setupUrl: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
    cookieDomains: ['mail.google.com', 'google.com'],
    authCookies: [...GOOGLE_AUTH_COOKIES, 'OSID'],
  },
  google_calendar: {
    id: 'google_calendar',
    name: 'Google Calendar',
    category: 'productivity',
    compatibleApp: true,
    apiBase: 'https://www.googleapis.com/calendar/v3',
    authScheme: 'bearer',
    kmsPath: 'credentials/google_calendar',
    fallbackKmsPaths: ['credentials/google'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    webUrl: 'https://calendar.google.com/',
    loginUrl: 'https://accounts.google.com/ServiceLogin?service=cl&continue=https://calendar.google.com/',
    setupUrl: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
    cookieDomains: ['calendar.google.com', 'google.com'],
    authCookies: GOOGLE_AUTH_COOKIES,
  },
  google_drive: {
    id: 'google_drive',
    name: 'Google Drive',
    category: 'productivity',
    compatibleApp: true,
    apiBase: 'https://www.googleapis.com/drive/v3',
    authScheme: 'bearer',
    kmsPath: 'credentials/google_drive',
    fallbackKmsPaths: ['credentials/google'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    webUrl: 'https://drive.google.com/drive/my-drive',
    loginUrl: 'https://accounts.google.com/ServiceLogin?service=wise&continue=https://drive.google.com/',
    setupUrl: 'https://console.cloud.google.com/apis/library/drive.googleapis.com',
    cookieDomains: ['drive.google.com', 'google.com'],
    authCookies: GOOGLE_AUTH_COOKIES,
  },
  salesforce: {
    id: 'salesforce',
    name: 'Salesforce',
    category: 'crm',
    compatibleApp: true,
    apiBase: 'https://{instance}.my.salesforce.com/services/data/v60.0',
    authScheme: 'bearer',
    kmsPath: 'credentials/salesforce',
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    webUrl: 'https://login.salesforce.com/',
    loginUrl: 'https://login.salesforce.com/',
    setupUrl: 'https://login.salesforce.com/lightning/setup/NavigationMenus/home',
    cookieDomains: ['salesforce.com', 'force.com'],
    authCookies: ['sid'],
  },
  microsoft_teams: {
    id: 'microsoft_teams',
    name: 'Microsoft Teams',
    category: 'productivity',
    compatibleApp: true,
    apiBase: 'https://graph.microsoft.com/v1.0',
    authScheme: 'bearer',
    kmsPath: 'credentials/microsoft_teams',
    fallbackKmsPaths: ['credentials/microsoft'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    webUrl: 'https://teams.microsoft.com/v2/',
    loginUrl: 'https://login.microsoftonline.com/',
    setupUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    cookieDomains: ['teams.microsoft.com', 'cloud.microsoft', 'login.microsoftonline.com'],
    authCookies: ['ESTSAUTHPERSISTENT', 'ESTSAUTH', 'skypetoken_asm', 'TSAUTHCOOKIE'],
  },
  github: {
    id: 'github',
    name: 'GitHub',
    category: 'developer',
    compatibleApp: true,
    apiBase: 'https://api.github.com',
    authScheme: 'bearer',
    extraHeaders: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    kmsPath: 'credentials/github',
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY', 'GITHUB_TOKEN'],
    webUrl: 'https://github.com/',
    loginUrl: 'https://github.com/login',
    setupUrl: 'https://github.com/settings/tokens?type=beta',
    cookieDomains: ['github.com'],
    authCookies: ['user_session', '__Host-user_session_same_site'],
  },
  google_forms: {
    id: 'google_forms',
    name: 'Google Forms',
    category: 'productivity',
    compatibleApp: true,
    apiBase: 'https://forms.googleapis.com/v1',
    authScheme: 'bearer',
    kmsPath: 'credentials/google_forms',
    fallbackKmsPaths: ['credentials/google'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    webUrl: 'https://docs.google.com/forms/',
    loginUrl: 'https://accounts.google.com/ServiceLogin?continue=https://docs.google.com/forms/',
    setupUrl: 'https://console.cloud.google.com/apis/library/forms.googleapis.com',
    cookieDomains: ['docs.google.com', 'google.com'],
    authCookies: GOOGLE_AUTH_COOKIES,
  },
  woocommerce: {
    id: 'woocommerce',
    name: 'WooCommerce',
    category: 'commerce',
    compatibleApp: true,
    apiBase: '{site_url}/wp-json/wc/v3',
    authScheme: 'basic',
    kmsPath: 'credentials/woocommerce',
    kmsTokenKeys: ['CONSUMER_KEY', 'CONSUMER_SECRET', 'API_KEY', 'OAUTH_TOKEN'],
    webUrl: '{site_url}/wp-admin/admin.php?page=wc-admin',
    loginUrl: '{site_url}/wp-login.php',
    setupUrl: '{site_url}/wp-admin/admin.php?page=wc-settings&tab=advanced&section=keys',
    cookieDomains: ['woocommerce.com', 'wordpress.com'],
    authCookies: ['wordpress_logged_in_*', 'wp_woocommerce_session_*'],
  },
  intercom: {
    id: 'intercom',
    name: 'Intercom',
    category: 'crm',
    compatibleApp: true,
    apiBase: 'https://api.intercom.io',
    authScheme: 'bearer',
    extraHeaders: {
      Accept: 'application/json',
      'Intercom-Version': '2.11',
    },
    kmsPath: 'credentials/intercom',
    kmsTokenKeys: ['API_KEY', 'OAUTH_TOKEN'],
    webUrl: 'https://app.intercom.com/',
    loginUrl: 'https://app.intercom.com/admins/sign_in',
    setupUrl: 'https://app.intercom.com/a/apps/_/developer-hub',
    cookieDomains: ['app.intercom.com', 'intercom.com', 'intercom.io'],
    authCookies: ['_intercom_session', 'intercom_session'],
  },
  facebook_lead_ads: {
    id: 'facebook_lead_ads',
    name: 'Facebook Lead Ads',
    category: 'marketing',
    compatibleApp: true,
    apiBase: 'https://graph.facebook.com/v20.0',
    authScheme: 'bearer',
    kmsPath: 'credentials/facebook_lead_ads',
    fallbackKmsPaths: ['credentials/facebook'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    webUrl: 'https://business.facebook.com/latest/instant_forms',
    loginUrl: 'https://www.facebook.com/login.php?next=https://business.facebook.com/latest/instant_forms',
    setupUrl: 'https://developers.facebook.com/tools/explorer/',
    cookieDomains: ['business.facebook.com', 'facebook.com'],
    authCookies: ['c_user', 'xs'],
  },
  docusign: {
    id: 'docusign',
    name: 'DocuSign',
    category: 'productivity',
    compatibleApp: true,
    apiBase: 'https://na4.docusign.net/restapi/v2.1',
    authScheme: 'bearer',
    kmsPath: 'credentials/docusign',
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    webUrl: 'https://apps.docusign.com/send/home',
    loginUrl: 'https://account.docusign.com/',
    setupUrl: 'https://admindemo.docusign.com/authenticate?goTo=appsAndKeys',
    cookieDomains: ['apps.docusign.com', 'docusign.com', 'docusign.net'],
    authCookies: ['DSAuth', 'DSID', '.ASPXAUTH', 'ds_session'],
  },
  google_ads: {
    id: 'google_ads',
    name: 'Google Ads',
    category: 'marketing',
    compatibleApp: true,
    apiBase: 'https://googleads.googleapis.com/v17',
    authScheme: 'bearer',
    kmsPath: 'credentials/google_ads',
    fallbackKmsPaths: ['credentials/google'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY', 'DEVELOPER_TOKEN'],
    webUrl: 'https://ads.google.com/aw/overview',
    loginUrl: 'https://accounts.google.com/ServiceLogin?continue=https://ads.google.com/aw/overview',
    setupUrl: 'https://ads.google.com/aw/apicenter',
    cookieDomains: ['ads.google.com', 'google.com'],
    authCookies: GOOGLE_AUTH_COOKIES,
  },
  klaviyo: {
    id: 'klaviyo',
    name: 'Klaviyo',
    category: 'marketing',
    compatibleApp: true,
    apiBase: 'https://a.klaviyo.com/api',
    authScheme: 'klaviyo',
    extraHeaders: {
      revision: '2024-10-15',
      accept: 'application/vnd.api+json',
    },
    kmsPath: 'credentials/klaviyo',
    kmsTokenKeys: ['API_KEY', 'OAUTH_TOKEN'],
    webUrl: 'https://www.klaviyo.com/dashboard',
    loginUrl: 'https://www.klaviyo.com/login',
    setupUrl: 'https://www.klaviyo.com/settings/account/api-keys',
    cookieDomains: ['klaviyo.com'],
    authCookies: ['kl_sessionid', 'sessionid', '__Secure-kl_session'],
  },
  linkedin: {
    id: 'linkedin',
    name: 'LinkedIn',
    category: 'social',
    compatibleApp: true,
    apiBase: 'https://api.linkedin.com/rest',
    authScheme: 'bearer',
    extraHeaders: {
      'LinkedIn-Version': '202410',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    kmsPath: 'credentials/linkedin',
    fallbackKmsPaths: ['channels/postiz'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://www.linkedin.com/feed/',
    loginUrl: 'https://www.linkedin.com/login',
    setupUrl: 'https://www.linkedin.com/developers/apps',
    cookieDomains: ['linkedin.com'],
    authCookies: ['li_at'],
  },
  quickbooks: {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    category: 'finance',
    compatibleApp: true,
    apiBase: 'https://quickbooks.api.intuit.com/v3/company/{realmId}',
    authScheme: 'bearer',
    extraHeaders: {
      Accept: 'application/json',
    },
    kmsPath: 'credentials/quickbooks',
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    webUrl: 'https://app.qbo.intuit.com/app/homepage',
    loginUrl: 'https://accounts.intuit.com/app/sign-in?app_group=QBO',
    setupUrl: 'https://developer.intuit.com/app/developer/myapps',
    cookieDomains: ['qbo.intuit.com', 'intuit.com'],
    authCookies: ['qbn.ticket', 'qbo.ticket', 'ius_session', 'intuit_icket'],
  },
  google_analytics: {
    id: 'google_analytics',
    name: 'Google Analytics',
    category: 'analytics',
    compatibleApp: true,
    apiBase: 'https://analyticsdata.googleapis.com/v1beta',
    secondaryApiBases: {
      admin: 'https://analyticsadmin.googleapis.com/v1beta',
      data: 'https://analyticsdata.googleapis.com/v1beta',
    },
    authScheme: 'bearer',
    kmsPath: 'credentials/google_analytics',
    fallbackKmsPaths: ['credentials/google'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    webUrl: 'https://analytics.google.com/analytics/web/',
    loginUrl: 'https://accounts.google.com/ServiceLogin?continue=https://analytics.google.com/analytics/web/',
    setupUrl: 'https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com',
    cookieDomains: ['analytics.google.com', 'google.com'],
    authCookies: GOOGLE_AUTH_COOKIES,
  },

  // ── 18. Hanzo Post Unified Social & Blog MCP Hub ───────────────────────────
  hanzo_post: {
    id: 'hanzo_post',
    name: 'Hanzo Post',
    category: 'publishing',
    apiBase: POSTIZ_MCP_URL,
    secondaryApiBases: {
      rest: 'https://post.hanzo.ai/api/public/v1',
    },
    authScheme: 'postiz_mcp',
    kmsPath: 'channels/postiz',
    fallbackKmsPaths: ['credentials/hanzo_post'],
    kmsTokenKeys: ['POSTIZ_API_KEY', 'API_KEY'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: POSTIZ_LAUNCHES_URL,
    loginUrl: 'https://post.hanzo.ai/auth/login',
    setupUrl: 'https://post.hanzo.ai/settings',
    cookieDomains: ['post.hanzo.ai', 'hanzo.ai', 'hanzo.id'],
    authCookies: ['auth', 'hanzo_session'],
  },

  // ── 19. Social & Developer Publishing Channels (Postiz MCP + ZAP Fallback) ─
  x: {
    id: 'x',
    name: 'X (Twitter)',
    category: 'social',
    apiBase: 'https://api.x.com/2',
    authScheme: 'bearer',
    kmsPath: 'credentials/x',
    fallbackKmsPaths: ['channels/postiz'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY', 'BEARER_TOKEN'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://x.com/home',
    loginUrl: 'https://x.com/i/flow/login',
    setupUrl: POSTIZ_LAUNCHES_URL,
    cookieDomains: ['x.com', 'twitter.com'],
    authCookies: ['auth_token', 'ct0'],
  },
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    category: 'social',
    apiBase: 'https://www.googleapis.com/youtube/v3',
    authScheme: 'bearer',
    kmsPath: 'credentials/youtube',
    fallbackKmsPaths: ['credentials/google', 'channels/postiz'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://studio.youtube.com/',
    loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://studio.youtube.com/',
    setupUrl: POSTIZ_LAUNCHES_URL,
    cookieDomains: ['youtube.com', 'google.com'],
    authCookies: ['SAPISID', '__Secure-3PAPISID'],
  },
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    category: 'social',
    apiBase: 'https://graph.facebook.com/v20.0',
    authScheme: 'bearer',
    kmsPath: 'credentials/instagram',
    fallbackKmsPaths: ['channels/postiz'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://www.instagram.com/',
    loginUrl: 'https://www.instagram.com/accounts/login/',
    setupUrl: POSTIZ_LAUNCHES_URL,
    cookieDomains: ['instagram.com'],
    authCookies: ['sessionid'],
  },
  threads: {
    id: 'threads',
    name: 'Threads',
    category: 'social',
    apiBase: 'https://graph.threads.net/v1.0',
    authScheme: 'bearer',
    kmsPath: 'credentials/threads',
    fallbackKmsPaths: ['channels/postiz'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://www.threads.com/',
    loginUrl: 'https://www.threads.com/login',
    setupUrl: POSTIZ_LAUNCHES_URL,
    cookieDomains: ['threads.com', 'threads.net'],
    authCookies: ['sessionid'],
  },
  tiktok: {
    id: 'tiktok',
    name: 'TikTok',
    category: 'social',
    apiBase: 'https://open.tiktokapis.com/v2',
    authScheme: 'bearer',
    kmsPath: 'credentials/tiktok',
    fallbackKmsPaths: ['channels/postiz'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://www.tiktok.com/tiktokstudio/upload',
    loginUrl: 'https://www.tiktok.com/login',
    setupUrl: POSTIZ_LAUNCHES_URL,
    cookieDomains: ['tiktok.com'],
    authCookies: ['sessionid', 'sessionid_ss'],
  },
  reddit: {
    id: 'reddit',
    name: 'Reddit',
    category: 'social',
    apiBase: 'https://oauth.reddit.com',
    authScheme: 'bearer',
    kmsPath: 'credentials/reddit',
    fallbackKmsPaths: ['channels/postiz'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://www.reddit.com/',
    loginUrl: 'https://www.reddit.com/login/',
    setupUrl: POSTIZ_LAUNCHES_URL,
    cookieDomains: ['reddit.com'],
    authCookies: ['reddit_session', 'token_v2'],
  },
  facebook: {
    id: 'facebook',
    name: 'Facebook',
    category: 'social',
    apiBase: 'https://graph.facebook.com/v20.0',
    authScheme: 'bearer',
    kmsPath: 'credentials/facebook',
    fallbackKmsPaths: ['channels/postiz'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://www.facebook.com/',
    loginUrl: 'https://www.facebook.com/login',
    setupUrl: POSTIZ_LAUNCHES_URL,
    cookieDomains: ['facebook.com'],
    authCookies: ['c_user', 'xs'],
  },
  bluesky: {
    id: 'bluesky',
    name: 'Bluesky',
    category: 'social',
    apiBase: 'https://bsky.social/xrpc',
    authScheme: 'bearer',
    kmsPath: 'credentials/bluesky',
    fallbackKmsPaths: ['channels/postiz'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://bsky.app/',
    loginUrl: 'https://bsky.app/',
    setupUrl: POSTIZ_LAUNCHES_URL,
    cookieDomains: ['bsky.app'],
    authCookies: ['bsky_storage'],
  },
  mastodon: {
    id: 'mastodon',
    name: 'Mastodon',
    category: 'social',
    apiBase: 'https://{instance}/api/v1',
    authScheme: 'bearer',
    kmsPath: 'credentials/mastodon',
    fallbackKmsPaths: ['channels/postiz'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://mastodon.social/home',
    loginUrl: 'https://mastodon.social/auth/sign_in',
    setupUrl: POSTIZ_LAUNCHES_URL,
    cookieDomains: ['mastodon.social'],
    authCookies: ['_mastodon_session'],
  },
  discord: {
    id: 'discord',
    name: 'Discord',
    category: 'social',
    apiBase: 'https://discord.com/api/v10',
    authScheme: 'bot_token',
    kmsPath: 'credentials/discord',
    fallbackKmsPaths: ['channels/discord', 'channels/postiz'],
    kmsTokenKeys: ['DISCORD_BOT_TOKEN', 'BOT_TOKEN', 'OAUTH_TOKEN', 'API_KEY'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://discord.com/channels/@me',
    loginUrl: 'https://discord.com/login',
    setupUrl: 'https://discord.com/developers/applications',
    cookieDomains: ['discord.com'],
    authCookies: ['__Secure-recent_accounts'],
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    category: 'social',
    apiBase: 'https://slack.com/api',
    authScheme: 'bearer',
    kmsPath: 'credentials/slack',
    fallbackKmsPaths: ['channels/slack', 'channels/postiz'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'BOT_TOKEN', 'API_KEY'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://app.slack.com/client',
    loginUrl: 'https://slack.com/signin',
    setupUrl: 'https://api.slack.com/apps',
    cookieDomains: ['slack.com', 'app.slack.com'],
    authCookies: ['d'],
  },
  telegram: {
    id: 'telegram',
    name: 'Telegram',
    category: 'social',
    apiBase: 'https://api.telegram.org/bot{token}',
    authScheme: 'telegram_bot',
    kmsPath: 'credentials/telegram',
    fallbackKmsPaths: ['channels/telegram', 'channels/postiz'],
    kmsTokenKeys: ['TELEGRAM_BOT_TOKEN', 'BOT_TOKEN', 'API_KEY'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://web.telegram.org/k/',
    loginUrl: 'https://web.telegram.org/k/',
    setupUrl: POSTIZ_LAUNCHES_URL,
    cookieDomains: ['web.telegram.org', 'telegram.org'],
    authCookies: ['stel_ssid', 'stel_token'],
  },
  devto: {
    id: 'devto',
    name: 'DEV Community (dev.to)',
    category: 'publishing',
    apiBase: 'https://dev.to/api',
    authScheme: 'api_key_header',
    apiKeyHeader: 'api-key',
    kmsPath: 'credentials/devto',
    fallbackKmsPaths: ['channels/postiz'],
    kmsTokenKeys: ['API_KEY', 'OAUTH_TOKEN'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://dev.to/dashboard',
    loginUrl: 'https://dev.to/enter',
    setupUrl: 'https://dev.to/settings/extensions',
    cookieDomains: ['dev.to'],
    authCookies: ['remember_user_token', '_Devto_Forem_Session'],
  },
  hashnode: {
    id: 'hashnode',
    name: 'Hashnode',
    category: 'publishing',
    apiBase: 'https://gql.hashnode.com',
    authScheme: 'api_key_header',
    apiKeyHeader: 'Authorization',
    kmsPath: 'credentials/hashnode',
    fallbackKmsPaths: ['channels/postiz'],
    kmsTokenKeys: ['API_KEY', 'OAUTH_TOKEN'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://hashnode.com/draft',
    loginUrl: 'https://hashnode.com/onboard',
    setupUrl: 'https://hashnode.com/settings/developer',
    cookieDomains: ['hashnode.com'],
    authCookies: ['token', '__Secure-next-auth.session-token'],
  },
  medium: {
    id: 'medium',
    name: 'Medium',
    category: 'publishing',
    apiBase: 'https://api.medium.com/v1',
    authScheme: 'bearer',
    kmsPath: 'credentials/medium',
    fallbackKmsPaths: ['channels/postiz'],
    kmsTokenKeys: ['OAUTH_TOKEN', 'API_KEY'],
    mcpEndpoint: POSTIZ_MCP_URL,
    webUrl: 'https://medium.com/me/stories/drafts',
    loginUrl: 'https://medium.com/m/signin',
    setupUrl: 'https://medium.com/me/settings/security',
    cookieDomains: ['medium.com'],
    authCookies: ['uid', 'sid'],
  },
};

export const COMPATIBLE_16_APPS = Object.values(CONNECTORS)
  .filter((c) => c.compatibleApp)
  .map((c) => c.id);

// ── Internal Helpers ─────────────────────────────────────────────────────────

function cleanTabId(tabId?: string | number | null): string | undefined {
  if (tabId === undefined || tabId === null || tabId === '') return undefined;
  return String(tabId).replace(/^tab-/, '');
}

async function zapJson(provider: string, method: string, params: Record<string, string>, ms = 20_000): Promise<any> {
  const raw = await zap.route(provider, method, params, ms);
  if (raw.startsWith('ERR:')) {
    throw new Error(raw.slice(4));
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface OpenTab {
  tabId: string;
  url: string;
  title: string;
}

async function listOpenTabs(provider: string): Promise<OpenTab[]> {
  try {
    const raw = await zapJson(provider, 'Target.getTargets', {});
    const infos = raw?.targetInfos ?? raw?.tabs ?? [];
    if (!Array.isArray(infos)) return [];
    return infos
      .map((t: any) => ({
        tabId: cleanTabId(t.tabId ?? t.id ?? t.targetId) || '',
        url: String(t.url || ''),
        title: String(t.title || ''),
      }))
      .filter((t) => Boolean(t.tabId));
  } catch {
    return [];
  }
}

function matchesConnectorDomain(urlStr: string, spec: ConnectorSpec, customSiteUrl?: string): boolean {
  if (!urlStr) return false;
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    const domains = [...spec.cookieDomains];
    if (customSiteUrl) {
      try {
        domains.push(new URL(customSiteUrl).hostname.toLowerCase());
      } catch {
        // ignore
      }
    }
    return domains.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
  } catch {
    return false;
  }
}

function matchCookieIndicators(cookieNames: Iterable<string>, patterns: string[]): string[] {
  const names = [...new Set(cookieNames)];
  const matched: string[] = [];
  for (const pat of patterns) {
    if (pat.endsWith('*')) {
      const prefix = pat.slice(0, -1);
      for (const n of names) {
        if (n.startsWith(prefix) && !matched.includes(n)) matched.push(n);
      }
    } else if (names.includes(pat) && !matched.includes(pat)) {
      matched.push(pat);
    }
  }
  return matched;
}

/** In-memory `gh auth token` fallback for GitHub connector when KMS token is absent. */
function ghAuthTokenFallback(): Promise<string | null> {
  return new Promise((resolve) => {
    nodeExecFile('gh', ['auth', 'token'], { timeout: 4_000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const tok = stdout?.toString().trim() || '';
      resolve(tok.length > 0 ? tok : null);
    });
  });
}

async function resolveFirstKmsSecret(paths: string[], keys: string[], env: string): Promise<string | null> {
  for (const p of paths) {
    for (const k of keys) {
      const v = await kmsGetSecret(`${p}/${k}`, env);
      if (v) return v;
    }
  }
  return null;
}

async function interpolateTemplateUrl(
  template: string,
  spec: ConnectorSpec,
  args: Record<string, any>,
  env: string,
): Promise<string> {
  let out = template;
  if (out.includes('{instance}')) {
    const inst =
      args.instance ||
      (await kmsGetSecret(`${spec.kmsPath}/INSTANCE`, env)) ||
      (spec.id === 'mastodon' ? 'mastodon.social' : '');
    if (!inst) throw new Error(`Missing {instance} for ${spec.id} (pass instance or seal ${spec.kmsPath}/INSTANCE)`);
    out = out.replace(/\{instance\}/g, String(inst).replace(/^https?:\/\//, '').replace(/\/+$/, ''));
  }
  if (out.includes('{site_url}')) {
    const site = args.site_url || (await kmsGetSecret(`${spec.kmsPath}/SITE_URL`, env)) || '';
    if (!site) {
      if (out.includes('/wp-json/')) {
        throw new Error(`Missing {site_url} for WooCommerce (pass site_url or seal credentials/woocommerce/SITE_URL)`);
      }
      return 'https://woocommerce.com/my-dashboard/';
    }
    const normalized = String(site).startsWith('http')
      ? String(site).replace(/\/+$/, '')
      : `https://${String(site).replace(/\/+$/, '')}`;
    out = out.replace(/\{site_url\}/g, normalized);
  }
  if (out.includes('{realmId}')) {
    const realm = args.realmId || (await kmsGetSecret(`${spec.kmsPath}/REALM_ID`, env)) || '';
    if (!realm) throw new Error(`Missing {realmId} for QuickBooks (pass realmId or seal credentials/quickbooks/REALM_ID)`);
    out = out.replace(/\{realmId\}/g, encodeURIComponent(String(realm)));
  }
  return out;
}

let rpcSeq = 0;

/** Call a Streamable-HTTP MCP server (`https://post.hanzo.ai/mcp`) in-memory. */
async function callStreamableMcp(
  endpoint: string,
  apiKey: string,
  mcpMethod: string,
  mcpParams: Record<string, unknown>,
): Promise<{ status: number; data: any }> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: ++rpcSeq,
    method: mcpMethod,
    params: mcpParams,
  });

  const attempt = async (authHeader: string) =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: authHeader,
        'x-api-key': apiKey,
      },
      body: payload,
    });

  let res = await attempt(`Bearer ${apiKey}`);
  if (res.status === 401 || res.status === 403) {
    res = await attempt(apiKey);
  }

  const rawText = await res.text();
  if (!res.ok) {
    return { status: res.status, data: rawText.slice(0, 600) };
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') || rawText.startsWith('event:') || rawText.startsWith('data:')) {
    const dataLines = rawText
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        return { status: res.status, data: JSON.parse(dataLines[i]) };
      } catch {
        // continue
      }
    }
    return { status: res.status, data: rawText };
  }

  try {
    return { status: res.status, data: JSON.parse(rawText) };
  } catch {
    return { status: res.status, data: rawText };
  }
}

/** Read a tab's live markdown/snapshot over ZAP without `Runtime.evaluate` (CSP-safe). */
async function readConnectorTab(
  provider: string,
  tabId: string,
  opts?: { outline?: boolean; filter?: string },
): Promise<{ title: string; url: string; content: string }> {
  let title = '';
  let url = '';
  let content = '';

  try {
    const rd = await zapJson(provider, 'hanzo.read', {
      tabId,
      ...(opts?.outline ? { outline: 'true' } : {}),
      ...(opts?.filter ? { filter: opts.filter } : {}),
    });
    if (rd && typeof rd === 'object') {
      title = String(rd.title || '');
      url = String(rd.url || '');
      content = String(rd.markdown || '');
    }
  } catch {
    // Fall back to interactive snapshot if read fails on this document
  }

  if (!content) {
    try {
      const snap = await zapJson(provider, 'hanzo.snapshot', { tabId, interactive: 'true' });
      if (snap && typeof snap === 'object') {
        title = title || String(snap.title || '');
        url = url || String(snap.url || '');
        content = String(snap.tree || '');
      }
    } catch {
      // Ignore
    }
  }

  if (!url) {
    try {
      const info = await zapJson(provider, 'hanzo.tabInfo', { tabId });
      title = title || String(info?.title || '');
      url = url || String(info?.url || '');
    } catch {
      // Ignore
    }
  }

  return { title, url, content };
}

/** Check matched auth cookie names on a tab via ZAP (`hanzo.getCookies`), NEVER exposing cookie values. */
async function inspectTabAuthCookies(
  provider: string,
  tabId: string,
  spec: ConnectorSpec,
): Promise<{ authenticated: boolean; matchedCookieNames: string[] }> {
  try {
    const raw = await zapJson(provider, 'hanzo.getCookies', { tabId });
    const cookies: any[] = Array.isArray(raw) ? raw : raw?.cookies || [];
    const names = cookies.map((c) => String(c?.name || '')).filter(Boolean);
    const matched = matchCookieIndicators(names, spec.authCookies);
    return { authenticated: matched.length > 0, matchedCookieNames: matched };
  } catch {
    return { authenticated: false, matchedCookieNames: [] };
  }
}

function looksLikeLoginRedirect(urlStr: string, spec: ConnectorSpec): boolean {
  if (!urlStr) return false;
  if (spec.id === 'salesforce' && urlStr === 'https://login.salesforce.com/') return true;
  return /\/(login|signin|sign-in|ServiceLogin|i\/flow\/login|auth\/login|admins\/sign_in)\b/i.test(urlStr);
}

/** Open or reuse the connector's tab in the Agentic Browser, auto-signing in from KMS if needed. */
async function openOrViewConnector(
  spec: ConnectorSpec,
  args: Record<string, any>,
  env: string,
): Promise<{
  tabId: string;
  url: string;
  title: string;
  authenticated: boolean;
  matchedCookieNames: string[];
  autoLoginStatus?: string;
  content: string;
}> {
  const provider = await zap.resolve(args.targetBrowser ?? null, args.clientId ?? null);
  if (!provider) {
    throw new Error('No Agentic Browser connected on the ZAP router');
  }

  const desiredUrl =
    args.url || args.fallbackUrl || (await interpolateTemplateUrl(spec.webUrl, spec, args, env));

  const tabs = await listOpenTabs(provider);
  let tabId = cleanTabId(args.tabId);
  if (!tabId) {
    const existing = tabs.find((t) => matchesConnectorDomain(t.url, spec, args.site_url));
    if (existing) {
      tabId = existing.tabId;
      if (args.url) {
        try {
          await zapJson(provider, 'hanzo.navigate', { tabId, url: desiredUrl });
        } catch {
          await zapJson(provider, 'Page.navigate', { tabId, url: desiredUrl });
        }
      }
    } else {
      const created = await zapJson(provider, 'Target.createTarget', { url: desiredUrl });
      tabId = cleanTabId(created?.tabId ?? created?.targetId);
      if (!tabId) throw new Error(`Failed to open browser tab for ${spec.id}`);
      await zapJson(provider, 'hanzo.wait', { tabId, timeout: '3000' }).catch(() => {});
    }
  }

  let cookieCheck = await inspectTabAuthCookies(provider, tabId, spec);
  let pageData = await readConnectorTab(provider, tabId, {
    outline: Boolean(args.outline),
    filter: args.filter,
  });

  let autoLoginStatus: string | undefined;
  const unauthenticated = !cookieCheck.authenticated || looksLikeLoginRedirect(pageData.url, spec);

  if (unauthenticated && args.autoLogin !== false) {
    const [hasUser, hasPass] = await Promise.all([
      kmsGetSecret(`credentials/${spec.id}/USERNAME`, env),
      kmsGetSecret(`credentials/${spec.id}/PASSWORD`, env),
    ]);
    if (hasUser || hasPass) {
      const loginUrl = await interpolateTemplateUrl(spec.loginUrl, spec, args, env).catch(
        () => spec.loginUrl,
      );
      const loginRes = await browserAutoLogin({
        app: spec.id,
        loginUrl,
        env,
        tabId,
        targetBrowser: args.targetBrowser,
        clientId: args.clientId,
      });
      autoLoginStatus = loginRes.status;
      if (loginRes.status === 'submitted' && desiredUrl !== loginUrl) {
        await zapJson(provider, 'hanzo.navigate', { tabId, url: desiredUrl }).catch(() => {});
      }
      cookieCheck = await inspectTabAuthCookies(provider, tabId, spec);
      pageData = await readConnectorTab(provider, tabId, {
        outline: Boolean(args.outline),
        filter: args.filter,
      });
    }
  }

  return {
    tabId,
    url: pageData.url || desiredUrl,
    title: pageData.title,
    authenticated: cookieCheck.authenticated,
    matchedCookieNames: cookieCheck.matchedCookieNames,
    ...(autoLoginStatus ? { autoLoginStatus } : {}),
    content: pageData.content,
  };
}

function resolveConnector(idRaw: unknown): ConnectorSpec | null {
  if (!idRaw) return null;
  const slug = slugifyApp(String(idRaw));
  const aliases: Record<string, string> = {
    twitter: 'x',
    postiz: 'hanzo_post',
    post: 'hanzo_post',
    gcal: 'google_calendar',
    gdrive: 'google_drive',
    gforms: 'google_forms',
    ga: 'google_analytics',
    ga4: 'google_analytics',
    teams: 'microsoft_teams',
    ms_teams: 'microsoft_teams',
    qbo: 'quickbooks',
    fb_lead_ads: 'facebook_lead_ads',
    dev_to: 'devto',
  };
  return CONNECTORS[slug] ?? CONNECTORS[aliases[slug] || ''] ?? null;
}

function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...data }, null, 2) }] };
}

function fail(error: string, extra: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error, ...extra }, null, 2) }],
    isError: true,
  };
}

const ACTIONS = ['list', 'request', 'view', 'act', 'configure'] as const;

export const connectorsTool: Tool = {
  name: 'connectors',
  description:
    'Unified connectors across all 16 compatible business apps (Gmail, Google Calendar, Google Drive, Salesforce, ' +
    'Microsoft Teams, GitHub, Google Forms, WooCommerce, Intercom, Facebook Lead Ads, DocuSign, Google Ads, Klaviyo, ' +
    'LinkedIn, QuickBooks, Google Analytics), LastPass, Hanzo Post (`post.hanzo.ai/mcp`), and 15 social/publishing networks.\n' +
    '3-Tier Execution:\n' +
    '1. Native REST API or `post.hanzo.ai/mcp` using in-memory Hanzo KMS credentials\n' +
    '2. Automatic fallback to the signed-in Agentic Browser over ZAP (`hanzo.read` / `hanzo.snapshot`)\n' +
    '3. KMS Browser Auto-Login (`vault.browser_login`) & interactive OAuth/token setup (`configure`)\n' +
    'Actions: list | request | view | act | configure',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description: 'Connector operation: list | request | view | act | configure',
      },
      connector: {
        type: 'string',
        description: `Connector ID (${Object.keys(CONNECTORS).join(', ')})`,
      },
      category: {
        type: 'string',
        description: 'list: optional category filter (vault, productivity, crm, developer, commerce, marketing, finance, analytics, social, publishing)',
      },
      compatibleOnly: {
        type: 'boolean',
        description: 'list: when true, list only the 16 compatible business apps',
      },
      method: {
        type: 'string',
        description: 'request: HTTP method (GET, POST, PUT, PATCH, DELETE; default GET)',
      },
      path: {
        type: 'string',
        description: 'request: API path appended to the connector apiBase (e.g. "/messages", "/profiles")',
      },
      apiVariant: {
        type: 'string',
        description: 'request: secondary API base selector (e.g. "admin" for Google Analytics Admin API, "rest" for Hanzo Post REST)',
      },
      query: {
        type: 'object',
        description: 'request: URL query parameters',
      },
      body: {
        type: ['object', 'string'],
        description: 'request: JSON or text request body',
      },
      headers: {
        type: 'object',
        description: 'request: extra non-secret HTTP headers',
      },
      mcpTool: {
        type: 'string',
        description: 'request: MCP tool name to invoke via https://post.hanzo.ai/mcp (or "tools/list")',
      },
      mcpArgs: {
        type: 'object',
        description: 'request: arguments for mcpTool on https://post.hanzo.ai/mcp',
      },
      browserFallback: {
        type: 'boolean',
        description: 'request: fall back to reading the signed-in Agentic Browser tab via ZAP when API token is missing or 401/403 (default: true)',
      },
      fallbackUrl: {
        type: 'string',
        description: 'request / view: explicit web URL to open on browser fallback',
      },
      url: {
        type: 'string',
        description: 'view: specific URL within the connector web app to open',
      },
      outline: {
        type: 'boolean',
        description: 'view: return headings outline only',
      },
      filter: {
        type: 'string',
        description: 'view: filter page markdown to sections matching this string',
      },
      autoLogin: {
        type: 'boolean',
        description: 'view: automatically sign in from KMS if browser session is unauthenticated (default: true)',
      },
      op: {
        type: 'string',
        enum: ['click', 'fill', 'press', 'snapshot', 'evaluate'],
        description: 'act: browser interaction verb over ZAP',
      },
      selector: {
        type: 'string',
        description: 'act: snapshot ref (@eN) or CSS selector',
      },
      text: {
        type: 'string',
        description: 'act (fill): text to enter into selector',
      },
      key: {
        type: 'string',
        description: 'act (press): key name such as Enter, Tab, Escape',
      },
      code: {
        type: 'string',
        description: 'act (evaluate): JavaScript expression (used only when op="evaluate")',
      },
      token: {
        type: 'string',
        description: 'configure: OAuth bearer token or API key to seal into Hanzo KMS',
      },
      secret: {
        type: 'string',
        description: 'configure: API secret / consumer secret / provisioning hash to seal into Hanzo KMS',
      },
      username: {
        type: 'string',
        description: 'configure: login username/email or consumer key to seal into Hanzo KMS',
      },
      password: {
        type: 'string',
        description: 'configure: login password to seal into Hanzo KMS',
      },
      totp_secret: {
        type: 'string',
        description: 'configure: TOTP Base32 secret or otpauth:// URI to seal into Hanzo KMS',
      },
      mcpServerUrl: {
        type: 'string',
        description: 'configure: remote MCP server URL to register on https://api.hanzo.ai/v1/tool/mcp/servers',
      },
      registerMcpServer: {
        type: 'boolean',
        description: 'configure: register connector MCP bridge on https://api.hanzo.ai/v1/tool/mcp/servers',
      },
      viaHanzoPost: {
        type: 'boolean',
        description: 'configure: open https://post.hanzo.ai/launches OAuth channel wizard in Chrome',
      },
      openBrowser: {
        type: 'boolean',
        description: 'configure: open setup/OAuth page in the Agentic Browser via ZAP when no token is passed (default: true)',
      },
      instance: {
        type: 'string',
        description: 'Salesforce / Mastodon instance subdomain or hostname',
      },
      site_url: {
        type: 'string',
        description: 'WooCommerce WordPress site base URL',
      },
      realmId: {
        type: 'string',
        description: 'QuickBooks Online company realmId',
      },
      env: {
        type: 'string',
        description: 'Hanzo KMS environment (default: prod)',
      },
      tabId: {
        type: ['string', 'integer'],
        description: 'Explicit browser tab ID',
      },
      targetBrowser: {
        type: 'string',
        description: 'ZAP browser filter (chrome | firefox)',
      },
      clientId: {
        type: 'string',
        description: 'Explicit ZAP browser node ID',
      },
    },
    required: ['action'],
  },
  async handler(args: Record<string, any> = {}): Promise<ToolResult> {
    const action = String(args.action || 'list');
    const env = String(args.env || 'prod');

    try {
      switch (action) {
        // ── 1. LIST ──────────────────────────────────────────────────────────
        case 'list': {
          const kmsGroups = await kmsListSecrets(env).catch(() => []);
          const kmsByPath = new Map<string, string[]>();
          for (const g of kmsGroups) {
            kmsByPath.set(g.path, g.keys);
          }

          let provider: string | null = null;
          let openTabs: OpenTab[] = [];
          const extensionSessionMap = new Map<string, { authenticated: boolean; cookieNames: string[] }>();

          try {
            provider = await zap.resolve(args.targetBrowser ?? null, args.clientId ?? null);
            if (provider) {
              openTabs = await listOpenTabs(provider);
              try {
                const sessRes = await zapJson(provider, 'social.sessions', {});
                const sessions: any[] = sessRes?.sessions || [];
                for (const s of sessions) {
                  if (s?.provider) {
                    extensionSessionMap.set(String(s.provider), {
                      authenticated: Boolean(s.authenticated),
                      cookieNames: Array.isArray(s.cookieNames) ? s.cookieNames : [],
                    });
                  }
                }
              } catch {
                // Older extension without social.sessions; per-tab cookie check below handles open tabs.
              }
            }
          } catch {
            provider = null;
          }

          let specs = Object.values(CONNECTORS);
          if (args.compatibleOnly) {
            specs = specs.filter((s) => s.compatibleApp);
          }
          if (args.category) {
            specs = specs.filter((s) => s.category === String(args.category).toLowerCase());
          }
          if (args.connector) {
            const one = resolveConnector(args.connector);
            specs = one ? [one] : [];
          }

          const ghCliToken = specs.some((s) => s.id === 'github') ? await ghAuthTokenFallback() : null;

          const items = await Promise.all(
            specs.map(async (spec) => {
              const allPaths = [spec.kmsPath, ...(spec.fallbackKmsPaths || [])];
              const presentKeys = new Set<string>();
              for (const p of allPaths) {
                for (const k of kmsByPath.get(p) || []) presentKeys.add(k);
              }
              const keys = [...presentKeys].sort();
              const hasApiToken =
                spec.kmsTokenKeys.some((k) => presentKeys.has(k)) ||
                (spec.id === 'github' && Boolean(ghCliToken)) ||
                (Boolean(spec.mcpEndpoint) && presentKeys.has('POSTIZ_API_KEY'));
              const hasLoginCreds = presentKeys.has('USERNAME') && presentKeys.has('PASSWORD');

              const matchingTab = openTabs.find((t) => matchesConnectorDomain(t.url, spec, args.site_url));
              const extSess = extensionSessionMap.get(spec.id);
              let authenticated = Boolean(extSess?.authenticated);
              let matchedCookieNames = extSess?.cookieNames ? [...extSess.cookieNames] : [];

              if (!authenticated && provider && matchingTab) {
                const tabCookies = await inspectTabAuthCookies(provider, matchingTab.tabId, spec);
                authenticated = tabCookies.authenticated;
                matchedCookieNames = tabCookies.matchedCookieNames;
              }

              const readyTier = hasApiToken
                ? 'tier1_kms_api'
                : authenticated
                  ? 'tier2_browser_session'
                  : hasLoginCreds
                    ? 'tier3_auto_login'
                    : 'needs_setup';

              return {
                id: spec.id,
                name: spec.name,
                category: spec.category,
                compatibleApp: Boolean(spec.compatibleApp),
                apiBase: spec.apiBase,
                ...(spec.mcpEndpoint ? { mcpBridge: spec.mcpEndpoint } : {}),
                webUrl: spec.webUrl,
                setupUrl: spec.setupUrl,
                kms: {
                  configured: keys.length > 0 || (spec.id === 'github' && Boolean(ghCliToken)),
                  path: spec.kmsPath,
                  keys,
                  ...(spec.id === 'github' && ghCliToken && keys.length === 0 ? { ghCliFallback: true } : {}),
                },
                browser: {
                  zapConnected: Boolean(provider),
                  authenticated,
                  openTabId: matchingTab ? matchingTab.tabId : null,
                  matchedCookieNames,
                },
                readyTier,
              };
            }),
          );

          return ok({
            action: 'list',
            total: items.length,
            compatibleAppsCount: items.filter((i) => i.compatibleApp).length,
            zapConnected: Boolean(provider),
            connectors: items,
          });
        }

        // ── 2. REQUEST (Tier 1 KMS API/MCP -> Tier 2/3 ZAP Browser Fallback) ─
        case 'request': {
          const spec = resolveConnector(args.connector);
          if (!spec) {
            return fail(
              `Unknown connector "${args.connector}". Available: ${Object.keys(CONNECTORS).join(', ')}`,
            );
          }

          const browserFallback = args.browserFallback !== false;
          const allPaths = [spec.kmsPath, ...(spec.fallbackKmsPaths || [])];

          // Route A: MCP Streamable-HTTP (`https://post.hanzo.ai/mcp`)
          const wantsMcp =
            Boolean(args.mcpTool) ||
            (spec.id === 'hanzo_post' && args.apiVariant !== 'rest' && !args.path?.startsWith('/'));

          if (wantsMcp && spec.mcpEndpoint) {
            const postizKey = await resolveFirstKmsSecret(
              ['channels/postiz', 'credentials/hanzo_post', spec.kmsPath],
              ['POSTIZ_API_KEY', 'API_KEY'],
              env,
            );
            if (postizKey) {
              const mcpMethod =
                args.mcpTool === 'tools/list' || args.path === 'tools/list' ? 'tools/list' : 'tools/call';
              const mcpParams =
                mcpMethod === 'tools/list'
                  ? {}
                  : {
                      name: String(args.mcpTool || 'list_integrations'),
                      arguments: {
                        ...(spec.id !== 'hanzo_post' ? { provider: spec.id } : {}),
                        ...(args.mcpArgs || {}),
                      },
                    };
              const mcpRes = await callStreamableMcp(spec.mcpEndpoint, postizKey, mcpMethod, mcpParams);
              if (mcpRes.status >= 200 && mcpRes.status < 300) {
                return ok({
                  action: 'request',
                  mode: 'mcp',
                  connector: spec.id,
                  endpoint: spec.mcpEndpoint,
                  status: mcpRes.status,
                  data: mcpRes.data,
                });
              }
              if (!browserFallback || (mcpRes.status !== 401 && mcpRes.status !== 403)) {
                return fail(`MCP call failed with HTTP ${mcpRes.status}`, {
                  connector: spec.id,
                  status: mcpRes.status,
                  data: mcpRes.data,
                });
              }
            } else if (!browserFallback) {
              return fail(`No POSTIZ_API_KEY sealed in KMS for ${spec.id} MCP bridge`);
            }
          } else {
            // Route B: Native REST / Enterprise API using KMS secret in-memory
            let apiAttempted = false;
            let lastStatus = 0;

            if (spec.authScheme === 'lastpass_enterprise') {
              const cid =
                (await kmsGetSecret('credentials/lastpass/LASTPASS_CID', env)) ||
                process.env.LASTPASS_CID ||
                null;
              const provhash =
                (await kmsGetSecret('credentials/lastpass/LASTPASS_PROVISIONING_HASH', env)) ||
                process.env.LASTPASS_PROVISIONING_HASH ||
                null;
              if (cid && provhash) {
                apiAttempted = true;
                const cmd = String(args.path || (args.body as any)?.cmd || 'getuserdata').replace(/^\/+/, '');
                const res = await fetch(spec.apiBase, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    cid,
                    provhash,
                    cmd,
                    ...(typeof args.body === 'object' && args.body ? { data: args.body } : {}),
                  }),
                });
                lastStatus = res.status;
                const raw = await res.text();
                let parsed: any = raw;
                try { parsed = JSON.parse(raw); } catch { /* plain text */ }
                if (res.ok) {
                  return ok({
                    action: 'request',
                    mode: 'native_api',
                    connector: spec.id,
                    status: res.status,
                    data: parsed,
                  });
                }
                if (!browserFallback || (res.status !== 401 && res.status !== 403)) {
                  return fail(`LastPass Enterprise API HTTP ${res.status}`, {
                    connector: spec.id,
                    status: res.status,
                  });
                }
              }
            } else {
              // Standard REST schemes
              let authHeaderValue: string | null = null;
              let authHeaderName = 'Authorization';
              let tokenForUrl: string | null = null;
              const extraKmsHeaders: Record<string, string> = {};

              if (spec.authScheme === 'basic') {
                const ck = await resolveFirstKmsSecret(allPaths, ['CONSUMER_KEY', 'API_KEY', 'USERNAME'], env);
                const cs = await resolveFirstKmsSecret(allPaths, ['CONSUMER_SECRET', 'API_SECRET', 'PASSWORD'], env);
                if (ck && cs) {
                  authHeaderValue = `Basic ${Buffer.from(`${ck}:${cs}`).toString('base64')}`;
                } else {
                  const bearer = await resolveFirstKmsSecret(allPaths, ['OAUTH_TOKEN'], env);
                  if (bearer) authHeaderValue = `Bearer ${bearer}`;
                }
              } else if (spec.authScheme === 'klaviyo') {
                const key = await resolveFirstKmsSecret(allPaths, ['API_KEY'], env);
                const oauth = key ? null : await resolveFirstKmsSecret(allPaths, ['OAUTH_TOKEN'], env);
                if (key) authHeaderValue = `Klaviyo-API-Key ${key}`;
                else if (oauth) authHeaderValue = `Bearer ${oauth}`;
              } else if (spec.authScheme === 'api_key_header') {
                const key = await resolveFirstKmsSecret(allPaths, spec.kmsTokenKeys, env);
                if (key) {
                  authHeaderName = spec.apiKeyHeader || 'x-api-key';
                  authHeaderValue = key;
                }
              } else if (spec.authScheme === 'bot_token') {
                const botTok = await resolveFirstKmsSecret(allPaths, ['DISCORD_BOT_TOKEN', 'BOT_TOKEN'], env);
                const oauthTok = botTok ? null : await resolveFirstKmsSecret(allPaths, ['OAUTH_TOKEN', 'API_KEY'], env);
                if (botTok) authHeaderValue = `Bot ${botTok}`;
                else if (oauthTok) authHeaderValue = `Bearer ${oauthTok}`;
              } else if (spec.authScheme === 'telegram_bot') {
                tokenForUrl = await resolveFirstKmsSecret(allPaths, spec.kmsTokenKeys, env);
              } else if (spec.authScheme === 'postiz_mcp') {
                const key = await resolveFirstKmsSecret(allPaths, spec.kmsTokenKeys, env);
                if (key) authHeaderValue = key;
              } else {
                let tok = await resolveFirstKmsSecret(allPaths, spec.kmsTokenKeys, env);
                if (!tok && spec.id === 'github') {
                  tok = await ghAuthTokenFallback();
                }
                if (tok) authHeaderValue = `Bearer ${tok}`;
              }

              if (spec.id === 'google_ads') {
                const devTok = await kmsGetSecret('credentials/google_ads/DEVELOPER_TOKEN', env);
                const custId = await kmsGetSecret('credentials/google_ads/CUSTOMER_ID', env);
                if (devTok) extraKmsHeaders['developer-token'] = devTok;
                if (custId) extraKmsHeaders['login-customer-id'] = custId.replace(/-/g, '');
              }

              if (authHeaderValue || tokenForUrl) {
                let baseTemplate =
                  (args.apiVariant && spec.secondaryApiBases?.[args.apiVariant]) || spec.apiBase;
                if (
                  spec.id === 'google_analytics' &&
                  !args.apiVariant &&
                  typeof args.path === 'string' &&
                  /^\/?(accountSummaries|accounts\b)/i.test(args.path)
                ) {
                  baseTemplate = spec.secondaryApiBases!.admin;
                }
                if (tokenForUrl) {
                  baseTemplate = baseTemplate.replace(/\{token\}/g, tokenForUrl);
                }

                let resolvedBase: string | null = null;
                try {
                  resolvedBase = await interpolateTemplateUrl(baseTemplate, spec, args, env);
                } catch (interpErr: any) {
                  if (!browserFallback) throw interpErr;
                }

                if (resolvedBase) {
                  apiAttempted = true;
                  const subPath = String(args.path || '');
                  const fullUrl = new URL(
                    subPath
                      ? `${resolvedBase.replace(/\/+$/, '')}/${subPath.replace(/^\/+/, '')}`
                      : resolvedBase,
                  );
                  if (args.query && typeof args.query === 'object') {
                    for (const [qk, qv] of Object.entries(args.query)) {
                      if (qv !== undefined && qv !== null) fullUrl.searchParams.set(qk, String(qv));
                    }
                  }

                  const method = String(args.method || 'GET').toUpperCase();
                  const reqHeaders: Record<string, string> = {
                    ...(spec.extraHeaders || {}),
                    ...extraKmsHeaders,
                    ...(args.headers || {}),
                  };
                  if (authHeaderValue) reqHeaders[authHeaderName] = authHeaderValue;
                  let encodedBody: string | undefined;
                  if (args.body !== undefined && method !== 'GET' && method !== 'HEAD') {
                    if (typeof args.body === 'string') {
                      encodedBody = args.body;
                    } else {
                      encodedBody = JSON.stringify(args.body);
                      if (!reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
                        reqHeaders['Content-Type'] = 'application/json';
                      }
                    }
                  }

                  const res = await fetch(fullUrl.toString(), {
                    method,
                    headers: reqHeaders,
                    ...(encodedBody !== undefined ? { body: encodedBody } : {}),
                  });
                  lastStatus = res.status;
                  const raw = await res.text();
                  let parsed: any = raw;
                  try { parsed = JSON.parse(raw); } catch { /* plain text */ }

                  if (res.ok) {
                    return ok({
                      action: 'request',
                      mode: 'native_api',
                      connector: spec.id,
                      method,
                      status: res.status,
                      data: parsed,
                    });
                  }

                  if (!browserFallback || (res.status !== 401 && res.status !== 403)) {
                    return fail(`${spec.name} API returned HTTP ${res.status}`, {
                      connector: spec.id,
                      status: res.status,
                      data: typeof parsed === 'string' ? parsed.slice(0, 500) : parsed,
                    });
                  }
                }
              }

              if (!apiAttempted && !browserFallback) {
                return fail(
                  `No API credentials sealed in Hanzo KMS for "${spec.id}" (${spec.kmsPath}) and browserFallback=false`,
                  { connector: spec.id, setupUrl: spec.setupUrl },
                );
              }

              // Tier 2 / Tier 3: Automatic Agentic Browser Fallback over ZAP
              const fallbackView = await openOrViewConnector(spec, args, env);
              return ok({
                action: 'request',
                mode: 'browser_fallback',
                fallbackReason: apiAttempted ? `api_http_${lastStatus}` : 'missing_api_credentials',
                connector: spec.id,
                tabId: fallbackView.tabId,
                url: fallbackView.url,
                title: fallbackView.title,
                authenticated: fallbackView.authenticated,
                ...(fallbackView.autoLoginStatus ? { autoLoginStatus: fallbackView.autoLoginStatus } : {}),
                content: fallbackView.content,
              });
            }
          }

          // Fallback path when MCP or LastPass Enterprise had no token / returned 401/403
          const fallbackView = await openOrViewConnector(spec, args, env);
          return ok({
            action: 'request',
            mode: 'browser_fallback',
            connector: spec.id,
            tabId: fallbackView.tabId,
            url: fallbackView.url,
            title: fallbackView.title,
            authenticated: fallbackView.authenticated,
            ...(fallbackView.autoLoginStatus ? { autoLoginStatus: fallbackView.autoLoginStatus } : {}),
            content: fallbackView.content,
          });
        }

        // ── 3. VIEW ──────────────────────────────────────────────────────────
        case 'view': {
          const spec = resolveConnector(args.connector);
          if (!spec) {
            return fail(
              `Unknown connector "${args.connector}". Available: ${Object.keys(CONNECTORS).join(', ')}`,
            );
          }
          const viewRes = await openOrViewConnector(spec, args, env);
          return ok({
            action: 'view',
            connector: spec.id,
            ...viewRes,
          });
        }

        // ── 4. ACT ───────────────────────────────────────────────────────────
        case 'act': {
          const spec = resolveConnector(args.connector);
          if (!spec) {
            return fail(
              `Unknown connector "${args.connector}". Available: ${Object.keys(CONNECTORS).join(', ')}`,
            );
          }
          const op = String(args.op || 'click');
          const provider = await zap.resolve(args.targetBrowser ?? null, args.clientId ?? null);
          if (!provider) {
            return fail('No Agentic Browser connected on the ZAP router');
          }

          let tabId = cleanTabId(args.tabId);
          if (!tabId) {
            const tabs = await listOpenTabs(provider);
            const existing = tabs.find((t) => matchesConnectorDomain(t.url, spec, args.site_url));
            if (existing) {
              tabId = existing.tabId;
            } else {
              const targetUrl = await interpolateTemplateUrl(spec.webUrl, spec, args, env);
              const created = await zapJson(provider, 'Target.createTarget', { url: targetUrl });
              tabId = cleanTabId(created?.tabId ?? created?.targetId);
              if (!tabId) return fail(`Could not open browser tab for ${spec.id}`);
              await zapJson(provider, 'hanzo.wait', { tabId, timeout: '2500' }).catch(() => {});
            }
          }

          const selector = args.selector ? String(args.selector) : undefined;
          const isRef = Boolean(selector && /^@?e\d+$/.test(selector.trim()));
          let result: unknown;

          switch (op) {
            case 'click': {
              if (!selector) return fail('selector is required for op="click"');
              if (isRef) {
                result = await zapJson(provider, 'hanzo.act', { tabId, op: 'click', selector });
              } else {
                try {
                  result = await zapJson(provider, 'hanzo.act', { tabId, op: 'click', selector });
                } catch {
                  result = await zapJson(provider, 'hanzo.click', { tabId, selector });
                }
              }
              break;
            }
            case 'fill': {
              if (!selector) return fail('selector is required for op="fill"');
              const val = String(args.text ?? args.value ?? '');
              if (isRef) {
                result = await zapJson(provider, 'hanzo.act', { tabId, op: 'fill', selector, text: val });
              } else {
                try {
                  result = await zapJson(provider, 'hanzo.act', { tabId, op: 'fill', selector, text: val });
                } catch {
                  result = await zapJson(provider, 'hanzo.fill', { tabId, selector, value: val });
                }
              }
              break;
            }
            case 'press': {
              const key = String(args.key || 'Enter');
              if (isRef && selector) {
                result = await zapJson(provider, 'hanzo.act', { tabId, op: 'press', selector, key });
              } else {
                result = await zapJson(provider, 'hanzo.press', {
                  tabId,
                  key,
                  ...(selector ? { selector } : {}),
                });
              }
              break;
            }
            case 'snapshot': {
              result = await zapJson(provider, 'hanzo.snapshot', { tabId, interactive: 'true' });
              break;
            }
            case 'evaluate': {
              if (!args.code) return fail('code is required for op="evaluate"');
              result = await zapJson(provider, 'Runtime.evaluate', {
                tabId,
                expression: String(args.code),
              });
              break;
            }
            default:
              return fail(`Unsupported act op "${op}". Use: click | fill | press | snapshot | evaluate`);
          }

          return ok({
            action: 'act',
            connector: spec.id,
            op,
            tabId,
            result,
          });
        }

        // ── 5. CONFIGURE ─────────────────────────────────────────────────────
        case 'configure': {
          const spec = resolveConnector(args.connector);
          if (!spec) {
            return fail(
              `Unknown connector "${args.connector}". Available: ${Object.keys(CONNECTORS).join(', ')}`,
            );
          }

          const keysSealed: string[] = [];
          const customFields: Record<string, string> = {};
          if (args.instance) customFields.INSTANCE = String(args.instance);
          if (args.site_url) customFields.SITE_URL = String(args.site_url);
          if (args.realmId) customFields.REALM_ID = String(args.realmId);

          if (spec.id === 'hanzo_post' && (args.token || args.secret)) {
            const postizKey = String(args.token || args.secret);
            await kmsSetSecret('channels/postiz', 'POSTIZ_API_KEY', postizKey, env);
            keysSealed.push('POSTIZ_API_KEY');
          } else if (spec.id === 'woocommerce' && args.username && args.secret && !args.password) {
            await kmsSetSecret(spec.kmsPath, 'CONSUMER_KEY', String(args.username), env);
            await kmsSetSecret(spec.kmsPath, 'CONSUMER_SECRET', String(args.secret), env);
            keysSealed.push('CONSUMER_KEY', 'CONSUMER_SECRET');
            for (const [ck, cv] of Object.entries(customFields)) {
              await kmsSetSecret(spec.kmsPath, ck, cv, env);
              keysSealed.push(ck);
            }
          } else if (spec.id === 'lastpass' && args.username && args.secret && !args.password) {
            await kmsSetSecret(spec.kmsPath, 'LASTPASS_CID', String(args.username), env);
            await kmsSetSecret(spec.kmsPath, 'LASTPASS_PROVISIONING_HASH', String(args.secret), env);
            keysSealed.push('LASTPASS_CID', 'LASTPASS_PROVISIONING_HASH');
          } else if (
            args.token ||
            args.secret ||
            args.username ||
            args.password ||
            args.totp_secret ||
            Object.keys(customFields).length > 0
          ) {
            const preferApiKey =
              spec.authScheme === 'klaviyo' ||
              spec.authScheme === 'api_key_header' ||
              spec.id === 'intercom';
            const sealed = await sealAppCredentials({
              app: spec.id,
              path: spec.kmsPath,
              env,
              username: args.username,
              password: args.password,
              api_key: preferApiKey ? args.token || args.secret : args.secret,
              oauth_token: preferApiKey ? undefined : args.token,
              totp_secret: args.totp_secret,
              custom: customFields,
            });
            keysSealed.push(...sealed.keysSealed);
          }

          // Optional remote MCP server registration on Hanzo Cloud (`POST /v1/tool/mcp/servers`)
          let mcpRegistration: Record<string, unknown> | undefined;
          const targetMcpUrl =
            args.mcpServerUrl || (args.registerMcpServer ? spec.mcpEndpoint || POSTIZ_MCP_URL : null);
          if (targetMcpUrl) {
            const apiBase = (process.env.HANZO_API_URL || 'https://api.hanzo.ai').replace(/\/+$/, '');
            const iamToken =
              process.env.HANZO_API_KEY ||
              process.env.HANZO_TOKEN ||
              (await kmsGetSecret('hanzo/HANZO_API_KEY', env)) ||
              '';
            if (iamToken) {
              try {
                const regRes = await fetch(`${apiBase}/v1/tool/mcp/servers`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${iamToken}`,
                  },
                  body: JSON.stringify({
                    name: `${spec.id}-mcp`,
                    connector: spec.id,
                    url: targetMcpUrl,
                    transport: 'streamable-http',
                  }),
                });
                mcpRegistration = {
                  registered: regRes.ok,
                  status: regRes.status,
                  endpoint: `${apiBase}/v1/tool/mcp/servers`,
                  mcpServerUrl: targetMcpUrl,
                };
              } catch (e: any) {
                mcpRegistration = {
                  registered: false,
                  error: e.message,
                  mcpServerUrl: targetMcpUrl,
                };
              }
            } else {
              mcpRegistration = {
                registered: false,
                reason: 'HANZO_API_KEY not set in environment for /v1/tool/mcp/servers registration',
                mcpServerUrl: targetMcpUrl,
              };
            }
          }

          // Open OAuth / Developer Token page in Chrome via ZAP when requested or when no secrets were passed
          const setupUrl = args.viaHanzoPost
            ? POSTIZ_LAUNCHES_URL
            : await interpolateTemplateUrl(spec.setupUrl, spec, args, env).catch(() => spec.setupUrl);

          let browserOpened: Record<string, unknown> | undefined;
          if (args.openBrowser === true || (args.openBrowser !== false && keysSealed.length === 0 && !targetMcpUrl)) {
            const provider = await zap.resolve(args.targetBrowser ?? null, args.clientId ?? null).catch(
              () => null,
            );
            if (provider) {
              const created = await zapJson(provider, 'Target.createTarget', { url: setupUrl });
              const openedTabId = cleanTabId(created?.tabId ?? created?.targetId);
              if (openedTabId) {
                await zap.route(provider, 'Target.activateTarget', { tabId: openedTabId }).catch(() => {});
              }
              browserOpened = { tabId: openedTabId, url: setupUrl };
            }
          }

          return ok({
            action: 'configure',
            connector: spec.id,
            kmsPath: spec.id === 'hanzo_post' ? 'channels/postiz' : spec.kmsPath,
            kmsSealed: keysSealed.length > 0,
            keysSealed,
            setupUrl,
            ...(mcpRegistration ? { mcpRegistration } : {}),
            ...(browserOpened ? { browserOpened } : {}),
          });
        }

        default:
          return fail(`Unknown connectors action "${action}". Valid actions: ${ACTIONS.join(', ')}`);
      }
    } catch (e: any) {
      return fail(e?.message || String(e), { action });
    }
  },
};

export const connectorsTools: Tool[] = [connectorsTool];
