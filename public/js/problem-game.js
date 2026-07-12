'use strict';
// ─── 做题模式前端逻辑 ───────────────────────────────────────────

const socket = io();

// ── 全局状态 ──────────────────────────────────────────────────
const G = {
  isOwner: false,
  roomId: null,
  // 游戏数据
  hands: { N: [], E: [], S: [], W: [] }, // 做题者看NS；旁观者额外看EW
  contract: null,
  tricksNeeded: 0,
  completedTricks: [],
  currentTrick: [],
  nsTricks: 0,
  ewTricks: 0,
  currentPlayer: null,
  leader: null,
  // 测试点
  totalTCs: 1,
  testCaseIdx: 0,
  // UI 状态
  selectedCard: null,   // { seat, card } 当前选中的牌
  activeSeat: null,     // 当前应操作哪个手牌区 ('N'|'S')
  // 记忆追踪（客户端）
  memoryUses: 0,
  viewedOldTricks: new Set(),
  // 计时
  startTime: null,
  timerHandle: null,
  // 记牌器计算基础数据
  playedCards: [],      // [{seat,card}] 所有已出过的牌（NS+EW）
  pendingTrickCollect: null, // 待收牌数据
  pendingTCPassed: null,     // 测试点通过数据（等收牌后弹窗）
  pendingGameEnd: null,      // 游戏结束数据（等收牌后显示）
};

// ── 工具 ──────────────────────────────────────────────────────
const SUITS = ['S', 'H', 'D', 'C']; // fallback; renderHand uses getSuitOrder()
const TRUMP_SUIT_ORDER = { S:['S','H','C','D'], H:['H','S','D','C'], D:['D','S','H','C'], C:['C','H','S','D'], NT:['S','H','C','D'] };
function getSuitOrder() { return TRUMP_SUIT_ORDER[G.contract && G.contract.suit] || ['S','H','C','D']; }
const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_COLOR  = { S: 'black', H: 'red', D: 'red', C: 'black' };
const RANK_LABEL  = { 14:'A', 13:'K', 12:'Q', 11:'J', 10:'T', 9:'9', 8:'8', 7:'7', 6:'6', 5:'5', 4:'4', 3:'3', 2:'2' };
const SEAT_LABEL  = { N:'北', E:'东', S:'南', W:'西' };
const SEATS_ORDER = ['N', 'E', 'S', 'W'];
const HONORS = [14, 13, 12, 11, 10]; // A K Q J T

function $(id) { return document.getElementById(id); }
function show(id) { $(id)?.classList.remove('hidden'); }
function hide(id) { $(id)?.classList.add('hidden'); }
function showScreen(name) {
  ['select','spectate','game','result'].forEach(s => {
    const el = $('screen-' + s);
    if (el) el.classList.toggle('hidden', s !== name);
  });
}

function rankLabel(r) { return RANK_LABEL[r] || r; }

function makeCardEl(suit, rank, clickFn) {
  const el = document.createElement('div');
  el.className = 'prob-card ' + (SUIT_COLOR[suit] === 'red' ? 'prob-card-red' : '');
  el.innerHTML = `<span class="prob-card-suit">${SUIT_SYMBOL[suit]}</span><span class="prob-card-rank">${rankLabel(rank)}</span>`;
  if (clickFn) el.addEventListener('click', clickFn);
  return el;
}

function makeBackEl() {
  const el = document.createElement('div');
  el.className = 'prob-card prob-card-back';
  el.textContent = '🂠';
  return el;
}

let toastTimer;
function showToast(msg, duration = 2500) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}

function setRoomDisplay() {
  const text = G.roomId || '---';
  const selectEl = $('prob-room-id-select');
  const topEl = $('prob-room-id-top');
  if (selectEl) selectEl.textContent = text;
  if (topEl) topEl.textContent = text;
}

function copyProbRoomId() {
  if (!G.roomId) return;
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    showToast(`房间号：${G.roomId}`);
    return;
  }
  navigator.clipboard.writeText(G.roomId)
    .then(() => showToast(`房间号 ${G.roomId} 已复制`))
    .catch(() => showToast(`房间号：${G.roomId}`));
}

function setOwnerMode(isOwner) {
  G.isOwner = !!isOwner;
  document.body.classList.toggle('prob-spectator', !G.isOwner);
  ['btn-history', 'btn-counter-suit', 'btn-counter-honor', 'btn-giveup', 'btn-retry', 'btn-back-select']
    .forEach(id => {
      const el = $(id);
      if (el) el.disabled = !G.isOwner;
    });
}

function rebuildPlayedCards() {
  G.playedCards = [];
  G.completedTricks.forEach(trick => {
    trick.cards.forEach(e => G.playedCards.push({ seat: e.seat, card: e.card }));
  });
  G.currentTrick.forEach(e => G.playedCards.push({ seat: e.seat, card: e.card }));
}

function applyProblemState(data, options = {}) {
  if (data.isOwner !== undefined) setOwnerMode(data.isOwner);
  G.contract        = data.contract;
  G.tricksNeeded    = data.tricksNeeded;
  G.totalTCs        = data.totalTCs || 1;
  G.testCaseIdx     = data.testCaseIdx || 0;
  G.hands.N         = data.hands.N;
  G.hands.S         = data.hands.S;
  G.hands.E         = data.spectatorHands?.E || [];
  G.hands.W         = data.spectatorHands?.W || [];
  G.completedTricks = data.completedTricks || [];
  G.currentTrick    = data.currentTrick || [];
  G.nsTricks        = data.nsTricks || 0;
  G.ewTricks        = data.ewTricks || 0;
  G.currentPlayer   = data.currentPlayer;
  G.leader          = data.leader || data.currentPlayer;
  G.memoryUses      = data.memoryUses || 0;
  G.selectedCard    = null;
  G.viewedOldTricks = new Set();
  G.pendingTCPassed = null;
  G.pendingGameEnd  = null;

  const c = data.contract;
  $('topbar-contract').textContent = `${c.level}${c.suit}${c.doubled?'X':c.redoubled?'XX':''} by ${c.declarer}`;
  $('topbar-vul').textContent = data.vulnerability || 'NONE';
  $('topbar-name').textContent = data.problemName || '';
  $('flavor-bg').textContent = data.flavorText || '';
  renderAuction(data.auction || []);

  rebuildPlayedCards();
  renderHand('N');
  renderHand('S');
  renderOpponentHand('E', data.handSizes.E);
  renderOpponentHand('W', data.handSizes.W);
  renderTrick(G.currentTrick);
  updateScores();
  updateActiveSeat();
  updateMemBadge();

  stopTimer();
  startTimer(data.startTime);
  setRoomDisplay();

  G.pendingTrickCollect = null;
  const overlay = $('trick-collect-overlay');
  if (overlay) overlay.classList.add('hidden');
  if (data.awaitingCollect && G.completedTricks.length > 0) {
    const trick = G.completedTricks[G.completedTricks.length - 1];
    G.pendingTrickCollect = {
      trick,
      nsTricks: G.nsTricks,
      ewTricks: G.ewTricks,
      completedCount: G.completedTricks.length,
    };
    G.currentTrick = trick.cards || [];
    renderTrick(G.currentTrick);
    if (overlay) {
      overlay.textContent = `${SEAT_LABEL[trick.winner]} 赢得此墩${G.isOwner ? ' — 点击任意位置收牌' : ' — 等待房主收牌'}`;
      overlay.classList.remove('hidden');
    }
  }

  if (!G.isOwner) {
    $('action-hint').textContent = options.spectatorHint || '旁观模式';
  }
  showScreen('game');
}

// ── 叫牌进程渲染 ──────────────────────────────────────────────
const SUIT_SYM = { S:'♠', H:'♥', D:'♦', C:'♣', NT:'NT' };
const SEAT_LABEL_CN = { N:'北', E:'东', S:'南', W:'西' };
const SEAT_ORDER = ['N','E','S','W'];

function bidHtml(bid) {
  if (bid === 'GARBLED') return `<span class="cg-bid-garbled"></span>`;
  if (bid === 'PASS') return `<span class="prob-auction-pass">PASS</span>`;
  if (bid === 'X')    return `<span class="prob-auction-bid">X</span>`;
  if (bid === 'XX')   return `<span class="prob-auction-bid">XX</span>`;
  const level = bid[0];
  const suitKey = bid.slice(1);
  const sym = SUIT_SYM[suitKey] || suitKey;
  const redSuits = new Set(['H','D']);
  const cls = redSuits.has(suitKey) ? 'prob-auction-suit-red' : 'prob-auction-bid';
  return `<span class="prob-auction-bid">${level}</span><span class="${cls}">${sym}</span>`;
}

function renderAuction(auction) {
  const panel = $('prob-mini-auction');
  const body  = $('prob-auction-body');
  if (!panel || !body) return;
  if (!auction || auction.length === 0) { panel.classList.add('hidden'); return; }

  const dealer = auction[0].seat;
  const startIdx = SEAT_ORDER.indexOf(dealer);

  let html = '<table class="prob-mini-auction-table"><thead><tr>';
  for (let i = 0; i < 4; i++) {
    html += `<th>${SEAT_LABEL_CN[SEAT_ORDER[(startIdx + i) % 4]]}</th>`;
  }
  html += '</tr></thead><tbody>';

  let row = ''; let colIdx = startIdx;
  auction.forEach(entry => {
    const col = SEAT_ORDER.indexOf(entry.seat);
    if (row === '' || col === startIdx) {
      if (row) html += `<tr>${row}</tr>`;
      row = '';
      if (col !== startIdx) {
        for (let i = startIdx; i !== col; i = (i + 1) % 4) row += '<td></td>';
      }
      colIdx = col;
    }
    row += `<td>${bidHtml(entry.bid)}</td>`;
    colIdx = (colIdx + 1) % 4;
  });
  if (row) {
    while (colIdx !== startIdx) { row += '<td></td>'; colIdx = (colIdx + 1) % 4; }
    html += `<tr>${row}</tr>`;
  }
  html += '</tbody></table>';

  body.innerHTML = html;
  body.scrollTop = body.scrollHeight;
  panel.classList.remove('hidden');
}

// ── 手牌渲染 ──────────────────────────────────────────────────
function renderHand(seat) {
  const container = $('cards-' + seat);
  if (!container) return;
  container.innerHTML = '';
  const hand = G.hands[seat];
  if (!hand || hand.length === 0) {
    container.innerHTML = '<span class="prob-empty-hand">（无牌）</span>';
    return;
  }

  // 按花色分组
  const groups = { S: [], H: [], D: [], C: [] };
  hand.forEach(c => groups[c.suit].push(c));
  getSuitOrder().forEach(suit => {
    groups[suit].sort((a, b) => b.rank - a.rank);
    if (groups[suit].length === 0) return;
    const groupEl = document.createElement('div');
    groupEl.className = 'prob-card-group';

    groups[suit].forEach(c => {
      const isActive = G.activeSeat === seat;
      const isSelected = G.selectedCard && G.selectedCard.seat === seat &&
                         G.selectedCard.card.suit === c.suit && G.selectedCard.card.rank === c.rank;
      const el = makeCardEl(c.suit, c.rank, isActive ? () => selectCard(seat, c) : null);
      if (isSelected) el.classList.add('prob-card-selected');
      if (!isActive) el.classList.add('prob-card-inactive');
      groupEl.appendChild(el);
    });
    container.appendChild(groupEl);
  });
}

function renderBacks(seat, count) {
  const container = $('backs-' + seat);
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < Math.min(count, 13); i++) {
    container.appendChild(makeBackEl());
  }
  const sizeEl = $('size-' + seat);
  if (sizeEl) sizeEl.textContent = count;
}

function renderVisibleOpponentHand(seat) {
  const container = $('backs-' + seat);
  if (!container) return;
  container.innerHTML = '';
  container.classList.add('prob-opponent-visible');
  const hand = G.hands[seat] || [];
  const groups = { S: [], H: [], D: [], C: [] };
  hand.forEach(c => groups[c.suit].push(c));
  getSuitOrder().forEach(suit => {
    groups[suit].sort((a, b) => b.rank - a.rank);
    if (groups[suit].length === 0) return;
    const groupEl = document.createElement('div');
    groupEl.className = 'prob-card-group';
    groups[suit].forEach(c => {
      const el = makeCardEl(c.suit, c.rank);
      el.classList.add('prob-card-inactive');
      groupEl.appendChild(el);
    });
    container.appendChild(groupEl);
  });
  const sizeEl = $('size-' + seat);
  if (sizeEl) sizeEl.textContent = hand.length;
}

function renderOpponentHand(seat, count) {
  if (!G.isOwner && G.hands[seat] && G.hands[seat].length > 0) {
    renderVisibleOpponentHand(seat);
    return;
  }
  const container = $('backs-' + seat);
  if (container) container.classList.remove('prob-opponent-visible');
  renderBacks(seat, count);
}

function renderTrick(trick) {
  SEATS_ORDER.forEach(seat => {
    const el = $('trick-' + seat);
    if (!el) return;
    el.innerHTML = '';
    const entry = trick.find(e => e.seat === seat);
    if (entry) {
      const c = entry.card;
      const cardEl = makeCardEl(c.suit, c.rank);
      el.appendChild(cardEl);
    }
  });
}

function updateScores() {
  $('score-ns').textContent = `NS: ${G.nsTricks}`;
  $('score-ew').textContent = `EW: ${G.ewTricks}`;
}

function updateActiveSeat() {
  const cur = G.currentPlayer;
  G.activeSeat = (cur === 'N' || cur === 'S') && G.isOwner ? cur : null;
  $('action-hint').textContent = G.activeSeat
    ? `轮到 ${SEAT_LABEL[cur]} 出牌`
    : (!G.isOwner && cur) ? `旁观模式 · ${SEAT_LABEL[cur]} 出牌`
    : (cur === 'E' || cur === 'W') ? `${SEAT_LABEL[cur]} 防守出牌中…` : '等待…';
  // 清除选中
  G.selectedCard = null;
  renderHand('N');
  renderHand('S');
}

function updateMemBadge() {
  const el = $('topbar-mem');
  if (!el) return;
  el.textContent = `MEM ${G.memoryUses}/3`;
  el.className = 'prob-mem-badge' +
    (G.memoryUses > 3 ? ' prob-mem-over' : G.memoryUses === 3 ? ' prob-mem-warn' : '');
}

// ── 计时器 ────────────────────────────────────────────────────
function startTimer(serverStartTime) {
  stopTimer();
  G.startTime = serverStartTime || Date.now();
  G.timerHandle = setInterval(() => {
    const s = Math.floor((Date.now() - G.startTime) / 1000);
    const el = $('topbar-timer');
    if (el) {
      el.textContent = s + 's';
      el.className = 'prob-timer' +
        (s > 400 ? ' prob-timer-over' : s >= 350 ? ' prob-timer-warn' : '');
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(G.timerHandle);
}

// ── 出牌交互 ──────────────────────────────────────────────────
// 单击直接出牌
function selectCard(seat, card) {
  if (G.activeSeat !== seat) return;
  if (G.pendingTrickCollect) return; // 待收牌时不许出牌
  playCard(seat, card);
}

function playCard(seat, card) {
  socket.emit('probPlayCard', { seat, card });
  G.selectedCard = null;
}

// ── 选题界面 ──────────────────────────────────────────────────
function renderProblemList(problems) {
  const list = $('prob-list');
  if (!list) return;
  list.innerHTML = '';
  if (!problems || problems.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);text-align:center">暂无题目</p>';
    return;
  }
  problems.forEach(p => {
    const item = document.createElement('div');
    item.className = 'prob-list-item';
    const suit = p.contract ? p.contract.suit : '?';
    const level = p.contract ? p.contract.level : '?';
    const declarer = p.contract ? p.contract.declarer : '?';
    item.innerHTML = `
      <div class="prob-list-id">${p.id}</div>
      <div class="prob-list-info">
        <div class="prob-list-name">${p.name || p.id}</div>
        <div class="prob-list-contract">${level}${suit} by ${declarer}</div>
      </div>
      <button class="btn btn-primary btn-sm prob-list-btn">开始</button>
    `;
    item.querySelector('button').addEventListener('click', () => {
      if (G.isOwner) socket.emit('probChooseProblem', { problemId: p.id });
      else showToast('只有房主可以选题');
    });
    list.appendChild(item);
  });
}

// ── 历史墩面板 ────────────────────────────────────────────────
function openHistory() {
  if (!G.isOwner) { showToast('旁观模式不能消耗记忆'); return; }
  // 展示过去已完成的墩
  const body = $('history-list');
  body.innerHTML = '';
  if (G.completedTricks.length === 0) {
    body.innerHTML = '<p style="color:var(--text-muted)">暂无历史墩</p>';
  } else {
    G.completedTricks.forEach((trick, idx) => {
      const isCurrent = (idx === G.completedTricks.length - 1);
      if (!isCurrent) {
        // 只有历史墩（非最新完成墩）才计入记忆使用
        if (!G.viewedOldTricks.has(idx)) {
          G.viewedOldTricks.add(idx);
          G.memoryUses++;
          updateMemBadge();
          socket.emit('probViewTrick', { trickIndex: idx });
        }
      }
      const row = document.createElement('div');
      row.className = 'prob-history-row';
      const cards = trick.cards.map(e =>
        `<span class="prob-hist-seat">${SEAT_LABEL[e.seat]}</span>
         <span class="prob-hist-card ${SUIT_COLOR[e.card.suit] === 'red' ? 'red' : ''}">${SUIT_SYMBOL[e.card.suit]}${rankLabel(e.card.rank)}</span>`
      ).join(' ');
      row.innerHTML = `<span class="prob-hist-idx">第${idx+1}墩</span> ${cards}
        <span class="prob-hist-winner">→ ${SEAT_LABEL[trick.winner]}赢</span>`;
      body.appendChild(row);
    });
  }
  openPanel('panel-history');
}

// ── 记牌器：剩余张数 ──────────────────────────────────────────
function openCounterSuit() {
  if (!G.isOwner) { showToast('旁观模式不能使用记牌器'); return; }
  G.memoryUses++;
  updateMemBadge();
  socket.emit('probOpenCounter', { counterType: 'suit' });

  // 计算防守方各花色剩余张数
  const body = $('counter-suit-body');
  body.innerHTML = '';

  SUITS.forEach(suit => {
    // 防守方剩余 = 13 - NS打出的此花色 - NS手中剩余此花色 - EW已打出的此花色
    const nsPlayed  = G.playedCards.filter(e => (e.seat==='N'||e.seat==='S') && e.card.suit===suit).length;
    const nsInHand  = [...G.hands.N, ...G.hands.S].filter(c => c.suit===suit).length;
    const ewPlayed  = G.playedCards.filter(e => (e.seat==='E'||e.seat==='W') && e.card.suit===suit).length;
    const remaining = 13 - nsPlayed - nsInHand - ewPlayed;

    const row = document.createElement('div');
    row.className = 'prob-counter-row';
    row.innerHTML = `
      <span class="prob-counter-suit ${SUIT_COLOR[suit]==='red'?'red':''}">${SUIT_SYMBOL[suit]}</span>
      <div class="prob-counter-bar-wrap">
        <div class="prob-counter-bar" style="width:${(remaining/13*100).toFixed(0)}%"></div>
      </div>
      <span class="prob-counter-num">${remaining}</span>
    `;
    body.appendChild(row);
  });

  openPanel('panel-counter-suit');
}

// ── 记牌器：大牌状态 ──────────────────────────────────────────
function openCounterHonor() {
  if (!G.isOwner) { showToast('旁观模式不能使用记牌器'); return; }
  G.memoryUses++;
  updateMemBadge();
  socket.emit('probOpenCounter', { counterType: 'honor' });

  const body = $('counter-honor-body');
  body.innerHTML = '';

  const nsCards = new Set(
    [...G.hands.N, ...G.hands.S].map(c => c.suit + c.rank)
  );
  const playedSet = new Set(G.playedCards.map(e => e.card.suit + e.card.rank));

  SUITS.forEach(suit => {
    const row = document.createElement('div');
    row.className = 'prob-honor-row';

    const suitLabel = document.createElement('span');
    suitLabel.className = 'prob-counter-suit ' + (SUIT_COLOR[suit]==='red'?'red':'');
    suitLabel.textContent = SUIT_SYMBOL[suit];
    row.appendChild(suitLabel);

    const cells = document.createElement('div');
    cells.className = 'prob-honor-cells';
    HONORS.forEach(rank => {
      const key = suit + rank;
      const inNS = nsCards.has(key);
      const played = playedSet.has(key);
      const inEW = !inNS && !played;
      const cell = document.createElement('span');
      cell.className = 'prob-honor-cell';
      if (inEW)  cell.classList.add('prob-honor-ew');
      if (inNS)  cell.classList.add('prob-honor-ns');
      if (played)cell.classList.add('prob-honor-played');
      cell.title = inEW ? '防守方持有' : inNS ? 'NS持有' : '已打出';
      cell.textContent = rankLabel(rank);
      cells.appendChild(cell);
    });
    row.appendChild(cells);
    body.appendChild(row);
  });

  const legend = document.createElement('div');
  legend.className = 'prob-honor-legend';
  legend.innerHTML = `
    <span class="prob-honor-cell prob-honor-ew">A</span> 防守方
    <span class="prob-honor-cell prob-honor-ns">A</span> NS持有
    <span class="prob-honor-cell prob-honor-played">A</span> 已打出
  `;
  body.appendChild(legend);

  openPanel('panel-counter-honor');
}

// ── 面板管理 ──────────────────────────────────────────────────
function openPanel(id) {
  show(id);
  show('panel-overlay');
}
function closePanel(id) {
  hide(id);
  hide('panel-overlay');
}
function closeAllPanels() {
  ['panel-history','panel-counter-suit','panel-counter-honor'].forEach(hide);
  hide('panel-overlay');
}

// ── 放弃 & 回大厅 ─────────────────────────────────────────────
function giveUp() {
  if (!G.isOwner) { showToast('旁观模式不能操作'); return; }
  if (confirm('确认放弃当前题目？结果将判为 WA。')) {
    socket.emit('probGiveUp');
  }
}
function backToSelect() {
  if (!G.isOwner) { showToast('旁观模式不能操作'); return; }
  socket.emit('probBackToSelect');
}
function retryProblem() {
  if (!G.isOwner) { showToast('旁观模式不能操作'); return; }
  socket.emit('probRetry');
}
function leaveToLobby() {
  socket.disconnect();
  window.location.href = '/';
}

// ── 结算界面 ──────────────────────────────────────────────────
const RESULT_INFO = {
  AC:  { label: 'AC', sub: 'Accepted', cls: 'result-ac',  msg: '恭喜！定约成功！' },
  WA:  { label: 'WA', sub: 'Wrong Answer', cls: 'result-wa',  msg: '定约失败。' },
  TLE: { label: 'TLE', sub: 'Time Limit Exceeded', cls: 'result-tle', msg: '超时（400秒）。' },
  MLE: { label: 'MLE', sub: 'Memory Limit Exceeded', cls: 'result-mle', msg: '查阅信息过多（超过3次）。' },
};

function showResult(data) {
  stopTimer();
  const info = RESULT_INFO[data.result] || RESULT_INFO.WA;
  const badge = $('result-badge');
  badge.textContent = info.label;
  badge.className = 'prob-result-badge ' + info.cls;

  const retryBtn = $('btn-retry');
  if (data.result !== 'AC') {
    retryBtn.classList.remove('hidden');
  } else {
    retryBtn.classList.add('hidden');
  }

  $('result-detail').innerHTML = `
    <div class="result-sub">${info.sub}</div>
    <div class="result-msg">${info.msg}</div>
    ${data.gaveUp ? '<div class="result-msg">（主动放弃）</div>' : ''}
  `;

  renderResultHands(data.initialHands, data.finalHands);
  renderResultTricks(data.completedTricks);

  showScreen('result');
}

function handToStr(hand, suit) {
  const cards = (hand || []).filter(c => c.suit === suit).sort((a,b) => b.rank - a.rank);
  if (cards.length === 0) return '<span class="result-void">—</span>';
  return cards.map(c => `<span>${RANK_LABEL[c.rank] || c.rank}</span>`).join('');
}

function handCellHtml(hand) {
  return ['S','H','D','C'].map(suit => {
    const color = (suit === 'H' || suit === 'D') ? ' red' : '';
    return `<div class="rh-suit${color}">${SUIT_SYMBOL[suit]}${handToStr(hand, suit)}</div>`;
  }).join('');
}

function renderResultHands(hands, finalHands) {
  const el = $('result-hands');
  if (!el) return;
  const h = finalHands || hands;
  if (!h) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="rh-compass">
      <div class="rh-cell rh-north"><div class="rh-seat-label">N</div>${handCellHtml(h.N)}</div>
      <div class="rh-cell rh-west" ><div class="rh-seat-label">W</div>${handCellHtml(h.W)}</div>
      <div class="rh-cell rh-east" ><div class="rh-seat-label">E</div>${handCellHtml(h.E)}</div>
      <div class="rh-cell rh-south"><div class="rh-seat-label">S</div>${handCellHtml(h.S)}</div>
    </div>`;
}

function renderResultTricks(tricks) {
  const el = $('result-tricks');
  if (!el || !tricks || tricks.length === 0) { if (el) el.innerHTML = ''; return; }
  const rows = tricks.map((t, i) => {
    const cards = t.cards.map(e => {
      const c = e.card;
      const color = (c.suit === 'H' || c.suit === 'D') ? ' red' : '';
      return `<span class="result-trick-card${color}">${SEAT_LABEL[e.seat]}${SUIT_SYMBOL[c.suit]}${RANK_LABEL[c.rank] || c.rank}</span>`;
    }).join('');
    const winColor = (t.winner === 'N' || t.winner === 'S') ? 'ns' : 'ew';
    return `<div class="result-trick-row"><span class="result-trick-num">第${i+1}墩</span>${cards}<span class="result-trick-win ${winColor}">→${SEAT_LABEL[t.winner]}</span></div>`;
  });
  el.innerHTML = `<div class="result-section-title">对局记录</div>` + rows.join('');
}

// ── 初始化 ────────────────────────────────────────────────────
(function init() {
  const ss = sessionStorage;
  G.roomId = ss.getItem('ss_prob_roomId');
  G.isOwner = ss.getItem('ss_prob_isOwner') === 'true';
  setRoomDisplay();
  const name = ss.getItem('ss_prob_name') || '玩家';

  if (!G.roomId) {
    // 没有房间信息，直接跳回大厅
    window.location.href = '/';
    return;
  }

  const ownerToken = ss.getItem('ss_prob_ownerToken') || null;
  socket.emit('joinRoom', { roomId: G.roomId, playerName: name, ownerToken });
})();

// ── Socket 事件 ───────────────────────────────────────────────

// 做题模式房间加入（可能是旁观者或房主）
socket.on('probRoomJoined', (data) => {
  // 判断是否房主
  setOwnerMode((socket.id === data.ownerSocketId) ||
               sessionStorage.getItem('ss_prob_isOwner') === 'true');
  setRoomDisplay();

  // 更新 token 为当前 socket.id，下次刷新时可再次验证
  if (G.isOwner) {
    sessionStorage.setItem('ss_prob_ownerToken', socket.id);
  }

  if (data.phase === 'PROB_SELECT') {
    renderProblemList(data.problems || []);
    $('select-hint').textContent = G.isOwner ? '选择一道题目开始练习' : '旁观模式 · 等待房主选题';
    showScreen('select');
  } else if (data.phase === 'PROB_PLAYING') {
    $('spec-title').textContent = '旁观中';
    $('spec-desc').textContent = `当前题目：${data.problemName || '未知'}`;
    showScreen('spectate');
  } else {
    showScreen('spectate');
  }
});

// 选题列表（房主开始后发来）
socket.on('probSelectStart', (data) => {
  renderProblemList(data.problems || []);
  $('select-hint').textContent = G.isOwner ? '选择一道题目开始练习' : '旁观模式 · 等待房主选题';
  closeAllPanels();
  setRoomDisplay();
  showScreen('select');
});

// 刷新/中途加入：房主恢复游戏状态，旁观者进入只读牌桌
socket.on('probReconnect', (data) => {
  if (data.isOwner) {
    sessionStorage.setItem('ss_prob_isOwner', 'true');
    sessionStorage.setItem('ss_prob_ownerToken', socket.id); // 更新 token
  } else {
    sessionStorage.setItem('ss_prob_isOwner', 'false');
  }
  applyProblemState(data, { spectatorHint: '旁观模式 · 正在观看当前题目' });
});

socket.on('probSpectatorHands', (data) => {
  if (G.isOwner || !data?.hands) return;
  G.hands.E = data.hands.E || [];
  G.hands.W = data.hands.W || [];
  renderOpponentHand('E', data.handSizes?.E ?? G.hands.E.length);
  renderOpponentHand('W', data.handSizes?.W ?? G.hands.W.length);
});

// 游戏开始（含 CG 阶段）
socket.on('probStart', (data) => {
  G.cgMode     = !!data.isCG;
  G.postCGMode = !!data.isPostCG;
  // 确保两个遮罩都关闭
  const overlay = $('cg-verdict-overlay');
  if (overlay) overlay.classList.add('hidden');
  const postOverlay = $('post-cg-verdict-overlay');
  if (postOverlay) postOverlay.classList.add('hidden');
  data.completedTricks = [];
  data.currentTrick = [];
  data.nsTricks = 0;
  data.ewTricks = 0;
  data.memoryUses = 0;
  data.startTime = Date.now();
  G.pendingTCPassed = null;
  G.pendingTrickCollect = null;
  G.pendingGameEnd = null;
  const _overlay = $('trick-collect-overlay');
  if (_overlay) _overlay.classList.add('hidden');

  applyProblemState(data, { spectatorHint: '旁观模式 · 正在观看当前题目' });
});

// 有牌被打出
socket.on('probCardPlayed', (data) => {
  G.currentTrick = data.currentTrick;
  // 记录已出牌
  const last = data.currentTrick[data.currentTrick.length - 1];
  G.playedCards.push({ seat: last.seat, card: last.card });

  // 更新本地手牌（若是N或S）
  const seat = last.seat;
  if (seat === 'N' || seat === 'S' || (!G.isOwner && (seat === 'E' || seat === 'W'))) {
    G.hands[seat] = G.hands[seat].filter(
      c => !(c.suit === last.card.suit && c.rank === last.card.rank)
    );
  }

  renderTrick(G.currentTrick);
  if (seat === 'N' || seat === 'S') renderHand(seat);
  if (seat === 'E') renderOpponentHand('E', data.handSizes.E);
  if (seat === 'W') renderOpponentHand('W', data.handSizes.W);

  G.currentPlayer = nextSeat(seat);
  updateActiveSeat();
});

// 一墩结束 —— 保留牌面，等待点击收牌
socket.on('probTrickEnd', (data) => {
  G.pendingTrickCollect = data; // 暂存，待点击后再结算

  const w = data.trick.winner;
  // 显示收牌提示覆盖层
  const overlay = $('trick-collect-overlay');
  if (overlay) {
    overlay.textContent = `${SEAT_LABEL[w]} 赢得此墩${G.isOwner ? ' — 点击任意位置收牌' : ' — 等待房主收牌'}`;
    overlay.classList.remove('hidden');
  }
});

function applyTrickCollected(data) {
  if (!data || !data.trick) return;
  if (data.completedCount && G.completedTricks.length >= data.completedCount) {
    G.pendingTrickCollect = null;
    if (G.currentTrick.length === 4) {
      G.currentTrick = [];
      G.currentPlayer = data.currentPlayer || data.trick.winner;
      G.leader = data.currentPlayer || data.trick.winner;
      renderTrick(G.currentTrick);
      updateActiveSeat();
    }
    const overlay = $('trick-collect-overlay');
    if (overlay) overlay.classList.add('hidden');
    return;
  }

  G.pendingTrickCollect = null;

  const overlay = $('trick-collect-overlay');
  if (overlay) overlay.classList.add('hidden');

  G.completedTricks.push(data.trick);
  G.nsTricks    = data.nsTricks;
  G.ewTricks    = data.ewTricks;

  // 若 probCardPlayed 已率先更新了新墩（length < 4），保留当前状态；
  // 否则本墩 4 张牌仍在显示，需清空并设置赢家为当前引牌者。
  if (G.currentTrick.length === 4) {
    G.currentTrick  = [];
    G.currentPlayer = data.trick.winner;
    G.leader        = data.trick.winner;
  }

  updateScores();
  renderTrick(G.currentTrick);
  updateActiveSeat();
}

// 收牌动作
function collectTrick() {
  if (!G.pendingTrickCollect) return;
  if (!G.isOwner) { showToast('等待房主收牌'); return; }
  const data = G.pendingTrickCollect;
  applyTrickCollected(data);

  // 通知服务端收牌（无论谁赢，服务端在此处做判断和推进）
  socket.emit('probTrickCollect');

  // 若有待处理的测试点通过通知，收牌后弹窗
  if (G.pendingTCPassed) {
    const tcData = G.pendingTCPassed;
    G.pendingTCPassed = null;
    showTCPassedDialog(tcData);
  }
}

socket.on('probTrickCollected', (data) => {
  applyTrickCollected(data);
});

// 测试点通过弹窗
function showTCPassedDialog(data) {
  const msg = `测试点 ${data.tcIdx + 1} / ${data.totalTCs} 通过！\n` +
              `换牌后进入测试点 ${data.nextTcIdx + 1}，继续。`;
  alert(msg);
  socket.emit('probTCAdvance');
}

// 出牌状态更新（当庄家赢墩需引出时）
socket.on('probPlayUpdate', (data) => {
  G.currentPlayer = data.currentPlayer;
  G.nsTricks      = data.nsTricks;
  G.ewTricks      = data.ewTricks;
  updateScores();
  updateActiveSeat();
  if (data.handSizes) {
    renderOpponentHand('E', data.handSizes.E);
    renderOpponentHand('W', data.handSizes.W);
  }
});

// 测试点通过（等收牌后再弹窗）
socket.on('probTCPassed', (data) => {
  if (G.pendingTrickCollect) {
    G.pendingTCPassed = data; // 有墩未收，先暂存
  } else {
    showTCPassedDialog(data); // 墩已收，直接弹窗
  }
});

// 新测试点开始（服务端回滚后推送）
socket.on('probTCStart', (data) => {
  G.testCaseIdx    = data.tcIdx;
  G.totalTCs       = data.totalTCs;
  G.hands.N        = data.hands.N;
  G.hands.S        = data.hands.S;
  if (!G.isOwner) { G.hands.E = []; G.hands.W = []; }
  G.nsTricks       = data.nsTricks;
  G.ewTricks       = data.ewTricks;
  G.currentPlayer  = data.currentPlayer;
  G.leader         = data.leader;
  G.currentTrick   = [];
  G.selectedCard   = null;
  G.pendingTrickCollect = null;
  G.pendingTCPassed = null;
  G.pendingGameEnd = null;
  G.memoryUses     = data.memoryUses ?? G.memoryUses;
  if (data.contract)     G.contract     = data.contract;
  if (data.tricksNeeded) G.tricksNeeded = data.tricksNeeded;

  // 截断 completedTricks 至分支点，重建 playedCards
  G.completedTricks = G.completedTricks.slice(0, data.completedCount);
  G.playedCards = [];
  G.completedTricks.forEach(trick => {
    trick.cards.forEach(e => G.playedCards.push({ seat: e.seat, card: e.card }));
  });

  renderHand('N');
  renderHand('S');
  renderOpponentHand('E', data.handSizes.E);
  renderOpponentHand('W', data.handSizes.W);
  renderTrick([]);
  updateScores();
  updateActiveSeat();
  updateMemBadge();
  const overlay = $('trick-collect-overlay');
  if (overlay) overlay.classList.add('hidden');
  if (data.startTime) startTimer(data.startTime);

  // 覆盖叫牌区（若本测试点有独立叫牌）
  if (data.auction) renderAuction(data.auction);
  // 测试点提示消息
  if (data.message) showToast(data.message, 4000);
  showScreen('game');
});

// 游戏结束（若有未收墩则延迟到收牌后显示）
socket.on('probGameEnd', (data) => {
  G.memoryUses = data.memoryUses;
  if (G.pendingTrickCollect) {
    G.pendingGameEnd = data;
  } else {
    showResult(data);
  }
});

// 记牌器确认（服务端已记录）
socket.on('probCounterAck', (data) => {
  G.memoryUses = data.memoryUses;
  updateMemBadge();
});

// CG 宕台遮罩
socket.on('probCGVerdictReady', () => {
  const overlay = $('cg-verdict-overlay');
  if (overlay) overlay.classList.remove('hidden');
});

function cgProceed() {
  const overlay = $('cg-verdict-overlay');
  if (overlay) overlay.classList.add('hidden');
  G.cgMode = false;
  socket.emit('probCGAck');
}

socket.on('probPostCGVerdictReady', ({ verdictText }) => {
  const overlay = $('post-cg-verdict-overlay');
  if (!overlay) return;
  const textEl = overlay.querySelector('.prob-post-cg-text');
  if (textEl) textEl.textContent = verdictText || '';
  overlay.classList.remove('hidden');
});

function postCGProceed() {
  const overlay = $('post-cg-verdict-overlay');
  if (overlay) overlay.classList.add('hidden');
  G.postCGMode = false;
  socket.emit('probPostCGAck');
}

// 错误提示
socket.on('appError', ({ msg }) => {
  showToast(msg);
  if (msg === '房间不存在') setTimeout(() => { window.location.href = '/'; }, 1500);
});

// ── 工具函数（轮序）─────────────────────────────────────────────
function nextSeat(s) {
  return SEATS_ORDER[(SEATS_ORDER.indexOf(s) + 1) % 4];
}
