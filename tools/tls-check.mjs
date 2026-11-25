/**
 * Verifies Node can complete TLS to the hosts this app depends on.
 * Run with NODE_EXTRA_CA_CERTS pointing at certs/windows-ca-bundle.pem.
 */
const targets = [
  'https://dev.azure.com/jblprd/_apis/connectionData?api-version=7.1-preview',
  'https://ui.shadcn.com/r/styles/new-york-v4/button.json',
  'https://registry.npmjs.org/next/latest',
];

console.log('NODE_EXTRA_CA_CERTS =', process.env.NODE_EXTRA_CA_CERTS ?? '(unset)');
console.log('NODE_TLS_REJECT_UNAUTHORIZED =', process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '(unset, good)');
console.log('');

for (const url of targets) {
  const host = new URL(url).host;
  try {
    const res = await fetch(url);
    console.log(`  OK    ${host.padEnd(22)} HTTP ${res.status}`);
  } catch (err) {
    const code = err.cause?.code ?? err.message;
    console.log(`  FAIL  ${host.padEnd(22)} ${code}`);
  }
}
