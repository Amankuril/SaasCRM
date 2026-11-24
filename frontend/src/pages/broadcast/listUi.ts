/** Small display helpers shared by the Contacts List views. */

const AVATAR_TONES = ['bg-slate-200/70 text-slate-700'];
export const toneFor = (id: string) => AVATAR_TONES[parseInt(id.slice(-4), 16) % AVATAR_TONES.length];
export const initialsOf = (name: string) =>
  name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

/** "13th Oct 2026 10:05 PM" like the reference design. */
export function longDate(value: string) {
  const d = new Date(value);
  const day = d.getDate();
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${day}${suffix} ${d.toLocaleString(undefined, { month: 'short' })} ${d.getFullYear()} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
