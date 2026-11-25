/**
 * Finds border lightness values that meet their contrast floors.
 *
 * Two different floors apply, and conflating them is how dark themes end up
 * either invisible or looking like a spreadsheet:
 *
 *  - `border-strong` outlines inputs and buttons. It conveys an interactive
 *    affordance, so WCAG asks for 3:1 against its background.
 *  - `border` draws table gridlines, which are decorative separators. They
 *    only need to be clearly perceivable; forcing 3:1 makes every row shout.
 */

function oklchToLinearSrgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function luminance(L, C, h) {
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const [r, g, b] = oklchToLinearSrgb(L, C, h).map(clamp);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg, bg) {
  const a = luminance(...fg);
  const b = luminance(...bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const CHROMA = 0.014;
const HUE = 266;
const raised = [0.212, 0.014, 266];
const base = [0.155, 0.012, 266];

console.log('\nlightness   vs card   vs page');
for (let L = 0.3; L <= 0.62; L += 0.02) {
  const candidate = [Number(L.toFixed(2)), CHROMA, HUE];
  console.log(
    `  ${L.toFixed(2)}       ${ratio(candidate, raised).toFixed(2).padStart(5)}    ${ratio(candidate, base).toFixed(2).padStart(5)}`,
  );
}

console.log('\nTargets: border ~2:1 (perceivable separator), border-strong >=3:1 (input outline)\n');
