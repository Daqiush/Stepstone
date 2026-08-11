'use strict';

const ROOM = sessionStorage.getItem('ss_complex_roomId');
const SIDE = sessionStorage.getItem('ss_complex_side');
const NAME = sessionStorage.getItem('ss_complex_name');
if (!ROOM || !SIDE) window.location.href = 'index.html';

const socket = io();
const state = { side: SIDE, hands: {}, bids: {}, phase: null, currentTrick: [], nsTricks: 0, ewTricks: 0 };
let announcedContractKey = null;
let sawBidding = false;
const sideSeats = SIDE === 'NS' ? ['N', 'S'] : ['W', 'E'];
const sideName = SIDE === 'NS' ? '南北方（实部纵列将）' : '东西方（虚部横行将）';

document.body.classList.add(SIDE === 'NS' ? 'complex-ns' : 'complex-ew');

document.getElementById('complex-side').textContent = sideName;
const trickSelect = document.getElementById('complex-tricks');
for (let n = 7; n <= 13; n++) trickSelect.add(new Option(`${n} 墩`, n));
const trumpSelect = document.getElementById('complex-trump');
for (let n = 1; n <= 5; n++) trumpSelect.add(new Option(SIDE === 'NS' ? `实部 ${n}` : `虚部 ${n}i`, n));
document.getElementById('complex-bid-hint').textContent = `${sideName}：选择目标墩数和将牌；双方提交后同时揭晓。`;
document.getElementById('complex-submit-bid').onclick = () => socket.emit('complexBid', {
  tricks: Number(trickSelect.value),
  trump: { axis: SIDE === 'NS' ? 'real' : 'imag', value: Number(trumpSelect.value) },
});

socket.on('connect', () => {
  socket.emit('joinRoom', { roomId: ROOM, playerName: NAME });
  socket.emit('chooseSeat', { seat: SIDE === 'NS' ? 'N' : 'E', playerName: NAME });
});
socket.on('complexGameStart', applyState);
socket.on('complexState', applyState);
socket.on('complexGameEnd', showResult);
socket.on('appError', ({ msg }) => toast(msg));

function applyState(data) {
  const wasPlaying = state.phase === 'COMPLEX_PLAYING';
  Object.assign(state, data);
  if (state.phase === 'COMPLEX_BIDDING') sawBidding = true;
  render();
  const contractKey = state.contract && `${state.contract.side}:${state.contract.tricks}:${state.contract.trump.axis}:${state.contract.trump.value}`;
  if (state.phase === 'COMPLEX_PLAYING' && sawBidding && !wasPlaying && announcedContractKey !== contractKey) {
    announcedContractKey = contractKey;
    showContractModal(state.contract);
  }
}
function cardText(card) {
  if (card.kind === 'ace') return card.order === 'realFirst' ? 'A+Ai' : 'Ai+A';
  return card.kind === 'real' ? `${card.re}+${card.im}i` : `${card.im}i+${card.re}`;
}
function canPlay(seat) { return state.phase === 'COMPLEX_PLAYING' && state.currentPlayer === seat; }
function isTrumpCard(card) {
  const trump = state.contract?.trump;
  if (!trump) return false;
  if (card.kind === 'ace') return true;
  return trump.axis === 'real' ? card.re === trump.value : card.im === trump.value;
}
function suitOf(card) {
  if (isTrumpCard(card)) return state.contract.trump;
  return { axis: card.kind, value: card.kind === 'real' ? card.re : card.im };
}
function sameSuit(a, b) { return a && b && a.axis === b.axis && a.value === b.value; }
function activeSuit() { return state.currentTrick?.length ? suitOf(state.currentTrick[0].card) : null; }
function cardIsActive(card, active) {
  if (!active) return false;
  if (sameSuit(active, state.contract?.trump)) return isTrumpCard(card);
  if (isTrumpCard(card)) return false;
  return active.axis === 'real' ? card.re === active.value : card.im === active.value;
}
function cellIsActive(re, im, active) {
  if (!active) return false;
  if (sameSuit(active, state.contract?.trump)) return active.axis === 'real' ? re === active.value : im === active.value;
  if (state.contract?.trump?.axis === 'real' && re === state.contract.trump.value) return false;
  if (state.contract?.trump?.axis === 'imag' && im === state.contract.trump.value) return false;
  return active.axis === 'real' ? re === active.value : im === active.value;
}
function renderCard(seat, card) {
  const button = document.createElement('button');
  const cardDirection = card.kind === 'ace'
    ? (card.order === 'realFirst' ? 'real-card' : 'imag-card')
    : (card.kind === 'real' ? 'real-card' : 'imag-card');
  button.className = `complex-card ${cardDirection}` + (isTrumpCard(card) ? ' trump-card' : '') + (cardIsActive(card, activeSuit()) ? ' active-card' : '') + (canPlay(seat) ? ' playable' : '');
  button.textContent = cardText(card);
  button.title = canPlay(seat) ? '点击出牌' : cardText(card);
  if (canPlay(seat)) button.onclick = () => socket.emit('complexPlayCard', { seat, card });
  return button;
}
function renderHand(seat) {
  const hand = state.hands[seat] || [];
  const trump = state.contract?.trump || null;
  const active = activeSuit();
  const aces = hand.filter(c => c.kind === 'ace');
  const card = document.createElement('article');
  card.className = 'complex-hand' + (canPlay(seat) ? ' active' : '');
  card.innerHTML = `<h3>${seat} 手 ${canPlay(seat) ? '· 请出牌' : ''}</h3>`;
  const plane = document.createElement('div');
  plane.className = 'complex-plane' + (trump?.axis === 'real' ? ' trump-real' : trump?.axis === 'imag' ? ' trump-imag' : '');
  const makeCell = (re, im, slotAces = []) => {
    const cell = document.createElement('div');
    cell.className = 'complex-cell' + (slotAces.length ? ' trump-ace-slot' : '') + (cellIsActive(re, im, active) ? ' active-suit' : '');
    hand.filter(c => c.kind !== 'ace' && c.re === re && c.im === im).forEach(c => cell.append(renderCard(seat, c)));
    slotAces.forEach(c => cell.append(renderCard(seat, c)));
    return cell;
  };
  const makeSpacer = () => document.createElement('div');
  if (trump?.axis === 'real') {
    plane.append(document.createElement('div'));
    for (let re = 1; re <= 5; re++) {
      plane.append(re === trump.value && aces.length ? makeCell(re, 6, aces) : makeSpacer());
    }
  }
  for (let im = 5; im >= 1; im--) {
    const y = document.createElement('div'); y.className = 'complex-axis'; y.textContent = `${im}i`; plane.append(y);
    for (let re = 1; re <= 5; re++) {
      plane.append(makeCell(re, im));
    }
    if (trump?.axis === 'imag') {
      plane.append(im === trump.value && aces.length ? makeCell(6, im, aces) : makeSpacer());
    }
  }
  plane.append(document.createElement('div'));
  for (let re = 1; re <= 5; re++) { const label = document.createElement('div'); label.className = 'complex-axis'; label.textContent = re; plane.append(label); }
  if (trump?.axis === 'imag') plane.append(document.createElement('div'));
  card.append(plane);
  if (!trump && aces.length) { const box = document.createElement('div'); box.className = 'complex-aces'; aces.forEach(c => box.append(renderCard(seat, c))); card.append(box); }
  return card;
}
function render() {
  const waitingBid = state.phase === 'COMPLEX_BIDDING';
  const mineSubmitted = !!state.bids[SIDE];
  document.getElementById('complex-bid-panel').classList.toggle('hidden', !waitingBid || mineSubmitted);
  document.getElementById('complex-message').textContent = waitingBid
    ? (mineSubmitted ? '已提交，等待对方同时叫牌…' : '双方正在同时叫牌')
    : state.phase === 'COMPLEX_PLAYING' ? `第 ${(state.completedCount || 0) + 1} 墩 · ${state.currentPlayer} 出牌`
    : state.phase === 'COMPLEX_SCORING' ? '本局结束' : '等待游戏开始…';
  const c = state.contract;
  document.getElementById('complex-contract').textContent = c ? `庄方：${c.side} · ${c.tricks} 墩 · 将牌：${c.trump.axis === 'real' ? '实部' : '虚部'} ${c.trump.value}${c.trump.axis === 'imag' ? 'i' : ''}` : '';
  document.getElementById('complex-ns-wins').textContent = `南北 ${state.nsTricks || 0}`;
  document.getElementById('complex-ew-wins').textContent = `东西 ${state.ewTricks || 0}`;
  const trick = document.getElementById('complex-trick'); trick.replaceChildren();
  (state.currentTrick || []).forEach(({ seat, card }) => { const el = document.createElement('div'); el.className = 'complex-trick-card'; el.innerHTML = `<span class="complex-trick-seat">${seat}</span>${cardText(card)}`; trick.append(el); });
  const hands = document.getElementById('complex-hands');
  hands.classList.toggle('ew-layout', SIDE === 'EW');
  hands.replaceChildren(...sideSeats.map(renderHand));
}
function showResult(result) {
  const box = document.getElementById('complex-result'); box.classList.remove('hidden');
  box.innerHTML = `<div><h2>${result.made ? '成约' : '宕约'}</h2><p>${result.contract.side} 叫 ${result.contract.tricks} 墩，实际获得 ${result.declarerTricks} 墩。</p><p>南北 ${result.nsTricks} 墩 · 东西 ${result.ewTricks} 墩</p><button class="btn btn-primary" id="complex-next">再来一局</button></div>`;
  document.getElementById('complex-next').onclick = () => socket.emit('complexNextDeal');
}
function showContractModal(contract) {
  const modal = document.getElementById('complex-contract-modal');
  document.getElementById('complex-contract-modal-text').textContent = `${contract.side} 方成为庄方，定约为 ${contract.tricks} 墩；将牌为${contract.trump.axis === 'real' ? '实部' : '虚部'} ${contract.trump.value}${contract.trump.axis === 'imag' ? 'i' : ''}。`;
  modal.classList.remove('hidden');
  document.getElementById('complex-contract-ack').onclick = () => modal.classList.add('hidden');
}
function toast(message) { const el = document.getElementById('complex-toast'); el.textContent = message; el.classList.remove('hidden'); setTimeout(() => el.classList.add('hidden'), 2200); }
