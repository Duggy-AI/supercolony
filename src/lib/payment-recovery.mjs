import { PERMIT2_ADDRESS } from '@x402/evm';
import { parseAbi } from 'viem';
import { getPublicRpcClient } from '../shared.mjs';
import { onchainTerms } from './payments.mjs';
import { transactionReceipt } from './transactions.mjs';

const NONCES = parseAbi(['function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)']);

// Wall-clock expiry alone cannot prove that a saved signature was never paid.
// Only renew after finalized chain state makes the old authorization unusable.
export async function authorizationUnpaid(state, options) {
  if (state.paymentStatus === 'confirmed') return false;
  const chainId = state.onchainPayment ? state.onchainPayment.chainId : 1;
  const client = await getPublicRpcClient(options, chainId);
  const block = await client.getBlock({ blockTag: 'finalized' });
  if (state.onchainPayment) {
    if (block.timestamp <= BigInt(onchainTerms(state).expiresAt)) return false;
    const receipt = await transactionReceipt(client, state.onchainPayment);
    // Every future block is past the contract's expiry. A successful receipt
    // under any replacement hash must still prevent another payment.
    return !receipt || (receipt.status === 'reverted' && receipt.blockNumber <= block.number);
  }
  const permit = state.payment.payload.permit2Authorization;
  if (block.timestamp <= BigInt(permit.deadline)) return false;
  const nonce = BigInt(permit.nonce);
  const bitmap = await client.readContract({
    address: PERMIT2_ADDRESS, abi: NONCES, functionName: 'nonceBitmap',
    args: [permit.from, nonce >> 8n], blockNumber: block.number,
  });
  return (bitmap & (1n << (nonce & 255n))) === 0n;
}
