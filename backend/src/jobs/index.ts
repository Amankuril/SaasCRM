import { processWebhookDelivery } from '../modules/developer/webhook.service.js';
import { processCampaignDispatch } from '../modules/campaigns/campaign.service.js';
import { processFlowResume } from '../modules/flows/engine.js';
import { processSendJob } from '../modules/messages/message.service.js';
import { processWebhookJob } from '../modules/whatsapp/webhook.processor.js';
import { processBillingSweep } from '../modules/billing/billing.jobs.js';
import { pollSheets } from '../modules/integrations/sheets.service.js';
import { processTemplateSync, reconcileTemplates } from '../modules/templates/templateSync.js';
import { tickReminders } from '../modules/reminders/reminder.service.js';
import { rollupRecentDays } from '../modules/reports/messagePricing.service.js';
import { processDomainEvents } from '../modules/events/domainEvents.js';
import { processSequenceRun, retrySequenceMessage, tickSequences } from '../modules/sequences/sequence.engine.js';
import { runDailyTriggers } from '../modules/sequences/sequence.daily.js';
import { autoSync, runSync } from '../modules/fbads/fbads.service.js';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import { registerProcessor, registerRepeating } from './queue.js';

/** Registers every job processor. Imported by both the API and the worker process. */
registerProcessor('whatsapp.send', processSendJob);
registerProcessor('webhook.process', processWebhookJob);
registerProcessor('campaign.dispatch', processCampaignDispatch);
registerProcessor('flow.resume', processFlowResume);
registerProcessor('integration.webhook', processWebhookDelivery);
registerProcessor('billing.sweep', async () => {
  await processBillingSweep();
});
registerRepeating('billing.sweep', 60 * 60 * 1000);
// Google Sheets campaigns: pick up new rows (live sheet edits) and send due ones.
registerProcessor('sheets.poll', async () => {
  await pollSheets();
});
registerRepeating('sheets.poll', env.SHEETS_POLL_SECONDS * 1000);
// Template statuses: re-read Meta while anything is in review, so approvals arrive even without webhooks.
registerProcessor('templates.sync', processTemplateSync);
registerProcessor('templates.reconcile', async () => {
  await reconcileTemplates();
});
registerRepeating('templates.reconcile', 60_000);
// Date reminders: send what is due (and retry what could not be sent yet).
registerProcessor('reminders.tick', async () => {
  await tickReminders();
});
registerRepeating('reminders.tick', 30_000);
// Message pricing report: sum up finished days so long ranges load fast.
registerProcessor('pricing.rollup', async () => {
  await rollupRecentDays();
});
registerRepeating('pricing.rollup', 60 * 60 * 1000);
// Sequences: contact events (triggers, goals, STOP), the due-time scheduler and date triggers.
registerProcessor('domain.events', processDomainEvents);
registerProcessor('sequence.run', processSequenceRun);
registerProcessor('sequence.retry', retrySequenceMessage);
registerProcessor('sequences.tick', async () => {
  await tickSequences();
});
registerRepeating('sequences.tick', 30_000);
registerProcessor('sequences.daily', async () => {
  await runDailyTriggers();
});
registerRepeating('sequences.daily', 15 * 60_000);
// Facebook Ads: sync jobs, and an automatic sync every 6 hours.
registerProcessor('fbads.sync', async (data) => {
  await runSync(new Types.ObjectId(data.workspaceId));
});
registerProcessor('fbads.autosync', async () => {
  await autoSync();
});
registerRepeating('fbads.autosync', 60 * 60_000);
