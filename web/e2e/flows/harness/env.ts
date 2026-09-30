import { fileURLToPath } from 'node:url';

// Where each process of the full-flow stack listens. None of these is a port `npm run dev` uses
// (4280, 5173, 7071, 10000-10002), so the suite can run while a dev stack is up.
export const PORTS = {
  swa: 4380,
  func: 7171,
  ripe: 4390,
  blob: 10100,
  queue: 10101,
  table: 10102,
} as const;

export const BASE_URL = `http://localhost:${PORTS.swa}`;
export const FUNC_URL = `http://127.0.0.1:${PORTS.func}`;
export const RIPE_STUB_URL = `http://127.0.0.1:${PORTS.ripe}`;

// Azurite's built-in development account. The key is the public one Microsoft documents for the
// storage emulator, not a credential.
const DEV_ACCOUNT = 'devstoreaccount1';
const DEV_KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
export const TABLES_CONNECTION_STRING =
  `DefaultEndpointsProtocol=http;AccountName=${DEV_ACCOUNT};AccountKey=${DEV_KEY};` +
  `TableEndpoint=http://127.0.0.1:${PORTS.table}/${DEV_ACCOUNT};`;

export const TABLES = ['users', 'projects', 'pledges', 'claims'] as const;

/** Repository root and the web workspace. */
export const REPO_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
export const WEB_DIR = fileURLToPath(new URL('../../../', import.meta.url));

/** Scratch space for one run: the staged API, and one log file per process. Git-ignored. */
export const STACK_DIR = fileURLToPath(new URL('../../../e2e-stack/', import.meta.url));
export const LOGS = {
  func: `${STACK_DIR}func.log`,
  swa: `${STACK_DIR}swa.log`,
  azurite: `${STACK_DIR}azurite.log`,
} as const;
