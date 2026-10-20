import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildRegisterPlan,
  formatRegisterPlan,
  pollAgentBind,
  readRegistration,
  runRegister,
  saveRegistration,
} from '../src/worker/register.mjs';

const TO = `0x${'12'.repeat(20)}`;
const FROM = `0x${'34'.repeat(20)}`;
const TX_HASH = `0x${'ab'.repeat(32)}`;
const DATA = '0xb68ca002';

function tempContext() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'colony-register-'));
  return {
    ctx: { kind: 'local', key: 'local', home, imdPath: '/opt/imd' },
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

test('register plan is human-readable and JSON-serialisable', () => {
  const plan = buildRegisterPlan({
    chainId: 1,
    chainName: 'mainnet',
    from: FROM,
    to: TO,
    data: DATA,
    value: 0n,
    gas: 21000n,
    gasPrice: 1000000000n,
    agentURI: 'https://api.imd.fun/agents/by-token/42.json',
  });
  const text = formatRegisterPlan(plan);
  assert.match(text, /chain:\s+mainnet \(1\)/);
  assert.match(text, new RegExp(TO));
  assert.match(text, /gas:\s+21000/);
  assert.doesNotThrow(() => JSON.stringify(plan));
  assert.equal(plan.maxFeeWei, '21000000000000');
});

test('bind polling returns the agentId without inventing success', async () => {
  let calls = 0;
  const result = await pollAgentBind({
    request: async () => {
      calls += 1;
      return { data: calls === 1 ? { tokenId: '42', agentId: null } : { tokenId: '42', agentId: '51495' } };
    },
    api: 'https://api.imd.fun',
    tokenId: '42',
    txHash: TX_HASH,
    attempts: 3,
    sleepFn: async () => {},
  });
  assert.equal(result.agentId, '51495');
  assert.equal(result.attempts, 2);
});

test('register sends one explicit transaction, saves its hash, then binds', async () => {
  const { ctx, cleanup } = tempContext();
  try {
    let confirmed = 0;
    let sent = 0;
    let sentTx = null;
    let waitedFor = null;
    const calls = [];
    const shared = {
      request: async (api, path_, options = {}) => {
        calls.push({ path: path_, options });
        if (path_ === '/agents/bind') {
          if (options.body?.txHash) return { data: { tokenId: '42', agentId: '51495' } };
          return { data: { tokenId: '42', agentId: null } };
        }
        if (path_.startsWith('/agents/register-intent')) {
          return {
            data: {
              to: TO,
              data: DATA,
              chainId: 1,
              agentURI: 'https://api.imd.fun/agents/by-token/42.json',
            },
          };
        }
        throw new Error(`unexpected ${path_}`);
      },
      getRpcClients: async () => ({
        publicClient: {
          chain: { name: 'mainnet' },
          estimateGas: async () => 21000n,
          getGasPrice: async () => 1000000000n,
          waitForTransactionReceipt: async ({ hash }) => {
            waitedFor = hash;
            return { status: 'success' };
          },
        },
        walletClient: {
          sendTransaction: async (tx) => {
            sent += 1;
            sentTx = tx;
            return TX_HASH;
          },
        },
        account: { address: FROM },
      }),
      confirmAction: async () => {
        confirmed += 1;
      },
    };

    const result = await runRegister({
      ctx,
      options: { api: 'https://api.imd.fun', tokenId: '42', yes: true },
      shared,
    });

    assert.equal(result.agentId, '51495');
    assert.equal(result.txHash, TX_HASH);
    assert.equal(sent, 1);
    assert.equal(confirmed, 1);
    assert.equal(waitedFor, TX_HASH);
    assert.equal(result.plan.to, TO);
    assert.equal(result.plan.gas, '21000');
    assert.equal(sentTx.gas, 21000n);
    assert.equal(sentTx.gasPrice, 1000000000n);
    assert.equal(result.plan.gasPrice, String(sentTx.gasPrice));
    assert.equal(result.plan.maxFeeWei, String(sentTx.gas * sentTx.gasPrice));
    const saved = readRegistration(ctx, '42');
    assert.equal(saved.txHash, TX_HASH);
    assert.equal(saved.status, 'registered');
    assert.equal(saved.agentId, '51495');
  } finally {
    cleanup();
  }
});

test('--tx-hash resumes polling without sending another transaction', async () => {
  const { ctx, cleanup } = tempContext();
  try {
    let sent = 0;
    let confirmations = 0;
    const shared = {
      request: async (api, path_, options = {}) => {
        if (path_ === '/agents/bind') {
          if (options.body?.txHash) return { data: { tokenId: '42', agentId: '51495' } };
          return { data: { tokenId: '42', agentId: null, pending: true } };
        }
        throw new Error(`unexpected ${path_}`);
      },
      getRpcClients: async () => {
        throw new Error('must not build a transaction when resuming');
      },
      confirmAction: async () => {
        confirmations += 1;
      },
    };
    const result = await runRegister({
      ctx,
      options: { api: 'https://api.imd.fun', tokenId: '42', txHash: TX_HASH, yes: true },
      shared,
    });
    assert.equal(result.agentId, '51495');
    assert.equal(sent, 0);
    assert.equal(confirmations, 0);
    assert.equal(readRegistration(ctx, '42').txHash, TX_HASH);
  } finally {
    cleanup();
  }
});

test('a pending bind without --tx-hash stops before sending a new transaction', async () => {
  const { ctx, cleanup } = tempContext();
  try {
    const shared = {
      request: async (api, path_) => {
        if (path_ === '/agents/bind') {
          return { data: { tokenId: '42', agentId: null, pending: true } };
        }
        throw new Error(`unexpected ${path_}`);
      },
      getRpcClients: async () => {
        throw new Error('must not build a transaction while registration is pending');
      },
      confirmAction: async () => {
        throw new Error('must not confirm a new transaction while registration is pending');
      },
    };
    await assert.rejects(
      runRegister({
        ctx,
        options: { api: 'https://api.imd.fun', tokenId: '42', yes: true },
        shared,
      }),
      /registration already pending; no new transaction; retry later or resume with --tx-hash/,
    );
    assert.equal(readRegistration(ctx, '42'), null);
  } finally {
    cleanup();
  }
});

test('an interrupted send with no tx hash is not re-sent automatically', async () => {
  const { ctx, cleanup } = tempContext();
  try {
    saveRegistration(ctx, '42', { status: 'sending', chainId: 1, to: TO });
    const shared = {
      request: async () => ({ data: { tokenId: '42', agentId: null } }),
      getRpcClients: async () => {
        throw new Error('must not build another transaction');
      },
      confirmAction: async () => {},
    };
    await assert.rejects(
      runRegister({
        ctx,
        options: { api: 'https://api.imd.fun', tokenId: '42', yes: true },
        shared,
      }),
      /outcome is unknown/,
    );
  } finally {
    cleanup();
  }
});

test('a saved unconfirmed hash is not re-sent automatically', async () => {
  const { ctx, cleanup } = tempContext();
  try {
    saveRegistration(ctx, '42', { status: 'submitted', txHash: TX_HASH });
    let sent = 0;
    const shared = {
      request: async () => ({ data: { tokenId: '42', agentId: null } }),
      getRpcClients: async () => {
        throw new Error('must not build a transaction');
      },
      confirmAction: async () => {},
    };
    await assert.rejects(
      runRegister({
        ctx,
        options: { api: 'https://api.imd.fun', tokenId: '42', yes: true },
        shared,
      }),
      new RegExp(`--tx-hash ${TX_HASH}`),
    );
    assert.equal(sent, 0);
  } finally {
    cleanup();
  }
});
