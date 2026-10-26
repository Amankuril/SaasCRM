import { randomBytes } from 'node:crypto';

/** zf_<formId>_<version>_<random>: identifies the form and makes each send's token unique. */
export function newFlowToken(form: { id: string; version: number }): string {
  return `zf_${form.id}_${form.version}_${randomBytes(9).toString('base64url')}`;
}

export function parseFlowToken(token: string): { formId: string; version: number } | null {
  const m = /^zf_([a-f0-9]{24})_(\d+)_[\w-]+$/.exec(token);
  return m ? { formId: m[1]!, version: Number(m[2]) } : null;
}
