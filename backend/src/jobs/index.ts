import { processWebhookDelivery } from '../modules/developer/webhook.service.js';
import { processCampaignDispatch } from '../modules/campaigns/campaign.service.js';
import { processFlowResume } from '../modules/flows/engine.js';
import { processSendJob } from '../modules/messages/message.service.js';
import { processWebhookJob } from '../modules/whatsapp/webhook.processor.js';
import { processBillingSweep } from '../modules/billing/billing.jobs.js';
import { pollSheets } from '../modules/integrations/sheets.service.js';
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
