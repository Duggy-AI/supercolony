import { coinAmount, friendlyAmount } from './payment-coins.mjs';
import { PAYMENT_NETWORKS, paymentNetwork } from './payment-networks.mjs';

const fundingError = funding => Object.assign(new Error(fundingInstructions(funding).join('\n')), { code: 'funding_required', funding });

export function fundingRequired(address, network, shortages, requirement) {
  const chainName = paymentNetwork(network).chain.name;
  const entry = { key: network, chainName, price: requirement?.price ?? requirement?.imd, support: requirement?.support,
    nativeBalance: requirement?.nativeBalance,
    options: requirement ? [{ ...requirement, funded: false, shortages }] : [], shortages };
  return fundingError({ address, network, chainName, shortages, networks: [entry] });
}

export function fundingRequiredOptions(address, networks) {
  return fundingError({ address, networks });
}

export function fundingNetworks(funding) {
  return funding.networks ?? [{ key: funding.network, chainName: funding.chainName, options: [], shortages: funding.shortages ?? [] }];
}

const missing = shortage => BigInt(shortage.required) - BigInt(shortage.balance);
// Prices and gas move between the check and the payment.
const withMargin = amount => (amount * 11n + 9n) / 10n;
const usable = network => (network.options ?? []).filter(option => !option.error && option.payment !== undefined);

function gasRange(network) {
  const gas = usable(network).map(option => BigInt(option.gas));
  if (!gas.length) return null;
  const low = gas.reduce((a, b) => a < b ? a : b);
  const high = gas.reduce((a, b) => a > b ? a : b);
  const text = friendlyAmount(low, 'ETH', { up: true });
  return { low, high, text: low === high ? text : text.replace(/ ETH$/, '') + ' to ' + friendlyAmount(high, 'ETH', { up: true }) };
}

function paymentText(option) {
  return (option.coin === 'IMD' ? '' : '≈ ') + friendlyAmount(option.payment, option.coin, { up: true });
}

const known = value => value !== null && value !== undefined;
const coversPayment = option => option.funded || !option.shortages?.some(shortage => shortage.coin === option.coin);

function balancesLine(network, gas) {
  const options = usable(network);
  const coins = options.filter(option => option.coin !== 'ETH' && known(option.balance)).map(option =>
    friendlyAmount(option.balance, option.coin) + (coversPayment(option) ? ' (enough)' : ''));
  const eth = options.find(option => option.coin === 'ETH');
  const native = network.nativeBalance ?? options.find(option => known(option.nativeBalance))?.nativeBalance;
  if (known(native)) {
    let mark = '';
    if (eth && coversPayment(eth)) mark = ' (enough)';
    else if (gas && BigInt(native) >= gas.high) mark = ' (enough for gas)';
    coins.push(friendlyAmount(native, 'ETH') + mark);
  }
  return coins.length ? '  You have: ' + coins.join(' · ') : null;
}

// One concrete instruction per network: the smallest single top-up that works.
export function quickestFix(network) {
  const candidates = usable(network).filter(option => option.shortages?.length);
  const gasOnly = candidates.filter(option => option.coin !== 'ETH' && option.shortages.every(shortage => shortage.coin === 'ETH'))
    .map(option => ({ option, amount: missing(option.shortages[0]) }))
    .sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
  if (gasOnly.length) {
    return 'Quickest: add about ' + friendlyAmount(withMargin(gasOnly[0].amount), 'ETH', { up: true })
      + ' for gas, then pay with your ' + gasOnly[0].option.coin + '.';
  }
  const eth = candidates.find(option => option.coin === 'ETH');
  const shortage = eth?.shortages.find(entry => entry.coin === 'ETH');
  if (shortage) return 'Simplest: send about ' + friendlyAmount(withMargin(missing(shortage)), 'ETH', { up: true }) + ', which covers both the payment and gas.';
  return null;
}

function shortageLines(network) {
  const others = network.shortages.some(shortage => shortage.coin !== 'ETH');
  return network.shortages.map(shortage => '  ' + (shortage.coin === 'ETH' && others ? 'ETH for gas' : shortage.coin)
    + ': you have ' + coinAmount(shortage.balance, shortage.coin) + ' · need ' + coinAmount(shortage.required, shortage.coin));
}

export function networkLines(network) {
  const support = network.support && BigInt(network.support) > 0n ? ' + ' + friendlyAmount(network.support, 'IMD', { up: true }) + ' optional support' : '';
  const heading = network.chainName.toUpperCase() + (network.price ? ' · task price ' + friendlyAmount(network.price, 'IMD', { up: true }) + support : '');
  if (network.error) return [heading, '  Not available right now: ' + network.error];
  const options = network.options ?? [];
  if (!options.length) return [heading, ...shortageLines(network)];
  const priced = usable(network).sort((a, b) => (a.coin === 'ETH') - (b.coin === 'ETH'));
  const gas = gasRange(network);
  const unrouted = options.filter(option => option.error).map(option => option.coin);
  const fix = quickestFix(network);
  const balances = balancesLine(network, gas);
  return [
    heading,
    '  ' + (priced.length > 1 ? 'Pay with any one: ' : 'Pay: ') + (priced.map(paymentText).join(' or ') || 'no coin available right now')
      + (unrouted.length ? ' (' + unrouted.join(', ') + ': no exchange route now)' : ''),
    '  Plus gas (network fee, always ETH): ' + (gas ? '≈ ' + gas.text : 'unavailable'),
    ...(balances ? [balances] : []),
    ...(fix ? ['  ' + fix] : []),
  ];
}

// Compact version for the receive screen and the network picker.
export function networkTargets(network) {
  const options = usable(network).sort((a, b) => (a.coin === 'ETH') - (b.coin === 'ETH'));
  if (!options.length) return [];
  const gas = gasRange(network);
  const fix = quickestFix(network);
  return [
    'Payment, any one of: ' + options.map(paymentText).join(' or '),
    'Gas, always ETH: ≈ ' + gas.text,
    ...(fix ? [fix] : []),
  ];
}

export function networkChoiceLabel(network) {
  if (network.error) return network.chainName + ' · not available right now';
  const coins = (network.options ?? []).filter(option => !option.error).map(option => option.coin);
  const gas = gasRange(network);
  const listed = coins.length > 1 ? coins.slice(0, -1).join(', ') + ' or ' + coins.at(-1) : coins[0];
  return network.chainName + (listed ? ' · pay with ' + listed : '') + (gas ? ' · gas ≈ ' + gas.text : '');
}

export function fundingInstructions(funding) {
  const networks = fundingNetworks(funding);
  const names = PAYMENT_NETWORKS.map(network => network.chain.name).join(' and ');
  return [
    (networks.length > 1 ? 'Not enough funds yet. Add funds on either network, then check again.'
      : 'Not enough funds on ' + networks[0].chainName + ' yet. Add funds, then check again.') + ' Amounts are estimates.',
    'Your wallet: ' + funding.address,
    'Same address on ' + names + '. Funds stay on the network you send them on.',
    ...networks.flatMap(network => ['', ...networkLines(network)]),
    ...(networks.some(network => network.support && BigInt(network.support) > 0n)
      ? ['', 'Includes the optional 10% support. Choose Original price when asked to pay only the task price.'] : []),
  ];
}
