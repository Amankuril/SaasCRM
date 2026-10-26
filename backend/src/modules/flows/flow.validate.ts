import { Types } from 'mongoose';
import { AiAgent } from '../ai/ai.model.js';
import { Form } from '../forms/form.model.js';
import { Tag } from '../contacts/tag.model.js';
import { MessageTemplate } from '../templates/template.model.js';
import { checkSendValues, sendRequirements, type TemplateExtras } from '../templates/templateSend.js';
import { WorkspaceMember } from '../workspaces/member.model.js';
import { Flow, FlowVersion } from './flow.model.js';
import { WAITING_NODES, nodeConfigSchemas, outputHandles, type Graph, type GraphNode } from './graph.js';

export interface ValidationIssue {
  nodeId: string | null;
  message: string;
}

/**
 * Everything that must hold before a flow can go live. Returns a list of
 * problems (empty = publishable) instead of throwing so the builder can
 * highlight each step.
 */
export async function validateFlow(workspaceId: Types.ObjectId, flowId: Types.ObjectId, graph: Graph): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const add = (nodeId: string | null, message: string) => issues.push({ nodeId, message });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const triggers = graph.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) add(null, 'A flow needs exactly one trigger.');
  if (new Set(graph.nodes.map((n) => n.id)).size !== graph.nodes.length) add(null, 'Two steps share the same id.');

  // Per-step configuration.
  for (const node of graph.nodes) {
    const parsed = nodeConfigSchemas[node.type].safeParse(node.data);
    if (!parsed.success) add(node.id, parsed.error.issues[0]?.message ?? 'This step is incomplete.');
  }

  // Edges point at real steps and real outputs, one connection per output.
  const used = new Set<string>();
  for (const edge of graph.edges) {
    const source = byId.get(edge.source);
    if (!source || !byId.has(edge.target)) {
      add(edge.source, 'A connection points to a step that no longer exists.');
      continue;
    }
    if (!outputHandles(source).includes(edge.sourceHandle)) add(source.id, 'A connection leaves from an output this step does not have.');
    const key = `${edge.source}:${edge.sourceHandle}`;
    if (used.has(key)) add(source.id, 'An output is connected to two steps. Each output can lead to one step.');
    used.add(key);
    if (edge.target === triggers[0]?.id) add(source.id, 'Nothing can connect back into the trigger.');
  }

  const trigger = triggers[0];
  if (trigger) {
    if (!graph.edges.some((e) => e.source === trigger.id)) add(trigger.id, 'Connect the trigger to a first step.');

    // Reachability from the trigger.
    const seen = new Set<string>([trigger.id]);
    const queue = [trigger.id];
    while (queue.length) {
      const id = queue.shift()!;
      for (const e of graph.edges) if (e.source === id && !seen.has(e.target)) seen.add(e.target), queue.push(e.target);
    }
    for (const n of graph.nodes) if (!seen.has(n.id)) add(n.id, 'This step is not connected to the flow.');
  }

  // A loop must pass through a waiting step, or it would spin forever.
  if (hasInstantLoop(graph, byId)) add(null, 'The flow loops back without a wait, question or buttons step in between.');

  await checkReferences(workspaceId, graph, add);
  if (trigger) await checkTriggerConflicts(workspaceId, flowId, trigger, add);
  return issues;
}

function hasInstantLoop(graph: Graph, byId: Map<string, GraphNode>): boolean {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    const source = byId.get(e.source);
    if (!source || WAITING_NODES.has(source.type)) continue; // leaving a waiting step breaks the loop
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 'visiting') return true;
    if (state.get(id) === 'done') return false;
    state.set(id, 'visiting');
    const cyclic = (adj.get(id) ?? []).some(visit);
    state.set(id, 'done');
    return cyclic;
  };
  return graph.nodes.some((n) => visit(n.id));
}

async function checkReferences(workspaceId: Types.ObjectId, graph: Graph, add: (nodeId: string | null, message: string) => void) {
  for (const node of graph.nodes) {
    const d = node.data as Record<string, unknown>;
    if (node.type === 'send_template' && typeof d.templateId === 'string') {
      const t = Types.ObjectId.isValid(d.templateId) ? await MessageTemplate.findOne({ _id: d.templateId, workspaceId }) : null;
      if (!t) add(node.id, 'The selected template no longer exists.');
      else if (t.status !== 'APPROVED') add(node.id, `Template "${t.name}" is not approved yet.`);
      else {
        const req = sendRequirements(t.components as never);
        const count = (key: string) => ((d[key] as unknown[]) ?? []).length;
        if (count('headerVariables') !== req.header || count('bodyVariables') !== req.body || count('buttonVariables') !== req.buttons.length) {
          add(node.id, 'Map every template variable.');
        } else {
          const placeholder = (n: number) => Array<string>(n).fill('x');
          // Offer expiry is checked when the step runs, not when the flow is published.
          const { offerExpiresAt: _expiry, ...issues } = checkSendValues(req, {
            headerParams: placeholder(req.header),
            bodyParams: placeholder(req.body),
            buttonParams: placeholder(req.buttons.length),
            extras: (d.templateExtras ?? {}) as TemplateExtras,
          });
          for (const messages of Object.values(issues)) add(node.id, messages[0]!);
        }
      }
    }
    const tagIds = [
      ...(node.type === 'trigger' && d.event === 'tag_added' && typeof d.tagId === 'string' ? [d.tagId] : []),
      ...(node.type === 'update_contact' ? ((d.actions as { tagId?: string }[]) ?? []).map((a) => a.tagId).filter((t): t is string => !!t) : []),
      ...(node.type === 'condition' ? ((d.rules as { field: string; value: string }[]) ?? []).filter((r) => r.field === 'tag').map((r) => r.value) : []),
    ];
    for (const tagId of tagIds) {
      if (!Types.ObjectId.isValid(tagId) || !(await Tag.exists({ _id: tagId, workspaceId }))) add(node.id, 'A selected tag no longer exists.');
    }
    const formId =
      (node.type === 'send_form' && typeof d.formId === 'string' && d.formId) ||
      (node.type === 'trigger' && d.event === 'form_submitted' && typeof d.formId === 'string' && d.formId) ||
      null;
    if (formId) {
      const form = Types.ObjectId.isValid(formId) ? await Form.findOne({ _id: formId, workspaceId }).lean() : null;
      if (!form) add(node.id, 'The selected form no longer exists.');
      else if (form.status !== 'published') add(node.id, `Publish the form "${form.name}" first.`);
    }
    if (node.type === 'ai_answer' && !(await AiAgent.exists({ workspaceId, enabled: true }))) {
      add(node.id, 'Turn on the AI agent (AI Agent page) before using this step.');
    }
    if (node.type === 'http_request' && typeof d.body === 'string' && /^\s*[[{]/.test(d.body)) {
      try {
        JSON.parse(d.body.replace(/\{\{\s*[a-z0-9_.]+\s*\}\}/gi, 'x'));
      } catch {
        add(node.id, 'The body is not valid JSON. Put {{placeholders}} inside quotes, e.g. "name": "{{contact.name}}".');
      }
    }
    if (node.type === 'handoff' && typeof d.assigneeId === 'string' && d.assigneeId) {
      const member = Types.ObjectId.isValid(d.assigneeId) ? await WorkspaceMember.findOne({ workspaceId, userId: d.assigneeId }).lean() : null;
      if (!member || member.role === 'analyst') add(node.id, 'Hand off to a teammate who can reply.');
    }
  }
}

/** Two live flows must not compete for the same message. */
async function checkTriggerConflicts(workspaceId: Types.ObjectId, flowId: Types.ObjectId, trigger: GraphNode, add: (nodeId: string | null, message: string) => void) {
  const d = trigger.data as { event?: string; keywords?: string[]; formId?: string };
  if (!['keyword', 'any_message', 'new_contact', 'form_submitted'].includes(d.event ?? '')) return;
  const others = await Flow.find({ workspaceId, status: 'active', _id: { $ne: flowId }, publishedVersionId: { $ne: null } }).select('name publishedVersionId').lean();
  const versions = await FlowVersion.find({ workspaceId, _id: { $in: others.map((o) => o.publishedVersionId) } }).lean();
  const nameOf = new Map(others.map((o) => [String(o.publishedVersionId), o.name]));

  for (const v of versions) {
    const other = nameOf.get(v._id.toString());
    if (d.event === 'keyword') {
      const mine = new Set((d.keywords ?? []).map((k) => k.toLowerCase()));
      const clash = v.trigger?.event === 'keyword' ? v.trigger.keywords.find((k) => mine.has(k.toLowerCase())) : undefined;
      if (clash) add(trigger.id, `Keyword "${clash}" is already used by the live flow "${other}".`);
    } else if (d.event === 'form_submitted') {
      if (v.trigger?.event === 'form_submitted' && String(v.trigger.formId) === d.formId) add(trigger.id, `The live flow "${other}" already runs when this form is submitted.`);
    } else if (v.trigger?.event === d.event) {
      add(trigger.id, `The live flow "${other}" already uses this trigger. Deactivate it first.`);
    }
  }
}
