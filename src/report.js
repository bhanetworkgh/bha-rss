// Genie rebuild step 4.2 (16 Nov 2026, Destiny): BHA RSS says when something fails. It holds no Slack key: a failure
// is posted to the dashboard (POST /api/engine/rss-error, the inbound key it already holds), and Bays posts it to
// #bha-pipeline-errors, once per kind and subject per day. A report that does not land is logged here and never
// stops the run it is about; the dashboard also checks each morning that the day's digest arrived.
import { config } from './config.js';

export async function reportError(report, fetchImpl = fetch) {
  if (!config.dashboardKey) {
    console.error(`[report] ${report.kind} for ${report.subject} not reported: DASHBOARD_INBOUND_KEY is not set`);
    return { ok: false, error: 'not_configured' };
  }
  const payload = { ...report, at: report.at || new Date().toISOString() };
  try {
    const res = await fetchImpl(`${config.dashboardUrl}/api/engine/rss-error`, {
      method: 'POST',
      headers: { 'x-dashboard-key': config.dashboardKey, 'content-type': 'application/json' },
      body: JSON.stringify({ body_b64: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64') }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    if (!res.ok || parsed?.ok === false) {
      console.error(`[report] ${report.kind} for ${report.subject} not reported: dashboard answered ${res.status}: ${text.slice(0, 300)}`);
      return { ok: false, error: `dashboard answered ${res.status}` };
    }
    return { ok: true, posted: parsed?.posted === true };
  } catch (err) {
    console.error(`[report] ${report.kind} for ${report.subject} not reported: ${String(err?.message || err)}`);
    return { ok: false, error: String(err?.message || err) };
  }
}
