/** Small display helpers shared by the Contacts List views. */

const AVATAR_TONES = ['bg-rose-50 text-rose-600', 'bg-violet-50 text-violet-600', 'bg-emerald-50 text-emerald-600', 'bg-sky-50 text-sky-600', 'bg-amber-50 text-amber-700', 'bg-indigo-50 text-indigo-600'];
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
