/**
 * Confirms that an explicit undici dispatcher carrying our CA bundle lets
 * fetch reach ADO without NODE_EXTRA_CA_CERTS being set on the process.
 * This is the mechanism the ADO client uses.
 */
import { readFileSync } from 'node:fs';

import { Agent } from 'undici';

delete process.env.NODE_EXTRA_CA_CERTS;

const ca = readFileSync('certs/windows-ca-bundle.pem', 'utf8');
const dispatcher = new Agent({ connect: { ca } });

const url = 'https://dev.azure.com/jblprd/_apis/connectionData?api-version=7.1-preview';

try {
  const res = await fetch(url, { dispatcher });
  console.log('with dispatcher CA  -> HTTP', res.status);
} catch (err) {
  console.log('with dispatcher CA  -> FAIL', err.cause?.code ?? err.message);
}

try {
  const res = await fetch(url);
  console.log('without dispatcher  -> HTTP', res.status);
} catch (err) {
  console.log('without dispatcher  -> FAIL', err.cause?.code ?? err.message);
}
