import { erc20Abi, parseUnits } from 'viem';
import { confirmAction, getRpcClients, print } from '../shared.mjs';
import { loadPaymentConfig } from '../lib/payments.mjs';
import { selectedPaymentNetwork } from '../lib/payment-networks.mjs';
import { walletInfo, saveLocalWallet, backupWallet, restoreWallet, walletFile, listWallets, selectWallet } from '../lib/local-wallet.mjs';
import { readPassword } from '../lib/password.mjs';
import { walletStatus } from '../lib/wallet-status.mjs';
import { receiveWallet, receiveQr, saveReceiveQr } from '../lib/wallet-receive.mjs';

async function newPassword() {
  const password = await readPassword('Local wallet password (at least 8 characters)');
  if (password !== await readPassword('Confirm password')) throw new Error('Passwords do not match.');
  return password;
}

function savedWalletText(wallet, home) {
  return `Wallet ready: ${wallet.address}\nEncrypted file: ${walletFile(home)}\nBack up this file and keep your password. Both are needed to restore your wallet.\nRun colony wallet receive to deposit funds.`;
}

function addressText(address) {
  return `address: ${address}`;
}

function networkStatusText(network) {
  if (network.error) return [`${network.chainName} (${network.chainId})`, `  balances unavailable: ${network.error}`];
  return [
    `${network.chainName} (${network.chainId})`,
    `  task price:         ${network.price} IMD`,
    ...network.coins.map((coin) => `  ${(coin.symbol + ':').padEnd(19)} ${coin.balance}${coin.symbol === 'ETH' ? '  (also pays gas)' : ''}`),
    `  IMD authorization:  ${network.allowance}`,
  ];
}

function statusText(status) {
  return [
    `address: ${status.address}`,
    'The same address works on every network below. Balances are separate per network.',
    ...status.networks.flatMap((network) => ['', ...networkStatusText(network)]),
  ].join('\n');
}

function receiveText(result) {
  const networks = result.networks.map((network) => `  ${network.chainName}: ${network.coins.join(', ')}`);
  return [
    result.networks.length === 1 ? `Receive on ${result.chainName}` : 'Receive funds',
    result.address,
    result.networks.length === 1 ? 'Accepted coins:' : 'This address works on both networks. Accepted coins:',
    ...networks,
    'In the sending wallet or exchange, choose the network you plan to pay on. Funds stay on that network.',
    'Also send a little ETH on the same network for gas (network fees).',
  ].join('\n');
}

export function registerWalletCommands(program) {
  const wallet = program.command('wallet').description('create, import, back up and fund your local wallet');

  wallet.command('list').description('list saved local wallets and the current selection')
    .action((_options, command) => {
      const opts = command.optsWithGlobals();
      const wallets = listWallets(opts.home);
      print(opts.json ? wallets : wallets.length ? wallets.map(w => `${w.active ? '*' : ' '} ${w.address}${w.active ? ' (current)' : ''}`).join('\n') : 'No saved wallets. Create, import or restore one.', opts);
    });

  wallet.command('use <address>').description('select a saved wallet')
    .action(async (address, _options, command) => {
      const opts = command.optsWithGlobals();
      const selected = await selectWallet(opts.home, address);
      print(opts.json ? selected : `Active wallet: ${selected.address}`, opts);
    });

  wallet.command('create').description('create a new password-encrypted local wallet')
    .action(async (_options, command) => {
      const opts = command.optsWithGlobals();
      const result = await saveLocalWallet(opts.home, listWallets(opts.home).length ? undefined : await newPassword());
      print(opts.json ? result : savedWalletText(result, opts.home), opts);
    });

  wallet.command('import').description('import a private key using hidden terminal input')
    .action(async (_options, command) => {
      const opts = command.optsWithGlobals();
      const privateKey = await readPassword('Private key (hidden)');
      const result = await saveLocalWallet(opts.home, listWallets(opts.home).length ? undefined : await newPassword(), privateKey);
      print(opts.json ? result : savedWalletText(result, opts.home), opts);
    });

  wallet.command('backup').description('copy the encrypted wallet file; never export a plaintext key')
    .requiredOption('--out <file>', 'new backup file path')
    .action(async (_options, command) => {
      const opts = command.optsWithGlobals();
      const result = await backupWallet(opts.home, opts.out);
      print(opts.json ? result : `Encrypted backup saved: ${result.path}\nKeep your wallet password separately.`, opts);
    });

  wallet.command('restore').description('add a wallet from an encrypted backup and select it')
    .requiredOption('--file <file>', 'encrypted JSON keystore backup')
    .action(async (_options, command) => {
      const opts = command.optsWithGlobals();
      const result = await restoreWallet(opts.home, opts.file, await readPassword('Backup password'));
      print(opts.json ? result : savedWalletText(result, opts.home), opts);
    });

  wallet.command('receive').description('show the deposit address and QR code (same address on every payment network)')
    .option('--out <file>', 'save an SVG QR code to a new file')
    .action(async (_options, command) => {
      const opts = command.optsWithGlobals();
      const result = await receiveWallet(opts);
      if (opts.out) result.qrFile = (await saveReceiveQr(result.address, opts.out)).path;
      if (opts.json) return print(result, opts);
      print(receiveText(result), opts);
      if (result.qrFile) print(`QR saved: ${result.qrFile}`, opts);
      else process.stdout.write(await receiveQr(result.address));
    });

  wallet
    .command('address')
    .description('print your public wallet address without unlocking')
    .action((options, command) => {
      const opts = command.optsWithGlobals();
      const account = walletInfo(opts);
      if (!account.configured) throw new Error('Create or import a wallet first.');
      print(opts.json ? { address: account.address } : addressText(account.address), opts);
    });

  wallet
    .command('status')
    .description('show balances on every payment network (narrow with --payment-chain)')
    .action(async (options, command) => {
      const opts = command.optsWithGlobals();
      const status = await walletStatus(opts);
      print(opts.json ? status : statusText(status), opts);
    });

  wallet
    .command('approve')
    .description('authorize an exact IMD amount on --payment-chain (default ethereum)')
    .requiredOption('--amount <amount>', 'token amount to approve, in whole tokens')
    .option('--wallet <address>', 'require this wallet address for the authorization')
    .action(async (options, command) => {
      const opts = command.optsWithGlobals();
      const expectedWallet = opts.wallet ?? walletInfo(opts).address;
      const network = await selectedPaymentNetwork(opts);
      const { payment, chainId, spender } = await loadPaymentConfig(opts.api, 'job.open', network.key);
      const amount = parseUnits(opts.amount, payment.decimals);
      if (amount <= 0n) throw new Error('--amount must be greater than zero');

      await confirmAction(
        `Authorize ${opts.amount} IMD for payment on ${network.chain.name}?\nWallet: ${expectedWallet}\nAsset: ${payment.asset}\nSpender: ${spender}\nThis transaction also uses ETH for network fees.`,
        opts,
      );

      const { publicClient, walletClient } = await getRpcClients({ ...opts, expectedWallet }, chainId);
      const hash = await walletClient.writeContract({
        address: payment.asset,
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, amount],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new Error(`approve transaction failed: ${hash}`);
      }

      const result = {
        transactionHash: hash,
        chainId,
        asset: payment.asset,
        spender,
        amount: opts.amount,
        amountAtomic: String(amount),
      };
      print(
        opts.json
          ? result
          : `authorized ${opts.amount} IMD on ${network.chain.name}\ntx: ${hash}`,
        opts,
      );
    });
}
