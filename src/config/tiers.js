/**
 * Tier limits — single source of truth for all feature gates.
 * Keep in sync with the frontend copy at src/config/tiers.js.
 */

const TIER_LIMITS = {
  FREE: {
    maxConnectedAccounts: 1,
    maxScanEmails: 500,
    maxDailyDeletions: 3,       // sender-level deletions per calendar day
    permanentDelete: false,
    bulkDelete: false,
    gmailOAuth: true,
    csvExport: true,
    emailPreview: false,
    prioritySorting: false,
    scheduledAutoClean: false,
    sizeAnalytics: false,
    unsubscribe: false,
    smartFilters: false,
    folderSupport: false,
    retentionRules: false,
    teamSeats: 0,
  },
  PRO: {
    maxConnectedAccounts: 3,
    maxScanEmails: Infinity,
    maxDailyDeletions: Infinity,
    permanentDelete: true,
    bulkDelete: true,
    gmailOAuth: true,
    csvExport: true,
    emailPreview: true,
    prioritySorting: true,
    scheduledAutoClean: true,
    sizeAnalytics: true,
    unsubscribe: false,
    smartFilters: false,
    folderSupport: false,
    retentionRules: false,
    teamSeats: 0,
  },
  PREMIUM: {
    maxConnectedAccounts: Infinity,
    maxScanEmails: Infinity,
    maxDailyDeletions: Infinity,
    permanentDelete: true,
    bulkDelete: true,
    gmailOAuth: true,
    csvExport: true,
    emailPreview: true,
    prioritySorting: true,
    scheduledAutoClean: true,
    sizeAnalytics: true,
    unsubscribe: true,
    smartFilters: true,
    folderSupport: true,
    retentionRules: true,
    teamSeats: 3,
  },
};

const getTier = (user) => user?.subscription?.tier ?? "FREE";
const getLimits = (user) => TIER_LIMITS[getTier(user)];

module.exports = { TIER_LIMITS, getTier, getLimits };
