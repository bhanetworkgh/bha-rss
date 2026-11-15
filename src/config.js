// Every setting comes from the environment. Secrets have no defaults: a missing one is named at boot.
const env = process.env;

function num(name, fallback) {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  port: num('PORT', 3000),
  supabaseUrl: (env.SUPABASE_URL || '').replace(/\/$/, ''),
  supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
  adminKey: env.BHA_RSS_KEY || '',
  apifyToken: env.APIFY_TOKEN || '',
  openrouterKey: env.OPENROUTER_API_KEY || '',
  openrouterUrl: (env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
  digestModel: env.DIGEST_MODEL || 'anthropic/claude-sonnet-5',
  dashboardUrl: (env.DASHBOARD_URL || 'https://dashboard.bhanetwork.org').replace(/\/$/, ''),
  dashboardKey: env.DASHBOARD_INBOUND_KEY || '',
  pollMs: num('POLL_MS', 60_000),
  concurrency: num('CONCURRENCY', 4),
  fetchTimeoutMs: num('FETCH_TIMEOUT_MS', 20_000),
  apifyTimeoutMs: num('APIFY_TIMEOUT_MS', 120_000),
  // The digest covers the UTC day before and is written at this UTC hour.
  digestHourUtc: Number.isInteger(Number(env.DIGEST_HOUR_UTC)) ? Number(env.DIGEST_HOUR_UTC) : 6,
  maxItemsPerDigest: num('MAX_ITEMS_PER_DIGEST', 400),
  linkedinPosts: num('LINKEDIN_POSTS', 10),
  // Richer capture (15 Nov 2026): per source and run, new videos given a transcript and new short news items
  // opened for the article's own text. A feed item shorter than shortContentChars counts as short.
  transcriptsPerRun: num('YT_TRANSCRIPTS_PER_RUN', 5),
  transcriptActor: env.YT_TRANSCRIPT_ACTOR || 'automation-lab~youtube-transcript',
  articlesPerRun: num('ARTICLES_PER_RUN', 10),
  shortContentChars: num('SHORT_CONTENT_CHARS', 800),
  schedulerOn: env.SCHEDULER !== 'off',
};

export function missingSettings() {
  const need = {
    SUPABASE_URL: config.supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: config.supabaseKey,
    BHA_RSS_KEY: config.adminKey,
    OPENROUTER_API_KEY: config.openrouterKey,
    DASHBOARD_INBOUND_KEY: config.dashboardKey,
    APIFY_TOKEN: config.apifyToken,
  };
  return Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
}
