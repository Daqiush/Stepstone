/* ult-game.js — 大招模式客户端（含叫牌阶段、技能系统） */
'use strict';

const socket = io();

const MY_ROOM = sessionStorage.getItem('ss_roomId');
const MY_SEAT = sessionStorage.getItem('ss_seat');
const MY_NAME = sessionStorage.getItem('ss_name');

if (!MY_ROOM || !MY_SEAT) { window.location.href = '/'; }

// 每次连接/重连后重新加入房间，服务端会推送当前阶段状态
socket.on('connect', () => {
  socket.emit('joinRoom',   { roomId: MY_ROOM, playerName: MY_NAME });
  socket.emit('chooseSeat', { seat: MY_SEAT,   playerName: MY_NAME });
});

// ── 全局状态 ──────────────────────────────────────────────────────
const G = {
  seat:          MY_SEAT,
  hand:          [],
  handSizes:     { N: 0, E: 0, S: 0, W: 0 },
  playerNames:   {},
  characters:    {},
  currentPlayer: null,
  leader:        null,
  currentTrick:  [],
  completedCount: 0,
  nsTricks:      0,
  ewTricks:      0,
  selectedCard:  null,
  contract:      null,
  declarer:      null,
  vulnerability: 'NONE',
  // 叫牌
  biddingHistory: [],
  currentBidder: null,
  dealer:        null,
  // 技能
  availableSkills: [],      // 当前阶段可用技能
  peekCards:     [],        // 尽瘁：牌堆展示
  peekSelected:  [],        // 尽瘁：已选放回
  boostNextSpade: false,    // 董卓：是否对下一张♠加π
  hunluanPending: false,    // 张绣：等待选目标
};

const SEATS     = ['N', 'E', 'S', 'W'];
const SUIT_SYM  = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_CLS  = { S: 'suit-S', H: 'suit-H', D: 'suit-D', C: 'suit-C' };
const RANK_SYM  = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

const VUL_LABEL = { NONE: '无局', NS: 'NS有局', EW: 'EW有局', BOTH: '双方有局' };
const SUIT_BIDS = ['C', 'D', 'H', 'S', 'NT'];

// 角色基础信息（与 characters.json 同步，用于 UI 显示）
const CHAR_INFO = {
  liubei:     { name:'刘备',   faction:'蜀汉', desc:'仁德：叫牌结束送至多2张给同伴+1点' },
  zhugeliang: { name:'诸葛亮', faction:'蜀汉', desc:'尽瘁：窥牌堆顶7张；智哲：复制1张' },
  caocao:     { name:'曹操',   faction:'魏国', desc:'奸雄CD:2：输墩后与赢墩者互换所打的牌' },
  zhangliao:  { name:'张辽',   faction:'魏国', desc:'突袭：叫牌结束从两对手各随机夺1张' },
  sunquan:    { name:'孙权',   faction:'吴国', desc:'制衡：叫牌开始弃至多4张摸等量的牌' },
  lvmeng:     { name:'吕蒙',   faction:'吴国', desc:'克己CD:1：有牌时可打出PASS保留手牌' },
  dongzhuo:   { name:'董卓',   faction:'群雄', desc:'酒池CD:1：打♠时可+π点数（最大A）' },
  zhangxiu:   { name:'张绣',   faction:'群雄', desc:'雄乱CD:2：引出前令有牌角色本墩强制PASS' },
  liuxie:     { name:'刘协',   faction:'汉朝', desc:'密诏CD:2：叫牌结束将全手牌交给同伴' },
  hetaihou:   { name:'何太后', faction:'汉朝', desc:'戚乱CD:1：赢得击宕敌方那墩时摸3张' },
};
const SUIT_BID_SYM = { C: '♣', D: '♦', H: '♥', S: '♠', NT: 'NT' };
const SUIT_BID_CLS = { C: 'bid-c', D: 'bid-d', H: 'bid-h', S: 'bid-s', NT: 'bid-nt' };

// ── 工具 ────────────────────────────────────────────────────────
function $(id)  { return document.getElementById(id); }
function show(id) { const el = $(id); if (el) el.classList.remove('hidden'); }
function hide(id) { const el = $(id); if (el) el.classList.add('hidden'); }
function hidePhaseScreens() {
  ['ult-screen-char','ult-screen-bid-prep','ult-screen-bidding','ult-screen-bid-end'].forEach(hide);
}

function seatName(seat) {
  return G.playerNames[seat] || { N:'北', E:'东', S:'南', W:'西' }[seat];
}

// ── 视角旋转 ──────────────────────────────────────────────────────
// 视觉位置字母含义：S=底部(自己), N=顶部(同伴), E=右侧, W=左侧
// 无论实际坐席是哪个，自己始终显示在底部
const VIS_BASE = ['S', 'E', 'N', 'W']; // 顺时针偏移 0/1/2/3 → 视觉位置

function actualToVis(seat) {
  const diff = (SEATS.indexOf(seat) - SEATS.indexOf(G.seat) + 4) % 4;
  return VIS_BASE[diff];
}

function visToActual(vis) {
  const diff = VIS_BASE.indexOf(vis);
  return SEATS[(SEATS.indexOf(G.seat) + diff) % 4];
}


function rankLabel(rank) {
  if (rank === null || rank === undefined) return '';
  const s    = Number(rank).toFixed(6);
  const dot  = s.indexOf('.');
  const intStr  = s.slice(0, dot);
  const fracStr = s.slice(dot).replace(/\.?0+$/, ''); // 去掉尾部零，若全零则为空
  const intNum  = parseInt(intStr, 10);
  const prefix  = (intNum in RANK_SYM) ? RANK_SYM[intNum] : intStr;
  return prefix + fracStr; // e.g. "Q.857341" or "A" or "9.5"
}


function cardLabel(card) {
  if (!card || card.type === 'PASS') return 'PASS';
  return SUIT_SYM[card.suit] + rankLabel(card.rank);
}

function sideOf(seat) { return (seat === 'N' || seat === 'S') ? 'NS' : 'EW'; }
function partners(seat) { return seat === 'N' ? 'S' : seat === 'S' ? 'N' : seat === 'E' ? 'W' : 'E'; }

function toast(msg, ms = 2500) {
  const el = $('ult-toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function logMsg(msg) {
  const el = $('ult-log');
  const line = document.createElement('div');
  line.className = 'ult-log-line';
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 60) el.removeChild(el.firstChild);
}

// ══════════════════════════════════════════════════════════════════
// PHASE 1: 选角色
// ══════════════════════════════════════════════════════════════════
socket.on('ultCharOptions', data => {
  hidePhaseScreens();
  G.playerNames   = data.playerNames;
  G.vulnerability = data.vulnerability || 'NONE';
  G.dealer        = data.dealer;
  G.characters    = {};

  $('ult-char-vul').textContent = `${VUL_LABEL[G.vulnerability]} · 庄位：${data.dealer}`;

  const opts = data.seatOptions?.[G.seat] || [];
  const grid = $('ult-char-options');
  grid.innerHTML = '';

  if (opts.length === 0) {
    // 观战或座位未分配
    $('ult-char-wait').textContent = '等待游戏开始…';
    show('ult-char-wait');
  } else {
    hide('ult-char-wait');
    for (const charId of opts) {
      const info = CHAR_INFO[charId] || { name: charId, faction: '', desc: '' };
      const btn = document.createElement('button');
      btn.className = 'ult-char-opt-btn';
      btn.dataset.charid = charId;
      btn.innerHTML = `<span class="ult-opt-name">${info.name}</span>
        <span class="ult-opt-faction">${info.faction}</span>
        <span class="ult-opt-desc">${info.desc}</span>`;
      btn.onclick = () => chooseChar(charId);
      grid.appendChild(btn);
    }
  }
  show('ult-screen-char');
});

function chooseChar(charId) {
  socket.emit('ultCharChoice', { charId });
  $('ult-char-options').innerHTML = '';
  $('ult-char-wait').textContent = '已选择，等待其他玩家…';
  show('ult-char-wait');
}

socket.on('ultCharChosen', data => {
  G.characters[data.seat] = data.charId;
  const displayName = data.charName || CHAR_INFO[data.charId]?.name || data.charId;
  const el = $('ult-char-' + data.seat);
  if (el) { el.textContent = displayName; el.title = displayName; }
  if (data.seat === G.seat) {
    document.querySelectorAll('.ult-char-opt-btn').forEach(b => {
      b.classList.toggle('chosen', b.dataset.charid === data.charId);
    });
  }
});

// ══════════════════════════════════════════════════════════════════
// PHASE 2: 叫牌准备
// ══════════════════════════════════════════════════════════════════
socket.on('ultBidPrepStart', data => {
  G.hand           = data.hand;
  G.handSizes      = data.handSizes;
  G.playerNames    = data.playerNames;
  G.characters     = data.characters;
  G.availability   = data.availableSkills || [];
  G.vulnerability  = data.vulnerability || 'NONE';
  G.dealer         = data.dealer;

  hidePhaseScreens();
  hide('ult-peek-panel');

  $('ult-bid-prep-vul').textContent = VUL_LABEL[G.vulnerability];

  renderPhaseHand('ult-bid-prep-hand', G.hand, false);
  renderSkillList('ult-bid-prep-skills', data.availableSkills || [], 'prep');
  $('ult-bid-prep-ready-status').textContent = '';
  show('ult-screen-bid-prep');
  updateNameplates();
});

// 技能队列：轮到谁（广播给所有人）
socket.on('ultSkillTurn', data => {
  const isMine = data.currentSeat === G.seat;
  const name   = seatName(data.currentSeat);
  const statusEl = data.trigger === 'bid_start'
    ? $('ult-bid-prep-ready-status')
    : $('ult-bid-end-ready-status');
  if (statusEl) {
    statusEl.textContent = isMine ? '▶ 轮到你选择技能（或跳过）' : `等待 ${name} 选择技能…`;
    statusEl.style.color = isMine ? 'var(--ult-gold)' : '';
  }
  // 如果不是自己，隐藏技能按钮并隐藏跳过按钮
  if (!isMine) {
    const skillsEl = data.trigger === 'bid_start'
      ? $('ult-bid-prep-skills') : $('ult-bid-end-skills');
    if (skillsEl) skillsEl.innerHTML = '';
    const skipEl = $('ult-btn-skill-skip');
    if (skipEl) skipEl.classList.add('hidden');
  }
});

// 技能队列：轮到自己（仅发给当前玩家）
socket.on('ultSkillYourTurn', data => {
  if (data.hand) { G.hand = data.hand; renderBidHand(); }
  G.availableSkills = data.availableSkills || [];

  const isBidEnd = data.trigger === 'bid_end';

  if (isBidEnd) {
    renderSkillList('ult-bid-end-skills', G.availableSkills, 'end');
    renderPhaseHand('ult-bid-end-hand', G.hand, false);
    // 确保叫牌结束屏幕是可见的
    show('ult-screen-bid-end');
  } else {
    renderSkillList('ult-bid-prep-skills', G.availableSkills, 'prep');
    renderPhaseHand('ult-bid-prep-hand', G.hand, false);
  }

  // 显示对应阶段的跳过按钮
  const skipId = isBidEnd ? 'ult-btn-skill-skip-end' : 'ult-btn-skill-skip';
  const skipEl = $(skipId);
  if (skipEl) skipEl.classList.remove('hidden');
});

function skipSkill() {
  socket.emit('ultSkillSkip');
  ['ult-btn-skill-skip', 'ult-btn-skill-skip-end'].forEach(id => {
    const el = $(id);
    if (el) el.classList.add('hidden');
  });
}

// 已使用技能后服务端通知（清空技能列表，等待下一个队列步骤）
socket.on('ultSkillUsed', () => {
  G.availableSkills = [];
  const prepVisible = !$('ult-screen-bid-prep')?.classList.contains('hidden');
  const endVisible  = !$('ult-screen-bid-end')?.classList.contains('hidden');
  if (prepVisible) { renderSkillList('ult-bid-prep-skills', [], 'prep'); }
  if (endVisible)  { renderSkillList('ult-bid-end-skills',  [], 'end');  }
  hide('ult-peek-panel');
  ['ult-btn-skill-skip', 'ult-btn-skill-skip-end'].forEach(id => {
    const el = $(id);
    if (el) el.classList.add('hidden');
  });
});

// ── 尽瘁：牌堆预览 ──────────────────────────────────────────────
socket.on('ultBidPeekCards', data => {
  G.peekCards    = data.cards || [];
  G.peekSelected = [];
  renderPeekPanel();
  show('ult-peek-panel');
});

function renderPeekPanel() {
  const pool = $('ult-peek-cards');
  const order = $('ult-peek-ordered');
  pool.innerHTML = '';
  order.innerHTML = '';

  for (const [i, card] of G.peekCards.entries()) {
    const btn = document.createElement('button');
    btn.className = 'ult-card ' + SUIT_CLS[card.suit];
    const isSelected = G.peekSelected.some(c => c.suit === card.suit && Math.abs(c.rank - card.rank) < 1e-9);
    if (isSelected) btn.classList.add('selected');
    btn.textContent = SUIT_SYM[card.suit] + rankLabel(card.rank);
    btn.dataset.idx = i;
    btn.onclick = () => togglePeekCard(i);
    pool.appendChild(btn);
  }

  for (const [j, card] of G.peekSelected.entries()) {
    const div = document.createElement('div');
    div.className = 'ult-card ' + SUIT_CLS[card.suit] + ' selected';
    div.textContent = SUIT_SYM[card.suit] + rankLabel(card.rank);
    div.style.cursor = 'pointer';
    div.onclick = () => removePeekSelected(j);
    order.appendChild(div);
  }
}

function togglePeekCard(idx) {
  const card = G.peekCards[idx];
  const already = G.peekSelected.findIndex(c => c.suit === card.suit && Math.abs(c.rank - card.rank) < 1e-9);
  if (already >= 0) {
    G.peekSelected.splice(already, 1);
  } else {
    G.peekSelected.push({ ...card });
  }
  renderPeekPanel();
}

function removePeekSelected(j) {
  G.peekSelected.splice(j, 1);
  renderPeekPanel();
}

function confirmPeek() {
  socket.emit('ultBidPrepPeekResp', { skillId: 'zgl_jincui', kept: G.peekSelected });
  G.peekCards = [];
  G.peekSelected = [];
  hide('ult-peek-panel');
}

function cancelPeek() {
  socket.emit('ultBidPrepPeekResp', { skillId: 'zgl_jincui', kept: [] });
  G.peekCards = [];
  G.peekSelected = [];
  hide('ult-peek-panel');
}

// ══════════════════════════════════════════════════════════════════
// PHASE 3: 叫牌
// ══════════════════════════════════════════════════════════════════
socket.on('ultBidPhaseStart', data => {
  G.dealer        = data.dealer;
  G.vulnerability = data.vulnerability || 'NONE';
  G.playerNames   = data.playerNames;
  G.characters    = data.characters;
  G.biddingHistory = [];

  hidePhaseScreens();
  $('ult-bid-vul').textContent   = VUL_LABEL[G.vulnerability];
  $('ult-bid-dealer').textContent = data.dealer;
  renderBidHand();
  renderBidHistory([]);
  renderBidButtons({}, null);
  $('ult-bid-contract').textContent = '';
  $('ult-bid-turn').textContent = '';
  show('ult-screen-bidding');
});

// 复用 biddingUpdate 事件（服务端同 classic 一样发）
socket.on('biddingUpdate', data => {
  G.biddingHistory = data.biddingHistory || [];
  G.currentBidder  = data.currentBidder;

  // 如果自己的手牌包含在 data 里，更新（bid_start 技能可能改变了手牌）
  if (data.hand) { G.hand = data.hand; renderBidHand(); }

  const cc = data.currentContract;
  renderBidHistory(G.biddingHistory);
  renderBidButtons(data.validBids || {}, cc);

  const isMine = G.currentBidder === G.seat;
  $('ult-bid-turn').textContent = isMine ? '▶ 轮到你叫牌！' : `等待 ${seatName(G.currentBidder)} 叫牌`;
  $('ult-bid-turn').className   = 'ult-bid-turn-label' + (isMine ? ' my-turn' : '');

  if (cc) {
    const sStr = SUIT_BID_SYM[cc.suit] || cc.suit;
    const dStr = cc.doubled ? ' X' : cc.redoubled ? ' XX' : '';
    $('ult-bid-contract').innerHTML = `当前定约：<strong>${cc.level}${sStr}${dStr}</strong>（${seatName(cc.seat)}）`;
  } else {
    $('ult-bid-contract').textContent = '尚无定约';
  }
});

socket.on('biddingEnd', data => {
  G.contract = data.contract;
  G.declarer = data.declarer;
  // 叫牌结束，进入叫牌结束技能阶段（由 ultBidEndStart 触发）
});

function renderBidHand() {
  const container = $('ult-bid-hand');
  container.innerHTML = '';
  const groups = { S: [], H: [], D: [], C: [] };
  for (const c of G.hand) { if (c.suit in groups) groups[c.suit].push(c); }
  for (const suit of ['S', 'H', 'D', 'C']) {
    if (!groups[suit].length) continue;
    groups[suit].sort((a, b) => b.rank - a.rank);
    const grp = document.createElement('div');
    grp.className = 'ult-suit-group';
    const sl = document.createElement('span');
    sl.className = 'ult-suit-label ' + SUIT_CLS[suit];
    sl.textContent = SUIT_SYM[suit];
    grp.appendChild(sl);
    for (const card of groups[suit]) {
      const span = document.createElement('span');
      span.className = 'ult-card-static ' + SUIT_CLS[card.suit];
      span.textContent = rankLabel(card.rank);
      grp.appendChild(span);
    }
    container.appendChild(grp);
  }
}

function renderBidHistory(history) {
  const thead = $('ult-bid-hist-header');
  const tbody = $('ult-bid-hist-body');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  // 表头：从庄位开始按 N/E/S/W 顺序（NESW顺序）
  const order = ['N','E','S','W'];
  for (const s of order) {
    const th = document.createElement('th');
    th.textContent = seatName(s);
    th.className = (s === G.seat) ? 'bid-hist-me' : '';
    thead.appendChild(th);
  }

  if (!history || !history.length) return;
  // 找庄位起点
  const dealerIdx = order.indexOf(G.dealer || 'N');

  let rowEl = document.createElement('tr');
  // 填充庄位之前的空格
  for (let i = 0; i < dealerIdx; i++) rowEl.appendChild(document.createElement('td'));

  for (const entry of history) {
    const td = document.createElement('td');
    const cls = getBidClass(entry.bid);
    td.innerHTML = `<span class="${cls}">${formatBid(entry.bid)}</span>`;
    rowEl.appendChild(td);

    if (rowEl.children.length === 4) {
      tbody.appendChild(rowEl);
      rowEl = document.createElement('tr');
    }
  }
  if (rowEl.children.length > 0) tbody.appendChild(rowEl);

  $('ult-bid-history-wrap').scrollTop = $('ult-bid-history-wrap').scrollHeight;
}

function getBidClass(bid) {
  if (bid === 'Pass') return 'bid-pass';
  if (bid === 'Double') return 'bid-x';
  if (bid === 'Redouble') return 'bid-xx';
  const suit = bid.slice(1);
  return SUIT_BID_CLS[suit] || '';
}

function formatBid(bid) {
  if (bid === 'Pass') return 'Pass';
  if (bid === 'Double') return 'X';
  if (bid === 'Redouble') return 'XX';
  const level = bid[0];
  const suit  = bid.slice(1);
  return level + (SUIT_BID_SYM[suit] || suit);
}

function renderBidButtons(validBids, cc) {
  const wrap = $('ult-bid-buttons');
  wrap.innerHTML = '';
  const isMine = G.currentBidder === G.seat;

  // Pass 按钮
  const passBtn = document.createElement('button');
  passBtn.className = 'btn ult-bid-btn bid-pass-btn';
  passBtn.textContent = 'Pass';
  passBtn.disabled = !isMine;
  passBtn.onclick = () => placeBid('Pass');
  wrap.appendChild(passBtn);

  // X / XX
  if (cc) {
    const xBtn = document.createElement('button');
    xBtn.className = 'btn ult-bid-btn bid-x-btn';
    xBtn.textContent = 'X';
    xBtn.disabled = !isMine || validBids['Double'] === false;
    xBtn.onclick = () => placeBid('Double');
    wrap.appendChild(xBtn);

    const xxBtn = document.createElement('button');
    xxBtn.className = 'btn ult-bid-btn bid-xx-btn';
    xxBtn.textContent = 'XX';
    xxBtn.disabled = !isMine || validBids['Redouble'] === false;
    xxBtn.onclick = () => placeBid('Redouble');
    wrap.appendChild(xxBtn);
  }

  // 叫品按钮（1C~7NT）
  const grid = document.createElement('div');
  grid.className = 'ult-bid-grid';
  for (let level = 1; level <= 7; level++) {
    for (const suit of SUIT_BIDS) {
      const bidStr = `${level}${suit}`;
      const btn = document.createElement('button');
      btn.className = `btn ult-bid-btn ${SUIT_BID_CLS[suit]}`;
      btn.textContent = level + (SUIT_BID_SYM[suit]);
      btn.disabled = !isMine; // server validates anyway
      btn.onclick = () => placeBid(bidStr);
      grid.appendChild(btn);
    }
  }
  wrap.appendChild(grid);
}

function placeBid(bid) {
  socket.emit('bid', { bid });
}

// ══════════════════════════════════════════════════════════════════
// PHASE 4: 叫牌结束技能
// ══════════════════════════════════════════════════════════════════
socket.on('ultBidEndStart', data => {
  G.hand           = data.hand;
  G.playerNames    = data.playerNames;
  G.characters     = data.characters;
  G.availableSkills = data.availableSkills || [];
  G.contract       = data.contract;
  G.declarer       = data.declarer;

  hidePhaseScreens();

  // 显示定约
  if (G.contract) {
    const cc = G.contract;
    const sStr = SUIT_BID_SYM[cc.suit] || cc.suit;
    $('ult-bid-end-contract').innerHTML =
      `定约：<strong>${cc.level}${sStr}${cc.doubled?'X':cc.redoubled?'XX':''}</strong> 由 ${seatName(G.declarer)} 主打`;
  }

  renderPhaseHand('ult-bid-end-hand', G.hand, false);
  renderSkillList('ult-bid-end-skills', data.availableSkills || [], 'end');
  $('ult-bid-end-ready-status').textContent = '';
  show('ult-screen-bid-end');
});


// ══════════════════════════════════════════════════════════════════
// PHASE 5: 出牌
// ══════════════════════════════════════════════════════════════════
socket.on('ultGameStart', data => {
  G.seat          = data.seat;
  G.hand          = data.hand;
  G.handSizes     = data.handSizes;
  G.playerNames   = data.playerNames;
  G.characters    = data.characters || {};
  G.currentPlayer = data.currentPlayer;
  G.leader        = data.leader;
  G.contract      = data.contract || null;
  G.declarer      = data.declarer || null;
  G.vulnerability = data.vulnerability || 'NONE';
  G.currentTrick  = [];
  G.completedCount = 0;
  G.nsTricks      = 0;
  G.ewTricks      = 0;
  G.selectedCard  = null;
  G.boostNextSpade = false;
  G.hunluanPending = false;
  G.playSkills     = data.playSkills || [];

  hidePhaseScreens();
  hide('ult-modal-end');
  updateNameplates();
  renderHand();
  renderAllHandBacks();
  renderTrick();
  updateTopBar();
  updateTurnLabel();
  updateContractBar();
});

// ── 渲染手牌（出牌阶段）──────────────────────────────────────────
function renderHand() {
  const container = $('ult-hand-self');
  container.innerHTML = '';

  const groups = { S: [], H: [], D: [], C: [] };
  for (const c of G.hand) { if (c.suit in groups) groups[c.suit].push(c); }

  for (const suit of ['S', 'H', 'D', 'C']) {
    if (!groups[suit].length) continue;
    groups[suit].sort((a, b) => b.rank - a.rank);
    const grpDiv = document.createElement('div');
    grpDiv.className = 'ult-suit-group';
    const suitSpan = document.createElement('span');
    suitSpan.className = 'ult-suit-label ' + SUIT_CLS[suit];
    suitSpan.textContent = SUIT_SYM[suit];
    grpDiv.appendChild(suitSpan);

    for (const card of groups[suit]) {
      const btn = document.createElement('button');
      btn.className = 'ult-card ' + SUIT_CLS[card.suit];
      const isSelected = G.selectedCard &&
        G.selectedCard.suit === card.suit &&
        Math.abs(G.selectedCard.rank - card.rank) < 1e-9;
      if (isSelected) btn.classList.add('selected');
      btn.dataset.suit = card.suit;
      btn.dataset.rank = card.rank;
      btn.textContent = rankLabel(card.rank);
      btn.onclick = () => selectCard(card);
      grpDiv.appendChild(btn);
    }
    container.appendChild(grpDiv);
  }

  // 出牌行
  if (G.currentPlayer === G.seat) {
    const row = document.createElement('div');
    row.className = 'ult-action-row';

    const hasSkill = id => G.playSkills?.some(sk => sk.id === id);

    // 张绣 雄乱：仅当自己引出（currentTrick 为空）
    if (G.currentTrick.length === 0 && hasSkill('zhangxiu_hunluan')) {
      const hlBtn = document.createElement('button');
      hlBtn.className = 'btn btn-ghost ult-skill-play-btn';
      hlBtn.textContent = '雄乱';
      hlBtn.onclick = () => openHunluan();
      row.appendChild(hlBtn);
    }

    // 吕蒙 克己：有牌时可 PASS
    if (hasSkill('lvmeng_keji') && G.hand.length > 0) {
      const kjBtn = document.createElement('button');
      kjBtn.className = 'btn btn-ghost ult-skill-play-btn';
      kjBtn.textContent = '克己PASS';
      kjBtn.onclick = () => playKeji();
      row.appendChild(kjBtn);
    }

    if (G.selectedCard) {
      // 董卓 酒池：选中♠且有技能时
      if (G.selectedCard.suit === 'S' && hasSkill('dongzhuo_jiuchi')) {
        const boostBtn = document.createElement('button');
        boostBtn.className = 'btn ult-skill-play-btn ' + (G.boostNextSpade ? 'btn-primary' : 'btn-ghost');
        boostBtn.textContent = G.boostNextSpade ? '酒池+π ✓' : '酒池+π';
        boostBtn.onclick = () => { G.boostNextSpade = !G.boostNextSpade; renderHand(); };
        row.appendChild(boostBtn);
      }

      const playBtn = document.createElement('button');
      playBtn.id = 'ult-btn-play';
      playBtn.className = 'btn btn-primary ult-play-btn';
      playBtn.textContent = '出牌：' + cardLabel(G.selectedCard) + (G.boostNextSpade && G.selectedCard.suit === 'S' ? '＋π' : '');
      playBtn.onclick = confirmPlay;
      row.appendChild(playBtn);
    }

    container.appendChild(row);
  }
}


function selectCard(card) {
  if (G.currentPlayer !== G.seat) { toast('还没到你出牌'); return; }
  if (G.selectedCard &&
      G.selectedCard.suit === card.suit &&
      Math.abs(G.selectedCard.rank - card.rank) < 1e-9) {
    confirmPlay(); return;
  }
  if (card.suit !== 'S') G.boostNextSpade = false;
  G.selectedCard = card;
  renderHand();
}

function confirmPlay() {
  if (!G.selectedCard) return;
  socket.emit('ultPlayCard', { card: G.selectedCard, boostSpade: G.boostNextSpade && G.selectedCard.suit === 'S' });
  G.selectedCard = null;
  G.boostNextSpade = false;
}

function playKeji() {
  socket.emit('ultPlayCard', { card: { type: 'PASS' }, skillOverride: 'lvmeng_keji' });
}

function openHunluan() {
  const list = $('ult-hunluan-targets');
  list.innerHTML = '';
  for (const s of ['N','E','S','W']) {
    if (s === G.seat) continue;
    const size = G.handSizes[s] || 0;
    if (size === 0) continue;
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost';
    btn.style.margin = '.25rem';
    btn.textContent = `${seatName(s)}（${size}张）`;
    btn.onclick = () => { socket.emit('ultUsePlaySkill', { skillId: 'zhangxiu_hunluan', target: s }); hide('ult-modal-hunluan'); };
    list.appendChild(btn);
  }
  show('ult-modal-hunluan');
}

function cancelHunluan() { hide('ult-modal-hunluan'); }

socket.on('ultForcedPass', data => {
  if (data.target === G.seat) toast('你本墩被强制 PASS！');
  else logMsg(`${seatName(data.seat)} 雄乱：${seatName(data.target)} 本墩强制PASS`);
});

// ── 渲染对手手牌背面 ─────────────────────────────────────────────
function renderHandBack(seat) {
  const vis  = actualToVis(seat);
  const size = G.handSizes[seat];
  const el   = $('ult-hand-back-' + vis);
  if (!el) return;
  el.innerHTML = '';
  const max = Math.min(size, 13);
  for (let i = 0; i < max; i++) {
    const card = document.createElement('div');
    card.className = 'ult-card-back';
    el.appendChild(card);
  }
  const sizeEl = $('ult-size-' + vis);
  if (sizeEl) sizeEl.textContent = size;
}

function renderAllHandBacks() {
  for (const seat of SEATS) { if (seat !== G.seat) renderHandBack(seat); }
}

// ── 渲染当前墩 ────────────────────────────────────────────────────
function renderTrick() {
  const area = $('ult-trick-area');
  area.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'ult-trick-grid';
  for (const seat of SEATS) {
    const vis  = actualToVis(seat);
    const cell = document.createElement('div');
    cell.className = 'ult-trick-cell ult-trick-' + vis.toLowerCase();
    const entry = G.currentTrick.find(e => e.seat === seat);
    if (entry) {
      const cardEl = document.createElement('div');
      if (entry.card.type === 'PASS') {
        cardEl.className = 'ult-trick-card ult-pass';
        cardEl.textContent = 'PASS';
      } else {
        cardEl.className = 'ult-trick-card ' + SUIT_CLS[entry.card.suit];
        const suitEl = document.createElement('span');
        suitEl.className = 'tc-suit';
        suitEl.textContent = SUIT_SYM[entry.card.suit];
        const rankEl = document.createElement('span');
        rankEl.className = 'tc-rank';
        rankEl.textContent = rankLabel(entry.card.rank);
        cardEl.appendChild(suitEl);
        cardEl.appendChild(rankEl);
      }
      cell.appendChild(cardEl);
    }
    grid.appendChild(cell);
  }
  area.appendChild(grid);
}

function updateTopBar() {
  $('ult-trick-counter').textContent = `墩 ${G.completedCount} / 13`;
  $('ult-score-row').textContent = `NS: ${G.nsTricks} | EW: ${G.ewTricks}`;
}

function updateContractBar() {
  if (!G.contract) return;
  const cc = G.contract;
  const sStr = SUIT_BID_SYM[cc.suit] || cc.suit;
  const dStr = cc.doubled ? ' X' : cc.redoubled ? ' XX' : '';
  $('ult-deck-display').innerHTML = `<span style="font-size:.7rem;color:var(--ult-gold)">${cc.level}${sStr}${dStr} 庄：${seatName(G.declarer)}</span>`;
}

function updateTurnLabel() {
  const el = $('ult-turn-label');
  if (G.currentPlayer) {
    const isMine = G.currentPlayer === G.seat;
    el.textContent = isMine ? '▶ 轮到你出牌！' : `轮到 ${seatName(G.currentPlayer)}`;
    el.className = 'ult-turn-label' + (isMine ? ' my-turn' : '');
  } else {
    el.textContent = '';
  }
}

function updateNameplates() {
  for (const vis of ['N', 'E', 'S', 'W']) {
    const seat   = visToActual(vis);
    const numEl  = $('ult-num-'  + vis);
    const nameEl = $('ult-name-' + vis);
    const charEl = $('ult-char-' + vis);
    if (numEl)  numEl.textContent  = SEATS.indexOf(seat) + 1;
    if (nameEl) nameEl.textContent = seatName(seat);
    if (charEl) {
      const charId = G.characters[seat];
      charEl.textContent = charId ? (CHAR_INFO[charId]?.name || charId) : '';
      charEl.title = charId || '';
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// Socket 事件：出牌阶段
// ══════════════════════════════════════════════════════════════════
socket.on('ultPlayUpdate', data => {
  G.currentPlayer  = data.currentPlayer;
  G.currentTrick   = data.currentTrick;
  G.completedCount = data.completedCount;
  G.nsTricks       = data.nsTricks;
  G.ewTricks       = data.ewTricks;
  G.handSizes      = data.handSizes;
  G.leader         = data.leader;

  renderAllHandBacks();
  renderTrick();
  updateTopBar();
  updateTurnLabel();
  if (G.currentPlayer !== G.seat) G.selectedCard = null;
  renderHand();
});

socket.on('ultCardPlayed', data => {
  G.currentTrick = data.currentTrick;
  renderTrick();
});

socket.on('ultTrickEnd', data => {
  G.nsTricks       = data.nsTricks;
  G.ewTricks       = data.ewTricks;
  G.completedCount = data.completedCount;
  G.leader         = data.winner;
  G.currentTrick   = [];
  updateTopBar();
  logMsg(`第 ${data.completedCount} 墩：${seatName(data.winner)} 赢得此墩`);
  renderTrick();
});

socket.on('ultHandUpdate', data => {
  if (data.seat === G.seat) {
    G.hand = data.hand;
    G.handSizes[data.seat] = data.hand.length;
    renderHand();
  } else {
    G.handSizes[data.seat] = data.hand ? data.hand.length : G.handSizes[data.seat];
    renderHandBack(data.seat);
  }
});

socket.on('ultHandSize', data => {
  G.handSizes[data.seat] = data.size;
  if (data.seat !== G.seat) renderHandBack(data.seat);
  // sizeEl already updated by renderHandBack; also update directly in case not rendered yet
  const vis = actualToVis(data.seat);
  const el  = $('ult-size-' + vis);
  if (el) el.textContent = data.size;
});

socket.on('ultSkillMsg', data => { logMsg(data.msg || data); });
socket.on('ultBidMsg',   data => { logMsg(data.msg || data); });

socket.on('ultAutoTricks', data => {
  G.nsTricks       = data.nsTricks;
  G.ewTricks       = data.ewTricks;
  G.completedCount = data.completedCount;
  updateTopBar();
  logMsg('所有人手牌已空，剩余墩自动分配完毕。');
});

socket.on('ultGameEnd', data => {
  G.nsTricks  = data.nsTricks;
  G.ewTricks  = data.ewTricks;
  updateTopBar();

  const titleEl = $('ult-end-title');
  const bodyEl  = $('ult-end-body');
  const scoreEl = $('ult-end-score');
  const myNS    = sideOf(G.seat);

  if (data.winner === 'TIE') {
    titleEl.textContent = '平局';
    bodyEl.textContent  = `NS 与 EW 各赢 ${data.nsTricks} 墩`;
  } else {
    const won = data.winner === myNS;
    titleEl.textContent = won ? '胜利！' : '惜败';
    bodyEl.innerHTML =
      `NS: ${data.nsTricks} 墩 &nbsp;|&nbsp; EW: ${data.ewTricks} 墩<br/>` +
      `<strong>${data.winner}</strong> 获胜`;
  }

  if (data.contract) {
    const cc = data.contract;
    const sStr = SUIT_BID_SYM[cc.suit] || cc.suit;
    const made = data.made;
    const diff = data.diff;
    scoreEl.innerHTML =
      `定约：${cc.level}${sStr} 庄 ${seatName(data.declarer)}<br/>` +
      `<span style="color:${made ? '#a3e635' : '#f87171'}">${made ? '完成' : '宕约'} ${diff >= 0 ? '+' : ''}${diff}</span>` +
      (data.score ? `&nbsp;·&nbsp;${data.score > 0 ? '+' : ''}${data.score}分` : '');
  } else {
    scoreEl.textContent = '';
  }

  show('ult-modal-end');
});

socket.on('characterUpdate', data => {
  G.characters[data.seat] = data.charId || data.charName;
  const charEl = $('ult-char-' + data.seat);
  if (charEl) { charEl.textContent = data.charName; charEl.title = data.charName; }
});

socket.on('appError', data => {
  const msg = data.msg || '发生错误';
  toast(msg);
  if (msg === '房间不存在') setTimeout(() => { window.location.href = '/'; }, 1500);
});

// ══════════════════════════════════════════════════════════════════
// 通用：技能列表渲染（叫牌准备/结束阶段）
// ══════════════════════════════════════════════════════════════════
function renderSkillList(containerId, skills, phase) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = '';
  if (!skills || skills.length === 0) {
    el.innerHTML = '<p class="ult-no-skill">本阶段无可用技能</p>';
    return;
  }
  for (const sk of skills) {
    const div = document.createElement('div');
    div.className = 'ult-skill-item';
    div.innerHTML = `<span class="ult-skill-name">${sk.name}</span>
      <span class="ult-skill-desc">${sk.description || ''}</span>`;

    const useBtn = document.createElement('button');
    useBtn.className = 'btn btn-primary ult-skill-use-btn';
    useBtn.textContent = '使用';
    useBtn.onclick = () => activateSkill(sk, phase, useBtn);
    div.appendChild(useBtn);
    el.appendChild(div);
  }
}

function activateSkill(sk, phase, btn) {
  const event = phase === 'prep' ? 'ultBidPrepSkill' : 'ultBidEndSkill';

  switch (sk.interaction?.type) {
    case 'peek_deck':
      socket.emit(event, { skillId: sk.id });
      btn.disabled = true; btn.textContent = '等待…';
      return;

    case 'discard_draw':
      activateDiscardDraw(sk, phase);
      return;

    case 'pick_give_partner':
      activatePickGive(sk, phase);
      return;

    case 'copy_card':
      activateCopyCard(sk, phase);
      return;

    case 'confirm_steal_both_opp':
      socket.emit(event, { skillId: sk.id });
      btn.disabled = true; btn.textContent = '已使用';
      return;

    case 'give_all_to_partner':
      if (confirm('确认将所有手牌交给同伴？')) {
        socket.emit(event, { skillId: sk.id });
        btn.disabled = true; btn.textContent = '已使用';
      }
      return;

    default:
      socket.emit(event, { skillId: sk.id });
  }
}

function activateDiscardDraw(sk, phase) {
  // 孙权制衡：选牌界面（最多4张）
  showCardPickModal(G.hand, 4, (selected) => {
    const event = phase === 'prep' ? 'ultBidPrepSkill' : 'ultBidEndSkill';
    socket.emit(event, { skillId: sk.id, data: { cards: selected } });
  }, '制衡 — 选择弃置的牌（至多4张）', '弃置并摸牌');
}

function activatePickGive(sk, phase) {
  // 刘备仁德：选牌界面（最多2张）
  showCardPickModal(G.hand, sk.interaction?.max || 2, (selected) => {
    const event = phase === 'prep' ? 'ultBidPrepSkill' : 'ultBidEndSkill';
    socket.emit(event, { skillId: sk.id, data: { cards: selected } });
  }, `仁德 — 选择送给同伴的牌（至多${sk.interaction?.max||2}张，+1点）`, '交出');
}

function activateCopyCard(sk, phase) {
  showCardPickModal(G.hand, 1, (selected) => {
    if (!selected.length) return;
    const event = phase === 'prep' ? 'ultBidPrepSkill' : 'ultBidEndSkill';
    socket.emit(event, { skillId: sk.id, data: { card: selected[0] } });
  }, '智哲 — 选择复制的牌（1张）', '复制');
}

// 通用选牌弹窗（内联简易实现）
let _pickCallback = null;
let _pickMax = 1;
let _pickSelected = [];

function showCardPickModal(hand, max, callback, title, confirmText) {
  _pickCallback = callback;
  _pickMax = max;
  _pickSelected = [];

  let modal = $('ult-pick-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'ult-pick-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `<div class="modal" style="max-width:480px">
      <h3 class="modal-title" id="ult-pick-title"></h3>
      <div id="ult-pick-cards" class="ult-phase-hand" style="margin:.8rem 0;min-height:3rem"></div>
      <div class="modal-btn-row">
        <button class="btn btn-primary" id="ult-pick-confirm"></button>
        <button class="btn btn-ghost" onclick="closePickModal()">取消</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
  }

  $('ult-pick-title').textContent = title;
  $('ult-pick-confirm').textContent = confirmText;
  $('ult-pick-confirm').onclick = () => {
    closePickModal();
    if (_pickCallback) _pickCallback(_pickSelected);
  };
  renderPickCards(hand);
  modal.classList.remove('hidden');
}

function renderPickCards(hand) {
  const container = $('ult-pick-cards');
  container.innerHTML = '';
  const groups = { S: [], H: [], D: [], C: [] };
  for (const c of hand) { if (c.suit in groups) groups[c.suit].push(c); }
  for (const suit of ['S','H','D','C']) {
    if (!groups[suit].length) continue;
    groups[suit].sort((a, b) => b.rank - a.rank);
    const grp = document.createElement('div');
    grp.className = 'ult-suit-group';
    const sl = document.createElement('span');
    sl.className = 'ult-suit-label ' + SUIT_CLS[suit];
    sl.textContent = SUIT_SYM[suit];
    grp.appendChild(sl);
    for (const card of groups[suit]) {
      const btn = document.createElement('button');
      btn.className = 'ult-card ' + SUIT_CLS[card.suit];
      const isSel = _pickSelected.some(c => c.suit === card.suit && Math.abs(c.rank - card.rank) < 1e-9);
      if (isSel) btn.classList.add('selected');
      btn.textContent = rankLabel(card.rank);
      btn.onclick = () => {
        const idx = _pickSelected.findIndex(c => c.suit === card.suit && Math.abs(c.rank - card.rank) < 1e-9);
        if (idx >= 0) { _pickSelected.splice(idx, 1); }
        else if (_pickSelected.length < _pickMax) { _pickSelected.push({ ...card }); }
        renderPickCards(hand);
      };
      grp.appendChild(btn);
    }
    container.appendChild(grp);
  }
}

function closePickModal() {
  const modal = $('ult-pick-modal');
  if (modal) modal.classList.add('hidden');
}

// ── 通用：相位手牌渲染（只读，不可点击）────────────────────────
function renderPhaseHand(containerId, hand, clickable) {
  const container = $(containerId);
  if (!container) return;
  container.innerHTML = '';
  const groups = { S: [], H: [], D: [], C: [] };
  for (const c of hand) { if (c.suit in groups) groups[c.suit].push(c); }
  for (const suit of ['S','H','D','C']) {
    if (!groups[suit].length) continue;
    groups[suit].sort((a, b) => b.rank - a.rank);
    const grp = document.createElement('div');
    grp.className = 'ult-suit-group';
    const sl = document.createElement('span');
    sl.className = 'ult-suit-label ' + SUIT_CLS[suit];
    sl.textContent = SUIT_SYM[suit];
    grp.appendChild(sl);
    for (const card of groups[suit]) {
      const span = document.createElement('span');
      span.className = 'ult-card-static ' + SUIT_CLS[card.suit];
      span.textContent = rankLabel(card.rank);
      grp.appendChild(span);
    }
    container.appendChild(grp);
  }
}

// ── 结算操作 ──────────────────────────────────────────────────────
function ultNextDeal() {
  hide('ult-modal-end');
  socket.emit('ownerStartGame');
}

function ultExit() {
  window.location.href = '/';
}

socket.on('gameReconnect', data => { if (data.seat) G.seat = data.seat; });
