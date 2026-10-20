import QRCode from 'qrcode';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { walletInfo } from './local-wallet.mjs';
import { PAYMENT_NETWORKS, paymentNetwork } from './payment-networks.mjs';
import { paymentCoins } from './payment-coins.mjs';

export async function receiveWallet(options, wallet = walletInfo(options)) {
  if (!wallet.configured) throw new Error('Create or import a wallet first.');
  // A plain address QR works in wallets and exchange withdrawal screens.
  // It does not encode a network; the sending network must be selected explicitly.
  const networks = (options.paymentChain ? [paymentNetwork(options.paymentChain)] : PAYMENT_NETWORKS).map(network => ({
    network: network.key, chainName: network.chain.name, chainId: network.chain.id,
    coins: paymentCoins(network.key).map(c => c.symbol),
  }));
  return { address: wallet.address, ...(networks.length === 1 ? networks[0] : {}), networks };
}

export function receiveQr(address) {
  return QRCode.toString(address, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
}

export function receiveQrText(address) {
  const segments = [{ data: '0x', mode: 'byte' }, { data: address.slice(2).toUpperCase(), mode: 'alphanumeric' }];
  return QRCode.toString(segments, { type: 'utf8', margin: 4, errorCorrectionLevel: 'L' });
}

export async function saveReceiveQr(address, out) {
  const path = resolve(out);
  if (!path.toLowerCase().endsWith('.svg')) throw new Error('Use an .svg file for the recharge QR code.');
  await writeFile(path, await QRCode.toString(address, { type: 'svg', margin: 4, errorCorrectionLevel: 'L' }), { flag: 'wx' });
  return { path };
}
