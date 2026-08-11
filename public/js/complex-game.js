'use strict';

const ROOM = sessionStorage.getItem('ss_complex_roomId');
const SIDE = sessionStorage.getItem('ss_complex_side');
const NAME = sessionStorage.getItem('ss_complex_name');
if (!ROOM || !SIDE) window.location.href = 'index.html';

const socket = io();
const state = { side: SIDE, hands: {}, bids: {}, phase: null, currentTrick: [], nsTricks: 0, ewTricks: 0 };
const sideSeats = SIDE === 'NS' ? ['N', 'S'] : ['E', 'W'];
const sideName = SIDE === 'NS' ? '南北方（实部纵列将）' : '东西方（虚部横行将）';

document.getElementById('complex-side').textContent = sideName;
const trickSelect = document.getElementById('complex-tricks');
for (let n = 1; n <= 13; n++) trickSelect.add(new Option(`${n} 墩`, n));
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
  Object.assign(state, data);
  render();
}
function cardText(card) {
  if (card.kind === 'ace') return card.order === 'realFirst' ? 'A+Ai' : 'Ai+A';
  return card.kind === 'real' ? `${card.re}+${card.im}i` : `${card.im}i+${card.re}`;
}
function canPlay(seat) { return state.phase === 'COMPLEX_PLAYING' && state.currentPlayer === seat; }
function renderCard(seat, card) {
  const button = document.createElement('button');
  button.className = 'complex-card' + (canPlay(seat) ? ' playable' : '');
  button.textContent = cardText(card);
  button.title = canPlay(seat) ? '点击出牌' : cardText(card);
  if (canPlay(seat)) button.onclick = () => socket.emit('complexPlayCard', { seat, card });
  return button;
}
function renderHand(seat) {
  const hand = state.hands[seat] || [];
  const card = document.createElement('article');
  card.className = 'complex-hand' + (canPlay(seat) ? ' active' : '');
  card.innerHTML = `<h3>${seat} 手 ${canPlay(seat) ? '· 请出牌' : ''}</h3>`;
  const plane = document.createElement('div'); plane.className = 'complex-plane';
  plane.append(document.createElement('div'));
  for (let re = 1; re <= 5; re++) { const label = document.createElement('div'); label.className = 'complex-axis'; label.textContent = re; plane.append(label); }
  for (let im = 5; im >= 1; im--) {
    const y = document.createElement('div'); y.className = 'complex-axis'; y.textContent = `${im}i`; plane.append(y);
    for (let re = 1; re <= 5; re++) {
      const cell = document.createElement('div'); cell.className = 'complex-cell';
      hand.filter(c => c.kind !== 'ace' && c.re === re && c.im === im).forEach(c => cell.append(renderCard(seat, c)));
      plane.append(cell);
    }
  }
  card.append(plane);
  const aces = hand.filter(c => c.kind === 'ace');
  if (aces.length) { const box = document.createElement('div'); box.className = 'complex-aces'; aces.forEach(c => box.append(renderCard(seat, c))); card.append(box); }
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
  document.getElementById('complex-score').textContent = `南北 ${state.nsTricks || 0} · ${state.ewTricks || 0} 东西`;
  const trick = document.getElementById('complex-trick'); trick.replaceChildren();
  (state.currentTrick || []).forEach(({ seat, card }) => { const el = document.createElement('div'); el.className = 'complex-trick-card'; el.innerHTML = `<span class="complex-trick-seat">${seat}</span>${cardText(card)}`; trick.append(el); });
  const hands = document.getElementById('complex-hands'); hands.replaceChildren(...sideSeats.map(renderHand));
}
function showResult(result) {
  const box = document.getElementById('complex-result'); box.classList.remove('hidden');
  box.innerHTML = `<div><h2>${result.made ? '成约' : '宕约'}</h2><p>${result.contract.side} 叫 ${result.contract.tricks} 墩，实际获得 ${result.declarerTricks} 墩。</p><p>南北 ${result.nsTricks} 墩 · 东西 ${result.ewTricks} 墩</p><button class="btn btn-primary" id="complex-next">再来一局</button></div>`;
  document.getElementById('complex-next').onclick = () => socket.emit('complexNextDeal');
}
function toast(message) { const el = document.getElementById('complex-toast'); el.textContent = message; el.classList.remove('hidden'); setTimeout(() => el.classList.add('hidden'), 2200); }
