import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recoverMessageAddress } from 'viem';
import jsQR from 'jsqr';
import { saveLocalWallet, walletInfo, walletSigner, backupWallet, restoreWallet, lockWallet, walletFile, listWallets, selectWallet } from '../src/lib/local-wallet.mjs';
import { receiveWallet, receiveQrText, saveReceiveQr } from '../src/lib/wallet-receive.mjs';
import { walletStatus } from '../src/lib/wallet-status.mjs';
import { publishJob } from '../src/lib/publish.mjs';
import { cancelOrder, listOrders } from '../src/lib/orders.mjs';
import { paymentApi } from './helpers/payment-api.mjs';
import { TEST_KEY, TEST_ADDRESS, runEntry } from './helpers/cli.mjs';
import { revealPrivateKey } from '../src/lib/local-wallet.mjs';

test('view private key verifies the supplied password every time, even with a cached session', async t => {
  const home = await mkdtemp(join(tmpdir(), 'colony-reveal-key-'));
  t.after(async () => { lockWallet(); await rm(home, { recursive: true, force: true }); });
  await saveLocalWallet(home, 'test reveal password', TEST_KEY);
  await saveLocalWallet(home);
  const current = walletInfo({ home }).address;
  await assert.rejects(revealPrivateKey(home, TEST_ADDRESS, 'wrong'), /Incorrect wallet password/);
  const revealed = await revealPrivateKey(home, TEST_ADDRESS, 'test reveal password');
  assert.equal(revealed.privateKey, TEST_KEY);
  assert.equal(walletInfo({ home }).address, current);
  await assert.rejects(revealPrivateKey(home, TEST_ADDRESS, 'wrong'), /Incorrect wallet password/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(revealPrivateKey(home, TEST_ADDRESS, 'test reveal password', { signal: controller.signal }), /abort/i);
});

test('cancelling while the wallet unlocks preserves cancellation and never signs', async t => {
  for (const passwordAccepted of [true, false]) {
    const home = await mkdtemp(join(tmpdir(), 'colony-unlock-cancel-'));
    t.after(async () => { lockWallet(); await rm(home, { recursive: true, force: true }); });
    const password = 'test cancellation password';
    await saveLocalWallet(home, password, TEST_KEY);
    lockWallet();
    const mock = await paymentApi(home);
    mock.control.chainId = 1;
    t.after(() => mock.close());
    await assert.rejects(publishJob({
      home, api: mock.url, rpc: mock.url + '/rpc', paymentChain: 'ethereum',
      input: { objective: 'Coffee site', template: 'website' },
      confirm: async () => {}, intervalMs: 1, timeoutMs: 50,
      requestPassword: async () => {
        const [order] = await listOrders(home);
        await cancelOrder(home, order.requestKey);
        return passwordAccepted ? password : 'incorrect';
      },
    }), /cancelled locally/);
    const [order] = await listOrders(home);
    assert.ok(order.cancelledAt);
    assert.equal(order.paymentHeader, undefined);
    assert.equal(mock.requests.filter(request => request.headers['payment-signature']).length, 0);
  }
});

test('switching wallets at payment confirmation cannot charge the newly selected wallet', async t => {
  const home = await mkdtemp(join(tmpdir(), 'colony-payer-switch-'));
  t.after(async () => { lockWallet(); await rm(home, { recursive: true, force: true }); });
  const first = await saveLocalWallet(home, 'test payment password', TEST_KEY);
  const second = await saveLocalWallet(home);
  await selectWallet(home, first.address);
  const mock = await paymentApi(home);
  mock.control.chainId = 1;
  t.after(() => mock.close());
  await assert.rejects(publishJob({ home, api: mock.url, rpc: mock.url + '/rpc', paymentChain: 'ethereum',
    input: { objective: 'Coffee site', template: 'website' },
    confirm: () => selectWallet(home, second.address),
  }), /Payment wallet changed/);
  const [order] = await listOrders(home);
  assert.equal(order.paymentHeader, undefined);
  assert.equal(mock.requests.filter(request => request.headers['payment-signature']).length, 0);
  const approval = await runEntry(['--home', home, '--api', mock.url, '--rpc', mock.url + '/rpc', '--yes', 'wallet', 'approve', '--amount', '0.5', '--wallet', first.address]);
  assert.equal(approval.status, 1);
  assert.match(approval.stderr, /Payment wallet changed/);
});

test('encrypted local wallet: import, read while locked, pay, lock, backup and restore', async t => {
  const home = await mkdtemp(join(tmpdir(), 'colony-keystore-'));
  t.after(async () => { lockWallet(); await rm(home, {recursive:true,force:true}); });
  const password = 'test wallet password 2026';
  const imported = await saveLocalWallet(home, password, TEST_KEY);
  assert.equal(imported.address, TEST_ADDRESS);
  assert.equal(imported.locked, false);
  lockWallet();
  const encrypted = await readFile(walletFile(home), 'utf8');
  assert.doesNotMatch(encrypted, new RegExp(TEST_KEY.slice(2) + '|' + password));
  assert.equal(JSON.parse(encrypted).version, 3);
  if(process.platform!=='win32') assert.equal((await stat(walletFile(home))).mode & 0o777, 0o600);
  await assert.rejects(saveLocalWallet(home, password, TEST_KEY), /already exists/);
  assert.equal(await readFile(walletFile(home),'utf8'), encrypted);
  await assert.rejects(walletSigner({home,requestPassword:async()=> 'incorrect'}), /Could not unlock/);
  assert.equal(walletInfo({home}).locked,true);
  let prompts=0;
  const options={home,requestPassword:async()=>{prompts++;return password;}};
  const account=await walletSigner(options);
  const signature=await account.signMessage({message:'local-wallet-test'});
  assert.equal(await recoverMessageAddress({message:'local-wallet-test',signature}), TEST_ADDRESS);
  await walletSigner(options);
  assert.equal(prompts,1);
  lockWallet();
  const mock=await paymentApi(home);
  t.after(()=>mock.close());
  mock.control.funding=true;
  const status=await walletStatus({...options,api:mock.url,rpc:mock.url+'/rpc',paymentChain:'robinhood'});
  assert.equal(status.address,TEST_ADDRESS);
  assert.equal(prompts,1,'balance does not unlock');
  const result=await publishJob({...options,api:mock.url,rpc:mock.url+'/rpc',paymentChain:'robinhood',payWith:'USDG',input:{objective:'Coffee site',template:'website'},confirm:async()=>{},intervalMs:1,timeoutMs:2000});
  assert.equal(result.status,'admitted');
  assert.equal(prompts,2,'one unlock covers funding and task payment');
  assert.doesNotMatch(JSON.stringify(result),new RegExp(TEST_KEY.slice(2)+'|'+password));
  const backup=join(home,'backup.json');
  await backupWallet(home,backup);
  await assert.rejects(backupWallet(home,backup), /EEXIST/);
  assert.equal(await readFile(backup,'utf8'),encrypted);
  const restored=join(home,'restored');
  assert.equal((await restoreWallet(restored,backup,password)).address,TEST_ADDRESS);
  assert.equal((await walletSigner({home:restored,requestPassword:async()=>password})).address,TEST_ADDRESS);
  const addressCommand=await runEntry(['--home',home,'wallet','address','--json']);
  assert.equal(addressCommand.status,0,addressCommand.stderr);
  assert.equal(JSON.parse(addressCommand.stdout).address,TEST_ADDRESS);
});

test('fresh wallets generate unique keys; invalid keys and weak passwords are not saved',async t=>{
  const home=await mkdtemp(join(tmpdir(),'colony-new-wallet-'));
  t.after(async()=>{lockWallet();await rm(home,{recursive:true,force:true});});
  await assert.rejects(saveLocalWallet(home,'short'),/at least 8/);
  await assert.rejects(saveLocalWallet(home,'test password','not-a-key'),/32-byte/);
  const a=await saveLocalWallet(join(home,'a'),'test password');
  const b=await saveLocalWallet(join(home,'b'),'test password');
  assert.notEqual(a.address,b.address);
  assert.equal(walletInfo({home:join(home,'a')}).address,a.address);
});

test('multiple wallets share one password and unlock session; restored backups use the local password', async t => {
  const home = await mkdtemp(join(tmpdir(), 'colony-multi-wallet-'));
  t.after(async () => { lockWallet(); await rm(home, { recursive: true, force: true }); });
  const first = await saveLocalWallet(home, 'first wallet password', TEST_KEY);
  // An existing first-wallet keystore remains usable without a selection file.
  await unlink(join(home, 'wallet-selection.json'));
  assert.equal(walletInfo({ home }).address, first.address);
  const firstFile = walletFile(home);
  const original = await readFile(firstFile, 'utf8');
  await walletSigner({ home, requestPassword: async () => 'first wallet password' });
  const second = await saveLocalWallet(home);
  assert.notEqual(first.address, second.address);
  assert.equal(listWallets(home).length, 2);
  assert.equal(walletInfo({ home }).address, second.address);
  assert.equal(await readFile(firstFile, 'utf8'), original);
  const selectedBackup = join(home, 'first-selected-backup.json');
  await backupWallet(home, selectedBackup, first.address);
  assert.equal(await readFile(selectedBackup, 'utf8'), original);
  assert.equal(walletInfo({ home }).address, second.address);
  assert.equal((await receiveWallet({ home, paymentChain: 'ethereum' }, { configured: true, address: first.address })).address, first.address);
  assert.ok(listWallets(home).every(wallet => !wallet.locked));
  const noPrompt = async () => { throw new Error('Must reuse the unlocked local password'); };
  const signer = await walletSigner({ home, requestPassword: noPrompt });
  const signature = await signer.signMessage({ message: 'selected wallet' });
  assert.equal(await recoverMessageAddress({ message: 'selected wallet', signature }), second.address);
  const backup = join(home, 'second-backup.json');
  await backupWallet(home, backup);
  await selectWallet(home, first.address);
  assert.equal(walletInfo({ home }).locked, false);
  assert.equal((await walletSigner({ home, requestPassword: noPrompt })).address, first.address);
  assert.equal((await walletSigner({ home, expectedWallet: first.address.toLowerCase(), requestPassword: noPrompt })).address, first.address);
  assert.equal(walletFile(home), firstFile);
  const listed = await runEntry(['--home', home, 'wallet', 'list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).find(wallet => wallet.active).address, first.address);
  const switched = await runEntry(['--home', home, 'wallet', 'use', second.address, '--json']);
  assert.equal(switched.status, 0, switched.stderr);
  assert.equal(walletInfo({ home }).address, second.address);
  const destination = join(home, 'restore-destination');
  await saveLocalWallet(destination, 'destination password', TEST_KEY);
  const restored = await restoreWallet(destination, backup, 'first wallet password', { requestPassword: noPrompt });
  assert.equal(restored.address, second.address);
  assert.equal(listWallets(destination).length, 2);
  await assert.rejects(restoreWallet(destination, backup, 'first wallet password'), /already exists/);
  assert.equal(listWallets(destination).length, 2);
  lockWallet();
  await assert.rejects(walletSigner({ home: destination, requestPassword: async () => 'first wallet password' }), /Could not unlock/);
  assert.equal((await walletSigner({ home: destination, requestPassword: async () => 'destination password' })).address, second.address);
  lockWallet();
  let prompts = 0;
  const third = await saveLocalWallet(home, undefined, undefined, { requestPassword: async () => { prompts++; return 'first wallet password'; } });
  assert.equal(prompts, 1);
  assert.equal((await walletSigner({ home, requestPassword: noPrompt })).address, third.address);
});

test('changing the active wallet during password entry prevents signing with the old wallet', async t => {
  const home = await mkdtemp(join(tmpdir(), 'colony-wallet-switch-'));
  t.after(async () => { lockWallet(); await rm(home, { recursive: true, force: true }); });
  const first = await saveLocalWallet(home, 'first wallet password', TEST_KEY);
  await saveLocalWallet(home);
  lockWallet();
  await assert.rejects(walletSigner({ home, requestPassword: async () => {
    await selectWallet(home, first.address);
    return 'first wallet password';
  } }), /Active wallet changed/);
  assert.equal(walletInfo({ home }).address, first.address);
  assert.equal(walletInfo({ home }).locked, false);
});

test('recharge QR decodes to the address and both networks are explicit without unlocking',async t=>{
  const home=await mkdtemp(join(tmpdir(),'colony-receive-'));
  t.after(async()=>{lockWallet();await rm(home,{recursive:true,force:true});});
  await saveLocalWallet(home,'test password',TEST_KEY);
  lockWallet();
  for(const network of ['ethereum','robinhood']){
    const receive=await receiveWallet({home,paymentChain:network});
    assert.equal(receive.address,TEST_ADDRESS);
    assert.equal(receive.chainId,network==='ethereum'?1:4663);
    assert.deepEqual(receive.coins,network==='ethereum'?['IMD','ETH','USDC','USDT']:['IMD','ETH','USDG']);
  }
  const qr=await receiveQrText(TEST_ADDRESS);
  const rows=qr.split('\n');
  const scale=6,width=rows[0].length*scale,height=rows.length*2*scale;
  const rgba=new Uint8ClampedArray(width*height*4).fill(255);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const moduleY=Math.floor(y/scale), c=rows[Math.floor(moduleY/2)][Math.floor(x/scale)];
    const dark=c==='█'||(c==='▀'&&moduleY%2===0)||(c==='▄'&&moduleY%2===1);
    if(dark){const i=(y*width+x)*4;rgba[i]=rgba[i+1]=rgba[i+2]=0;}
  }
  const decoded=jsQR(rgba,width,height);
  assert.equal(decoded.data.toLowerCase(),TEST_ADDRESS.toLowerCase());
  const out=join(home,'receive.svg');
  await saveReceiveQr(TEST_ADDRESS,out);
  assert.match(await readFile(out,'utf8'),/<svg/);
  await assert.rejects(saveReceiveQr(TEST_ADDRESS,out),/EEXIST/);
  assert.equal(walletInfo({home}).locked,true);
});
