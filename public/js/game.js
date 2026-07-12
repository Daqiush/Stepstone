// game.js — 游戏主逻辑 + UI 渲染

// ────────────────────────────────────────────────────────────────
// 初始化：从 sessionStorage 恢复身份
// ────────────────────────────────────────────────────────────────
const MY_ROOM = sessionStorage.getItem('ss_roomId');
const MY_SEAT = sessionStorage.getItem('ss_seat');
const MY_NAME = sessionStorage.getItem('ss_name');

if (!MY_ROOM || !MY_SEAT) {
  window.location.href = 'index.html';
}

// 旋转视角：每个玩家看到自己在下方（视觉 S）
// 视觉位置 → 实际座位偏移量：S=0, N=2, W=1, E=3
const _seatsArr = ['N','E','S','W'];
const _myIdx    = _seatsArr.indexOf(MY_SEAT);
const SEAT_TO_VISUAL = {};
const VISUAL_TO_SEAT = {};
for (const [vis, off] of [['S',0],['N',2],['W',1],['E',3]]) {
  const actual = _seatsArr[(_myIdx + off) % 4];
  SEAT_TO_VISUAL[actual] = vis;
  VISUAL_TO_SEAT[vis]    = actual;
}

const socket = io();

// 叫牌覆层状态
let G_pendingLv  = null; // 已选阶数 (1-7) 或 null
let G_pendingBid = null; // 已确定的待出叫品字符串，或 null

// ────────────────────────────────────────────────────────────────
// 游戏状态
// ────────────────────────────────────────────────────────────────
const G = {
  mySeat:       MY_SEAT,
  playerNames:  {},
  boardInfo:    null,
  phase:        null,   // BIDDING | PLAYING | SCORING
  myHand:       [],
  dummyHand:    null,
  dummy:        null,
  declarer:     null,
  leader:       null,
  currentPlayer: null,
  currentContract: null,
  currentTrick:  [],
  completedCount: 0,
  nsTricks: 0,
  ewTricks: 0,
  dummyRevealed: false,
  biddingHistory: [],
  currentBidder:  null,
  validBids:      {},
  claimSelectedTricks: null,
  nextDealReady: {},
  boardScores:   [],
  // 教学模式
  teachingMode:         false,
  teachingSeats:        [],
  teachingHands:        {},
  teachingCurrentSeat:  null,
  teachingCurrentHand:  null,
  // 明手代控庄家
  declarerControlledBy: null,
  declarerHand:         null,
  declarerSelectedCard: null,
  // 双明手分析
  ddTable: null,
};

// ────────────────────────────────────────────────────────────────
// Socket 连接后重新加入房间
// ────────────────────────────────────────────────────────────────
socket.on('connect', () => {
  socket.emit('joinRoom', { roomId: MY_ROOM, playerName: MY_NAME });
  socket.emit('chooseSeat', { seat: MY_SEAT, playerName: MY_NAME });
});

window.addEventListener('resize', fitTeachPanel);

// ────────────────────────────────────────────────────────────────
// Socket 事件处理
// ────────────────────────────────────────────────────────────────

socket.on('gameStart', (data) => {
  G.myHand       = BR.sortHand(data.hand);
  G.boardInfo    = data.boardInfo;
  G.playerNames  = data.playerNames;
  G.phase        = 'BIDDING';
  if (data.boardScores) G.boardScores = data.boardScores;
  G.dummyHand    = null;
  G.dummy        = null;
  G.declarer     = null;
  G.currentPlayer = null;
  // 教学模式
  G.teachingMode        = !!data.teachingMode;
  G.teachingSeats       = data.teachingSeats || [];
  G.teachingHands       = data.teachingHands || {};
  G.teachingCurrentSeat = null;
  G.teachingCurrentHand = null;
  G.declarerControlledBy = null;
  G.declarerHand         = null;
  G.declarerSelectedCard = null;
  G._teachSelectedCard   = null;
  G.currentContract = null;
  G.currentTrick = [];
  G.completedCount = 0;
  G.nsTricks = G.ewTricks = 0;
  G.dummyRevealed = false;
  G.nextDealReady = {};

  G_pendingLv = null; G_pendingBid = null;
  renderTopBar();
  renderAllHands();
  closeModal('modal-game-end');
  hide('bottom-right-panel');
  // 显示叫牌覆层和历史，隐藏墩显示和迷你历史
  show('bid-overlay');
  show('bid-hist-center');
  hide('mini-bid-history');
  hide('trick-grid');
  document.getElementById('trick-area').classList.add('bidding-mode');
  show('btn-topbar-history'); // 游戏期间始终显示，无历史时打开后有提示
  if (G.teachingMode) show('teaching-badge'); else hide('teaching-badge');
  // 教学模式：初始化 teach panel（隐藏，等叫牌更新后决定是否显示）
  const teachPanel = document.getElementById('teach-panel');
  if (teachPanel) teachPanel.classList.add('hidden');
});

socket.on('biddingUpdate', (data) => {
  G.biddingHistory  = data.history;
  G.currentBidder   = data.currentBidder;
  G.currentContract = data.currentContract;
  // 教学模式：更新当前教学手牌
  if (G.teachingMode) {
    G.teachingCurrentSeat = data.teachingCurrentSeat || null;
    G.teachingCurrentHand = data.teachingCurrentHand
      ? BR.sortHand(data.teachingCurrentHand) : null;
    if (G.teachingCurrentSeat && data.teachingCurrentHand) {
      G.teachingHands[G.teachingCurrentSeat] = G.teachingCurrentHand;
    }
    const bidSeat = G.teachingCurrentSeat || MY_SEAT;
    G.validBids = BR.getValidBids(data.currentContract, bidSeat, data.currentBidder);
  } else {
    G.validBids = BR.getValidBids(data.currentContract, MY_SEAT, data.currentBidder);
  }
  renderBiddingPanel();
  renderNameplates();
  if (G.teachingMode) renderTeachPanel();
});

socket.on('biddingEnd', (data) => {
  G.currentContract     = data.contract;
  G.declarer            = data.declarer;
  G.dummy               = data.dummy;
  G.leader              = data.leader;
  G.biddingHistory      = data.biddingHistory;
  G.declarerControlledBy = data.declarerControlledBy || null;
  G.phase               = 'PLAYING';
  G.teachingCurrentSeat = null;
  G.teachingCurrentHand = null;
  // 按将牌重新排序自己的手牌
  G.myHand = BR.sortHand(G.myHand, data.contract?.suit);

  G_pendingLv = null; G_pendingBid = null;
  // 隐藏叫牌覆层和历史，显示墩显示和迷你历史
  hide('bid-overlay');
  hide('bid-hist-center');
  document.getElementById('trick-area').classList.remove('bidding-mode');
  show('trick-grid');
  show('mini-bid-history');
  renderMiniBidHistory();
  show('bottom-right-panel');
  renderTopBar();
  renderNameplates();
  renderAllHands();
  showToast(`叫牌结束。定约：${contractText(G.currentContract)}，庄家：${BR.SEAT_LABEL[G.declarer]}，首引：${BR.SEAT_LABEL[G.leader]}`);
});

socket.on('dummyRevealed', ({ dummy, dummyHand }) => {
  G.dummy         = dummy;
  G.dummyHand     = BR.sortHand(dummyHand, G.currentContract?.suit);
  G.dummyRevealed = true;
  renderAllHands();
});

socket.on('cardPlayed', ({ seat, card, currentTrick }) => {
  G.currentTrick = currentTrick;

  // 更新手牌（服务器权威，本地同步删除）
  if (seat === MY_SEAT) {
    G.myHand = G.myHand.filter(c => !(c.suit === card.suit && c.rank === card.rank));
  }
  if (seat === G.dummy && G.dummyHand) {
    G.dummyHand = G.dummyHand.filter(c => !(c.suit === card.suit && c.rank === card.rank));
  }
  // 教学模式：更新教学手牌
  if (G.teachingMode && G.teachingSeats.includes(seat) && G.teachingHands[seat]) {
    G.teachingHands[seat] = G.teachingHands[seat].filter(
      c => !(c.suit === card.suit && c.rank === card.rank));
  }
  // 明手代控庄家：更新庄家手牌
  if (G.declarerHand && seat === G.declarer) {
    G.declarerHand = G.declarerHand.filter(c => !(c.suit === card.suit && c.rank === card.rank));
  }

  renderTrickArea();
  renderPlayerHand(seat);
});

socket.on('roomUpdate', (data) => {
  G.playerNames = data.playerNames;
  G.readyStatus = data.readyStatus;
  G.boardScores = data.boardScores || [];
  
  if (data.phase === 'LOBBY') {
    renderNameplates();
  }
});

socket.on('playUpdate', (data) => {
  G.currentPlayer  = data.currentPlayer;
  G.currentTrick   = data.currentTrick;
  G.completedCount = data.completedCount;
  G.nsTricks       = data.nsTricks;
  G.ewTricks       = data.ewTricks;
  G.dummy          = data.dummy;
  G.declarer       = data.declarer;
  G.declarerControlledBy = data.declarerControlledBy || null;
  // 教学模式：更新当前教学手牌
  if (G.teachingMode) {
    G.teachingCurrentSeat = data.teachingCurrentSeat || null;
    G.teachingCurrentHand = data.teachingCurrentHand
      ? BR.sortHand(data.teachingCurrentHand, G.currentContract?.suit) : null;
    if (G.teachingCurrentSeat && G.teachingCurrentHand) {
      G.teachingHands[G.teachingCurrentSeat] = G.teachingCurrentHand;
    }
  }
  renderTrickBadges();
  renderNameplates();
  renderTrickArea();
  renderAllHands();
  renderTopBar();
  renderTeachPanel();
});

socket.on('trickEnd', ({ trick, winner, nsTricks, ewTricks }) => {
  G.nsTricks = nsTricks;
  G.ewTricks = ewTricks;
  G.completedCount++;
  G.currentTrick = [];

  renderTrickBadges();
  renderTrickArea();
  setTimeout(renderTrickArea, 700); // 清空墩显示

  // 短暂显示赢墩者
  const indicator = document.getElementById('trick-indicator');
  if (indicator) {
    indicator.textContent = BR.SEAT_LABEL[winner] + '赢';
    indicator.style.color = 'var(--gold-light)';
    setTimeout(() => {
      indicator.textContent = '';
      indicator.style.color = '';
    }, 1200);
  }
  renderTopBar();
});

socket.on('gameEnd', (data) => {
  G.phase = 'SCORING';
  G.boardScores = data.boardScores;
  if (data.ddTable) G.ddTable = data.ddTable;
  hide('bottom-right-panel');
  show('btn-topbar-history');
  showEndModal(data);
  try { sessionStorage.setItem('ss_history', JSON.stringify(data.boardScores)); } catch(e) {}
});

socket.on('ddTableReady', ({ ddTable }) => {
  G.ddTable = ddTable;
  const ddEl = document.getElementById('end-dd-table');
  if (ddEl && document.getElementById('modal-game-end')?.classList.contains('active')) {
    ddEl.innerHTML = renderDDTable(ddTable);
  } else if (ddEl) {
    ddEl.innerHTML = renderDDTable(ddTable);
  }
});

socket.on('nextDealUpdate', ({ readyStatus, playerNames }) => {
  G.nextDealReady = readyStatus;
  renderNextDealReady(readyStatus, playerNames);
});

// ── 声称 ──────────────────────────────────────────────────────
socket.on('claimRequest', (data) => {
  if (data.claimer === MY_SEAT) return; // 发起者不重复显示
  showClaimRecvModal(data);
});

socket.on('claimVoteUpdate', ({ votes, voters }) => {
  const statusEl = document.getElementById('claim-vote-status');
  if (statusEl) {
    const done = Object.values(votes).filter(v => v !== undefined).length;
    statusEl.textContent = `已投票 ${done}/${voters.length}`;
  }
});

socket.on('claimResult', ({ accepted, tricksToWin, claimer }) => {
  closeModal('modal-claim-recv');
  if (accepted) {
    showToast(`声称已被接受 — 赢得 ${tricksToWin} 墩`);
  } else {
    showToast('声称被拒绝，继续打牌');
  }
});

// ── 查看上一墩 ────────────────────────────────────────────────
socket.on('viewLastTrickData', ({ lastTrick }) => {
  showLastTrickModal(lastTrick);
});

socket.on('viewLastTrickRequest', ({ requester, requesterName }) => {
  if (BR.sideOf(requester) === BR.sideOf(MY_SEAT)) {
    if (requester === MY_SEAT) showToast('已向对手发送查看请求，等待同意...');
    return; // 本方不投票
  }
  document.getElementById('view-vote-desc').textContent =
    `${requesterName}（${BR.SEAT_LABEL[requester]}）请求查看上一墩，是否同意？`;
  document.getElementById('view-vote-status').textContent = '';
  show('view-vote-btns');
  showModal('modal-view-vote');
});

socket.on('viewLastTrickVoteUpdate', ({ votes }) => {
  const done = Object.values(votes).filter(v => v !== undefined).length;
  const statusEl = document.getElementById('view-vote-status');
  if (statusEl) statusEl.textContent = `已投票 ${done}/2`;
});

socket.on('viewLastTrickVoteResult', ({ approved, requester }) => {
  closeModal('modal-view-vote');
  if (!approved && requester === MY_SEAT) {
    showToast('查看上一墩被对手拒绝');
  }
});

socket.on('bidQuestionRecv', ({ bidIndex, qaIdx, question, asker, askerName }) => {
  G_answerBidIndex = bidIndex;
  G_answerQaIdx    = qaIdx;
  G_answerAsker    = asker;
  const entry = G.biddingHistory[bidIndex];
  const bidStr = entry ? (entry.bid === 'Pass' ? 'PASS' : entry.bid === 'Double' ? 'X' : entry.bid === 'Redouble' ? 'XX' : entry.bid) : '?';
  const desc = document.getElementById('bid-answer-desc');
  if (desc) desc.textContent = `${askerName || BR.SEAT_LABEL[asker]} 询问您的叫品 [${bidStr}]${question ? '：' + question : '（无具体问题，请解释）'}`;
  const inp = document.getElementById('bid-answer-input');
  if (inp) inp.value = '';
  showModal('modal-bid-answer');
});

socket.on('bidAnswerRecv', ({ bidIndex, qaIdx, answer, answererName, bid }) => {
  const bidStr = bid === 'Pass' ? 'PASS' : bid === 'Double' ? 'X' : bid === 'Redouble' ? 'XX' : bid;
  showToast(`${answererName || '对方'} 对 [${bidStr}] 的解释：${answer || '（无解释）'}`);
});

socket.on('appError', ({ msg }) => {
  showToast(msg);
  if (msg === '房间不存在') setTimeout(() => { window.location.href = '/'; }, 1500);
});

socket.on('playerDisconnected', ({ seat }) => {
  showToast(`${BR.SEAT_LABEL[seat]} 断线`);
});

// ── 悬浮出牌逻辑 ─────────────────────────────────────
let currentHoverSuit = null;
let hoverTimeout = null;
function updatePlayOverlay(suit, isDummy = false, isReadOnly = false, previewSuit = null) {
  const overlay = document.getElementById('play-confirm-overlay');
  if (!overlay) return;
  if (!suit && !previewSuit) {
    overlay.classList.add('hidden');
    document.querySelectorAll('.player-area.high-z').forEach(el => el.classList.remove('high-z'));
    overlay.innerHTML = '';
    currentHoverSuit = null;
    return;
  }
  
  // 以 previewSuit (如果存在) 作为缓存标记，否则以 suit 为缓存标记
  const hoverTarget = previewSuit || suit;
  if (currentHoverSuit === hoverTarget) return;
  currentHoverSuit = hoverTarget;
  
  // 决定当前该操作的座位和 DOM
  const targetSeat = isDummy ? G.dummy : MY_SEAT;
  const visPos = SEAT_TO_VISUAL[targetSeat];
  const areaEl = document.getElementById('area-' + visPos);
  
  // 移动 DOM 元素并设置对应方位的类名
  if (areaEl && overlay.parentNode !== areaEl) {
    areaEl.appendChild(overlay);
  }
  overlay.className = 'overlay-pos-' + visPos;
  
  // 提升当前操作区的层级，防止悬浮框被中心出牌区遮挡
  document.querySelectorAll('.player-area.high-z').forEach(el => el.classList.remove('high-z'));
  if (areaEl) {
    areaEl.classList.add('high-z');
  }
  
  overlay.innerHTML = '';
  const hand = isDummy ? G.dummyHand : G.myHand;
  
  // ===== 1. 出牌行 (Play Row) =====
  if (suit) {
    const playRowWrap = document.createElement('div');
    const playRow = document.createElement('div');
    playRow.className = 'overlay-row';
    const cards = hand.filter(c => c.suit === suit);
    cards.forEach(card => {
      const el = makeCardEl(card, false);
      if (!isReadOnly && isLegalPlay(card)) {
        el.onclick = () => {
          overlay.classList.add('hidden');
          document.querySelectorAll('.player-area.high-z').forEach(e => e.classList.remove('high-z'));
          currentHoverSuit = null;
          playCard(card);
        };
        el.title = '点击出牌';
      } else {
        el.classList.add('card-inert');
      }
      playRow.appendChild(el);
    });
    
    // 如果有两排，加上说明文字
    if (previewSuit && previewSuit !== suit) {
      const lbl = document.createElement('div');
      lbl.className = 'overlay-row-label';
      lbl.textContent = '请出合法牌';
      playRowWrap.appendChild(lbl);
    }
    playRowWrap.appendChild(playRow);
    overlay.appendChild(playRowWrap);
  }
  
  // ===== 2. 预览行 (Preview Row) =====
  if (previewSuit && previewSuit !== suit) {
    const previewRowWrap = document.createElement('div');
    const previewRow = document.createElement('div');
    previewRow.className = 'overlay-row';
    const previewCards = hand.filter(c => c.suit === previewSuit);
    previewCards.forEach(card => {
      const el = makeCardEl(card, false);
      el.classList.add('card-inert');
      previewRow.appendChild(el);
    });
    
    const lbl = document.createElement('div');
    lbl.className = 'overlay-row-label';
    lbl.textContent = '您悬浮的花色预览';
    previewRowWrap.appendChild(lbl);
    previewRowWrap.appendChild(previewRow);
    
    overlay.appendChild(previewRowWrap);
  }
  
  overlay.classList.remove('hidden');
}

// ────────────────────────────────────────────────────────────────
// 渲染函数
// ────────────────────────────────────────────────────────────────

function renderTopBar() {
  const bi = G.boardInfo;
  if (!bi) return;

  // 副号
  document.getElementById('board-badge').textContent =
    `第 ${bi.dealNumber} 副`;

  // 局况
  const vulEl = document.getElementById('vul-display');
  const nsVul = bi.vul === 'BOTH' || bi.vul === 'NS';
  const ewVul = bi.vul === 'BOTH' || bi.vul === 'EW';
  vulEl.innerHTML =
    `<span class="vul-badge ${nsVul ? 'vul-yes' : 'vul-no'}">NS ${nsVul ? '有局' : '无局'}</span>` +
    `<span class="vul-badge ${ewVul ? 'vul-yes' : 'vul-no'}">EW ${ewVul ? '有局' : '无局'}</span>`;

  // 定约
  const contractEl = document.getElementById('contract-display');
  if (G.currentContract && G.phase !== 'BIDDING') {
    contractEl.innerHTML = contractText(G.currentContract, true) +
      ` <span style="font-size:.75rem;color:var(--text-muted)">庄${BR.SEAT_LABEL[G.declarer]}</span>`;
  } else {
    contractEl.textContent = '';
  }

  // 发牌人（全程显示）
  const dealerEl = document.getElementById('dealer-display');
  if (dealerEl) dealerEl.textContent = `发牌人：${BR.SEAT_LABEL[bi.dealer]}`;

  // 墩数（仅打牌阶段）
  document.getElementById('trick-counter').textContent =
    G.phase === 'PLAYING' ? `墩：${G.nsTricks}↔${G.ewTricks}` : '';
}

function renderAllHands() {
  for (const s of ['N','E','S','W']) renderPlayerHand(s);
}

function renderPlayerHand(seat) {
  const wrap = document.getElementById('hand-' + SEAT_TO_VISUAL[seat]);
  if (!wrap) return;

  const isMine     = seat === MY_SEAT;
  const isDummy    = seat === G.dummy && G.dummyRevealed;
  const visPos     = SEAT_TO_VISUAL[seat];
  const isEastWest = visPos === 'E' || visPos === 'W';

  wrap.innerHTML = '';

  if (isDummy) {
    // 明手：按将牌花色顺序分列显示
    const trump  = G.currentContract?.suit;
    const suits  = BR.suitOrder(trump);
    const groups = BR.groupBySuit(G.dummyHand || []);
    const canPlay = G.phase === 'PLAYING' && G.currentPlayer === G.dummy
      && (MY_SEAT === G.declarer || G.declarerControlledBy === MY_SEAT);
    const dWrap  = document.createElement('div');
    dWrap.className = 'dummy-hand-wrap';

    let mandatorySuit = null;
    if (canPlay && G.currentTrick && G.currentTrick.length > 0) {
      const leadSuit = G.currentTrick[0].card.suit;
      if (G.dummyHand.some(c => c.suit === leadSuit)) {
        mandatorySuit = leadSuit;
      }
    }

    const areaEl = document.getElementById('area-' + SEAT_TO_VISUAL[G.dummy]);
    if (areaEl && !areaEl.dataset.hoverBoundDummy) {
      areaEl.addEventListener('mouseleave', () => updatePlayOverlay(null));
      areaEl.dataset.hoverBoundDummy = 'true';
    }
    updatePlayOverlay(null);

    const MAX_DUMMY_DISPLAY = 6;

    for (const suit of suits) {
      if (!groups[suit].length) continue;
      const col = document.createElement('div');
      col.className = 'dummy-suit-col';

      let displayCards = groups[suit];
      let hiddenCount = 0;
      if (groups[suit].length > MAX_DUMMY_DISPLAY) {
        displayCards = groups[suit].slice(0, MAX_DUMMY_DISPLAY - 1);
        hiddenCount = groups[suit].length - (MAX_DUMMY_DISPLAY - 1);
      }

      const isLongSuit = groups[suit].length > MAX_DUMMY_DISPLAY;

      displayCards.forEach((card, idx) => {
        const el = makeCardEl(card, true);
        if (idx > 0) el.classList.add('dummy-card');
        
        el.onmouseenter = () => {
          const playSuit = canPlay ? (mandatorySuit ? mandatorySuit : card.suit) : null;
          const previewSuitToPass = isLongSuit ? card.suit : null;
          
          clearTimeout(hoverTimeout);
          hoverTimeout = setTimeout(() => {
            updatePlayOverlay(playSuit, true, !canPlay, previewSuitToPass);
          }, 80);
        };
        el.onmouseleave = () => {
          clearTimeout(hoverTimeout);
        };
        
        el.classList.add('card-inert'); // 移除直接点击，改用悬浮
        col.appendChild(el);
      });

      if (hiddenCount > 0) {
        const moreEl = document.createElement('div');
        moreEl.className = 'dummy-more-indicator dummy-card';
        moreEl.textContent = `+${hiddenCount}`;
        
        moreEl.onmouseenter = () => {
          const playSuit = canPlay ? (mandatorySuit ? mandatorySuit : suit) : null;
          // 提示符本身就代表这是一个长套
          clearTimeout(hoverTimeout);
          hoverTimeout = setTimeout(() => {
            updatePlayOverlay(playSuit, true, !canPlay, suit);
          }, 80);
        };
        moreEl.onmouseleave = () => {
          clearTimeout(hoverTimeout);
        };
        
        col.appendChild(moreEl);
      }

      dWrap.appendChild(col);
    }
    wrap.appendChild(dWrap);
    return;
  }

  if (isMine) {
    // 我的手牌：正面显示；动态叠放使其适应容器宽度
    const count = G.myHand.length;
    let cardW = 54;
    const tempCard = document.createElement('div');
    tempCard.className = 'card';
    tempCard.style.visibility = 'hidden';
    wrap.appendChild(tempCard);
    cardW = tempCard.offsetWidth || 54;
    wrap.removeChild(tempCard);
    const areaEl = document.getElementById('area-' + SEAT_TO_VISUAL[MY_SEAT]);
    const availW = areaEl ? areaEl.clientWidth - 16 : 600;
    const totalW = count * cardW + (count - 1) * 2;
    const overlap = (count > 1 && totalW > availW)
      ? Math.min(Math.round(cardW * 0.7), Math.round((totalW - availW) / (count - 1)))
      : 0;

    const isMyTurnToPlay = G.phase === 'PLAYING' && G.currentPlayer === MY_SEAT && !G.claimReq;
    
    // 如果跟牌阶段自己有要跟的花色，强制该花色为唯一合法悬浮花色
    let mandatorySuit = null;
    if (isMyTurnToPlay && G.currentTrick && G.currentTrick.length > 0) {
      const leadSuit = G.currentTrick[0].card.suit;
      if (G.myHand.some(c => c.suit === leadSuit)) {
        mandatorySuit = leadSuit;
      }
    }

    // 绑定鼠标离开南家区域时隐藏浮层
    if (areaEl && !areaEl.dataset.hoverBound) {
      areaEl.addEventListener('mouseleave', () => updatePlayOverlay(null));
      areaEl.dataset.hoverBound = 'true';
    }

    // 每次渲染手牌前先重置浮层状态
    updatePlayOverlay(null);

    G.myHand.forEach((card, idx) => {
      const el = makeCardEl(card, false);
      
      if (isMyTurnToPlay) {
        el.onmouseenter = () => {
          const hoverSuit = mandatorySuit ? mandatorySuit : card.suit;
          clearTimeout(hoverTimeout);
          hoverTimeout = setTimeout(() => {
            updatePlayOverlay(hoverSuit, false, false, null);
          }, 80);
        };
        el.onmouseleave = () => {
          clearTimeout(hoverTimeout);
        };
      }
      
      // 所有自己手牌在手牌区内都不用半透明（彻底废除半透明），全部加 card-inert 禁用自带 hover 和点击
      el.classList.add('card-inert');
      
      if (idx > 0 && overlap > 0) el.style.marginLeft = `-${overlap}px`;
      wrap.appendChild(el);
    });
    return;
  }

  // 他人：背面（水平叠放）
  const count = getHandCount(seat);
  let cardW = 54;
  const tempCard = document.createElement('div');
  tempCard.className = 'card';
  tempCard.style.visibility = 'hidden';
  wrap.appendChild(tempCard);
  cardW = tempCard.offsetWidth || 54;
  wrap.removeChild(tempCard);
  let overlap;
  if ((visPos === 'E' || visPos === 'W') && count > 1) {
    // 东西列宽有限，动态计算叠放量使所有牌恰好填满列宽
    const areaEl = document.getElementById('area-' + visPos);
    const availW = Math.max(cardW * 2, (areaEl ? areaEl.clientWidth : cardW * 4) - 20);
    const step = Math.max(cardW * 0.18, (availW - cardW) / (count - 1));
    overlap = Math.round(cardW - step);
  } else {
    overlap = Math.round(cardW * 0.56);
  }
  for (let i = 0; i < count; i++) {
    const back = document.createElement('div');
    back.className = 'card card-back';
    if (i > 0) back.style.marginLeft = `-${overlap}px`;
    wrap.appendChild(back);
  }
}

function getHandCount(seat) {
  if (seat === MY_SEAT) return G.myHand.length;
  if (seat === G.dummy && G.dummyHand) return G.dummyHand.length;
  // 估算：13 - completedCount - 当前墩已出
  const trickContrib = G.currentTrick.filter(c => c.seat === seat).length;
  return Math.max(0, 13 - G.completedCount - trickContrib);
}

function makeCardEl(card, faceUp) {
  const el   = document.createElement('div');
  const col  = (card.suit === 'H' || card.suit === 'D') ? 'red' : 'black';
  const sym  = BR.SUIT_SYMBOL[card.suit];
  const rank = BR.rankDisplay(card.rank);
  el.className = `card ${col}`;
  el.dataset.suit = card.suit;
  el.dataset.rank = card.rank;
  el.innerHTML =
    `<div class="card-tl"><span class="card-rank">${rank}</span><span class="card-suit-sm">${sym}</span></div>` +
    `<div class="card-suit-center">${sym}</div>` +
    `<div class="card-br"><span class="card-rank">${rank}</span><span class="card-suit-sm">${sym}</span></div>`;
  return el;
}

function isLegalPlay(card) {
  if (G.currentTrick.length === 0) return true;
  const ledSuit = G.currentTrick[0].card.suit;
  if (card.suit === ledSuit) return true;
  return !G.myHand.some(c => c.suit === ledSuit);
}

function renderTrickArea() {
  for (const seat of ['N','E','S','W']) {
    const el = document.getElementById('ts-' + SEAT_TO_VISUAL[seat]);
    if (!el) continue;
    const played = G.currentTrick.find(c => c.seat === seat);
    if (played) {
      el.innerHTML = '';
      const card = makeCardEl(played.card, true);
      card.classList.add('disabled', 'card-appearing');
      el.appendChild(card);
    } else {
      el.innerHTML = '';
    }
  }
}

function renderTrickBadges() {
  const ns = document.getElementById('ns-tricks-badge');
  const ew = document.getElementById('ew-tricks-badge');
  if (ns) ns.textContent = `NS: ${G.nsTricks}`;
  if (ew) ew.textContent = `EW: ${G.ewTricks}`;

  const needed = G.currentContract ? G.currentContract.level + 6 : 7;
  const decSide = G.declarer ? BR.sideOf(G.declarer) : 'NS';
  const decTricks = decSide === 'NS' ? G.nsTricks : G.ewTricks;
  if (ns) ns.classList.toggle('winning', decSide === 'NS' && decTricks >= needed);
  if (ew) ew.classList.toggle('winning', decSide === 'EW' && decTricks >= needed);
}

function renderNameplates() {
  for (const s of ['N','E','S','W']) {
    const el = document.getElementById('nameplate-' + SEAT_TO_VISUAL[s]);
    if (!el) continue;
    const name = G.playerNames[s] || BR.SEAT_LABEL[s];
    let cls = 'player-nameplate';
    const isActive = G.phase === 'BIDDING' ? s === G.currentBidder :
                     G.phase === 'PLAYING' ? (s === G.currentPlayer || (s === G.dummy && G.currentPlayer === G.dummy)) : false;
    if (isActive)        cls += ' active';
    if (s === G.declarer) cls += ' declarer';
    if (s === G.dummy)    cls += ' dummy';

    const dot = isActive ? '<div class="nameplate-dot"></div>' : '';
    let tag = '';
    if (s === G.declarer) tag = '<span style="font-size:.68rem;color:var(--declarer-color)">庄</span>';
    if (s === G.dummy)    tag = '<span style="font-size:.68rem;color:var(--dummy-color)">明</span>';
    el.className = cls;
    el.innerHTML = `${dot}${tag}${name}`;
  }
}

// ── 叫牌面板渲染 ──────────────────────────────────────────────
function renderBiddingPanel() {
  renderBidOverlay();
  renderBidHistoryCenter();
  renderNameplates();
}

function renderBidOverlay() {
  const isMyTurn = G.currentBidder === MY_SEAT ||
    (G.teachingMode && G.currentBidder === G.teachingCurrentSeat);

  // 当前叫牌人标签
  const turnLabel = document.getElementById('bid-turn-label');
  if (turnLabel) {
    const bidderName = G.playerNames[G.currentBidder] || BR.SEAT_LABEL[G.currentBidder] || '';
    const suffix = G.teachingMode && G.currentBidder === G.teachingCurrentSeat
      ? '（教学）' : '';
    turnLabel.textContent = isMyTurn ? `轮到你叫牌${suffix}` : `${bidderName} 叫牌中…`;
    turnLabel.style.color = isMyTurn ? 'var(--gold-light)' : 'var(--text-muted)';
  }

  // 阶数按钮
  const lvRow = document.getElementById('bid-lv-row');
  if (lvRow) {
    lvRow.innerHTML = '';
    for (let lv = 1; lv <= 7; lv++) {
      const btn = document.createElement('button');
      btn.className = 'bid-lv-btn';
      btn.textContent = lv;
      const anyValid = isMyTurn && ['C','D','H','S','NT'].some(s => G.validBids[`${lv}${s}`]);
      if (!anyValid) btn.classList.add('bid-disabled');
      else btn.onclick = () => selectLevel(lv);
      if (G_pendingLv === lv) btn.classList.add('selected');
      lvRow.appendChild(btn);
    }
  }

  // 花色按钮（选定阶数后出现）
  const suitRow = document.getElementById('bid-suit-row');
  if (suitRow) {
    if (G_pendingLv !== null && G_pendingBid === null) {
      suitRow.classList.remove('hidden');
      suitRow.innerHTML = '';
      for (const suit of ['C','D','H','S','NT']) {
        const btn = document.createElement('button');
        btn.className = 'bid-suit-btn' + ((suit === 'H' || suit === 'D') ? ' red' : '');
        btn.innerHTML = suit === 'NT' ? 'NT' : BR.SUIT_SYMBOL[suit];
        const bid = `${G_pendingLv}${suit}`;
        if (!isMyTurn || !G.validBids[bid]) btn.classList.add('bid-disabled');
        else btn.onclick = () => selectSuit(suit);
        suitRow.appendChild(btn);
      }
      const cancelLvBtn = document.createElement('button');
      cancelLvBtn.className = 'bid-cancel-lv';
      cancelLvBtn.textContent = '✕';
      cancelLvBtn.onclick = cancelLv;
      suitRow.appendChild(cancelLvBtn);
    } else {
      suitRow.classList.add('hidden');
    }
  }

  // 特殊叫品按钮
  [['btn-pass-c','Pass'], ['btn-dbl-c','Double'], ['btn-rdbl-c','Redouble']].forEach(([id, bid]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const valid = isMyTurn && G.validBids[bid];
    btn.classList.toggle('bid-disabled', !valid);
  });

  // 待确认叫品预览
  const pendingRow = document.getElementById('bid-pending-row');
  if (pendingRow) {
    if (G_pendingBid) {
      pendingRow.classList.remove('hidden');
      const el = document.getElementById('bid-pending-display');
      if (el) el.innerHTML = bidHtml(G_pendingBid);
    } else {
      pendingRow.classList.add('hidden');
    }
  }
}

// ── 叫牌交互 ──────────────────────────────────────────────────
function selectLevel(lv) {
  G_pendingLv = lv; G_pendingBid = null;
  renderBidOverlay();
}

function selectSuit(suit) {
  G_pendingBid = `${G_pendingLv}${suit}`;
  renderBidOverlay();
}

function selectSpecial(special) {
  if (!G.validBids[special]) return;
  G_pendingLv = null; G_pendingBid = special;
  renderBidOverlay();
}

function cancelLv() {
  G_pendingLv = null; G_pendingBid = null;
  renderBidOverlay();
}

function cancelBid() {
  G_pendingLv = null; G_pendingBid = null;
  renderBidOverlay();
}

function confirmBid() {
  if (!G_pendingBid) return;
  if (!G.validBids[G_pendingBid]) { showToast('该叫品无效'); return; }
  const alertPanel  = document.getElementById('bid-alert-panel');
  const isAlerted   = alertPanel && !alertPanel.classList.contains('hidden');
  const explainText = isAlerted ? (document.getElementById('bid-explain-text')?.value.trim() || null) : null;
  submitBid(G_pendingBid, isAlerted || null, explainText);
  G_pendingLv = null; G_pendingBid = null;
  // 重置 ALERT 面板
  if (alertPanel) alertPanel.classList.add('hidden');
  if (document.getElementById('bid-explain-text')) document.getElementById('bid-explain-text').value = '';
  renderBidOverlay();
}

function renderBidHistoryCenter() {
  const head = document.getElementById('bid-hist-c-head');
  const body = document.getElementById('bid-hist-c-body');
  if (!head || !body) return;

  const order = ['N','E','S','W'];
  const startIdx = G.boardInfo ? order.indexOf(G.boardInfo.dealer) : 0;

  // Header: dealer starts, rotated order
  head.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const th = document.createElement('th');
    const s = order[(startIdx + i) % 4];
    const isMine = s === MY_SEAT || (G.teachingMode && G.teachingSeats.includes(s));
    th.textContent = BR.SEAT_LABEL[s] + (isMine ? '★' : '');
    head.appendChild(th);
  }

  // Rebuild body
  body.innerHTML = '';
  let row = null; let colIdx = startIdx;
  G.biddingHistory.forEach((entry, bidIdx) => {
    const { seat, bid } = entry;
    const col = order.indexOf(seat);
    if (row === null || col === startIdx) {
      row = document.createElement('tr');
      body.appendChild(row);
      if (col !== startIdx) {
        for (let i = startIdx; i < col; i++) row.appendChild(document.createElement('td'));
      }
      colIdx = col;
    }
    const td = document.createElement('td');
    const isOpponent = BR.sideOf(seat) !== BR.sideOf(MY_SEAT);
    const isSelf = seat === MY_SEAT;
    const hasAlert = !!entry.alert;
    // 自己也能看到自己的 A 标
    td.innerHTML = bidHtmlWithAlert(bid, hasAlert && (isOpponent || isSelf), null, entry.explain);
    if (isOpponent && hasAlert) {
      td.style.cursor = 'pointer';
      td.title = '点击询问这个叫品';
      td.addEventListener('click', () => openBidQuestionModal(bidIdx, bid, seat));
    } else if (isSelf) {
      td.style.cursor = 'pointer';
      td.title = hasAlert ? '点击修改提醒/解释' : '点击添加提醒/解释';
      td.addEventListener('click', () => openBidEditModal(bidIdx, bid, hasAlert, entry.explain));
    }
    row.appendChild(td);
    colIdx = (colIdx + 1) % 4;
    if (colIdx === startIdx && colIdx !== col + 1) row = null;
  });

  // Scroll to bottom to show latest
  const wrap = document.getElementById('bid-hist-center');
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

function renderMiniBidHistory() {
  const container = document.getElementById('mini-bid-body');
  if (!container) return;
  if (!G.biddingHistory || !G.biddingHistory.length) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:.7rem;text-align:center">无记录</div>';
    return;
  }
  const order = ['N','E','S','W'];
  const startIdx = G.boardInfo ? order.indexOf(G.boardInfo.dealer) : 0;

  let html = '<table class="mini-hist-table"><thead><tr>';
  for (let i = 0; i < 4; i++) {
    html += `<th>${BR.SEAT_LABEL[order[(startIdx + i) % 4]]}</th>`;
  }
  html += '</tr></thead><tbody>';

  let row = ''; let colIdx = startIdx;
  G.biddingHistory.forEach((entry) => {
    const { seat, bid } = entry;
    const col = order.indexOf(seat);
    if (row === '' || col === startIdx) {
      if (row) html += `<tr>${row}</tr>`;
      row = '';
      if (col !== startIdx) {
        for (let i = startIdx; i < col; i++) row += '<td></td>';
      }
      colIdx = col;
    }
    const isOpponent = BR.sideOf(seat) !== BR.sideOf(MY_SEAT);
    const isSelf = seat === MY_SEAT;
    const hasAlert = !!entry.alert;
    row += `<td>${bidHtmlWithAlert(bid, hasAlert && (isOpponent || isSelf), null, entry.explain)}</td>`;
    colIdx = (colIdx + 1) % 4;
  });
  if (row) {
    while (colIdx !== startIdx) { row += '<td></td>'; colIdx = (colIdx + 1) % 4; }
    html += `<tr>${row}</tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;

  // 自动滚动到底部显示最新叫品
  container.scrollTop = container.scrollHeight;
}

function renderBidHistory(tbodyId, history, useSlash = false) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = '';
  const order = ['N','E','S','W'];

  // 找到 dealer 的位置，确定从哪一列开始
  let startIdx = 0;
  if (G.boardInfo) {
    startIdx = order.indexOf(G.boardInfo.dealer);
  }

  let row = null;
  let colIdx = startIdx;

  history.forEach(({ seat, bid }) => {
    const col = order.indexOf(seat);
    if (row === null || col === startIdx) {
      row = document.createElement('tr');
      tbody.appendChild(row);
      // 填充前面的空格
      if (col !== startIdx) {
        for (let i = startIdx; i < col; i++) {
          const td = document.createElement('td');
          row.appendChild(td);
        }
      }
      colIdx = col;
    }

    const td = document.createElement('td');
    td.innerHTML = bidHtml(bid, useSlash);
    row.appendChild(td);
    colIdx = (colIdx + 1) % 4;

    if (colIdx === startIdx && colIdx !== col + 1) {
      row = null; // 换行
    }
  });
}

function bidHtml(bid, useSlash = false) {
  if (bid === 'Pass')     return `<span class="bh-pass">${useSlash ? '/' : 'PASS'}</span>`;
  if (bid === 'Double')   return `<span class="bh-dbl">X</span>`;
  if (bid === 'Redouble') return `<span class="bh-rdbl">XX</span>`;
  const lv   = bid[0];
  const suit = bid.slice(1);
  const col  = (suit === 'H' || suit === 'D') ? 'suit-red' : 'suit-black';
  const sym  = suit === 'NT' ? 'NT' : BR.SUIT_SYMBOL[suit];
  return `<span class="bh-bid">${lv}<span class="${col}">${sym}</span></span>`;
}

function bidHtmlWithAlert(bid, hasAlert, alertText, explainText) {
  let base = bidHtml(bid);
  if (!hasAlert) return base;
  const tip = explainText || ' ';
  return `<span class="bid-alerted" title="${tip.replace(/"/g, '&quot;')}">${base}<sup class="alert-marker">A</sup></span>`;
}

function renderContractChip() {
  const chip = document.getElementById('bid-result-chip');
  if (!chip || !G.currentContract) return;
  const bi    = G.boardInfo;
  const side  = BR.sideOf(G.declarer);
  const isVul = bi && (bi.vul === 'BOTH' || bi.vul === side);
  const vulTxt = isVul ? '<span class="vul-badge vul-yes" style="font-size:.68rem">有局</span>' : '<span class="vul-badge vul-no" style="font-size:.68rem">无局</span>';
  chip.innerHTML = `定约 ${contractText(G.currentContract, true)} &nbsp;庄：${BR.SEAT_LABEL[G.declarer]}（${side}方）&nbsp;${vulTxt}`;
}

// ── 计分面板 ──────────────────────────────────────────────────
function renderScoringPanel(data) {
  const content = document.getElementById('score-content');
  if (!content) return;

  if (data.passedOut) {
    content.innerHTML = `<div class="score-line"><span class="score-big score-zero">全不叫 — 本副0分</span></div>`;
  } else {
    const scoreClass = data.score > 0 ? 'score-pos' : data.score < 0 ? 'score-neg' : 'score-zero';
    const madeText   = data.made ? `+${data.diff >= 0 ? data.diff : 0} 超额` : `宕 ${Math.abs(data.diff)} 墩`;
    content.innerHTML =
      `<div class="score-line">定约 ${contractText(data.contract, true)} 庄家 ${BR.SEAT_LABEL[data.declarer]}（${vulLabel(data.vulnerability)}）</div>` +
      `<div class="score-line">${data.made ? '✓ 成约' : '✗ 宕约'} · 赢得 ${data.declarerTricks} 墩 · 需要 ${data.needed} 墩 · ${madeText}</div>` +
      `<div class="score-line"><span class="score-big ${scoreClass}">${data.score > 0 ? '+' : ''}${data.score}</span> <span style="color:var(--text-muted)">（${BR.sideOf(data.declarer)}方得分）</span></div>`;
  }

  // 历史表格
  renderScoreHistory(data.boardScores);
}

function renderScoreHistory(scores) {
  const wrap = document.getElementById('score-history-wrap');
  if (!wrap || !scores.length) return;

  let html = `<table class="score-history-table"><thead><tr>
    <th>副</th><th>定约</th><th>庄</th><th>结果</th><th>得分</th>
  </tr></thead><tbody>`;

  scores.forEach(s => {
    if (s.passedOut) {
      html += `<tr><td>${s.dealNumber}</td><td colspan="4" style="color:var(--text-muted)">全不叫</td></tr>`;
    } else {
      const sc = s.score;
      const cls = sc > 0 ? 'pos' : sc < 0 ? 'neg' : '';
      const diff = s.diff ?? (s.declarerTricks - s.needed);
      const diffTxt = diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : '=';
      html += `<tr>
        <td>${s.dealNumber}</td>
        <td>${contractText(s.contract)}</td>
        <td>${BR.SEAT_LABEL[s.declarer]}</td>
        <td class="${cls}">${diffTxt}</td>
        <td class="${cls}">${sc > 0 ? '+' : ''}${sc}</td>
      </tr>`;
    }
  });

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function renderNextDealReady(readyStatus, playerNames) {
  const ready = Object.entries(readyStatus).filter(([,r]) => r).map(([s]) => (playerNames[s] || BR.SEAT_LABEL[s]));
  const txt = ready.length ? `已准备：${ready.join('、')} (${ready.length}/4)` : '';
  const el = document.getElementById('next-deal-ready');
  if (el) el.textContent = txt;
  const modalEl = document.getElementById('end-ready-status');
  if (modalEl) modalEl.textContent = txt;
}

// ────────────────────────────────────────────────────────────────
// 用户操作
// ────────────────────────────────────────────────────────────────

function submitBid(bid, alert = null, explain = null) {
  if (!G.validBids[bid]) return;
  socket.emit('bid', { bid, alert, explain });
}

function toggleAlertPanel() {
  const panel = document.getElementById('bid-alert-panel');
  if (!panel) return;
  const isNowOpen = panel.classList.toggle('hidden');
  const btn = document.getElementById('btn-alert-toggle');
  if (btn) btn.classList.toggle('active', !isNowOpen);
}

// ALERT 询问弹窗
let G_questionBidIndex = null;
let G_questionBidSeat  = null;

function openBidQuestionModal(bidIdx, bid, seat) {
  G_questionBidIndex = bidIdx;
  G_questionBidSeat  = seat;
  const desc = document.getElementById('bid-question-desc');
  if (desc) desc.textContent = `询问 ${BR.SEAT_LABEL[seat]} 的叫品：${bid === 'Pass' ? 'PASS' : bid === 'Double' ? 'X' : bid === 'Redouble' ? 'XX' : bid}`;
  const inp = document.getElementById('bid-question-input');
  if (inp) inp.value = '';
  showModal('modal-bid-question');
}

function submitBidQuestion() {
  if (G_questionBidIndex === null) return;
  const q = document.getElementById('bid-question-input')?.value.trim() || '';
  socket.emit('bidQuestion', { bidIndex: G_questionBidIndex, question: q });
  closeModal('modal-bid-question');
  showToast('询问已发送，等待回答...');
}

let G_answerBidIndex = null;
let G_answerQaIdx    = null;
let G_answerAsker    = null;

function submitBidAnswer() {
  const a = document.getElementById('bid-answer-input')?.value.trim() || '';
  if (G_answerBidIndex === null) return;
  socket.emit('bidAnswer', { bidIndex: G_answerBidIndex, qaIdx: G_answerQaIdx, asker: G_answerAsker, answer: a });
  closeModal('modal-bid-answer');
}

// ALERT 修改弹窗（自己修改）
let G_editBidIndex = null;

function openBidEditModal(bidIdx, bid, hasAlert, explain) {
  G_editBidIndex = bidIdx;
  const desc = document.getElementById('bid-edit-desc');
  if (desc) desc.textContent = `修改您叫出的：${bid === 'Pass' ? 'PASS' : bid === 'Double' ? 'X' : bid === 'Redouble' ? 'XX' : bid}`;
  const chk = document.getElementById('bid-edit-alert');
  if (chk) chk.checked = !!hasAlert;
  const inp = document.getElementById('bid-edit-explain');
  if (inp) inp.value = explain || '';
  showModal('modal-bid-edit');
}

function submitBidEdit() {
  if (G_editBidIndex === null) return;
  const chk = document.getElementById('bid-edit-alert')?.checked;
  const exp = document.getElementById('bid-edit-explain')?.value.trim() || '';
  socket.emit('editBidAlert', { bidIndex: G_editBidIndex, alert: chk, explain: exp });
  closeModal('modal-bid-edit');
}

function playCard(card) {
  socket.emit('playCard', { card });
}

// ── 声称 ──────────────────────────────────────────────────────
function openClaimModal() {
  if (G.phase !== 'PLAYING') return;
  if (G.seat === G.dummy) return;
  const remaining = 13 - G.completedCount;
  document.getElementById('claim-remaining').textContent = remaining;
  document.getElementById('claim-reason').value = '';
  G.claimSelectedTricks = null;

  // 生成按钮 0 ~ remaining
  const row = document.getElementById('claim-tricks-row');
  row.innerHTML = '';
  for (let i = 0; i <= remaining; i++) {
    const btn = document.createElement('button');
    btn.className = 'claim-trick-btn';
    btn.textContent = i;
    btn.onclick = () => {
      G.claimSelectedTricks = i;
      row.querySelectorAll('.claim-trick-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    };
    row.appendChild(btn);
  }

  showModal('modal-claim');
}

function submitClaim() {
  if (G.claimSelectedTricks === null) { showToast('请选择声称墩数'); return; }
  const reason = document.getElementById('claim-reason').value.trim();
  socket.emit('claim', { tricksToWin: G.claimSelectedTricks, reason });
  closeModal('modal-claim');
}

function voteOnClaim(accept) {
  socket.emit('claimVote', { accept });
  const btns = document.getElementById('claim-vote-btns');
  if (btns) btns.style.display = 'none';
  const status = document.getElementById('claim-vote-status');
  if (status) status.textContent = accept ? '已投：同意，等待另一对手…' : '已投：拒绝，等待另一对手…';
}

function showClaimRecvModal(data) {
  const isOpponent = BR.sideOf(data.claimer) !== BR.sideOf(MY_SEAT);
  const isDummy    = MY_SEAT === G.dummy;
  // 明手不参与投票，但若其正在代控庄家出牌，则可以投票
  const isDummyControlsDeclarer = isDummy && G.declarerControlledBy === MY_SEAT;
  const canVote    = !isDummy || isDummyControlsDeclarer;

  const titleEl = document.querySelector('#modal-claim-recv .modal-title');
  if (titleEl) { titleEl.innerHTML = `<i data-lucide="alert-triangle"></i> ${isOpponent ? '对方声称' : '同伴声称'}`; if (window.lucide) lucide.createIcons({ nodes: [titleEl] }); }

  const info = document.getElementById('claim-recv-info');
  info.innerHTML =
    `<p><strong>${data.claimerName}（${BR.SEAT_LABEL[data.claimer]}）</strong> 声称赢得剩余 <strong>${data.tricksToWin}</strong> 墩</p>` +
    (data.reason ? `<p style="color:var(--text-muted);font-size:.85rem;margin-top:.3rem">理由：${data.reason}</p>` : '') +
    (isDummy && !isDummyControlsDeclarer ? `<p style="color:var(--text-muted);font-size:.85rem;margin-top:.4rem">明手不参与投票。</p>` : '');

  // 仅对手可看到所有人手牌；同伴只能看基本信息
  const handsGrid = document.getElementById('claim-all-hands');
  handsGrid.innerHTML = '';
  if (isOpponent) {
    handsGrid.style.display = '';
    for (const s of ['N','E','S','W']) {
      const hand = data.allHands[s] || [];
      const block = document.createElement('div');
      block.className = 'claim-hand-block';
      block.innerHTML = `<div class="claim-hand-label">${BR.SEAT_LABEL[s]}（${BR.sideOf(s)}）${s === data.claimer ? ' ★声称方' : ''}</div>`;
      const cardsDiv = document.createElement('div');
      cardsDiv.className = 'claim-hand-cards';
      BR.sortHand(hand).forEach(card => {
        const el = makeCardEl(card, true);
        el.classList.add('disabled');
        el.style.transform = 'scale(.72)';
        el.style.marginRight = '-12px';
        cardsDiv.appendChild(el);
      });
      block.appendChild(cardsDiv);
      handsGrid.appendChild(block);
    }
  } else {
    handsGrid.style.display = 'none';
  }

  const btns = document.getElementById('claim-vote-btns');
  if (btns) btns.style.display = canVote ? 'flex' : 'none';

  document.getElementById('claim-vote-status').textContent = '';
  showModal('modal-claim-recv');
}

// ── 查看上一墩 ────────────────────────────────────────────────
function requestViewLast() {
  if (G.phase !== 'PLAYING') return;
  socket.emit('requestViewLastTrick');
}

function voteViewLast(approve) {
  socket.emit('viewLastTrickVote', { approve });
  const btns = document.getElementById('view-vote-btns');
  if (btns) btns.style.display = 'none';
  const status = document.getElementById('view-vote-status');
  if (status) status.textContent = approve ? '已同意，等待另一对手…' : '已拒绝，等待另一对手…';
}

function showLastTrickModal(trick) {
  const grid = document.getElementById('last-trick-display');
  grid.innerHTML = '';
  const visualOrder = [
    { vis: 'N', col: 2, row: 1 },
    { vis: 'W', col: 1, row: 2 },
    { vis: 'E', col: 3, row: 2 },
    { vis: 'S', col: 2, row: 3 }
  ];
  
  for (const { vis, col, row } of visualOrder) {
    const s = VISUAL_TO_SEAT[vis];
    const entry = trick.cards.find(c => c.seat === s);
    const slot  = document.createElement('div');
    slot.className = 'trick-card-slot';
    slot.style.gridColumn = col;
    slot.style.gridRow = row;
    
    const label = document.createElement('div');
    label.className = 'trick-seat-label';
    label.textContent = BR.SEAT_LABEL[s];
    slot.appendChild(label);
    
    if (entry) {
      const el = makeCardEl(entry.card, true);
      el.classList.add('disabled');
      slot.appendChild(el);
    }
    if (trick.winner === s) {
      const mark = document.createElement('div');
      mark.className = 'trick-winner-mark';
      mark.textContent = '✓ 赢墩';
      slot.appendChild(mark);
    }
    grid.appendChild(slot);
  }
  showModal('modal-last-trick');
}

// ── 下一副 ───────────────────────────────────────────────────
function doNextDeal() {
  socket.emit('nextDeal');
  const btn = document.getElementById('btn-next-deal');
  if (btn) { btn.disabled = true; btn.textContent = '等待其他玩家…'; }
}

function closeEndModal() {
  closeModal('modal-game-end');
}

function closeEndAndNextDeal() {
  socket.emit('nextDeal');
  const btn = document.getElementById('btn-end-next');
  if (btn) { btn.disabled = true; btn.textContent = '等待其他玩家…'; }
  // 不关闭弹窗，gameStart 事件触发后自动关闭
}

function openHistory() { openHistoryModal(); }

function openHistoryModal() {
  const scores = G.boardScores;
  const container = document.getElementById('modal-history-content');
  if (!container) return;
  if (!scores || !scores.length) {
    container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:2rem">\u6682\u65e0\u5386\u53f2\u6570\u636e\uff0c\u8bf7\u5148\u5b8c\u6210\u4e00\u5c40\u6e38\u620f\u3002</p>';
    showModal('modal-history');
    lucide.createIcons();
    return;
  }
  container.innerHTML = '';
  scores.forEach((s, i) => renderHistoryBoard(container, s, i));
  showModal('modal-history');
  lucide.createIcons();
}

const SUIT_SYM_H = { S:'\u2660', H:'\u2665', D:'\u2666', C:'\u2663' };

function histBidHtml(entry) {
  const bid = entry.bid;
  let base;
  if (bid === 'Pass')     base = `<span class="bh-pass">PASS</span>`;
  else if (bid === 'Double')   base = `<span class="bh-dbl">X</span>`;
  else if (bid === 'Redouble') base = `<span class="bh-rdbl">XX</span>`;
  else {
    const lv = bid[0], suit = bid.slice(1);
    const col = (suit === 'H' || suit === 'D') ? 'suit-red' : 'suit-black';
    const sym = suit === 'NT' ? 'NT' : SUIT_SYM_H[suit];
    base = `<span class="bh-bid">${lv}<span class="${col}">${sym}</span></span>`;
  }
  if (entry.alert !== null && entry.alert !== undefined) {
    const tip = entry.explain || ' ';
    return `<span class="bid-alerted" title="${tip.replace(/"/g,'&quot;')}">${base}<sup class="alert-marker">A</sup></span>`;
  }
  return base;
}

function renderHistoryBidding(history, dealer) {
  if (!history || !history.length) return '<div style="color:var(--text-muted);font-size:.8rem">\u65e0\u8bb0\u5f55</div>';
  const order = ['N','E','S','W'];
  const startIdx = order.indexOf(dealer || 'N');
  let html = '<table class="hist-table"><thead><tr>';
  for (let i = 0; i < 4; i++) {
    const s = order[(startIdx + i) % 4];
    html += `<th>${BR.SEAT_LABEL[s]}</th>`;
  }
  html += '</tr></thead><tbody>';
  let row = ''; let colIdx = startIdx;
  history.forEach(entry => {
    const col = order.indexOf(entry.seat);
    if (col === startIdx || row === '') {
      if (row) html += `<tr>${row}</tr>`;
      row = '';
      if (col !== startIdx) for (let i = startIdx; i < col; i++) row += '<td></td>';
      colIdx = col;
    }
    row += `<td>${histBidHtml(entry)}</td>`;
    colIdx = (colIdx + 1) % 4;
    if (colIdx === startIdx) { html += `<tr>${row}</tr>`; row = ''; }
  });
  if (row) html += `<tr>${row}</tr>`;
  html += '</tbody></table>';
  return html;
}

function renderHistoryBoard(container, s, boardIdx) {
  const block = document.createElement('div');
  block.className = 'hist-board-block';
  if (s.passedOut) {
    const ddHtml = s.ddTable ? renderDDTable(s.ddTable) : '';
    const bidHtml = s.biddingHistory?.length
      ? `<div class="hist-section"><div class="hist-section-title">\u53eb\u724c</div>${renderHistoryBidding(s.biddingHistory, s.biddingHistory[0]?.seat)}</div>`
      : '';
    block.innerHTML = `
      <div class="hist-board-header">
        <span class="hist-board-num">\u7b2c${s.dealNumber}\u526f</span>
        <span style="color:var(--text-muted)">\u5168\u4e0d\u53eb \u00b7 0\u5206</span>
      </div>
      ${bidHtml ? `<div class="hist-board-sections">${bidHtml}</div>` : ''}
      ${ddHtml}`;
    container.appendChild(block);
    return;
  }
  const diff = s.diff ?? (s.declarerTricks - s.needed);
  const cls  = s.score > 0 ? 'pos' : s.score < 0 ? 'neg' : '';
  const dTxt = diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : '=';
  const suit = s.contract.suit;
  const sym  = suit === 'NT' ? 'NT' : SUIT_SYM_H[suit];
  const col  = (suit === 'H' || suit === 'D') ? 'suit-red' : '';
  const dbl  = s.contract.redoubled ? 'XX' : s.contract.doubled ? 'X' : '';
  const contractHtml = `${s.contract.level}<span class="${col}">${sym}</span>${dbl}`;
  const dealer = s.biddingHistory?.[0]?.seat || 'N';
  const claimHtml = s.claim ? `<div class="hist-claim-note">\ud83c\udff3 \u58f0\u79f0\uff1a${BR.SEAT_LABEL[s.claim.claimer]} \u8d62\u5f97 ${s.claim.tricksToWin} \u58a9${s.claim.reason ? `\uff08${s.claim.reason}\uff09` : ''}</div>` : '';
  const repId = `replay-${boardIdx}`;
  block.innerHTML = `
    <div class="hist-board-header">
      <span class="hist-board-num">\u7b2c${s.dealNumber}\u526f</span>
      <span class="hist-board-contract">${contractHtml} \u5e84\uff1a${BR.SEAT_LABEL[s.declarer]}</span>
      <span class="hist-board-result ${cls}">${s.made ? '\u6210\u7ea6' : '\u5b9a\u7ea6'} ${dTxt} &middot; ${s.score > 0 ? '+' : ''}${s.score}\u5206</span>
    </div>
    <div class="hist-board-sections">
      <div class="hist-section">
        <div class="hist-section-title">\u53eb\u724c</div>
        ${renderHistoryBidding(s.biddingHistory, dealer)}
        ${claimHtml}
      </div>
      <div class="hist-section hist-section-replay">
        <div class="hist-section-title">\u51fa\u724c\u56de\u653e <span style="font-size:.7rem;color:var(--text-faint)">\uff08\u5171${s.completedTricks?.length ?? 0}\u58a9\uff09</span></div>
        <div id="${repId}"></div>
      </div>
    </div>`;
  container.appendChild(block);
  if (s.completedTricks?.length) {
    renderReplay(repId, s.completedTricks, s.dummy, s.declarer, s.initialHands);
  }
}

// ── \u52a8\u753b\u56de\u653e ────────────────────────────────────────────────────
const replayStates = {};

function renderReplay(containerId, tricks, dummy, declarer, initialHands) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  const plays = [];
  tricks.forEach((trick, ti) => {
    trick.cards.forEach(({seat, card}) => {
      plays.push({ seat, card, trickIdx: ti, isWinner: seat === trick.winner });
    });
  });
  replayStates[containerId] = { plays, current: 0, timer: null, dummy, declarer, initialHands: initialHands || null };
  wrap.innerHTML = `
    <div class="replay-wrap">
      <div class="replay-table" id="${containerId}-table"></div>
      <div class="replay-controls">
        <button class="replay-btn" onclick="replayGoStart('${containerId}')">|\u25c0</button>
        <button class="replay-btn" onclick="replayStep('${containerId}',-1)">\u25c0</button>
        <button class="replay-btn" id="${containerId}-play" onclick="replayTogglePlay('${containerId}')">\u25b6</button>
        <button class="replay-btn" onclick="replayStep('${containerId}',1)">\u25b6</button>
        <button class="replay-btn" onclick="replayGoEnd('${containerId}')">\u25b6|</button>
        <span class="replay-pos" id="${containerId}-pos">0 / ${plays.length}</span>
      </div>
      <div class="replay-timeline" id="${containerId}-timeline"></div>
    </div>`;
  buildReplayTimeline(containerId, plays, dummy);
  drawReplayTable(containerId, plays, 0, dummy, declarer, initialHands);
}

function buildReplayTimeline(cid, plays, dummy) {
  const tl = document.getElementById(`${cid}-timeline`);
  if (!tl) return;
  tl.innerHTML = '';
  let prevTrick = -1;
  plays.forEach((p, i) => {
    if (p.trickIdx !== prevTrick) {
      prevTrick = p.trickIdx;
      const sep = document.createElement('span');
      sep.className = 'replay-trick-sep';
      sep.textContent = `${p.trickIdx + 1}.`;
      tl.appendChild(sep);
    }
    const chip = document.createElement('button');
    chip.className = 'replay-chip';
    chip.id = `${cid}-chip-${i}`;
    const isRed = p.card.suit === 'H' || p.card.suit === 'D';
    chip.innerHTML = `<span class="${isRed ? 'suit-red' : ''}">${SUIT_SYM_H[p.card.suit]}${p.card.rank === 'T' ? '10' : p.card.rank}</span>`;
    if (p.seat === dummy) chip.style.opacity = '0.65';
    chip.title = `${BR.SEAT_LABEL[p.seat]}`;
    chip.addEventListener('click', () => {
      replayStates[cid].current = i + 1;
      updateReplay(cid);
    });
    tl.appendChild(chip);
  });
}

function drawReplayTable(cid, plays, upTo, dummy, declarer, initialHands) {
  const table = document.getElementById(`${cid}-table`);
  if (!table) return;
  const slotPos = { N: [2,1], W: [1,2], E: [3,2], S: [2,3] };
  table.innerHTML = '';
  table.style.cssText = 'display:grid;grid-template:auto auto auto/1fr 1fr 1fr;gap:4px;min-width:200px;';

  const nowPlays = plays.slice(0, upTo);
  const lastTi = upTo > 0 ? plays[upTo - 1].trickIdx : -1;
  const trickCards = nowPlays.filter(p => p.trickIdx === lastTi);
  const winnerSeat = trickCards.length === 4 ? trickCards.find(p => p.isWinner)?.seat : null;

  // \u91cd\u5efa\u5404\u5bb6\u5df2\u6253\u51fa\u7684\u724c\u96c6\u5408\uff08\u7528\u4e8e\u8ba1\u7b97\u624b\u724c\u5269\u4f59\uff09
  let handRemaining = null;
  if (initialHands) {
    handRemaining = {};
    for (const s of ['N','E','S','W']) {
      handRemaining[s] = initialHands[s] ? [...initialHands[s]] : [];
    }
    for (const p of nowPlays) {
      handRemaining[p.seat] = handRemaining[p.seat].filter(
        c => !(c.suit === p.card.suit && c.rank === p.card.rank)
      );
    }
  }

  for (const seat of ['N','E','S','W']) {
    const [gc, gr] = slotPos[seat];
    const slot = document.createElement('div');
    slot.style.cssText = `grid-column:${gc};grid-row:${gr};display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0;`;

    // \u5ea7\u4f4d\u6807\u7b7e
    const lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:.62rem;color:var(--text-muted);white-space:nowrap;margin-bottom:1px';
    lbl.textContent = BR.SEAT_LABEL[seat] + (seat === dummy ? '\u660e' : seat === declarer ? '\u5e84' : '');
    slot.appendChild(lbl);

    // \u672c\u58a9\u51fa\u724c
    const play = trickCards.find(p => p.seat === seat);
    if (play) {
      const isRed = play.card.suit === 'H' || play.card.suit === 'D';
      const chip = document.createElement('div');
      chip.className = 'replay-table-card' + (play.seat === winnerSeat ? ' winner' : '');
      chip.innerHTML = `<span class="${isRed ? 'suit-red' : ''}">${SUIT_SYM_H[play.card.suit]}${play.card.rank === 'T' ? '10' : play.card.rank}</span>`;
      slot.appendChild(chip);
    }

    // \u624b\u724c\u5269\u4f59
    if (handRemaining) {
      const rem = handRemaining[seat];
      const handDiv = document.createElement('div');
      handDiv.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;gap:1px;max-width:90px;margin-top:2px;';
      // \u6309\u82b1\u8272\u5206\u7ec4\u6392\u5e8f\u663e\u793a
      const bySuit = { S: [], H: [], D: [], C: [] };
      rem.forEach(c => { if (bySuit[c.suit]) bySuit[c.suit].push(c); });
      for (const suit of ['S','H','D','C']) {
        const cards = bySuit[suit].sort((a,b) => {
          const v = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };
          return (v[b.rank]||0) - (v[a.rank]||0);
        });
        cards.forEach(c => {
          const isRed = suit === 'H' || suit === 'D';
          const mini = document.createElement('span');
          mini.style.cssText = `font-size:.48rem;line-height:1.2;${isRed?'color:var(--red)':'color:var(--text-muted)'}`;
          mini.textContent = SUIT_SYM_H[suit] + (c.rank === 'T' ? '10' : c.rank);
          handDiv.appendChild(mini);
        });
      }
      if (rem.length === 0) {
        handDiv.style.cssText += 'color:var(--text-faint);font-size:.5rem;';
        handDiv.textContent = '\u65e0\u724c';
      }
      slot.appendChild(handDiv);
    }

    table.appendChild(slot);
  }
}

function updateReplay(cid) {
  const st = replayStates[cid];
  if (!st) return;
  drawReplayTable(cid, st.plays, st.current, st.dummy, st.declarer, st.initialHands);
  st.plays.forEach((_, i) => {
    const chip = document.getElementById(`${cid}-chip-${i}`);
    if (chip) chip.classList.toggle('active', i < st.current);
  });
  const pos = document.getElementById(`${cid}-pos`);
  if (pos) pos.textContent = `${st.current} / ${st.plays.length}`;
}

function replayStep(cid, d) {
  const st = replayStates[cid]; if (!st) return;
  st.current = Math.max(0, Math.min(st.plays.length, st.current + d));
  updateReplay(cid);
}
function replayGoStart(cid) { const st = replayStates[cid]; if (st) { st.current = 0; updateReplay(cid); } }
function replayGoEnd(cid)   { const st = replayStates[cid]; if (st) { st.current = st.plays.length; updateReplay(cid); } }
function replayTogglePlay(cid) {
  const st = replayStates[cid]; if (!st) return;
  const btn = document.getElementById(`${cid}-play`);
  if (st.timer) {
    clearInterval(st.timer); st.timer = null;
    if (btn) btn.textContent = '\u25b6';
  } else {
    if (btn) btn.textContent = '\u23f8';
    st.timer = setInterval(() => {
      if (st.current >= st.plays.length) {
        clearInterval(st.timer); st.timer = null;
        if (btn) btn.textContent = '\u25b6'; return;
      }
      st.current++; updateReplay(cid);
    }, 800);
  }
}

// ────────────────────────────────────────────────────────────────
// 结束弹窗
// ────────────────────────────────────────────────────────────────
function showEndModal(data) {
  const titleEl   = document.getElementById('end-title');
  const contentEl = document.getElementById('end-content');
  const histEl    = document.getElementById('end-history');

  if (data.passedOut) {
    titleEl.textContent = '全不叫 — 本副无人叫牌';
    contentEl.innerHTML = '<div class="end-score-big score-zero" style="color:var(--text-muted)">0 分</div>';
  } else {
    const scoreClass = data.score > 0 ? 'score-pos' : data.score < 0 ? 'score-neg' : 'score-zero';
    const madeStr    = data.made ? `成约 +${data.diff} 超额` : `宕 ${Math.abs(data.diff)} 墩`;
    titleEl.textContent = data.made ? '✓ 成约' : '✗ 宕约';
    titleEl.style.color = data.made ? 'var(--green)' : 'var(--red-soft)';

    contentEl.innerHTML =
      `<div class="end-contract-row">${contractText(data.contract, true)} &nbsp; 庄：${BR.SEAT_LABEL[data.declarer]}</div>` +
      `<div class="end-detail">${madeStr} · 赢 ${data.declarerTricks} 墩 · 需 ${data.needed} 墩 · ${vulLabel(data.vulnerability)}</div>` +
      `<div class="end-score-big ${scoreClass}">${data.score > 0 ? '+' : ''}${data.score}</div>` +
      `<div class="end-detail" style="margin-top:.2rem">${BR.sideOf(data.declarer)}方得 ${Math.abs(data.score)} 分</div>`;
  }

  // 历史
  if (data.boardScores?.length > 1) {
    histEl.innerHTML = '<h4>历史记录</h4>';
    let html = `<table class="score-history-table"><thead><tr><th>副</th><th>板</th><th>定约</th><th>庄</th><th>结果</th><th>得分</th></tr></thead><tbody>`;
    data.boardScores.forEach(s => {
      if (s.passedOut) {
        html += `<tr><td>${s.dealNumber}</td><td>-</td><td colspan="4" style="color:var(--text-muted)">全不叫</td></tr>`;
      } else {
        const cls  = s.score > 0 ? 'pos' : s.score < 0 ? 'neg' : '';
        const diff = s.diff ?? (s.declarerTricks - s.needed);
        const diffTxt = diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : '=';
        html += `<tr><td>${s.dealNumber}</td><td>${s.boardNumber}</td><td>${contractText(s.contract)}</td><td>${BR.SEAT_LABEL[s.declarer]}</td><td class="${cls}">${diffTxt}</td><td class="${cls}">${s.score > 0 ? '+' : ''}${s.score}</td></tr>`;
      }
    });
    html += '</tbody></table>';
    histEl.innerHTML += html;
  } else {
    histEl.innerHTML = '';
  }

  // 双明手分析表（优先用本次 data 里的，再 fallback 到 G.ddTable）
  const ddEl = document.getElementById('end-dd-table');
  const ddSrc = data.ddTable || G.ddTable;
  if (ddEl) ddEl.innerHTML = ddSrc ? renderDDTable(ddSrc) : '';

  showModal('modal-game-end');
}

// ── 双明手分析表渲染 ──────────────────────────────────────────────
function renderDDTable(table) {
  // table[strain][hand]: strain 0=S,1=H,2=D,3=C,4=NT; hand 0=N,1=E,2=S,3=W
  // 显示列顺序：♣♦♥♠NT；显示行顺序：N S E W
  const COLS = [
    { h: '♣', s: 3, cl: 'dd-c' },
    { h: '♦', s: 2, cl: 'dd-d' },
    { h: '♥', s: 1, cl: 'dd-h' },
    { h: '♠', s: 0, cl: 'dd-s' },
    { h: 'NT', s: 4, cl: 'dd-nt' },
  ];
  const ROWS = [
    { l: 'N', h: 0 }, { l: 'S', h: 2 },
    { l: 'E', h: 1 }, { l: 'W', h: 3 },
  ];
  let html = '<table class="dd-table"><thead><tr><th></th>';
  for (const c of COLS) html += `<th class="${c.cl}">${c.h}</th>`;
  html += '</tr></thead><tbody>';
  for (const r of ROWS) {
    html += `<tr><td class="dd-seat">${r.l}</td>`;
    for (const c of COLS) {
      const odd = table[c.s][r.h] - 6;
      html += odd > 0
        ? `<td class="dd-make">${odd}</td>`
        : `<td class="dd-nomake">-</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return `<div class="dd-wrap"><span class="dd-label">双明手分析</span>${html}</div>`;
}

// ────────────────────────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────────────────────────
function contractText(cc, html = false) {
  if (!cc) return '—';
  const suit = cc.suit;
  const sym  = suit === 'NT' ? 'NT' : BR.SUIT_SYMBOL[suit];
  const col  = (suit === 'H' || suit === 'D') ? 'var(--red)' : '#eee';
  const dbl  = cc.redoubled ? 'XX' : cc.doubled ? 'X' : '';
  if (html) {
    return `${cc.level}<span style="color:${col}">${sym}</span>${dbl}`;
  }
  return `${cc.level}${sym}${dbl}`;
}

function vulLabel(vul) {
  return BR.VUL_LABEL[vul] || vul;
}

function showPanel(id) {
  document.getElementById(id)?.classList.remove('hidden');
}
function hidePanel(id) {
  document.getElementById(id)?.classList.add('hidden');
}
function showModal(id) {
  document.getElementById(id)?.classList.remove('hidden');
}
function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
}
function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id) { document.getElementById(id)?.classList.add('hidden');    }

let toastTimer;
function showToast(msg) {
  const el = document.getElementById('game-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ── 教学模式 ─────────────────────────────────────────────────────
socket.on('declarerControlStart', ({ declarer, declarerHand }) => {
  G.declarerControlledBy = MY_SEAT; // this socket is the dummy player
  G.declarerHand = BR.sortHand(declarerHand, G.currentContract?.suit);
  G.declarerSelectedCard = null;
  showToast(`叫牌结束，本局由你代控庄家（${BR.SEAT_LABEL[declarer]}），视角已旋转180°`);
  // Rotate view to put declarer at visual S
  rebuildVisualMap(declarer);
  renderAllHands();
  renderNameplates();
  renderTeachPanel();
});

// 教学模式：动态重建视角映射（用于明手代控庄家，将 viewSeat 放在视觉南侧）
function rebuildVisualMap(viewSeat) {
  const arr = ['N','E','S','W'];
  const idx = arr.indexOf(viewSeat);
  for (const k in SEAT_TO_VISUAL) delete SEAT_TO_VISUAL[k];
  for (const k in VISUAL_TO_SEAT) delete VISUAL_TO_SEAT[k];
  for (const [vis, off] of [['S',0],['N',2],['W',1],['E',3]]) {
    const actual = arr[(idx + off) % 4];
    SEAT_TO_VISUAL[actual] = vis;
    VISUAL_TO_SEAT[vis]    = actual;
  }
}

// 教学面板：检查是否溢出视口，用 zoom 缩放使其完整可见
function fitTeachPanel() {
  const panel = document.getElementById('teach-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  panel.style.zoom = '';
  requestAnimationFrame(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const r  = panel.getBoundingClientRect();
    const over = Math.max(r.width / vw, r.height / vh);
    if (over > 1) panel.style.zoom = 1 / over;
  });
}

// 教学面板：在打牌/叫牌阶段显示当前教学座位的手牌或声称操作
function renderTeachPanel() {
  const panel = document.getElementById('teach-panel');
  if (!panel) return;

  const isPanelNeeded =
    (G.teachingMode && G.phase === 'PLAYING' && G.teachingCurrentSeat !== null) ||
    (G.teachingMode && G.phase === 'BIDDING' && G.teachingCurrentSeat !== null) ||
    (G.declarerControlledBy === MY_SEAT && G.phase === 'PLAYING' &&
     G.currentPlayer === G.declarer);

  if (!isPanelNeeded) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  // 根据当前出牌方位，把面板停靠到对应边
  const activeSeat = (G.declarerControlledBy === MY_SEAT && G.currentPlayer === G.declarer)
    ? G.declarer
    : G.teachingCurrentSeat;
  if (activeSeat) panel.dataset.vis = SEAT_TO_VISUAL[activeSeat];

  fitTeachPanel();

  const labelEl = document.getElementById('teach-panel-label');
  const handEl  = document.getElementById('teach-hand-area');
  const bidEl   = document.getElementById('teach-bid-area');
  const playBtn = document.getElementById('teach-play-confirm');

  handEl.innerHTML = '';
  bidEl.classList.add('hidden');
  playBtn.classList.add('hidden');

  // 明手代控庄家出牌
  if (G.declarerControlledBy === MY_SEAT && G.phase === 'PLAYING'
      && G.currentPlayer === G.declarer) {
    const seat = G.declarer;
    if (labelEl) labelEl.textContent = `代控庄家 ${BR.SEAT_LABEL[seat]}（${G.playerNames[seat] || seat}）`;
    const hand = G.declarerHand || [];
    renderTeachHand(hand, seat);
    return;
  }

  // 教学座位出牌 / 叫牌
  const seat = G.teachingCurrentSeat;
  const hand = G.teachingCurrentHand || G.teachingHands[seat] || [];
  const seatName = G.playerNames[seat] || BR.SEAT_LABEL[seat];
  if (labelEl) {
    const action = G.phase === 'BIDDING' ? '叫牌' : '出牌';
    labelEl.textContent = `教学：${seatName}（${BR.SEAT_LABEL[seat]}） ${action}`;
  }

  if (G.phase === 'PLAYING') {
    renderTeachHand(hand, seat);
  } else {
    // 叫牌阶段：教学座位的手牌仅展示，叫品通过中央叫牌覆层操作
    renderTeachHandDisplay(hand);
  }
}

// 渲染教学面板中的可交互手牌（出牌用）
function renderTeachHand(hand, seat) {
  const handEl = document.getElementById('teach-hand-area');
  if (!handEl) return;
  handEl.innerHTML = '';

  // 确定强制跟色
  let mandatorySuit = null;
  if (G.currentTrick && G.currentTrick.length > 0) {
    const ledSuit = G.currentTrick[0].card.suit;
    if (hand.some(c => c.suit === ledSuit)) mandatorySuit = ledSuit;
  }

  const groups = BR.groupBySuit(hand);
  const suits  = BR.suitOrder(G.currentContract?.suit);
  for (const suit of suits) {
    if (!groups[suit].length) continue;
    const grp = document.createElement('div');
    grp.className = 'teach-suit-group';

    for (const card of groups[suit]) {
      const el = makeCardEl(card, false);
      el.classList.add('teach-card');
      if (mandatorySuit && card.suit !== mandatorySuit) {
        el.classList.add('card-inert');
      }
      const isSelected = G.declarerControlledBy === MY_SEAT && G.declarerSelectedCard
        ? G.declarerSelectedCard.suit === card.suit && G.declarerSelectedCard.rank === card.rank
        : G._teachSelectedCard
          ? G._teachSelectedCard.suit === card.suit && G._teachSelectedCard.rank === card.rank
          : false;
      if (isSelected) el.classList.add('selected');
      el.onclick = () => teachSelectCard(card, seat);
      grp.appendChild(el);
    }
    handEl.appendChild(grp);
  }

  const playBtn = document.getElementById('teach-play-confirm');
  if (playBtn && (G._teachSelectedCard || (G.declarerControlledBy === MY_SEAT && G.declarerSelectedCard))) {
    const c = G.declarerControlledBy === MY_SEAT ? G.declarerSelectedCard : G._teachSelectedCard;
    const btn = document.getElementById('teach-btn-play');
    if (btn && c) btn.textContent = `出牌：${BR.SUIT_SYMBOL[c.suit]}${c.rank}`;
    playBtn.classList.remove('hidden');
  }
}

// 渲染教学面板中的纯展示手牌（叫牌阶段）
function renderTeachHandDisplay(hand) {
  const handEl = document.getElementById('teach-hand-area');
  if (!handEl) return;
  handEl.innerHTML = '';
  const groups = BR.groupBySuit(hand);
  for (const suit of BR.suitOrder(G.currentContract?.suit)) {
    if (!groups[suit].length) continue;
    const grp = document.createElement('div');
    grp.className = 'teach-suit-group';
    for (const card of groups[suit]) {
      const el = makeCardEl(card, false);
      el.classList.add('teach-card', 'card-inert');
      grp.appendChild(el);
    }
    handEl.appendChild(grp);
  }
}

function teachSelectCard(card, seat) {
  if (G.declarerControlledBy === MY_SEAT && seat === G.declarer) {
    G.declarerSelectedCard = (G.declarerSelectedCard?.suit === card.suit &&
      G.declarerSelectedCard?.rank === card.rank) ? null : card;
  } else {
    G._teachSelectedCard = (G._teachSelectedCard?.suit === card.suit &&
      G._teachSelectedCard?.rank === card.rank) ? null : card;
  }
  renderTeachPanel();
}

function teachConfirmPlay() {
  const card = G.declarerControlledBy === MY_SEAT ? G.declarerSelectedCard : G._teachSelectedCard;
  if (!card) return;
  socket.emit('playCard', { card });
  G.declarerSelectedCard = null;
  G._teachSelectedCard   = null;
}

function teachCancelCard() {
  G.declarerSelectedCard = null;
  G._teachSelectedCard   = null;
  renderTeachPanel();
}

// 教学模式：声称时使用当前教学座位或自己
function openClaimModalTeach() {
  openClaimModal(); // reuse existing claim modal
}
