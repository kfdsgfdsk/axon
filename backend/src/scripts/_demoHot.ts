import { requestHotWalletAddress } from '../services/signer/client';

async function main() {
  const r = await requestHotWalletAddress('solana-devnet');
  console.log(JSON.stringify(r));
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
