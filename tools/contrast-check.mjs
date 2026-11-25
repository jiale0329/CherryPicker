/**
 * Checks WCAG contrast for the dark theme's text colours.
 *
 * The design guidance calls for 4.5:1 minimum for body text, and the previous
 * muted-foreground sat close to that floor while carrying most of this
 * dashboard's information. This converts the oklch tokens to sRGB and reports
 * the real ratios so "more contrast" is a measurement rather than a feeling.
 */

/** oklch -> linear sRGB -> relative luminance, per WCAG 2.1. */
function oklchToLinearSrgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function luminance(L, C, h) {
  const [r, g, b] = oklchToLinearSrgb(L, C, h);
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

function ratio(fg, bg) {
  const a = luminance(...fg);
  const b = luminance(...bg);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

const BEFORE = {
  base: [0.165, 0.006, 286],
  raised: [0.205, 0.007, 286],
  foreground: [0.95, 0.002, 286],
  muted: [0.69, 0.011, 286],
  border: [0.275, 0.008, 286],
};

const AFTER = {
  base: [0.155, 0.012, 266],
  raised: [0.212, 0.014, 266],
  foreground: [0.97, 0.003, 266],
  muted: [0.755, 0.014, 266],
  border: [0.41, 0.014, 266],
  borderStrong: [0.52, 0.016, 266],
};

function report(label, theme) {
  console.log(`\n${label}`);
  const checks = [
    ['body text on page', theme.foreground, theme.base],
    ['body text on card', theme.foreground, theme.raised],
    ['muted text on page', theme.muted, theme.base],
    ['muted text on card', theme.muted, theme.raised],
    ['gridline vs card', theme.border, theme.raised],
    ...(theme.borderStrong ? [['input outline vs card', theme.borderStrong, theme.raised]] : []),
  ];

  for (const [name, fg, bg] of checks) {
    const value = ratio(fg, bg);
    /*
     * 4.5:1 for body text. 3:1 for an input outline, which conveys an
     * interactive affordance. A gridline is a decorative separator and only
     * needs to be perceivable, so it is held to ~2:1 rather than 3:1.
     */
    const floor = name.startsWith('gridline') ? 1.9 : name.startsWith('input') ? 3 : 4.5;
    const verdict = value >= floor ? 'pass' : 'FAIL';
    console.log(`  ${name.padEnd(24)} ${value.toFixed(2).padStart(5)}:1  ${verdict} (needs ${floor})`);
  }
}

report('BEFORE', BEFORE);
report('AFTER', AFTER);
console.log('');
