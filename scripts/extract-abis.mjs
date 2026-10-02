// Copy the ABI arrays (not full build artifacts) from the contracts repo's Foundry output.
// Usage: node scripts/extract-abis.mjs [path-to-archon-repo]   (default: ../archon)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractsRepo = resolve(root, process.argv[2] ?? '../archon');
const outDir = resolve(root, 'src/chain/abis');
const CONTRACTS = ['IntentEngine', 'ArchonRouter', 'AgentVault', 'StablePool', 'VolatilePool'];

mkdirSync(outDir, { recursive: true });
for (const name of CONTRACTS) {
  const artifact = resolve(contractsRepo, 'out', `${name}.sol`, `${name}.json`);
  const { abi } = JSON.parse(readFileSync(artifact, 'utf8'));
  if (!Array.isArray(abi) || abi.length === 0) throw new Error(`No ABI in ${artifact}`);
  writeFileSync(resolve(outDir, `${name}.json`), JSON.stringify(abi, null, 2) + '\n');
  console.log(`${name}: ${abi.length} entries`);
}
