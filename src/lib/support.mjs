import { createInterface } from 'node:readline/promises';
import { formatUnits } from 'viem';
import { orderPayment } from './payments.mjs';
import { SUPPORT_RECIPIENT } from './support-recipient.mjs';

export function supportChoices(state) {
  const payment = orderPayment(state);
  const base = BigInt(payment.amount);
  const amount = base / 10n;
  const display = n => formatUnits(n, payment.decimals) + ' IMD';
  return [
    { label: `${display(base + amount)} · Adds 10% optional support · Help us make Colony better.`, amount: String(amount), recipient: SUPPORT_RECIPIENT },
    { label: `${display(base)} · Original price`, amount: '0', recipient: SUPPORT_RECIPIENT },
  ];
}

// Interactive prompts highlight support; unattended runs never add it.
export const DEFAULT_SUPPORT_CHOICE = 0;

export async function selectSupport(state, options) {
  // A resumed signed funding plan must keep its original amounts and recipient.
  if (state.funding?.steps.some(step => step.rawTransaction)) return;
  const choices = supportChoices(state);
  let index = 1;
  if (options.chooseSupport) index = await options.chooseSupport(choices);
  else if (process.stdin.isTTY && !options.yes && !options.confirm) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await rl.question(`Choose payment:\n1. ${choices[0].label}\n2. ${choices[1].label}\nChoice [1]: `, { signal: options.signal });
      if (!['', '1', '2'].includes(answer.trim())) throw new Error('Payment selection cancelled.');
      index = answer.trim() === '2' ? 1 : 0;
    } finally { rl.close(); }
  }
  if (index !== 0 && index !== 1) throw new Error('Payment selection cancelled.');
  const { amount, recipient } = choices[index];
  state.support = { amount, recipient };
}

export function supportView(state) {
  if (!state.support || BigInt(state.support.amount) === 0n) return null;
  const payment = orderPayment(state);
  return {
    amount: formatUnits(BigInt(state.support.amount), payment.decimals),
    total: formatUnits(BigInt(payment.amount) + BigInt(state.support.amount), payment.decimals),
    recipient: state.support.recipient,
  };
}
