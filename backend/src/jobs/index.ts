import { processCampaignDispatch } from '../modules/campaigns/campaign.service.js';
import { processSendJob } from '../modules/messages/message.service.js';
import { processWebhookJob } from '../modules/whatsapp/webhook.processor.js';
import { registerProcessor } from './queue.js';

/** Registers every job processor. Imported by both the API and the worker process. */
registerProcessor('whatsapp.send', processSendJob);
registerProcessor('webhook.process', processWebhookJob);
registerProcessor('campaign.dispatch', processCampaignDispatch);
