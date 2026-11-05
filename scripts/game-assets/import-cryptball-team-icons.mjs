import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const out = fileURLToPath(new URL('../../apps/cryptball/public/assets/teams/', import.meta.url));
mkdirSync(out, { recursive: true });
// Original compact mascot marks. Names and silhouettes supplement palette identity.
const marks = {
  rams: ['#72d9d6', '<path d="M24 24C10 7 2 26 12 36L21 32C11 24 18 20 24 29M40 24C54 7 62 26 52 36L43 32C53 24 46 20 40 29"/><path d="M23 22L32 18L41 22L42 37L35 47H29L22 37Z"/><path class="ink" d="M26 29L30 31M38 29L34 31M29 39H35"/>'],
  foxes: ['#f08b59', '<path d="M13 12L29 24H35L51 12L48 36L32 49L16 36Z"/><path class="light" d="M17 30L29 35L32 44L35 35L47 30L40 42L32 49L24 42Z"/><path class="ink" d="M22 29L27 31M42 29L37 31M29 41H35L32 44Z"/>'],
  owls: ['#6f9fff', '<path d="M12 16L26 21H38L52 16L48 40L32 49L16 40Z"/><path class="light" d="M16 24L30 28L26 38L18 35ZM48 24L34 28L38 38L46 35Z"/><path class="ink" d="M23 28V32M41 28V32M29 36L32 40L35 36"/>'],
  gators: ['#9dc95b', '<path d="M10 30L19 21L31 20L37 25L53 28L50 39L24 43L13 38Z"/><path class="ink" d="M15 34H49M25 26H29"/><path class="light" d="M22 34L25 39L28 34M35 34L38 39L41 34"/>'],
  bats: ['#be8ce8', '<path d="M27 26L28 17L32 22L36 17L37 26L54 17L51 37L43 33L39 43L32 48L25 43L21 33L13 37L10 17Z"/><path class="ink" d="M27 32H29M35 32H37M32 39V43"/>'],
  hornets: ['#f4ce55', '<path class="light" d="M26 26C11 12 6 28 24 35M38 26C53 12 58 28 40 35"/><path d="M26 22L32 18L38 22L41 36L32 49L23 36Z"/><path class="ink" d="M26 30H38M25 37H39M28 22L23 13M36 22L41 13"/>'],
};
for (const [id, [color, mark]] of Object.entries(marks)) {
 const name = id[0].toUpperCase() + id.slice(1);
 const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-labelledby="title"><title id="title">${name}</title><path fill="#101b25" stroke="${color}" stroke-width="2" d="M32 3L58 13V38L48 51L32 61L16 51L6 38V13Z"/><g fill="${color}" stroke="#101b25" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><style>.ink{fill:none;stroke:#101b25;stroke-width:3}.light{fill:#f7f1dc}</style>${mark}</g></svg>\n`;
 writeFileSync(`${out}/${id}.svg`, svg);
}
console.log(`Built ${Object.keys(marks).length} original mascot emblems.`);
