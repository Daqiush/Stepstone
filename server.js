'use strict';
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');

let calcDDTable = null;
let solveBoard  = null;
try {
  const ddsWrapper = require('./dds-wrapper');
  calcDDTable = ddsWrapper.calcDDTable;
  solveBoard  = ddsWrapper.solveBoard;
  console.log('[DDS] wrapper loaded OK');
} catch (e) {
  console.error('[DDS] require failed:', e.message);
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
const PORT   = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ────────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────────
const SEATS      = ['N', 'E', 'S', 'W'];
const SUITS      = ['S', 'H', 'D', 'C'];
const RANKS      = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const RANK_VAL   = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };
const SUIT_ORDER = { C:0, D:1, H:2, S:3, NT:4 };

// 16副牌局况与庄位表（正式定约桥牌标准）
const BOARD_INFO = [
  null,
  { vul:'NONE', dealer:'N' }, // 1
  { vul:'NS',   dealer:'E' }, // 2
  { vul:'EW',   dealer:'S' }, // 3
  { vul:'BOTH', dealer:'W' }, // 4
  { vul:'NS',   dealer:'N' }, // 5
  { vul:'EW',   dealer:'E' }, // 6
  { vul:'BOTH', dealer:'S' }, // 7
  { vul:'NONE', dealer:'W' }, // 8
  { vul:'EW',   dealer:'N' }, // 9
  { vul:'BOTH', dealer:'E' }, // 10
  { vul:'NONE', dealer:'S' }, // 11
  { vul:'NS',   dealer:'W' }, // 12
  { vul:'BOTH', dealer:'N' }, // 13
  { vul:'NONE', dealer:'E' }, // 14
  { vul:'NS',   dealer:'S' }, // 15
  { vul:'EW',   dealer:'W' }, // 16
];

// ────────────────────────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────────────────────────
const nextSeat   = s => SEATS[(SEATS.indexOf(s) + 1) % 4];
const partner    = s => SEATS[(SEATS.indexOf(s) + 2) % 4];
const sideOf     = s => (s === 'N' || s === 'S') ? 'NS' : 'EW';
const opponents  = s => SEATS.filter(x => sideOf(x) !== sideOf(s));

function bidVal(bid) {
  if (['Pass','Double','Redouble'].includes(bid)) return -1;
  return parseInt(bid[0]) * 5 + SUIT_ORDER[bid.slice(1)];
}

function parseSuit(bid) { // "4S" → "S", "3NT" → "NT"
  return bid.slice(1);
}

function createDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit:s, rank:r });
  return d;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function removeOneCard(hand, card) {
  const idx = hand.findIndex(c => c.suit === card.suit && Math.abs(c.rank - card.rank) < 1e-9);
  if (idx !== -1) {
    const newHand = [...hand];
    newHand.splice(idx, 1);
    return newHand;
  }
  return hand;
}

function generateUltDeck() {
  const deck = [];
  const suits = ['S', 'H', 'D', 'C'];
  for (let i = 0; i < 52; i++) {
    const x = -2 * Math.log(Math.random() * Math.random());
    let rank = clampRank(14 - x);
    deck.push({ suit: suits[Math.floor(Math.random() * 4)], rank });
  }
  return deck;
}

function dealCards() {
  const d = shuffle(createDeck());
  return { N: d.slice(0,13), E: d.slice(13,26), S: d.slice(26,39), W: d.slice(39,52) };
}

function generateRoomId() {
  return String(Math.floor(Math.random() * 1000)).padStart(3, '0');
}

// ────────────────────────────────────────────────────────────────
// 计分（定约桥牌，每副独立计分）
// ────────────────────────────────────────────────────────────────
function calcScore(contract, vulnerable, declarerTricks) {
  if (!contract || contract.suit === 'Pass') return 0;
  const { level, suit, doubled, redoubled } = contract;
  const needed = level + 6;

  if (declarerTricks < needed) {
    // 宕约罚分
    const n = needed - declarerTricks;
    let penalty = 0;
    if (!doubled && !redoubled) {
      penalty = n * (vulnerable ? 100 : 50);
    } else {
      let dbl;
      if (vulnerable) {
        dbl = n === 1 ? 200 : 200 + (n - 1) * 300;
      } else {
        if      (n === 1) dbl = 100;
        else if (n === 2) dbl = 300;
        else if (n === 3) dbl = 500;
        else              dbl = 500 + (n - 3) * 300;
      }
      penalty = redoubled ? dbl * 2 : dbl;
    }
    return -penalty;
  }

  // 成约
  const overtricks = declarerTricks - needed;

  // 基础墩分
  let trickScore;
  if (suit === 'NT')               trickScore = 40 + 30 * (level - 1);
  else if (suit === 'H' || suit === 'S') trickScore = 30 * level;
  else                             trickScore = 20 * level;

  if (doubled)   trickScore *= 2;
  if (redoubled) trickScore *= 4;

  let score = trickScore;

  // 得局/部分分奖励
  if (trickScore >= 100) score += vulnerable ? 500 : 300;
  else                   score += 50;

  // 满贯奖励
  if (level === 6) score += vulnerable ? 750 : 500;
  if (level === 7) score += vulnerable ? 1500 : 1000;

  // 加倍侮辱分
  if (doubled)   score += 50;
  if (redoubled) score += 100;

  // 超额墩
  if (overtricks > 0) {
    let ot;
    if (!doubled && !redoubled) {
      ot = overtricks * (suit === 'C' || suit === 'D' ? 20 : 30);
    } else {
      ot = overtricks * (vulnerable ? 200 : 100) * (redoubled ? 2 : 1);
    }
    score += ot;
  }

  return score;
}

// ────────────────────────────────────────────────────────────────
// 叫牌验证
// ────────────────────────────────────────────────────────────────
function validateBid(bid, room, seat) {
  if (seat !== room.currentBidder) return { ok: false, msg: '还没到你叫牌' };
  if (bid === 'Pass') return { ok: true };

  const cc = room.currentContract;

  if (bid === 'Double') {
    if (!cc)                              return { ok: false, msg: '没有可加倍的定约' };
    if (sideOf(cc.seat) === sideOf(seat)) return { ok: false, msg: '不能加倍己方定约' };
    if (cc.doubled)                       return { ok: false, msg: '定约已被加倍' };
    return { ok: true };
  }

  if (bid === 'Redouble') {
    if (!cc || !cc.doubled)               return { ok: false, msg: '定约未被加倍' };
    if (cc.redoubled)                     return { ok: false, msg: '定约已被再加倍' };
    if (sideOf(cc.doublerSeat) === sideOf(seat)) return { ok: false, msg: '不能再加倍己方的加倍' };
    return { ok: true };
  }

  // 正常叫品
  if (cc && bidVal(bid) <= bidVal(`${cc.level}${cc.suit}`)) {
    return { ok: false, msg: '叫品必须高于当前定约' };
  }
  return { ok: true };
}

// ────────────────────────────────────────────────────────────────
// 确定庄家（首先叫出最终定约花色的本方牌手）
// ────────────────────────────────────────────────────────────────
function getDeclarer(history, finalSuit, winnerSeat) {
  const side = sideOf(winnerSeat);
  const sideSeats = side === 'NS' ? ['N','S'] : ['E','W'];
  for (const e of history) {
    if (!sideSeats.includes(e.seat)) continue;
    if (['Pass','Double','Redouble'].includes(e.bid)) continue;
    if (parseSuit(e.bid) === finalSuit) return e.seat;
  }
  return winnerSeat;
}

// ────────────────────────────────────────────────────────────────
// 赢墩判定
// ────────────────────────────────────────────────────────────────
function trickWinner(trick, trumpSuit) {
  const ledSuit = trick[0].card.suit;
  const hasTrump = trumpSuit && trumpSuit !== 'NT';
  let best = trick[0];
  for (let i = 1; i < trick.length; i++) {
    const cur = trick[i];
    const bC = best.card, cC = cur.card;
    const bT = hasTrump && bC.suit === trumpSuit;
    const cT = hasTrump && cC.suit === trumpSuit;
    if (cT && !bT) { best = cur; continue; }
    if (cT && bT && RANK_VAL[cC.rank] > RANK_VAL[bC.rank]) { best = cur; continue; }
    if (!cT && !bT && cC.suit === ledSuit && RANK_VAL[cC.rank] > RANK_VAL[bC.rank]) { best = cur; }
  }
  return best.seat;
}

// ────────────────────────────────────────────────────────────────
// 房间数据结构
// ────────────────────────────────────────────────────────────────
function makeRoom(id) {
  return {
    id,
    sockets:       { N:null, E:null, S:null, W:null },
    playerNames:   { N:null, E:null, S:null, W:null },
    readyStatus:   { N:false, E:false, S:false, W:false }, // 仅用于下一副准备
    ownerSocketId: null, // 创建房间的玩家（房主）
    phase: 'LOBBY',  // LOBBY | BIDDING | PLAYING | SCORING
    dealNumber: 1,
    boardInfo: null,
    hands: null,
    // 叫牌
    biddingHistory:   [],
    currentBidder:    null,
    currentContract:  null,
    consecutivePasses: 0,
    // 打牌
    declarer:       null,
    dummy:          null,
    leader:         null,
    currentPlayer:  null,
    currentTrick:   [],
    completedTricks: [],
    nsTricks: 0,
    ewTricks: 0,
    dummyRevealed: false,
    // 声称
    claimReq: null,
    // 查看上一墩
    viewReq: null,
    // 声称记录（用于历史）
    lastClaim: null,
    // 分数历史
    boardScores: [],
    // 教学模式
    mode:                'classic',
    teachingMode:         false,
    ownerName:            '',
    ownerControlledSeats: [],
    declarerControlledBy: null,
  };
}

// ────────────────────────────────────────────────────────────────
// 大招模式重连状态恢复
// ────────────────────────────────────────────────────────────────
function sendUltReconnectState(room, seat, sock) {
  const phase = room.phase;

  if (phase === 'ULT_CHAR_SELECT') {
    sock.emit('ultCharOptions', {
      seat,
      seatOptions:   room.charOptions,
      playerNames:   room.playerNames,
      vulnerability: room.boardInfo.vul,
      dealer:        room.boardInfo.dealer,
    });
    // 已选角色的广播
    for (const s of SEATS) {
      if (room.characters[s]) {
        const ch = getChar(room.characters[s]);
        sock.emit('ultCharChosen', { seat: s, charId: room.characters[s], charName: ch?.name || room.characters[s] });
      }
    }
    return;
  }

  if (phase === 'ULT_BID_PREP') {
    const bidStartSkills = getAvailableSkills(room, seat, 'bid_start');
    sock.emit('ultBidPrepStart', {
      seat,
      hand:            room.hands[seat],
      handSizes:       getHandSizesFor(room),
      playerNames:     room.playerNames,
      characters:      room.characters,
      availableSkills: bidStartSkills,
      vulnerability:   room.boardInfo.vul,
      dealer:          room.boardInfo.dealer,
    });
    const readySeats = SEATS.filter(s => room.ultBidPrepReady?.[s]);
    if (readySeats.length) sock.emit('ultBidPrepReadyUpdate', { readySeats });
    return;
  }

  if (phase === 'BIDDING') {
    // ult 叫牌阶段
    sock.emit('ultBidPhaseStart', {
      dealer:        room.boardInfo.dealer,
      vulnerability: room.boardInfo.vul,
      playerNames:   room.playerNames,
      characters:    room.characters,
    });
    sock.emit('biddingUpdate', {
      biddingHistory:    room.biddingHistory,
      currentBidder:     room.currentBidder,
      currentContract:   room.currentContract,
      consecutivePasses: room.consecutivePasses,
      hand:              room.hands[seat],
      validBids:         {},
    });
    return;
  }

  if (phase === 'ULT_BID_END') {
    const bidEndSkills = getAvailableSkills(room, seat, 'bid_end');
    sock.emit('ultBidEndStart', {
      seat,
      hand:            room.hands[seat],
      handSizes:       getHandSizesFor(room),
      playerNames:     room.playerNames,
      characters:      room.characters,
      availableSkills: bidEndSkills,
      contract:        room.currentContract,
      declarer:        room.declarer,
    });
    const readySeats = SEATS.filter(s => room.ultBidEndReady?.[s]);
    if (readySeats.length) sock.emit('ultBidEndReadyUpdate', { readySeats });
    return;
  }

  if (phase === 'PLAYING') {
    sock.emit('ultGameStart', {
      seat,
      hand:          room.hands[seat],
      handSizes:     getHandSizesFor(room),
      playerNames:   room.playerNames,
      characters:    room.characters || {},
      currentPlayer: room.currentPlayer,
      leader:        room.leader,
      contract:      room.currentContract,
      declarer:      room.declarer,
      vulnerability: room.boardInfo.vul,
      playSkills:    getAvailableSkills(room, seat, 'play_time'),
    });
    sock.emit('ultPlayUpdate', {
      currentPlayer:  room.currentPlayer,
      currentTrick:   room.currentTrick,
      completedCount: room.completedTricks.length,
      nsTricks:       room.nsTricks,
      ewTricks:       room.ewTricks,
      handSizes:      getHandSizesFor(room),
      leader:         room.leader,
    });
    return;
  }

  if (phase === 'SCORING') {
    // 重发上局结果
    sock.emit('ultGameEnd', {
      nsTricks:  room.nsTricks,
      ewTricks:  room.ewTricks,
      winner:    room.nsTricks > room.ewTricks ? 'NS' : room.ewTricks > room.nsTricks ? 'EW' : 'TIE',
      playerNames: room.playerNames,
      contract:  room.currentContract,
      declarer:  room.declarer,
    });
    return;
  }
}

// ────────────────────────────────────────────────────────────────
// 重连状态恢复
// ────────────────────────────────────────────────────────────────
function sendReconnectState(room, seat, sock) {
  // 大招模式：独立重连流程
  if (room.mode === 'ult') {
    sendUltReconnectState(room, seat, sock);
    return;
  }

  sock.emit('gameStart', {
    hand:        room.hands[seat],
    boardInfo:   room.boardInfo,
    seat,
    playerNames: room.playerNames,
    boardScores: room.boardScores,
  });

  if (room.phase === 'BIDDING') {
    sock.emit('biddingUpdate', {
      history:           room.biddingHistory,
      currentBidder:     room.currentBidder,
      currentContract:   room.currentContract,
      consecutivePasses: room.consecutivePasses,
    });
    return;
  }

  // PLAYING 或 SCORING
  sock.emit('biddingEnd', {
    contract:       room.currentContract,
    declarer:       room.declarer,
    dummy:          room.dummy,
    leader:         room.leader,
    biddingHistory: room.biddingHistory,
  });

  if (room.dummyRevealed) {
    sock.emit('dummyRevealed', {
      dummy:     room.dummy,
      dummyHand: room.hands[room.dummy],
    });
  }

  if (room.phase === 'PLAYING') {
    sock.emit('playUpdate', {
      currentPlayer:  room.currentPlayer,
      currentTrick:   room.currentTrick,
      completedCount: room.completedTricks.length,
      nsTricks:       room.nsTricks,
      ewTricks:       room.ewTricks,
      dummyRevealed:  room.dummyRevealed,
      dummy:          room.dummy,
      declarer:       room.declarer,
    });

    // 重连时恢复进行中的投票状态
    if (room.claimReq) {
      const req = room.claimReq;
      const remaining = 13 - room.completedTricks.length;
      sock.emit('claimRequest', {
        claimer:     req.claimer,
        claimerName: room.playerNames[req.claimer],
        tricksToWin: req.tricksToWin,
        reason:      req.reason,
        allHands:    room.hands,
        remaining,
        claimerSide: sideOf(req.claimer),
      });
      if (Object.keys(req.votes).length > 0) {
        sock.emit('claimVoteUpdate', { votes: req.votes, voters: req.voters });
      }
    }

    if (room.viewReq) {
      const req = room.viewReq;
      sock.emit('viewLastTrickRequest', {
        requester:     req.requester,
        requesterName: room.playerNames[req.requester],
      });
      if (Object.keys(req.votes).length > 0) {
        sock.emit('viewLastTrickVoteUpdate', { votes: req.votes });
      }
    }
  } else {
    // SCORING
    const ls = room.boardScores[room.boardScores.length - 1];
    if (ls) {
      const payload = ls.passedOut
        ? { passedOut: true, score: 0, boardScores: room.boardScores, ddTable: ls.ddTable || null }
        : {
            passedOut: false,
            contract:       ls.contract,
            declarer:       ls.declarer,
            dummy:          room.dummy,
            declarerTricks: ls.declarerTricks,
            needed:         ls.needed,
            score:          ls.score,
            made:           ls.made,
            diff:           ls.diff,
            vulnerability:  ls.vulnerability,
            boardScores:    room.boardScores,
            ddTable:        ls.ddTable || null,
          };
      sock.emit('gameEnd', payload);
    }
  }
}

function sendTeachingReconnectState(room, sock) {
  const teachingHands = {};
  for (const ts of room.ownerControlledSeats) teachingHands[ts] = room.hands[ts];
  const primarySeat = room.ownerControlledSeats[0];
  sock.emit('gameStart', {
    hand:          room.hands[primarySeat],
    boardInfo:     room.boardInfo,
    seat:          primarySeat,
    playerNames:   room.playerNames,
    teachingMode:  true,
    teachingSeats: room.ownerControlledSeats,
    teachingHands,
    boardScores:   room.boardScores,
  });
  if (room.phase === 'BIDDING') {
    const teachingCurrentSeat = room.ownerControlledSeats.includes(room.currentBidder)
      ? room.currentBidder : null;
    sock.emit('biddingUpdate', {
      history:              room.biddingHistory,
      currentBidder:        room.currentBidder,
      currentContract:      room.currentContract,
      consecutivePasses:    room.consecutivePasses,
      teachingCurrentSeat,
      teachingCurrentHand:  teachingCurrentSeat ? room.hands[teachingCurrentSeat] : null,
    });
    return;
  }
  sock.emit('biddingEnd', {
    contract:             room.currentContract,
    declarer:             room.declarer,
    dummy:                room.dummy,
    leader:               room.leader,
    biddingHistory:       room.biddingHistory,
    declarerControlledBy: room.declarerControlledBy,
  });
  if (room.declarerControlledBy) {
    sock.emit('declarerControlStart', {
      declarer:     room.declarer,
      declarerHand: room.hands[room.declarer],
    });
  }
  if (room.dummyRevealed) {
    sock.emit('dummyRevealed', { dummy: room.dummy, dummyHand: room.hands[room.dummy] });
  }
  if (room.phase === 'PLAYING') {
    const teachingCurrentSeat = room.ownerControlledSeats.includes(room.currentPlayer)
      ? room.currentPlayer : null;
    sock.emit('playUpdate', {
      currentPlayer:        room.currentPlayer,
      currentTrick:         room.currentTrick,
      completedCount:       room.completedTricks.length,
      nsTricks:             room.nsTricks,
      ewTricks:             room.ewTricks,
      dummyRevealed:        room.dummyRevealed,
      dummy:                room.dummy,
      declarer:             room.declarer,
      declarerControlledBy: room.declarerControlledBy,
      teachingCurrentSeat,
      teachingCurrentHand:  teachingCurrentSeat ? room.hands[teachingCurrentSeat] : null,
    });
  } else {
    const ls = room.boardScores[room.boardScores.length - 1];
    if (ls) {
      const payload = ls.passedOut
        ? { passedOut: true, score: 0, boardScores: room.boardScores, ddTable: ls.ddTable || null }
        : { passedOut: false, contract: ls.contract, declarer: ls.declarer, dummy: room.dummy,
            declarerTricks: ls.declarerTricks, needed: ls.needed, score: ls.score,
            made: ls.made, diff: ls.diff, vulnerability: ls.vulnerability, boardScores: room.boardScores, ddTable: ls.ddTable || null };
      sock.emit('gameEnd', payload);
    }
  }
}

// ────────────────────────────────────────────────────────────────
// 广播辅助
// ────────────────────────────────────────────────────────────────
function roomState(room) {
  return {
    playerNames:          room.playerNames,
    readyStatus:          room.readyStatus,
    ownerSocketId:        room.ownerSocketId,
    phase:                room.phase,
    dealNumber:           room.dealNumber,
    boardScores:          room.boardScores,
    mode:                 room.mode,
    characters:           room.characters || {},
    teachingMode:         room.teachingMode,
    ownerControlledSeats: room.ownerControlledSeats,
  };
}

function bcastBidding(room) {
  const ownerSock = room.teachingMode ? room.ownerSocketId : null;
  let ownerSent = false;
  for (const s of SEATS) {
    const sock = room.sockets[s];
    if (!sock) continue;
    if (ownerSock && sock === ownerSock) {
      if (ownerSent) continue;
      ownerSent = true;
      // 教学模式：房主看到所有 alert，外加当前教学座位的手牌
      const teachingCurrentSeat = room.ownerControlledSeats.includes(room.currentBidder)
        ? room.currentBidder : null;
      io.to(ownerSock).emit('biddingUpdate', {
        history:              room.biddingHistory,
        currentBidder:        room.currentBidder,
        currentContract:      room.currentContract,
        consecutivePasses:    room.consecutivePasses,
        teachingCurrentSeat,
        teachingCurrentHand:  teachingCurrentSeat ? room.hands[teachingCurrentSeat] : null,
      });
      continue;
    }
    const filteredHistory = room.biddingHistory.map(e => {
      const isOpponent = sideOf(e.seat) !== sideOf(s);
      const isSelf = e.seat === s;
      if (isOpponent || isSelf) return e;
      return { seat: e.seat, bid: e.bid };
    });
    io.to(sock).emit('biddingUpdate', {
      history:           filteredHistory,
      currentBidder:     room.currentBidder,
      currentContract:   room.currentContract,
      consecutivePasses: room.consecutivePasses,
    });
  }
}

function bcastPlay(room) {
  // 明手是房主控制、庄家是真实玩家时，轮到明手出牌应由庄家操作，不触发教学面板
  const dumIsOwner    = room.ownerControlledSeats.includes(room.dummy);
  const decIsReal     = !room.ownerControlledSeats.includes(room.declarer);
  const ownerYieldsDummy = room.teachingMode && dumIsOwner && decIsReal && room.currentPlayer === room.dummy;
  const teachingCurrentSeat = room.teachingMode
    && room.ownerControlledSeats.includes(room.currentPlayer)
    && !ownerYieldsDummy
    ? room.currentPlayer : null;
  io.to(room.id).emit('playUpdate', {
    currentPlayer:       room.currentPlayer,
    currentTrick:        room.currentTrick,
    completedCount:      room.completedTricks.length,
    nsTricks:            room.nsTricks,
    ewTricks:            room.ewTricks,
    dummyRevealed:       room.dummyRevealed,
    dummy:               room.dummy,
    declarer:            room.declarer,
    declarerControlledBy: room.declarerControlledBy,
    teachingCurrentSeat,
    teachingCurrentHand: teachingCurrentSeat ? room.hands[teachingCurrentSeat] : null,
  });
}

// ────────────────────────────────────────────────────────────────
// 游戏流程
// ────────────────────────────────────────────────────────────────
function startGame(room) {
  const bn = ((room.dealNumber - 1) % 16) + 1;
  const bi = BOARD_INFO[bn];
  room.boardInfo      = { ...bi, number: bn, dealNumber: room.dealNumber };
  room.phase          = 'BIDDING';
  room.hands          = dealCards(room.mode);
  room.initialHands   = { N: [...room.hands.N], E: [...room.hands.E], S: [...room.hands.S], W: [...room.hands.W] };
  room.ddTable        = null;
  if (calcDDTable) {
    calcDDTable(room.hands).then(table => {
      console.log('[DDS] computed for room', room.id, '→', table?.[4]);
      room.ddTable = table;
      if (room.phase === 'SCORING' && room.boardScores.length > 0) {
        const ls = room.boardScores[room.boardScores.length - 1];
        ls.ddTable = table;
        io.to(room.id).emit('ddTableReady', { ddTable: table });
      }
    }).catch(err => { console.error('[DDS] error:', err.message); });
  }
  room.biddingHistory = [];
  room.currentBidder  = bi.dealer;
  room.currentContract = null;
  room.consecutivePasses = 0;
  room.declarer = room.dummy = room.leader = room.currentPlayer = null;
  room.currentTrick = [];
  room.completedTricks = [];
  room.nsTricks = room.ewTricks = 0;
  room.dummyRevealed = false;
  room.claimReq = room.viewReq = null;

  // 每位牌手只收到自己的手牌（教学模式：房主统一接收一个合并事件）
  const ownerSock = room.teachingMode ? room.ownerSocketId : null;
  let ownerSent = false;
  for (const s of SEATS) {
    if (!room.sockets[s]) continue;
    if (ownerSock && room.sockets[s] === ownerSock) {
      if (!ownerSent) {
        ownerSent = true;
        const teachingHands = {};
        for (const ts of room.ownerControlledSeats) teachingHands[ts] = room.hands[ts];
        const primarySeat = room.ownerControlledSeats[0];
        io.to(ownerSock).emit('gameStart', {
          hand:          room.hands[primarySeat],
          boardInfo:     room.boardInfo,
          seat:          primarySeat,
          playerNames:   room.playerNames,
          teachingMode:  true,
          teachingSeats: room.ownerControlledSeats,
          teachingHands,
          boardScores:   room.boardScores,
        });
      }
    } else {
      io.to(room.sockets[s]).emit('gameStart', {
        hand:        room.hands[s],
        boardInfo:   room.boardInfo,
        seat:        s,
        playerNames: room.playerNames,
        boardScores: room.boardScores,
      });
    }
  }
  bcastBidding(room);
}

function finishBidding(room) {
  const cc = room.currentContract;
  if (!cc) {
    if (room.mode === 'ult') {
      // 大招模式全Pass：重新发牌
      io.to(room.id).emit('ultBidMsg', { msg: '全体Pass，重新发牌……' });
      room.dealNumber++;
      setTimeout(() => startUltGame(room), 1500);
      return;
    }
    // 经典模式全Pass
    room.phase = 'SCORING';
    room.boardScores.push({
      dealNumber:  room.dealNumber,
      boardNumber: room.boardInfo.number,
      score:       0,
      passedOut:   true,
      ddTable:     room.ddTable || null,
      biddingHistory: [...room.biddingHistory],
      initialHands:   room.initialHands,
    });
    io.to(room.id).emit('gameEnd', {
      passedOut:   true,
      score:       0,
      boardScores: room.boardScores,
      ddTable:     room.ddTable || null,
    });
    return;
  }

  const declarer = getDeclarer(room.biddingHistory, cc.suit, cc.seat);
  room.declarer = declarer;
  room.dummy    = partner(declarer);
  room.leader   = nextSeat(declarer);
  room.currentPlayer = room.leader;

  if (room.mode === 'ult') {
    // 大招模式：叫牌结束 → 进入叫牌结束技能阶段
    room.phase = 'ULT_BID_END';
    io.to(room.id).emit('biddingEnd', {
      contract: cc, declarer, dummy: room.dummy, leader: room.leader,
      biddingHistory: room.biddingHistory,
    });
    startUltBidEnd(room);
    return;
  }

  room.phase = 'PLAYING';

  // 教学模式：若房主做庄且明手是真实玩家 → 明手代控庄家
  if (room.teachingMode) {
    const decIsOwner = room.ownerControlledSeats.includes(room.declarer);
    const dumIsOwner = room.ownerControlledSeats.includes(room.dummy);
    room.declarerControlledBy = (decIsOwner && !dumIsOwner) ? room.dummy : null;
  }

  io.to(room.id).emit('biddingEnd', {
    contract:             cc,
    declarer:             room.declarer,
    dummy:                room.dummy,
    leader:               room.leader,
    biddingHistory:       room.biddingHistory,
    declarerControlledBy: room.declarerControlledBy,
  });

  if (room.declarerControlledBy) {
    const dcSock = room.sockets[room.declarerControlledBy];
    if (dcSock) {
      io.to(dcSock).emit('declarerControlStart', {
        declarer:     room.declarer,
        declarerHand: room.hands[room.declarer],
      });
    }
  }
  bcastPlay(room);
}

function processPlay(room, effectiveSeat, card) {
  // 从手牌中移除
  room.hands[effectiveSeat] = room.hands[effectiveSeat].filter(
    c => !(c.suit === card.suit && c.rank === card.rank)
  );
  room.currentTrick.push({ seat: effectiveSeat, card });

  // 首引后摊明手
  if (!room.dummyRevealed && room.completedTricks.length === 0 && room.currentTrick.length === 1) {
    room.dummyRevealed = true;
    io.to(room.id).emit('dummyRevealed', {
      dummy:     room.dummy,
      dummyHand: room.hands[room.dummy],
    });
  }

  io.to(room.id).emit('cardPlayed', {
    seat: effectiveSeat,
    card,
    currentTrick: room.currentTrick,
  });

  if (room.currentTrick.length === 4) {
    const winner = trickWinner(room.currentTrick, room.currentContract.suit);
    const trick  = { cards: [...room.currentTrick], winner };
    room.completedTricks.push(trick);
    if (sideOf(winner) === 'NS') room.nsTricks++;
    else                          room.ewTricks++;
    room.currentTrick  = [];
    room.currentPlayer = winner;

    io.to(room.id).emit('trickEnd', {
      trick,
      winner,
      nsTricks: room.nsTricks,
      ewTricks: room.ewTricks,
    });

    if (room.completedTricks.length === 13) { endGame(room); return; }
  } else {
    room.currentPlayer = nextSeat(effectiveSeat);
  }
  bcastPlay(room);
}

function endGame(room, forcedNS, forcedEW) {
  const ns = forcedNS !== undefined ? forcedNS : room.nsTricks;
  const ew = forcedEW !== undefined ? forcedEW : room.ewTricks;
  const cc = room.currentContract;
  const decSide = sideOf(room.declarer);
  const decTricks = decSide === 'NS' ? ns : ew;

  const vul = room.boardInfo.vul;
  const vulnerable = vul === 'BOTH'
    ? true
    : vul === 'NS' ? decSide === 'NS'
    : vul === 'EW' ? decSide === 'EW'
    : false;

  const score  = calcScore(cc, vulnerable, decTricks);
  const needed = cc.level + 6;
  const made   = decTricks >= needed;
  const diff   = decTricks - needed;

  room.boardScores.push({
    dealNumber:     room.dealNumber,
    boardNumber:    room.boardInfo.number,
    contract:       cc,
    declarer:       room.declarer,
    dummy:          room.dummy,
    declarerTricks: decTricks,
    needed,
    score,
    made,
    diff,
    vulnerability:   vul,
    biddingHistory:  [...room.biddingHistory],
    completedTricks: [...room.completedTricks],
    initialHands:    room.initialHands,
    ddTable:         room.ddTable || null,
    claim: room.lastClaim ? { claimer: room.lastClaim.claimer, tricksToWin: room.lastClaim.tricksToWin, reason: room.lastClaim.reason } : null,
  });
  room.phase = 'SCORING';

  io.to(room.id).emit('gameEnd', {
    passedOut: false,
    contract:  cc,
    declarer:  room.declarer,
    dummy:     room.dummy,
    declarerTricks: decTricks,
    needed,
    score,
    made,
    diff,
    vulnerability: vul,
    boardScores:   room.boardScores,
    ddTable:       room.ddTable || null,
  });
}

// ────────────────────────────────────────────────────────────────
// Socket.io
// ────────────────────────────────────────────────────────────────
const rooms       = {};
const sockRoom    = {};
const sockSeat    = {};

io.on('connection', socket => {
  console.log(`连接: ${socket.id}`);

  // ── 大厅 ─────────────────────────────────────────────
  socket.on('createRoom', ({ playerName, mode }) => {
    let id;
    do { id = generateRoomId(); } while (rooms[id]);
    const room = makeRoom(id);
    room.ownerSocketId = socket.id;
    room.ownerName     = playerName || '';
    if (mode === 'ult')           { room.mode = 'ult'; }
    else if (mode === 'teaching') { room.mode = 'classic'; room.teachingMode = true; }
    else if (mode === 'problem')  { room.mode = 'problem'; room.phase = 'PROB_SELECT'; }
    rooms[id] = room;
    sockRoom[socket.id] = id;
    socket.join(id);
    socket.emit('roomCreated', { roomId: id, ownerSocketId: socket.id, mode: room.mode, teachingMode: room.teachingMode });
    console.log(`房间 ${id} 由 ${playerName} 创建（模式: ${room.mode}${room.teachingMode ? '/教学' : ''}）`);
  });

  socket.on('joinRoom', ({ roomId, playerName, ownerToken }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('appError', { msg: '房间不存在' }); return; }
    sockRoom[socket.id] = roomId;
    socket.join(roomId);
    if (room.mode === 'problem') {
      // 若携带有效 token（原始 ownerSocketId），更新为新 socket，恢复房主权限
      if (ownerToken && ownerToken === room.ownerSocketId) {
        room.ownerSocketId = socket.id;
      }
      const isOwner = (socket.id === room.ownerSocketId);

      // 游戏中加入/重连：房主恢复操作权，旁观者进入只读牌桌
      if ((room.phase === 'PROB_PLAYING' || room.phase === 'PROB_CG' || room.phase === 'PROB_POST_CG') && room.probState) {
        socket.emit('probReconnect', buildProblemSnapshot(room, isOwner));
        return;
      }

      // 结算中加入/重连：重发结算数据
      if (room.phase === 'PROB_SCORING' && room.probState?.lastResult) {
        socket.emit('probGameEnd', room.probState.lastResult);
        return;
      }

      socket.emit('probRoomJoined', {
        roomId,
        ownerSocketId: room.ownerSocketId,
        phase: room.phase,
        problems: room.phase === 'PROB_SELECT' ? PROBLEM_LIST : null,
        problemName: room.problem ? room.problem.name : null,
      });
      return;
    }
    if (room.phase === 'LOBBY') {
      socket.emit('roomJoined', { roomId, playerNames: room.playerNames, readyStatus: room.readyStatus, ownerSocketId: room.ownerSocketId, mode: room.mode });
    }
    // 非 LOBBY 阶段：只加入 socket.io 房间，等 chooseSeat 再恢复游戏状态
  });

  socket.on('chooseSeat', ({ seat, playerName }) => {
    const roomId = sockRoom[socket.id];
    const room   = rooms[roomId];
    if (!room) return;
    // 教学模式：房主重连 — 恢复所有控制座位
    if (room.teachingMode && room.ownerControlledSeats.includes(seat)
        && (room.ownerSocketId === socket.id || !room.sockets[seat])) {
      if (room.phase !== 'LOBBY') {
        room.ownerSocketId = socket.id;
        for (const ts of room.ownerControlledSeats) room.sockets[ts] = socket.id;
        sockSeat[socket.id] = room.ownerControlledSeats[0];
        sendTeachingReconnectState(room, socket);
        return;
      }
    }
    if (room.sockets[seat]) { socket.emit('appError', { msg: '该座位已被占用' }); return; }
    if (room.teachingMode && socket.id === room.ownerSocketId) {
      socket.emit('appError', { msg: '教学模式下房主不入座，游戏会自动填充空位' }); return;
    }

    // 释放旧座位
    const old = sockSeat[socket.id];
    if (old) {
      room.sockets[old] = null;
      room.playerNames[old] = null;
      room.readyStatus[old] = false;
    }

    room.sockets[seat]     = socket.id;
    room.playerNames[seat] = playerName;
    room.readyStatus[seat] = false;
    sockSeat[socket.id]    = seat;

    if (room.phase === 'LOBBY') {
      io.to(roomId).emit('roomUpdate', roomState(room));
    } else {
      // 游戏进行中重连：向该玩家推送当前完整状态
      sendReconnectState(room, seat, socket);
    }
  });

  socket.on('leaveSeat', () => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    // 只允许在 LOBBY 阶段站起来
    if (!room || !seat || room.phase !== 'LOBBY') return;

    room.sockets[seat]     = null;
    room.playerNames[seat] = null;
    room.readyStatus[seat] = false;
    sockSeat[socket.id]    = null;

    io.to(roomId).emit('roomUpdate', roomState(room));
    socket.emit('seatLeft');
  });

  socket.on('ownerStartGame', () => {
    const roomId = sockRoom[socket.id];
    const room   = rooms[roomId];
    // 大招模式结算后可重新开局
    if (room && room.mode === 'ult' && room.phase === 'SCORING') {
      if (room.ownerSocketId !== socket.id) { socket.emit('appError', { msg: '只有房主可以重新开始' }); return; }
      room.dealNumber++;
      SEATS.forEach(s => { room.readyStatus[s] = false; });
      startUltGame(room);
      return;
    }
    if (!room || room.phase !== 'LOBBY') return;
    if (room.ownerSocketId !== socket.id) {
      socket.emit('appError', { msg: '只有房主可以开始游戏' }); return;
    }

    // 做题模式：房主直接开始，无需入座
    if (room.mode === 'problem') {
      room.phase = 'PROB_SELECT';
      socket.emit('probSelectStart', { problems: PROBLEM_LIST });
      return;
    }

    if (room.teachingMode) {
      const realSeated = SEATS.filter(s => room.sockets[s]);
      if (realSeated.length === 0) {
        socket.emit('appError', { msg: '教学模式下需要至少1名玩家就座' }); return;
      }
      const ownerSeats = [];
      for (const s of SEATS) {
        if (!room.sockets[s]) {
          room.sockets[s]     = socket.id;
          room.playerNames[s] = room.ownerName || '教学';
          ownerSeats.push(s);
        }
      }
      room.ownerControlledSeats = ownerSeats;
      if (ownerSeats.length > 0) sockSeat[socket.id] = ownerSeats[0];
      io.to(roomId).emit('roomUpdate', roomState(room));
    } else {
      const allSeated = SEATS.every(s => room.sockets[s]);
      if (!allSeated) {
        socket.emit('appError', { msg: '需要4名玩家全部就座后才能开始' }); return;
      }
    }

    if (room.mode === 'ult') startUltGame(room);
    else if (room.mode === 'problem') {
      room.phase = 'PROB_SELECT';
      socket.emit('probSelectStart', { problems: PROBLEM_LIST });
    }
    else startGame(room);
  });

  // ── 叫牌 ─────────────────────────────────────────────
  socket.on('bid', ({ bid, alert, explain }) => {
    const roomId = sockRoom[socket.id];
    const room   = rooms[roomId];
    if (!room || room.phase !== 'BIDDING') return;
    let seat = sockSeat[socket.id];

    // 教学模式：房主代替当前叫牌座位出牌
    if (room.teachingMode && socket.id === room.ownerSocketId
        && room.ownerControlledSeats.includes(room.currentBidder)) {
      seat = room.currentBidder;
    }

    const v = validateBid(bid, room, seat);
    if (!v.ok) { socket.emit('appError', { msg: v.msg }); return; }

    const alerted     = !!alert;
    const explainText = (alerted && explain) ? String(explain).trim().slice(0, 500) : null;
    room.biddingHistory.push({ seat, bid, alert: alerted || null, explain: explainText });

    if (bid === 'Pass') {
      room.consecutivePasses++;
      const hasContract = !!room.currentContract;
      // 4次Pass（全不叫）或有定约后3次Pass
      if ((hasContract && room.consecutivePasses >= 3) ||
          (!hasContract && room.consecutivePasses >= 4)) {
        finishBidding(room); return;
      }
    } else if (bid === 'Double') {
      room.currentContract = { ...room.currentContract, doubled: true, redoubled: false, doublerSeat: seat };
      room.consecutivePasses = 0;
    } else if (bid === 'Redouble') {
      room.currentContract = { ...room.currentContract, redoubled: true, doublerSeat: seat };
      room.consecutivePasses = 0;
    } else {
      room.currentContract   = { level: parseInt(bid[0]), suit: parseSuit(bid), seat, doubled: false, redoubled: false };
      room.consecutivePasses = 0;
    }

    room.currentBidder = nextSeat(seat);
    bcastBidding(room);
  });

  // ── 出牌 ─────────────────────────────────────────────
  socket.on('playCard', ({ card }) => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (!room || room.phase !== 'PLAYING' || room.claimReq) return;

    let effective = seat;
    if (room.teachingMode) {
      const dumIsOwner = room.ownerControlledSeats.includes(room.dummy);
      const decIsReal  = !room.ownerControlledSeats.includes(room.declarer);
      // 教学模式：房主代替当前出牌座位，但以下两种情况除外：
      // 1. 明手是房主且庄家是真实玩家时（庄家代打明手）
      // 2. declarerControlledBy 已设置（真实明手接管了庄家的出牌权）
      if (socket.id === room.ownerSocketId && room.ownerControlledSeats.includes(room.currentPlayer)) {
        const dummyPlaysForDeclarer = room.currentPlayer === room.dummy && dumIsOwner && decIsReal;
        const realDummyControlsDeclarer = room.declarerControlledBy
          && (room.currentPlayer === room.declarer || room.currentPlayer === room.dummy);
        if (!dummyPlaysForDeclarer && !realDummyControlsDeclarer) {
          effective = room.currentPlayer;
        }
      }
      // 明手是房主控制、庄家是真实玩家时：庄家代打明手（标准桥牌规则）
      if (dumIsOwner && decIsReal && room.currentPlayer === room.dummy && seat === room.declarer) {
        effective = room.dummy;
      }
      // 明手代控庄家：明手玩家可以为庄家座位或明手座位出牌
      if (room.declarerControlledBy && seat === room.declarerControlledBy) {
        if (room.currentPlayer === room.declarer || room.currentPlayer === room.dummy) {
          effective = room.currentPlayer;
        }
      }
    } else {
      // 经典模式：庄家代打明手
      if (room.currentPlayer === room.dummy && seat === room.declarer) {
        effective = room.dummy;
      }
    }
    if (effective !== room.currentPlayer) {
      socket.emit('appError', { msg: '还没到你出牌' }); return;
    }

    const hand = room.hands[effective];
    if (!hand.some(c => c.suit === card.suit && c.rank === card.rank)) {
      socket.emit('appError', { msg: '该牌不在你手中' }); return;
    }

    // 跟花检查
    if (room.currentTrick.length > 0) {
      const led = room.currentTrick[0].card.suit;
      if (card.suit !== led && hand.some(c => c.suit === led)) {
        socket.emit('appError', { msg: '必须跟出同花色' }); return;
      }
    }

    processPlay(room, effective, card);
  });

  // ── 声称 ─────────────────────────────────────────────
  socket.on('claim', ({ tricksToWin, reason }) => {
    const roomId = sockRoom[socket.id];
    const room   = rooms[roomId];
    if (!room || room.phase !== 'PLAYING' || room.claimReq) return;
    let seat = sockSeat[socket.id];
    // 教学模式：房主以庄家（或其搭档）座位声称
    if (room.teachingMode && socket.id === room.ownerSocketId) {
      seat = room.ownerControlledSeats.find(s => s === room.declarer || s === partner(room.declarer))
          || room.ownerControlledSeats[0];
    }
    if (!seat) { socket.emit('appError', { msg: '无法确定声称座位' }); return; }
    if (seat === room.dummy) { socket.emit('appError', { msg: '明手不能声称' }); return; }

    const remaining = 13 - room.completedTricks.length;
    if (tricksToWin < 0 || tricksToWin > remaining) {
      socket.emit('appError', { msg: '声称墩数超出范围' }); return;
    }

    // voters：除声称者本人和明手以外的所有座位
    // 桥牌规则：同伴可以制止同伴的错误声称，所以声称者同伴也在投票人列表中
    const claimerSide = sideOf(seat);
    let voters = SEATS.filter(s => s !== seat && s !== room.dummy);
    // 若真实明手代控庄家，将其加入投票人
    if (room.declarerControlledBy && !voters.includes(room.declarerControlledBy)) {
      voters.push(room.declarerControlledBy);
    }
    // 教学模式：房主声称时，移除房主自控座位；但确保所有非房主真实玩家都在投票人列表
    if (room.teachingMode && socket.id === room.ownerSocketId) {
      voters = voters.filter(s => !room.ownerControlledSeats.includes(s));
      for (const s of SEATS) {
        const sock = room.sockets[s];
        if (sock && sock !== room.ownerSocketId && !voters.includes(s)) {
          voters.push(s);
        }
      }
    }

    room.claimReq = { claimer: seat, tricksToWin, reason: reason || '', voters, votes: {} };

    io.to(room.id).emit('claimRequest', {
      claimer:     seat,
      claimerName: room.playerNames[seat],
      tricksToWin,
      reason:      room.claimReq.reason,
      allHands:    room.hands,
      remaining,
      claimerSide,
    });

    // 无需投票时（所有对方座位均为房主控制）立即通过
    if (voters.length === 0) {
      io.to(room.id).emit('claimResult', { accepted: true, tricksToWin, claimer: seat });
      room.lastClaim = { claimer: seat, tricksToWin, reason: reason || '' };
      room.claimReq = null;
      const nsAdd = claimerSide === 'NS' ? tricksToWin : (remaining - tricksToWin);
      const ewAdd = claimerSide === 'EW' ? tricksToWin : (remaining - tricksToWin);
      endGame(room, room.nsTricks + nsAdd, room.ewTricks + ewAdd);
    }
  });

  socket.on('claimVote', ({ accept }) => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (!room || !room.claimReq) return;
    const req = room.claimReq;

    // 教学模式：房主的一票覆盖其所有被投票座位；declarerControlledBy 的一票也覆盖其控制的座位
    if (room.teachingMode) {
      if (socket.id === room.ownerSocketId) {
        // 房主一票覆盖所有自己控制的 voter seats
        for (const s of req.voters) {
          if (room.ownerControlledSeats.includes(s)) req.votes[s] = accept;
        }
      } else if (room.declarerControlledBy && seat === room.declarerControlledBy) {
        // 明手代控庄家：其一票也覆盖自己控制的庄家 voter seat（若在 voters 中）
        if (req.voters.includes(seat)) req.votes[seat] = accept;
        if (req.voters.includes(room.declarer)) req.votes[room.declarer] = accept;
      } else {
        if (!req.voters.includes(seat)) return;
        req.votes[seat] = accept;
      }
    } else {
      if (!req.voters.includes(seat)) return;
      req.votes[seat] = accept;
    }

    const allVoted   = req.voters.every(s => req.votes[s] !== undefined);
    if (!allVoted) {
      io.to(room.id).emit('claimVoteUpdate', { votes: req.votes, voters: req.voters });
      return;
    }

    const accepted = req.voters.every(s => req.votes[s]);
    io.to(room.id).emit('claimResult', { accepted, tricksToWin: req.tricksToWin, claimer: req.claimer });
    room.claimReq = null;

    if (accepted) room.lastClaim = { claimer: req.claimer, tricksToWin: req.tricksToWin, reason: req.reason };
    if (accepted) {
      const remaining = 13 - room.completedTricks.length;
      const tw = req.tricksToWin;
      const claimerSide = sideOf(req.claimer);
      const nsAdd = claimerSide === 'NS' ? tw : (remaining - tw);
      const ewAdd = claimerSide === 'EW' ? tw : (remaining - tw);
      endGame(room, room.nsTricks + nsAdd, room.ewTricks + ewAdd);
    }
    // 拒绝则继续打牌
  });

  // ── 查看上一墩 ──────────────────────────────────────
  socket.on('requestViewLastTrick', () => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (!room || room.phase !== 'PLAYING') return;
    if (room.completedTricks.length === 0) {
      socket.emit('appError', { msg: '还没有已完成的墩' }); return;
    }
    // 教学模式：自动通过，无需投票
    if (room.teachingMode) {
      const lastTrick = room.completedTricks[room.completedTricks.length - 1];
      socket.emit('viewLastTrickData', { direct: true, lastTrick });
      return;
    }
    // 移除对 room.viewReq 的防抖返回。这能防止当有对手刷新页面/掉线导致无法投票时，状态机陷入永久死锁，从而允许随时发起新的覆盖投票。
    // if (room.viewReq) return;

    const trickSeats = room.currentTrick.map(c => c.seat);
    const myPlayed   = trickSeats.includes(seat);
    const ptPlayed   = trickSeats.includes(partner(seat));

    if (!myPlayed && !ptPlayed) {
      // 直接查看
      socket.emit('viewLastTrickData', {
        direct:    true,
        lastTrick: room.completedTricks[room.completedTricks.length - 1],
      });
    } else {
      // 需对手同意
      room.viewReq = {
        requester: seat,
        opponents: opponents(seat),
        votes: {},
      };
      io.to(room.id).emit('viewLastTrickRequest', {
        requester:     seat,
        requesterName: room.playerNames[seat],
      });
    }
  });

  socket.on('viewLastTrickVote', ({ approve }) => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (!room || !room.viewReq) return;
    const req = room.viewReq;
    if (!req.opponents.includes(seat)) return;

    req.votes[seat] = approve;
    const allVoted  = req.opponents.every(s => req.votes[s] !== undefined);
    if (!allVoted) {
      io.to(room.id).emit('viewLastTrickVoteUpdate', { votes: req.votes });
      return;
    }

    const approved = req.opponents.every(s => req.votes[s]);
    const lastTrick = approved ? room.completedTricks[room.completedTricks.length - 1] : null;

    io.to(room.id).emit('viewLastTrickVoteResult', {
      approved,
      requester: req.requester,
    });

    if (approved) {
      const rs = room.sockets[req.requester];
      if (rs) io.to(rs).emit('viewLastTrickData', { direct: false, lastTrick });
    }
    room.viewReq = null;
  });

  // ── 修改提醒/解释 ──────────────────────────────────────
  socket.on('editBidAlert', ({ bidIndex, alert, explain }) => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (!room || room.phase !== 'BIDDING') return;
    const entry = room.biddingHistory[bidIndex];
    if (entry && entry.seat === seat) {
      const alerted = !!alert;
      const explainText = (alerted && explain) ? String(explain).trim().slice(0, 500) : null;
      entry.alert = alerted || null;
      entry.explain = explainText;
      bcastBidding(room);
    }
  });

  // ── 叫品询问 ──────────────────────────────────────────
  socket.on('bidQuestion', ({ bidIndex, question }) => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (!room) return;
    const entry = room.biddingHistory[bidIndex];
    if (!entry) return;
    if (!entry.qa) entry.qa = [];
    const qaIdx = entry.qa.length;
    entry.qa.push({ asker: seat, askerName: room.playerNames[seat], question: question || '', answer: null });
    const bidderSock = room.sockets[entry.seat];
    if (bidderSock) {
      io.to(bidderSock).emit('bidQuestionRecv', {
        bidIndex, qaIdx,
        question: question || '',
        asker: seat,
        askerName: room.playerNames[seat],
      });
    }
  });

  socket.on('bidAnswer', ({ bidIndex, qaIdx, asker, answer }) => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (!room) return;
    const entry = room.biddingHistory[bidIndex];
    if (entry && entry.qa && entry.qa[qaIdx]) {
      entry.qa[qaIdx].answer = answer || '';
    }
    const askerSock = room.sockets[asker];
    if (askerSock) {
      io.to(askerSock).emit('bidAnswerRecv', {
        bidIndex, qaIdx,
        answer: answer || '',
        answererName: room.playerNames[seat],
        bid: entry ? entry.bid : '?',
      });
    }
  });

  // ── 下一副 ───────────────────────────────────────────
  socket.on('nextDeal', () => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (!room || room.phase !== 'SCORING') return;

    // 教学模式：房主点击下一副牌时，同时标记其所有控制座位
    if (room.teachingMode && socket.id === room.ownerSocketId && room.ownerControlledSeats.length > 0) {
      const newStatus = !room.readyStatus[room.ownerControlledSeats[0]];
      for (const ts of room.ownerControlledSeats) room.readyStatus[ts] = newStatus;
    } else {
      room.readyStatus[seat] = !room.readyStatus[seat];
    }
    io.to(roomId).emit('nextDealUpdate', { readyStatus: room.readyStatus, playerNames: room.playerNames });

    const allReady = SEATS.every(s => room.sockets[s] && room.readyStatus[s]);
    if (allReady) {
      room.dealNumber++;
      SEATS.forEach(s => room.readyStatus[s] = false);
      startGame(room);
    }
  });

  // ── 断线 ─────────────────────────────────────────────
  socket.on('disconnect', () => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (room && seat) {
      room.sockets[seat]     = null;
      room.playerNames[seat] = null;
      room.readyStatus[seat] = false;
      io.to(roomId).emit('playerDisconnected', { seat });
      if (room.phase === 'LOBBY' && SEATS.every(s => !room.sockets[s])) {
        delete rooms[roomId];
        console.log(`房间 ${roomId} 已清空删除`);
      }
    }
    delete sockRoom[socket.id];
    delete sockSeat[socket.id];
    console.log(`断线: ${socket.id}`);
  });
});

// ════════════════════════════════════════════════════════════════
// 大招模式引擎
// ════════════════════════════════════════════════════════════════

// ── 角色/技能数据加载 ─────────────────────────────────────────────
let CHAR_DATA = { characters: [] };
try {
  CHAR_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'skills/characters.json'), 'utf8'));
} catch(e) { console.warn('技能数据加载失败:', e.message); }

function getChar(charId) { return CHAR_DATA.characters.find(c => c.id === charId); }

// ── 大招模式工具 ──────────────────────────────────────────────────
// 点数钳制：最小2，最大14，保留6位小数（整数倍 × 0.000001）
function clampRank(r) { return parseFloat(Math.min(14, Math.max(2, r)).toFixed(6)); }

// 服务端牌张标签（用于技能消息）
function cardStr(card) {
  if (!card || card.type === 'PASS') return 'PASS';
  const SYM = { S:'♠', H:'♥', D:'♦', C:'♣' };
  const r = Math.round(card.rank);
  const RL = {10:'T',11:'J',12:'Q',13:'K',14:'A'};
  return (SYM[card.suit] || card.suit) + (RL[r] || r);
}

// ── 技能 CD 系统 ──────────────────────────────────────────────────
// room.skillCooldowns = { [seat]: { [skillId]: boardsLeft } }
// boardsLeft > 0 = 不可用；每副牌开始时 -1，到 0 时删除（可用）
function tickCooldowns(cds) {
  const result = {};
  for (const [seat, skills] of Object.entries(cds || {})) {
    const s2 = {};
    for (const [id, boards] of Object.entries(skills)) {
      if (boards > 1) s2[id] = boards - 1;
    }
    if (Object.keys(s2).length) result[seat] = s2;
  }
  return result;
}
function isSkillOnCD(room, seat, skillId) {
  return !!(room.skillCooldowns?.[seat]?.[skillId]);
}
function setSkillCD(room, seat, skillId, boards) {
  if (!boards) return;
  if (!room.skillCooldowns) room.skillCooldowns = {};
  if (!room.skillCooldowns[seat]) room.skillCooldowns[seat] = {};
  room.skillCooldowns[seat][skillId] = boards;
}

// 获取某座位在指定触发时机可用的技能列表（未 CD、触发匹配）
function getAvailableSkills(room, seat, trigger) {
  const charId = room.characters?.[seat];
  if (!charId) return [];
  const char = getChar(charId);
  if (!char) return [];
  return char.skills
    .filter(sk => sk.trigger === trigger && !isSkillOnCD(room, seat, sk.id))
    .map(sk => ({ id: sk.id, name: sk.name, description: sk.description, type: sk.type, cooldown: sk.cooldown, interaction: sk.interaction }));
}

// 手牌大小映射（不含自身）
function getHandSizesFor(room, exceptSeat) {
  const r = {};
  for (const s of SEATS) r[s] = room.hands[s]?.length ?? 0;
  return r;
}

// 随机分配角色选项：每座位2个，全部不重复
function assignCharOptions(room) {
  const allIds = CHAR_DATA.characters.map(c => c.id);
  const pool = shuffle([...allIds]);
  const need = SEATS.length * 2;
  const chosen = pool.slice(0, Math.min(need, pool.length));
  // 如果角色不够填满（理论上不会，10 > 8）则循环复用
  while (chosen.length < need) chosen.push(...shuffle([...allIds]));
  room.charOptions = {};
  SEATS.forEach((s, i) => { room.charOptions[s] = [chosen[i * 2], chosen[i * 2 + 1]]; });
}

// ── 牌堆系统 ─────────────────────────────────────────────────────
function makeUltDeck() {
  // 使用与发牌一致的卡方分布（自由度4），点数带6位小数
  return { cards: generateUltDeck(), top: [] };
}

// 大招模式初始手牌：标准桥牌但 rank 为数字（2-14），供大招比较逻辑使用
function dealUltIntHands() {
  const cards = [];
  for (const suit of SUITS)
    for (const r of RANKS)
      cards.push({ suit, rank: RANK_VAL[r] });
  const d = shuffle(cards);
  return { N: d.slice(0,13), E: d.slice(13,26), S: d.slice(26,39), W: d.slice(39,52) };
}

function genUltCard(spec) {
  const suit = (!spec?.suit || spec.suit === 'random')
    ? SUITS[Math.floor(Math.random() * 4)]
    : spec.suit;
  let rank;
  if (!spec?.rank || spec.rank === 'random') {
    rank = 2 + Math.random() * 12; // [2, 14)
  } else {
    rank = parseFloat(spec.rank);
  }
  return { suit, rank: parseFloat(rank.toFixed(6)) };
}

function drawUltCard(deck) {
  if (deck.top && deck.top.length > 0) return deck.top.shift();
  if (deck.cards && deck.cards.length > 0) return deck.cards.pop();
  deck.cards = shuffle(generateUltDeck());
  return deck.cards.pop();
}

function dealUltHands(deck) {
  const h = {};
  for (const s of SEATS) { h[s] = []; for (let i = 0; i < 13; i++) h[s].push(drawUltCard(deck)); }
  return h;
}

// ── 大招模式赢墩判定 ──────────────────────────────────────────────
// PASS牌（{type:'PASS'}）视为点数 -Infinity，永不赢墩；相同点数先出者赢。
function ultTrickWinner(trick) {
  let best = null, bestRank = -Infinity;
  for (const e of trick) {
    const r = e.card.type === 'PASS' ? -Infinity : e.card.rank;
    if (r > bestRank) { best = e; bestRank = r; }
  }
  return best.seat;
}

// ── 技能系统 ─────────────────────────────────────────────────────
function evalCond(cond, ctx) {
  if (!cond) return true;
  const m = cond.trim().match(/^(.+?)\s*(>=|<=|!=|==|>|<)\s*(.+)$/);
  if (!m) return true;
  const lhs = parseFloat(String(m[1].trim()).split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx));
  const rhs = parseFloat(m[3].trim());
  if (isNaN(lhs)) return false;
  switch (m[2]) {
    case '>': return lhs > rhs;   case '<': return lhs < rhs;
    case '>=': return lhs >= rhs; case '<=': return lhs <= rhs;
    case '==': return lhs === rhs;case '!=': return lhs !== rhs;
  }
  return false;
}

function resolveUltTarget(spec, seat) {
  if (spec === 'self')    return seat;
  if (spec === 'partner') return partner(seat);
  if (spec === 'left')    return nextSeat(seat);
  if (spec === 'right')   return nextSeat(partner(seat));
  if (SEATS.includes(spec)) return spec;
  return seat;
}

function sendUltHandUpdate(room, seat) {
  for (const s of SEATS) {
    const sock = room.sockets[s];
    if (!sock) continue;
    if (s === seat) {
      io.to(sock).emit('ultHandUpdate', { seat, hand: room.hands[seat] });
    } else {
      io.to(sock).emit('ultHandSize', { seat, size: room.hands[seat].length });
    }
  }
}

function execUltEffect(effect, room, actor) {
  const target = effect.target ? resolveUltTarget(effect.target, actor) : actor;
  switch (effect.action) {
    case 'draw': {
      const cnt = effect.count || 1;
      for (let i = 0; i < cnt; i++) room.hands[target].push(drawUltCard(room.deck));
      sendUltHandUpdate(room, target);
      io.to(room.id).emit('ultSkillMsg', { actor, msg: `${room.playerNames[target]} 摸了 ${cnt} 张牌` });
      break;
    }
    case 'discard': {
      const cnt = Math.min(effect.count || 1, room.hands[target].length);
      room.hands[target].splice(room.hands[target].length - cnt, cnt);
      sendUltHandUpdate(room, target);
      io.to(room.id).emit('ultSkillMsg', { actor, msg: `${room.playerNames[target]} 弃了 ${cnt} 张牌` });
      break;
    }
    case 'steal': {
      const cnt = Math.min(effect.count || 1, room.hands[target].length);
      for (let i = 0; i < cnt; i++) {
        if (!room.hands[target].length) break;
        const idx = Math.floor(Math.random() * room.hands[target].length);
        const [card] = room.hands[target].splice(idx, 1);
        room.hands[actor].push(card);
      }
      sendUltHandUpdate(room, actor);
      sendUltHandUpdate(room, target);
      io.to(room.id).emit('ultSkillMsg', { actor, msg: `${room.playerNames[actor]} 从 ${room.playerNames[target]} 处夺了 ${cnt} 张牌` });
      break;
    }
    case 'give': {
      const cnt = Math.min(effect.count || 1, room.hands[actor].length);
      for (let i = 0; i < cnt; i++) {
        if (!room.hands[actor].length) break;
        const idx = Math.floor(Math.random() * room.hands[actor].length);
        const [card] = room.hands[actor].splice(idx, 1);
        room.hands[target].push(card);
      }
      sendUltHandUpdate(room, actor);
      sendUltHandUpdate(room, target);
      io.to(room.id).emit('ultSkillMsg', { actor, msg: `${room.playerNames[actor]} 送给 ${room.playerNames[target]} ${cnt} 张牌` });
      break;
    }
    case 'place_top': {
      room.deck.top.unshift(genUltCard(effect.card));
      io.to(room.id).emit('ultSkillMsg', { actor, msg: `${room.playerNames[actor]} 将一张牌放在牌堆顶` });
      break;
    }
  }
}

function triggerUltSkills(room, event, extraCtx, onlySeats) {
  const seats = onlySeats || SEATS;
  for (const seat of seats) {
    const charId = room.characters?.[seat];
    if (!charId) continue;
    const char = getChar(charId);
    if (!char) continue;
    for (const skill of char.skills) {
      if (skill.type !== 'passive' || skill.trigger !== event) continue;
      if (isSkillOnCD(room, seat, skill.id)) continue;
      const ctx = {
        hand_size:  room.hands[seat]?.length ?? 0,
        tricks_won: sideOf(seat) === 'NS' ? room.nsTricks : room.ewTricks,
        trick_count: room.completedTricks.length,
        ...extraCtx,
      };
      if (!evalCond(skill.condition, ctx)) continue;
      if (skill.effects) {
        for (const eff of skill.effects) execUltEffect(eff, room, seat, extraCtx);
      }
      // 特殊被动技能（无 effects 字段，硬编码逻辑）
      if (skill.id === 'caocao_jxiong') {
        const { trick, winner } = extraCtx || {};
        if (trick && winner && winner !== seat) {
          const myEntry = trick.cards.find(e => e.seat === seat);
          const winnerEntry = trick.cards.find(e => e.seat === winner);
          if (myEntry && winnerEntry &&
              myEntry.card.type !== 'PASS' && winnerEntry.card.type !== 'PASS') {
            room.hands[seat].push({ ...winnerEntry.card });
            room.hands[winner].push({ ...myEntry.card });
            sendUltHandUpdate(room, seat);
            sendUltHandUpdate(room, winner);
            io.to(room.id).emit('ultSkillMsg', { actor: seat, msg:
              `${room.playerNames[seat]} 奸雄：获得 ${cardStr(winnerEntry.card)}，${room.playerNames[winner]} 获得 ${cardStr(myEntry.card)}` });
            setSkillCD(room, seat, skill.id, skill.cooldown);
          }
        }
      }
      if (skill.id === 'hetaihou_qiluan') {
        // extraCtx contains: winner, trickLeader, contract
        const { winner, trickLeader, contract } = extraCtx || {};
        if (winner && trickLeader && contract) {
          const defSide = sideOf(room.declarer) === 'NS' ? 'EW' : 'NS';
          const needed  = contract.level + 6;
          const setAt   = 14 - needed; // defending side needs this many tricks to set
          const defTricks = defSide === 'NS' ? room.nsTricks : room.ewTricks;
          if (sideOf(seat) === defSide && defTricks === setAt) {
            const cnt = 3;
            for (let i = 0; i < cnt; i++) room.hands[seat].push(drawUltCard(room.deck));
            sendUltHandUpdate(room, seat);
            io.to(room.id).emit('ultSkillMsg', { actor: seat, msg:
              `${room.playerNames[seat]} 戚乱：击宕！摸 ${cnt} 张牌` });
            setSkillCD(room, seat, skill.id, skill.cooldown);
          }
        }
      }
    }
  }
}

// ── 游戏流程 ─────────────────────────────────────────────────────
function startUltGame(room) {
  // 倒计CD（副牌间CD递减）
  room.skillCooldowns = tickCooldowns(room.skillCooldowns);
  room.forcedPassSeat = null;

  // 发牌：初始手牌用标准整数桥牌（rank 为数字 2-14），技能牌堆用卡方分布小数
  room.hands = dealUltIntHands(); // 整数 rank 标准发牌
  room.deck  = makeUltDeck(); // 技能牌堆（卡方分布）
  room.currentTrick = [];
  room.completedTricks = [];
  room.nsTricks = room.ewTricks = 0;
  room.biddingHistory = [];
  room.consecutivePasses = 0;
  room.currentContract = null;
  room.declarer = null;
  room.dummy = null;

  // 局情（用于局况和计分）
  const bn = ((room.dealNumber - 1) % 16) + 1;
  room.boardInfo = { ...BOARD_INFO[bn], number: bn, dealNumber: room.dealNumber };

  // 随机分配角色选项（每座2个，不重复）
  assignCharOptions(room);
  room.characters = {};
  room.charSelected = {};   // { seat: true/false }

  room.phase = 'ULT_CHAR_SELECT';
  // 逐座位发送（含 seat 字段，供客户端导航到 ult.html）
  for (const s of SEATS) {
    const sock = room.sockets[s];
    if (!sock) continue;
    io.to(sock).emit('ultCharOptions', {
      seat:         s,
      seatOptions:  room.charOptions,
      playerNames:  room.playerNames,
      vulnerability: room.boardInfo.vul,
      dealer:       room.boardInfo.dealer,
    });
  }
}

function checkUltCharSelectDone(room) {
  if (!SEATS.every(s => room.sockets[s] ? room.charSelected[s] : true)) return;
  // 所有在席玩家已选角色
  startUltBidPrep(room);
}

// ── 技能队列（叫牌准备/结束阶段轮流发动）────────────────────────
function startSkillPhase(room, trigger) {
  if (trigger === 'bid_start') {
    room.phase = 'ULT_BID_PREP';
    room.ultBidPeekCards = {};
  } else {
    room.phase = 'ULT_BID_END';
  }

  // 按庄位→顺时针顺序，筛选有技能的玩家组成队列
  const dIdx = SEATS.indexOf(room.boardInfo.dealer);
  const ordered = [...SEATS.slice(dIdx), ...SEATS.slice(0, dIdx)];
  room.skillQueue = ordered.filter(s =>
    room.sockets[s] && getAvailableSkills(room, s, trigger).length > 0
  );
  room.skillQueueIdx = 0;
  room.skillQueueTrigger = trigger;

  // 广播阶段开始（不附带技能列表，技能选项由 ultSkillYourTurn 单独下发）
  for (const s of SEATS) {
    const sock = room.sockets[s];
    if (!sock) continue;
    const evt = trigger === 'bid_start' ? 'ultBidPrepStart' : 'ultBidEndStart';
    const payload = {
      seat: s, hand: room.hands[s], handSizes: getHandSizesFor(room),
      playerNames: room.playerNames, characters: room.characters,
      availableSkills: [],
      vulnerability: room.boardInfo.vul, dealer: room.boardInfo.dealer,
    };
    if (trigger === 'bid_end') {
      payload.contract  = room.currentContract;
      payload.declarer  = room.declarer;
    }
    io.to(sock).emit(evt, payload);
  }

  emitSkillTurnOrFinish(room);
}

// 旧别名，保留供重连路径调用
function startUltBidPrep(room) { startSkillPhase(room, 'bid_start'); }
function startUltBidEnd(room)  { startSkillPhase(room, 'bid_end');   }

function emitSkillTurnOrFinish(room) {
  // 跳过已无技能的座位
  while (room.skillQueueIdx < room.skillQueue.length) {
    const s = room.skillQueue[room.skillQueueIdx];
    if (room.sockets[s] && getAvailableSkills(room, s, room.skillQueueTrigger).length > 0) break;
    room.skillQueueIdx++;
  }

  if (room.skillQueueIdx >= room.skillQueue.length) {
    // 队列结束
    if (room.skillQueueTrigger === 'bid_start') {
      room.phase = 'BIDDING';
      room.biddingHistory = [];
      room.consecutivePasses = 0;
      room.currentContract = null;
      room.currentBidder = room.boardInfo.dealer;
      io.to(room.id).emit('ultBidPhaseStart', {
        dealer:        room.boardInfo.dealer,
        vulnerability: room.boardInfo.vul,
        playerNames:   room.playerNames,
        characters:    room.characters,
      });
      bcastBidding(room);
    } else {
      startUltPlayPhase(room);
    }
    return;
  }

  const seat   = room.skillQueue[room.skillQueueIdx];
  const skills = getAvailableSkills(room, seat, room.skillQueueTrigger);

  // 广播：轮到谁
  io.to(room.id).emit('ultSkillTurn', {
    currentSeat:  seat,
    trigger:      room.skillQueueTrigger,
    playerNames:  room.playerNames,
    handSizes:    getHandSizesFor(room),
  });

  // 仅向当前玩家发送技能选项和手牌
  const sock = room.sockets[seat];
  if (sock) {
    io.to(sock).emit('ultSkillYourTurn', {
      availableSkills: skills,
      hand:            room.hands[seat],
      trigger:         room.skillQueueTrigger,
    });
  }
}

function advanceSkillQueue(room) {
  room.skillQueueIdx++;
  emitSkillTurnOrFinish(room);
}

function startUltPlayPhase(room) {
  room.phase = 'PLAYING';
  room.currentTrick = [];
  room.completedTricks = [];
  room.nsTricks = room.ewTricks = 0;
  room.leader = nextSeat(room.declarer); // 定约左手首引
  room.currentPlayer = room.leader;
  room.forcedPassSeat = null;

  for (const s of SEATS) {
    const sock = room.sockets[s];
    if (!sock) continue;
    io.to(sock).emit('ultGameStart', {
      seat:         s,
      hand:         room.hands[s],
      handSizes:    getHandSizesFor(room),
      playerNames:  room.playerNames,
      characters:   room.characters || {},
      currentPlayer: room.currentPlayer,
      leader:       room.leader,
      contract:     room.currentContract,
      declarer:     room.declarer,
      vulnerability: room.boardInfo.vul,
      playSkills:   getAvailableSkills(room, s, 'play_time'),
    });
  }
  bcastUltPlay(room);
  // 首攻者可能空手（如刘协密诏），立即推进自动PASS逻辑
  advanceUltPlayer(room, room.leader);
}

function bcastUltPlay(room) {
  io.to(room.id).emit('ultPlayUpdate', {
    currentPlayer: room.currentPlayer,
    currentTrick:  room.currentTrick,
    completedCount: room.completedTricks.length,
    nsTricks:  room.nsTricks,
    ewTricks:  room.ewTricks,
    handSizes: { N: room.hands.N.length, E: room.hands.E.length, S: room.hands.S.length, W: room.hands.W.length },
    leader:    room.leader,
  });
}

function completeRemainingUltTricks(room) {
  const leader  = room.leader;
  const oppSeat = opponents(leader)[0];
  const remaining = 13 - room.completedTricks.length;
  for (let i = 0; i < remaining; i++) {
    const winner = i % 2 === 0 ? leader : oppSeat;
    room.completedTricks.push({ cards: [], winner, auto: true });
    if (sideOf(winner) === 'NS') room.nsTricks++; else room.ewTricks++;
  }
  io.to(room.id).emit('ultAutoTricks', {
    nsTricks:       room.nsTricks,
    ewTricks:       room.ewTricks,
    completedCount: room.completedTricks.length,
  });
  endUltGame(room);
}

function endUltGame(room) {
  room.phase = 'SCORING';
  const cc = room.currentContract;
  let score = 0, made = false, diff = 0;

  if (cc && room.declarer) {
    const decSide = sideOf(room.declarer);
    const decTricks = decSide === 'NS' ? room.nsTricks : room.ewTricks;
    const vul = room.boardInfo?.vul || 'NONE';
    const vulnerable = vul === 'BOTH' ? true
      : vul === 'NS' ? decSide === 'NS'
      : vul === 'EW' ? decSide === 'EW' : false;
    score = calcScore(cc, vulnerable, decTricks);
    made  = decTricks >= cc.level + 6;
    diff  = decTricks - (cc.level + 6);
    if (!room.boardScores) room.boardScores = [];
    room.boardScores.push({ dealNumber: room.dealNumber, score, made, diff, contract: cc, declarer: room.declarer });
  }

  io.to(room.id).emit('ultGameEnd', {
    nsTricks:   room.nsTricks,
    ewTricks:   room.ewTricks,
    winner:     room.nsTricks > room.ewTricks ? 'NS' : room.ewTricks > room.nsTricks ? 'EW' : 'TIE',
    playerNames: room.playerNames,
    contract:   cc || null,
    declarer:   room.declarer || null,
    score,
    made,
    diff,
  });
}

function processUltPlay(room, seat, card) {
  if (card.type !== 'PASS') {
    room.hands[seat] = removeOneCard(room.hands[seat], card);
    sendUltHandUpdate(room, seat);
  }

  room.currentTrick.push({ seat, card });
  io.to(room.id).emit('ultCardPlayed', { seat, card, currentTrick: room.currentTrick });

  if (room.currentTrick.length < 4) {
    advanceUltPlayer(room, nextSeat(seat));
    return;
  }

  // 本墩结束
  const trickLeader = room.leader;  // 当前墩的首引者（墩后会变）
  const winner = ultTrickWinner(room.currentTrick);
  const trick  = { cards: [...room.currentTrick], winner };
  room.completedTricks.push(trick);
  if (sideOf(winner) === 'NS') room.nsTricks++; else room.ewTricks++;
  room.leader = winner;
  room.currentTrick = [];
  room.forcedPassSeat = null; // 强制PASS效果仅本墩有效

  io.to(room.id).emit('ultTrickEnd', {
    trick, winner,
    nsTricks: room.nsTricks, ewTricks: room.ewTricks,
    completedCount: room.completedTricks.length,
  });

  const trickCtx = { trick, winner, trickLeader, contract: room.currentContract };
  // 获胜方技能
  triggerUltSkills(room, 'on_trick_win', trickCtx, [winner]);
  // 失败方技能（曹操 奸雄）
  const loserSeats = SEATS.filter(s => sideOf(s) !== sideOf(winner));
  triggerUltSkills(room, 'on_trick_lose', trickCtx, loserSeats);
  // 何太后 戚乱（特殊 trigger）
  triggerUltSkills(room, 'on_trick_win_set', trickCtx, SEATS);

  if (room.completedTricks.length === 13) { endUltGame(room); return; }

  if (SEATS.every(s => room.hands[s].length === 0)) {
    completeRemainingUltTricks(room); return;
  }

  advanceUltPlayer(room, winner);
}

// 自动处理：空手 → PASS；张绣强制 → PASS
function advanceUltPlayer(room, startSeat) {
  if (room.completedTricks.length >= 13) return;
  let seat = startSeat;

  while (room.currentTrick.length < 4) {
    const alreadyPlayed = room.currentTrick.find(e => e.seat === seat);
    if (alreadyPlayed) { seat = nextSeat(seat); continue; }

    const isEmpty = room.hands[seat].length === 0;
    const isForced = room.forcedPassSeat === seat;

    if (!isEmpty && !isForced) {
      // 该玩家需要手动出牌
      break;
    }

    // 自动 PASS（空手或被张绣强制）
    const autoCard = { type: 'PASS' };
    room.currentTrick.push({ seat, card: autoCard });
    io.to(room.id).emit('ultCardPlayed', { seat, card: autoCard, currentTrick: room.currentTrick, auto: true });
    if (isForced) room.forcedPassSeat = null;

    if (room.currentTrick.length === 4) {
      // 本墩满4张 → 走正常结束流程（复用 processUltPlay 已做的逻辑无法复用，此处内联）
      const trickLeader = room.leader;
      // 全PASS时 leader 赢
      const allPass = room.currentTrick.every(e => e.card.type === 'PASS');
      const winner = allPass ? room.leader : ultTrickWinner(room.currentTrick);
      const trick  = { cards: [...room.currentTrick], winner };
      room.completedTricks.push(trick);
      if (sideOf(winner) === 'NS') room.nsTricks++; else room.ewTricks++;
      room.leader = winner;
      room.currentTrick = [];
      room.forcedPassSeat = null;
      io.to(room.id).emit('ultTrickEnd', {
        trick, winner,
        nsTricks: room.nsTricks, ewTricks: room.ewTricks,
        completedCount: room.completedTricks.length,
      });
      const trickCtx = { trick, winner, trickLeader, contract: room.currentContract };
      triggerUltSkills(room, 'on_trick_win', trickCtx, [winner]);
      triggerUltSkills(room, 'on_trick_lose', trickCtx, SEATS.filter(s => sideOf(s) !== sideOf(winner)));
      triggerUltSkills(room, 'on_trick_win_set', trickCtx, SEATS);
      if (room.completedTricks.length === 13) { endUltGame(room); return; }
      if (SEATS.every(s => room.hands[s].length === 0)) { completeRemainingUltTricks(room); return; }
      advanceUltPlayer(room, winner);
      return;
    }
    seat = nextSeat(seat);
  }

  room.currentPlayer = seat;
  if (room.currentTrick.length < 4) bcastUltPlay(room);
}

// ── 叫牌阶段技能分发 ──────────────────────────────────────────────
function hasCharSkill(room, seat, skillId) {
  const char = getChar(room.characters?.[seat]);
  return char?.skills.some(sk => sk.id === skillId) || false;
}

function handleUltBidPhaseSkill(room, seat, skillId, data, expectedTrigger, socket) {
  // 只允许当前队列中的玩家发动技能
  if (room.skillQueue?.[room.skillQueueIdx] !== seat) {
    socket.emit('appError', { msg: '现在不是你的技能回合' }); return;
  }
  const char = getChar(room.characters?.[seat]);
  if (!char) return;
  const skill = char.skills.find(sk => sk.id === skillId && sk.trigger === expectedTrigger);
  if (!skill) { socket.emit('appError', { msg: '技能不存在或触发时机不对' }); return; }
  if (isSkillOnCD(room, seat, skillId)) { socket.emit('appError', { msg: '技能冷却中' }); return; }

  switch (skillId) {
    case 'zgl_jincui': {
      // 诸葛亮 尽瘁：抽牌堆顶7张发给玩家查看
      const count = 7;
      const peeked = [];
      for (let i = 0; i < count; i++) peeked.push(drawUltCard(room.deck));
      room.ultBidPeekCards[seat] = peeked;
      const sock = room.sockets[seat];
      if (sock) io.to(sock).emit('ultBidPeekCards', { skillId, cards: peeked });
      // 等待玩家通过 ultBidPrepPeekResp 返回排序结果
      return; // 不立即设置CD，等响应
    }
    case 'sunquan_zhiheng': {
      // 孙权 制衡：弃置 cards，然后摸等量
      const cards = Array.isArray(data?.cards) ? data.cards : [];
      const valid = cards.filter(c =>
        room.hands[seat].some(h => h.suit === c.suit && Math.abs(h.rank - c.rank) < 1e-9)
      ).slice(0, 4);
      if (valid.length === 0 && cards.length > 0) {
        socket.emit('appError', { msg: '所选牌不在手中' }); return;
      }
      for (const c of valid) {
        room.hands[seat] = removeOneCard(room.hands[seat], c);
      }
      for (let i = 0; i < valid.length; i++) room.hands[seat].push(drawUltCard(room.deck));
      sendUltHandUpdate(room, seat);
      io.to(room.id).emit('ultSkillMsg', { actor: seat, msg:
        `${room.playerNames[seat]} 制衡：弃 ${valid.length} 张，摸 ${valid.length} 张` });
      setSkillCD(room, seat, skillId, skill.cooldown);
      break;
    }
    case 'liubei_ren': {
      // 刘备 仁德：将至多2张牌交给同伴，点数+1
      const cards = Array.isArray(data?.cards) ? data.cards.slice(0, 2) : [];
      const valid = cards.filter(c =>
        room.hands[seat].some(h => h.suit === c.suit && Math.abs(h.rank - c.rank) < 1e-9)
      );
      const ptner = partner(seat);
      for (const c of valid) {
        room.hands[seat] = removeOneCard(room.hands[seat], c);
        room.hands[ptner].push({ suit: c.suit, rank: clampRank(c.rank + 1) });
      }
      if (valid.length > 0) {
        sendUltHandUpdate(room, seat);
        sendUltHandUpdate(room, ptner);
      }
      io.to(room.id).emit('ultSkillMsg', { actor: seat, msg:
        `${room.playerNames[seat]} 仁德：送给 ${room.playerNames[ptner]} ${valid.length} 张牌（+1点）` });
      setSkillCD(room, seat, skillId, skill.cooldown);
      break;
    }
    case 'zgl_zhizhe': {
      // 诸葛亮 智哲：复制手牌中1张
      const c = data?.card;
      if (!c) { socket.emit('appError', { msg: '请选择一张牌' }); return; }
      const inHand = room.hands[seat].find(h => h.suit === c.suit && Math.abs(h.rank - c.rank) < 1e-9);
      if (!inHand) { socket.emit('appError', { msg: '该牌不在手中' }); return; }
      room.hands[seat].push({ ...inHand });
      sendUltHandUpdate(room, seat);
      io.to(room.id).emit('ultSkillMsg', { actor: seat, msg:
        `${room.playerNames[seat]} 智哲：复制了 ${cardStr(inHand)}` });
      setSkillCD(room, seat, skillId, skill.cooldown);
      break;
    }
    case 'zhangliao_tuxi': {
      // 张辽 突袭：从两名对手各随机夺1张
      const opps = opponents(seat);
      let stolen = 0;
      for (const opp of opps) {
        if (room.hands[opp].length === 0) continue;
        const idx = Math.floor(Math.random() * room.hands[opp].length);
        const [card] = room.hands[opp].splice(idx, 1);
        room.hands[seat].push(card);
        sendUltHandUpdate(room, opp);
        stolen++;
      }
      sendUltHandUpdate(room, seat);
      io.to(room.id).emit('ultSkillMsg', { actor: seat, msg:
        `${room.playerNames[seat]} 突袭：从两名对手各夺1张，共夺 ${stolen} 张` });
      setSkillCD(room, seat, skillId, skill.cooldown);
      break;
    }
    case 'liuxie_mizha': {
      // 刘协 密诏：将所有手牌交给同伴
      const ptner = partner(seat);
      const myHand = room.hands[seat].splice(0);
      room.hands[ptner].push(...myHand);
      sendUltHandUpdate(room, seat);
      sendUltHandUpdate(room, ptner);
      io.to(room.id).emit('ultSkillMsg', { actor: seat, msg:
        `${room.playerNames[seat]} 密诏：将 ${myHand.length} 张手牌悉数交给 ${room.playerNames[ptner]}` });
      setSkillCD(room, seat, skillId, skill.cooldown);
      break;
    }
    default:
      socket.emit('appError', { msg: `未知技能 ${skillId}` });
      return;
  }
  // 通知玩家技能已使用
  const sock = room.sockets[seat];
  if (sock) io.to(sock).emit('ultSkillUsed', { skillId });

  // 尽瘁需等待 peek 响应再推进队列；其余技能立即推进
  if (skillId !== 'zgl_jincui') {
    advanceSkillQueue(room);
  }
}

// ── Socket 事件（大招模式）───────────────────────────────────────
io.on('connection', socket => {

  // ── 选角色（ULT_CHAR_SELECT 阶段）────────────────────────────
  socket.on('ultCharChoice', ({ charId }) => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'ult' || room.phase !== 'ULT_CHAR_SELECT' || !seat) return;
    const opts = room.charOptions?.[seat];
    if (!opts || !opts.includes(charId)) {
      socket.emit('appError', { msg: '该角色不在你的可选范围内' }); return;
    }
    room.characters[seat] = charId;
    room.charSelected[seat] = true;
    const char = getChar(charId);
    io.to(roomId).emit('ultCharChosen', { seat, charId, charName: char?.name || charId });
    checkUltCharSelectDone(room);
  });

  // ── 叫牌准备阶段技能使用 ──────────────────────────────────────
  socket.on('ultBidPrepSkill', ({ skillId, data }) => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'ult' || room.phase !== 'ULT_BID_PREP' || !seat) return;
    handleUltBidPhaseSkill(room, seat, skillId, data, 'bid_start', socket);
  });

  socket.on('ultBidPrepPeekResp', ({ skillId, kept }) => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'ult' || room.phase !== 'ULT_BID_PREP' || !seat) return;
    if (skillId !== 'zgl_jincui') return;
    const peeked = room.ultBidPeekCards?.[seat];
    if (!peeked) return;
    delete room.ultBidPeekCards[seat];
    // kept: 玩家选择保留的牌（有序），放回牌堆顶
    const keptCards = Array.isArray(kept) ? kept.filter(c =>
      peeked.some(p => p.suit === c.suit && Math.abs(p.rank - c.rank) < 1e-9)
    ) : [];
    for (let i = keptCards.length - 1; i >= 0; i--) room.deck.top.unshift(keptCards[i]);
    const keptStr = keptCards.map(cardStr).join(' ');
    const burned  = peeked.length - keptCards.length;
    io.to(room.id).emit('ultSkillMsg', { actor: seat, msg:
      `${room.playerNames[seat]} 尽瘁：放回 [${keptStr || '—'}]，烧毁 ${burned} 张` });
    setSkillCD(room, seat, skillId, 0); // 无CD
    advanceSkillQueue(room); // 尽瘁 peek 响应完成后推进队列
  });

  // ── 叫牌结束阶段技能使用 ──────────────────────────────────────
  socket.on('ultBidEndSkill', ({ skillId, data }) => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'ult' || room.phase !== 'ULT_BID_END' || !seat) return;
    handleUltBidPhaseSkill(room, seat, skillId, data, 'bid_end', socket);
  });

  // ── 跳过技能（两阶段通用）────────────────────────────────────
  socket.on('ultSkillSkip', () => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (!room || !seat) return;
    if (room.phase !== 'ULT_BID_PREP' && room.phase !== 'ULT_BID_END') return;
    if (room.skillQueue?.[room.skillQueueIdx] !== seat) return;
    io.to(room.id).emit('ultSkillMsg', { actor: seat, msg: `${room.playerNames[seat]} 跳过技能` });
    advanceSkillQueue(room);
  });

  // ── 出牌阶段：出牌（支持克己PASS和酒池加值）───────────────────
  socket.on('ultPlayCard', ({ card, skillOverride, boostSpade }) => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'ult' || room.phase !== 'PLAYING') return;
    if (room.currentPlayer !== seat) { socket.emit('appError', { msg: '还没到你出牌' }); return; }

    if (card.type === 'PASS') {
      // 吕蒙 克己：有牌情况下打出PASS
      if (room.hands[seat].length > 0) {
        if (skillOverride !== 'lvmeng_keji') {
          socket.emit('appError', { msg: '手牌不为空时不能出 PASS' }); return;
        }
        if (!hasCharSkill(room, seat, 'lvmeng_keji') || isSkillOnCD(room, seat, 'lvmeng_keji')) {
          socket.emit('appError', { msg: '克己技能不可用' }); return;
        }
        setSkillCD(room, seat, 'lvmeng_keji', 1);
        io.to(room.id).emit('ultSkillMsg', { actor: seat, msg: `${room.playerNames[seat]} 克己：出PASS` });
      }
      processUltPlay(room, seat, card);
      return;
    }

    const exists = room.hands[seat].some(c => c.suit === card.suit && Math.abs(c.rank - card.rank) < 1e-9);
    if (!exists) { socket.emit('appError', { msg: '手中没有此牌' }); return; }

    // 董卓 酒池：打出♠时加 π
    let playCard = { ...card };
    if (boostSpade && playCard.suit === 'S') {
      if (hasCharSkill(room, seat, 'dongzhuo_jiuchi') && !isSkillOnCD(room, seat, 'dongzhuo_jiuchi')) {
        const boost = 3141592 / 1000000; // 3.141592
        playCard.rank = clampRank(playCard.rank + boost);
        setSkillCD(room, seat, 'dongzhuo_jiuchi', 1);
        io.to(room.id).emit('ultSkillMsg', { actor: seat, msg:
          `${room.playerNames[seat]} 酒池：♠加π → ${cardStr(playCard)}` });
      }
    }
    processUltPlay(room, seat, playCard);
  });

  // ── 出牌阶段：出牌前技能（张绣 雄乱）────────────────────────
  socket.on('ultUsePlaySkill', ({ skillId, target }) => {
    const roomId = sockRoom[socket.id];
    const seat   = sockSeat[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'ult' || room.phase !== 'PLAYING') return;
    if (room.currentPlayer !== seat || room.currentTrick.length !== 0) {
      socket.emit('appError', { msg: '只能在你引出牌之前使用此技能' }); return;
    }
    if (skillId === 'zhangxiu_hunluan') {
      if (!hasCharSkill(room, seat, 'zhangxiu_hunluan') || isSkillOnCD(room, seat, 'zhangxiu_hunluan')) {
        socket.emit('appError', { msg: '雄乱技能不可用' }); return;
      }
      if (!SEATS.includes(target) || target === seat || room.hands[target].length === 0) {
        socket.emit('appError', { msg: '无效目标' }); return;
      }
      room.forcedPassSeat = target;
      setSkillCD(room, seat, 'zhangxiu_hunluan', 2);
      io.to(room.id).emit('ultSkillMsg', { actor: seat, msg:
        `${room.playerNames[seat]} 雄乱：${room.playerNames[target]} 本墩强制PASS` });
      io.to(room.id).emit('ultForcedPass', { target, seat });
    }
  });

});

// ════════════════════════════════════════════════════════════════
// 做题模式引擎
// ════════════════════════════════════════════════════════════════

// 加载题库
const PROBLEMS_DIR = path.join(__dirname, 'public', 'problems');
const PROBLEM_LIST = [];
try {
  const files = fs.readdirSync(PROBLEMS_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const raw = fs.readFileSync(path.join(PROBLEMS_DIR, f), 'utf8');
    const p = JSON.parse(raw);
    PROBLEM_LIST.push({ id: p.id, name: p.name, flavorText: p.flavorText, contract: p.contract });
  }
  PROBLEM_LIST.sort((a, b) => a.id.localeCompare(b.id));
  console.log(`[做题] 已加载 ${PROBLEM_LIST.length} 道题目`);
} catch (e) {
  console.warn('[做题] 题库加载失败:', e.message);
}

function loadProblem(id) {
  const f = path.join(PROBLEMS_DIR, id + '.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

// 牌面字符串（用于日志）
const RANK_STR = { 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'T',11:'J',12:'Q',13:'K',14:'A' };
function cardStr2(c) { return c ? c.suit + (RANK_STR[c.rank] || c.rank) : '?'; }

// 判断手牌是否有某张牌
function handHasCard(hand, card) {
  if (card.rank === 'MAX' || card.rank === 'MIN' || card.rank === 'WIN') return hand.some(c => c.suit === card.suit);
  return hand.some(c => c.suit === card.suit && c.rank === card.rank);
}

// 从手牌移除一张牌
function removeCard(hand, card) {
  const idx = hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
  if (idx !== -1) { const h = [...hand]; h.splice(idx, 1); return h; }
  return hand;
}

// 将脚本牌（可含 rank:'MAX'/'MIN' 动态选择器）解析为手牌中的实际牌张
// 返回实际牌张对象，或 null（该花色无牌）
function resolveScriptCard(sc, hand) {
  if (sc.rank !== 'MAX' && sc.rank !== 'MIN') return null; // 非动态，由调用方处理
  const suitCards = hand.filter(c => c.suit === sc.suit);
  if (suitCards.length === 0) return null;
  return suitCards.reduce((best, c) =>
    sc.rank === 'MAX' ? (c.rank > best.rank ? c : best) : (c.rank < best.rank ? c : best)
  );
}

// WIN 选择器：找到 seat 手中该花色中能赢得本墩的最小牌
// 需要大过：① 本墩已出的该花色最大牌；② 尚未出牌的各家该花色最大牌
function resolveWinCard(sc, seat, ps) {
  const suit = sc.suit;
  const allSeats = ['N', 'E', 'S', 'W'];
  const playedSeats = new Set(ps.currentTrick.map(e => e.seat));
  let maxToBeat = 0;
  for (const entry of ps.currentTrick) {
    if (entry.card.suit === suit) maxToBeat = Math.max(maxToBeat, entry.card.rank);
  }
  for (const s of allSeats) {
    if (s === seat || playedSeats.has(s)) continue;
    const hand = (s === 'N' || s === 'S') ? ps.hands[s] : ps.ewHands[s];
    for (const c of hand) {
      if (c.suit === suit) maxToBeat = Math.max(maxToBeat, c.rank);
    }
  }
  const seatHand = (seat === 'N' || seat === 'S') ? ps.hands[seat] : ps.ewHands[seat];
  const winning = seatHand.filter(c => c.suit === suit && c.rank > maxToBeat);
  if (winning.length === 0) return null;
  return winning.reduce((min, c) => c.rank < min.rank ? c : min);
}

// EW 搭档关系
function ewPartner(seat) { return seat === 'E' ? 'W' : 'E'; }

// 检查中途触发器条件是否满足
function checkMidTrickTrigger(trig, ps) {
  const ct = ps.currentTrick;
  const cond = trig.condition;
  if (cond.isTrickLeader !== undefined && cond.isTrickLeader !== (ct.length === 0)) return false;
  if (cond.ledBy && (ct.length === 0 || ct[0].seat !== cond.ledBy)) return false;
  if (cond.ledSuit && (ct.length === 0 || ct[0].card.suit !== cond.ledSuit)) return false;
  if (cond.ledRankLt !== undefined && (ct.length === 0 || ct[0].card.rank >= cond.ledRankLt)) return false;
  if (cond.ruffedBy) {
    const r = cond.ruffedBy;
    const play = ct.find(e => e.seat === r.seat);
    if (!play || play.card.suit !== r.ruffSuit) return false;
    if (r.excludeRanks && r.excludeRanks.includes(play.card.rank)) return false;
  }
  if (cond.playedNotCard) {
    const pnc = cond.playedNotCard;
    const sPlay = ct.find(e => e.seat === pnc.seat);
    if (!sPlay) return false;  // 该座位尚未出牌
    if (sPlay.card.suit === pnc.suit && sPlay.card.rank === pnc.rank) return false;  // 出了排除牌
  }
  if (cond.playedRankLt !== undefined) {
    const pr = cond.playedRankLt;
    const sPlay = ct.find(e => e.seat === pr.seat);
    if (!sPlay) return false;  // 该座位尚未出牌
    if (sPlay.card.suit !== pr.suit || sPlay.card.rank >= pr.rank) return false;  // 未出该花色小牌
  }
  if (cond.completedSuitTricksLt !== undefined) {
    const { suit, count } = cond.completedSuitTricksLt;
    const done = ps.completedTricks.filter(t => t.cards[0].card.suit === suit).length;
    if (done >= count) return false;
  }
  if (cond.completedSuitTricksGt !== undefined) {
    const { suit, count } = cond.completedSuitTricksGt;
    const done = ps.completedTricks.filter(t => t.cards[0].card.suit === suit).length;
    if (done <= count) return false;
  }
  if (cond.completedTricksEq !== undefined) {
    if (ps.completedTricks.length !== cond.completedTricksEq) return false;
  }
  if (cond.mustDiscard) {
    // 触发座位必须无法跟首引花色（即必须垫牌）
    const ledSuit = ct.length > 0 ? ct[0].card.suit : null;
    if (!ledSuit) return false;
    const seatHand = ps.ewHands[trig.triggerSeat];
    if (seatHand.some(c => c.suit === ledSuit)) return false;
  }
  if (cond.cardsPlayed) {
    // 所有指定牌均已出现（含当前墩，以捕捉"刚打出的那一刻"）
    const allCards = [
      ...ps.completedTricks.flatMap(t => t.cards.map(e => e.card)),
      ...ps.currentTrick.map(e => e.card),
    ];
    for (const cp of cond.cardsPlayed) {
      if (!allCards.some(c => c.suit === cp.suit && c.rank === cp.rank)) return false;
    }
  }
  if (cond.cardNotPlayed) {
    // 指定牌尚未出现（含当前墩）
    const { suit, rank } = cond.cardNotPlayed;
    const allCards = [
      ...ps.completedTricks.flatMap(t => t.cards.map(e => e.card)),
      ...ps.currentTrick.map(e => e.card),
    ];
    if (allCards.some(c => c.suit === suit && c.rank === rank)) return false;
  }
  if (cond.cardsHeldBySide) {
    const { side, cards } = cond.cardsHeldBySide;
    const seats = side === 'NS' ? ['N', 'S'] : side === 'EW' ? ['E', 'W'] : [];
    if (seats.length === 0 || !Array.isArray(cards)) return false;
    for (const needed of cards) {
      const held = seats.some(seat => {
        const hand = side === 'NS' ? ps.hands[seat] : ps.ewHands[seat];
        return (hand || []).some(c => c.suit === needed.suit && c.rank === needed.rank);
      });
      if (!held) return false;
    }
  }
  // 若有换牌配置，from 座位必须仍持有足够的待换出牌
  if (trig.swap) {
    const { from } = trig.swap;
    const suitCards = ps.ewHands[from.seat].filter(c => c.suit === from.suit);
    if (from.rank !== undefined) {
      if (!suitCards.some(c => c.rank === from.rank)) return false;
    } else if (from.count !== undefined) {
      if (suitCards.length < from.count) return false;
    } else {
      if (suitCards.length === 0) return false;
    }
  }
  return true;
}

// 检查某座位是否曾在某花色被引出时垫牌（已亮牌没有该花色）
function hasShownVoid(ps, seat, suit) {
  for (const trick of ps.completedTricks) {
    if (!trick.cards || trick.cards.length === 0) continue;
    const ledSuit = trick.cards[0].card.suit;
    if (ledSuit !== suit) continue;
    const play = trick.cards.find(e => e.seat === seat);
    if (play && play.card.suit !== suit) return true;
  }
  return false;
}

// 执行中途触发器换牌：将 from 座位的指定牌移给 to 座位，以 to 座位的 N 张指定花色为对价
// from 支持：rank（单张）、count+dir（取最小/大N张）、否则整个花色
function applyMidTrickTriggerSwap(trig, ps) {
  const { from, to } = trig.swap;
  const suitCards = ps.ewHands[from.seat].filter(c => c.suit === from.suit);
  let moveCards;
  if (from.rank !== undefined) {
    moveCards = suitCards.filter(c => c.rank === from.rank);
  } else if (from.count !== undefined) {
    const dir = from.dir || 'min';
    moveCards = [...suitCards]
      .sort(dir === 'min' ? (a, b) => a.rank - b.rank : (a, b) => b.rank - a.rank)
      .slice(0, from.count);
  } else {
    moveCards = suitCards;
  }
  if (moveCards.length === 0) return;
  const count = moveCards.length;
  const compensate = [...ps.ewHands[to.seat].filter(c => c.suit === to.suit)]
    .sort(trig.swap.toDir === 'min' ? (a, b) => a.rank - b.rank : (a, b) => b.rank - a.rank)
    .slice(0, count);
  // 逐张移出 moveCards
  for (const c of moveCards) {
    ps.ewHands[from.seat] = removeCard(ps.ewHands[from.seat], c);
  }
  ps.ewHands[to.seat] = [...ps.ewHands[to.seat], ...moveCards];
  // 对价移回
  for (const c of compensate) {
    ps.ewHands[to.seat]   = removeCard(ps.ewHands[to.seat], c);
    ps.ewHands[from.seat] = [...ps.ewHands[from.seat], c];
  }
}

// 从 DDS 最优牌列表中选出最有利于 EW 连续兑现赢墩的牌（次选逻辑）
// candidates: 均为 DDS 最优分值的候选牌（seat 方持有）
function pickBestConsecutiveCard(candidates, seat, ewHands, nsHands, currentTrick, trumpSuit) {
  if (candidates.length <= 1) return candidates[0] || null;
  const isTrumpContract = trumpSuit && trumpSuit !== 'NT';

  function suitCardsByOwner(suit) {
    return [
      ...(ewHands.E || []).filter(c => c.suit === suit).map(c => ({ ...c, side: 'EW', seat: 'E' })),
      ...(ewHands.W || []).filter(c => c.suit === suit).map(c => ({ ...c, side: 'EW', seat: 'W' })),
      ...(nsHands.N || []).filter(c => c.suit === suit).map(c => ({ ...c, side: 'NS', seat: 'N' })),
      ...(nsHands.S || []).filter(c => c.suit === suit).map(c => ({ ...c, side: 'NS', seat: 'S' })),
    ];
  }

  function removeOneRank(ranks, rank) {
    const idx = ranks.indexOf(rank);
    if (idx === -1) return ranks;
    const next = [...ranks];
    next.splice(idx, 1);
    return next;
  }

  function ranksForSeat(suit, owner, ownerSeat) {
    const source = owner === 'EW' ? ewHands[ownerSeat] : nsHands[ownerSeat];
    return (source || []).filter(c => c.suit === suit).map(c => c.rank).sort((a, b) => b - a);
  }

  // EW 在某花色持有的连续顶牌数（从最高开始，遇 NS 牌则停）。
  function seqTops(suit) {
    const all = suitCardsByOwner(suit).sort((a, b) => b.rank - a.rank);
    let n = 0;
    for (const c of all) { if (c.side === 'EW') n++; else break; }
    return n;
  }

  // 从候选牌开始，估算 EW 在该花色能"直接兑现"的长度。
  // NS 每轮用能跟的小牌保留拦张；若短套大牌被迫落下，后续非连续大牌也算兑现。
  function cashRunAfterLead(card) {
    const suit = card.suit;
    const ewRanks = [
      ...ranksForSeat(suit, 'EW', 'E'),
      ...ranksForSeat(suit, 'EW', 'W'),
    ].sort((a, b) => b - a);
    let nRanks = ranksForSeat(suit, 'NS', 'N');
    let sRanks = ranksForSeat(suit, 'NS', 'S');

    const planned = [card.rank, ...removeOneRank(ewRanks, card.rank)];
    let tricks = 0;

    for (const ewRank of planned) {
      // 非将花色在有将定约下，任一 NS 手缺门就不再视为安全兑现。
      if (isTrumpContract && suit !== trumpSuit && (nRanks.length === 0 || sRanks.length === 0)) break;

      const nPlay = forcedFollowRank(nRanks, ewRank);
      const sPlay = forcedFollowRank(sRanks, ewRank);
      if ((nPlay !== null && nPlay > ewRank) || (sPlay !== null && sPlay > ewRank)) break;

      tricks++;
      nRanks = nPlay === null ? nRanks : removeOneRank(nRanks, nPlay);
      sRanks = sPlay === null ? sRanks : removeOneRank(sRanks, sPlay);
    }

    return tricks;
  }

  function forcedFollowRank(ranks, ewRank) {
    if (ranks.length === 0) return null;
    const under = ranks.filter(r => r < ewRank);
    if (under.length > 0) return Math.min(...under);
    return Math.min(...ranks);
  }

  function isHighestRemaining(card) {
    const all = suitCardsByOwner(card.suit);
    const maxRank = Math.max(...all.map(c => c.rank));
    return card.rank === maxRank;
  }

  // 出 card 后 EW 是否赢当前墩
  function ewWins(card) {
    const trick = [...currentTrick, { seat, card }];
    const ledSuit = trick[0].card.suit;
    let best = trick[0];
    for (const e of trick.slice(1)) {
      const isTrump = trumpSuit && trumpSuit !== 'NT' && e.card.suit === trumpSuit;
      const bestIsTrump = trumpSuit && trumpSuit !== 'NT' && best.card.suit === trumpSuit;
      if (isTrump && !bestIsTrump) { best = e; }
      else if (!isTrump && bestIsTrump) { /* skip */ }
      else if (e.card.suit === best.card.suit && e.card.rank > best.card.rank) { best = e; }
    }
    return best.seat === 'E' || best.seat === 'W';
  }

  const scored = candidates.map(c => ({
    card: c,
    wins: ewWins(c) ? 1 : 0,
    cashRun: currentTrick.length === 0
      ? 1 + countEwSafeCashTricks(
          removeCardFromSeat(ewHands, seat, c),
          nsHands,
          trumpSuit)
      : cashRunAfterLead(c),
    cashTop: isHighestRemaining(c) ? 1 : 0,
    nonTrump: !isTrumpContract || c.suit !== trumpSuit ? 1 : 0,
    tops: seqTops(c.suit),
    rank: c.rank,
  }));
  scored.sort((a, b) =>
    b.wins - a.wins ||
    b.cashRun - a.cashRun ||
    b.cashTop - a.cashTop ||
    b.nonTrump - a.nonTrump ||
    b.tops - a.tops ||
    b.rank - a.rank
  );
  return scored[0].card;
}

function removeCardFromSeat(hands, seat, card) {
  return {
    N: hands.N ? hands.N.map(c => ({ ...c })) : [],
    S: hands.S ? hands.S.map(c => ({ ...c })) : [],
    E: hands.E ? hands.E.map(c => ({ ...c })) : [],
    W: hands.W ? hands.W.map(c => ({ ...c })) : [],
    [seat]: removeCard(hands[seat] || [], card),
  };
}

function legalCardsForSeat(hand, currentTrick) {
  if (!currentTrick || currentTrick.length === 0) return hand || [];
  const ledSuit = currentTrick[0].card.suit;
  const follows = (hand || []).filter(c => c.suit === ledSuit);
  return follows.length > 0 ? follows : (hand || []);
}

function cardSurelyWinsCurrentTrick(seat, card, currentTrick, hands, trumpSuit) {
  const afterPlay = [...currentTrick, { seat, card }];
  if (trickWinner2(afterPlay, trumpSuit) !== seat) return false;

  let probe = afterPlay;
  let next = nextSeat(seat);
  while (probe.length < 4) {
    const hand = hands[next] || [];
    if (next === 'N' || next === 'S') {
      const legal = legalCardsForSeat(hand, probe);
      if (legal.some(c => trickWinner2([...probe, { seat: next, card: c }], trumpSuit) === next)) {
        return false;
      }
    }
    probe = [...probe, { seat: next, card: legalCardsForSeat(hand, probe)[0] || { suit: 'C', rank: 2 } }];
    next = nextSeat(next);
  }
  return true;
}

function countEwSafeCashTricks(ewHands, nsHands, trumpSuit) {
  const isTrumpContract = trumpSuit && trumpSuit !== 'NT';
  const workEw = {
    E: (ewHands.E || []).map(c => ({ ...c })),
    W: (ewHands.W || []).map(c => ({ ...c })),
  };
  const workNs = {
    N: (nsHands.N || []).map(c => ({ ...c })),
    S: (nsHands.S || []).map(c => ({ ...c })),
  };

  function forcedFollow(hand, suit, ewRank) {
    const cards = hand.filter(c => c.suit === suit);
    if (cards.length === 0) return null;
    const under = cards.filter(c => c.rank < ewRank).sort((a, b) => a.rank - b.rank);
    if (under.length > 0) return under[0];
    return cards.sort((a, b) => a.rank - b.rank)[0];
  }

  function safeCashCards() {
    const cards = [
      ...workEw.E.map(c => ({ seat: 'E', card: c })),
      ...workEw.W.map(c => ({ seat: 'W', card: c })),
    ];
    return cards.filter(({ card }) => {
      if (isTrumpContract && card.suit !== trumpSuit) {
        if (workNs.N.every(c => c.suit !== card.suit)) return false;
        if (workNs.S.every(c => c.suit !== card.suit)) return false;
      }
      const nPlay = forcedFollow(workNs.N, card.suit, card.rank);
      const sPlay = forcedFollow(workNs.S, card.suit, card.rank);
      return !(nPlay && nPlay.rank > card.rank) && !(sPlay && sPlay.rank > card.rank);
    });
  }

  let tricks = 0;
  while (true) {
    const safe = safeCashCards().sort((a, b) =>
      b.card.rank - a.card.rank ||
      (a.card.suit === trumpSuit ? -1 : 0) - (b.card.suit === trumpSuit ? -1 : 0)
    );
    if (safe.length === 0) break;
    const { seat, card } = safe[0];
    workEw[seat] = removeCard(workEw[seat], card);
    const nPlay = forcedFollow(workNs.N, card.suit, card.rank);
    const sPlay = forcedFollow(workNs.S, card.suit, card.rank);
    if (nPlay) workNs.N = removeCard(workNs.N, nPlay);
    if (sPlay) workNs.S = removeCard(workNs.S, sPlay);
    tricks++;
  }
  return tricks;
}

function pickWinThenCashCard(seat, ewHands, nsHands, currentTrick, trumpSuit, ewTricks, ewNeeded) {
  if (!currentTrick || currentTrick.length === 0) return null;
  const hands = { N: nsHands.N, S: nsHands.S, E: ewHands.E, W: ewHands.W };
  const legal = legalCardsForSeat(ewHands[seat] || [], currentTrick);
  const winners = legal.filter(card =>
    cardSurelyWinsCurrentTrick(seat, card, currentTrick, hands, trumpSuit)
  );
  const scored = winners.map(card => {
    const nextEwHands = removeCardFromSeat(ewHands, seat, card);
    return {
      card,
      total: ewTricks + 1 + countEwSafeCashTricks(nextEwHands, nsHands, trumpSuit),
      rank: card.rank,
    };
  }).filter(x => x.total >= ewNeeded);
  scored.sort((a, b) => b.total - a.total || a.rank - b.rank);
  return scored[0]?.card || null;
}

// 防守方桥牌启发式选牌（DDS 不可用时的回退）
// 应用标准规则：二手出低、三手出高、四手最省赢牌
function autoDefenseCardFallback(seat, hand, currentTrick, trumpSuit) {
  const isTrump = s => trumpSuit && trumpSuit !== 'NT' && s === trumpSuit;
  const position = currentTrick.length; // 0=引出, 1=二手, 2=三手, 3=四手

  // 引出：出最长非将花色的第4好牌
  if (position === 0) {
    const nonTrump = hand.filter(c => !isTrump(c.suit));
    const pool = nonTrump.length > 0 ? nonTrump : hand;
    const bySuit = {};
    for (const c of pool) { (bySuit[c.suit] = bySuit[c.suit] || []).push(c); }
    let best = null, bestLen = 0;
    for (const [, cards] of Object.entries(bySuit)) {
      if (cards.length > bestLen) { bestLen = cards.length; best = cards; }
    }
    if (!best) best = hand;
    const sorted = [...best].sort((a, b) => b.rank - a.rank);
    return sorted[Math.min(3, sorted.length - 1)];
  }

  const ledSuit  = currentTrick[0].card.suit;
  const suitCards = hand.filter(c => c.suit === ledSuit).sort((a, b) => a.rank - b.rank);
  const canFollow = suitCards.length > 0;
  const trumpCards = hand.filter(c => isTrump(c.suit)).sort((a, b) => a.rank - b.rank);

  // 辅助：当前墩的临时赢家
  const curWinner   = trickWinner2(currentTrick, trumpSuit);
  const curWinCard  = currentTrick.find(e => e.seat === curWinner).card;
  const nsWinning   = curWinner === 'N' || curWinner === 'S';
  const partnerSeat = ewPartner(seat);
  const partnerWin  = curWinner === partnerSeat;

  // 能跟花色
  if (canFollow) {
    if (position === 1) return suitCards[0]; // 二手出低

    // 三手、四手：看能否出赢
    const canBeatWithSuit = (c) => {
      const cT = isTrump(c.suit), bT = isTrump(curWinCard.suit);
      if (cT && !bT) return true;
      if (!cT && bT) return false;
      if (c.suit === ledSuit && c.rank > curWinCard.rank) return true;
      return false;
    };
    const winners = suitCards.filter(canBeatWithSuit);

    if (position === 2) {
      if (partnerWin) return suitCards[0]; // 同伴赢，出低示意
      return winners.length > 0 ? winners[0] : suitCards[suitCards.length - 1]; // 三手出高
    }
    // position === 3
    if (partnerWin) return suitCards[0];
    return winners.length > 0 ? winners[0] : suitCards[0]; // 最省赢牌，无则出低
  }

  // 不能跟花色：考虑将吃
  if (trumpCards.length > 0 && !isTrump(ledSuit)) {
    if (nsWinning && !partnerWin) {
      return trumpCards[0]; // 将吃（最小的将）
    }
  }

  // 弃牌：最小非将，无则最小将
  const nonTrump = hand.filter(c => !isTrump(c.suit)).sort((a, b) => a.rank - b.rank);
  return (nonTrump.length > 0 ? nonTrump[0] : hand.sort((a, b) => a.rank - b.rank)[0]) || null;
}

// 计算某局的赢墩方（经典规则，将色取自定约）
function trickWinner2(trick, trumpSuit) {
  const ledSuit = trick[0].card.suit;
  const hasTrump = trumpSuit && trumpSuit !== 'NT';
  let best = trick[0];
  for (let i = 1; i < trick.length; i++) {
    const cur = trick[i];
    const bC = best.card, cC = cur.card;
    const bT = hasTrump && bC.suit === trumpSuit;
    const cT = hasTrump && cC.suit === trumpSuit;
    if (cT && !bT) { best = cur; continue; }
    if (cT && bT && cC.rank > bC.rank) { best = cur; continue; }
    if (!cT && !bT && cC.suit === ledSuit && cC.rank > bC.rank) { best = cur; }
  }
  return best.seat;
}

// 做题模式出牌：处理防守方的下一张自动出牌（异步，优先用脚本，否则 DDS）
async function probAutoDefense(room) {
  const ps = room.probState;
  if (!ps || ps.finished) return false;

  const trumpSuit    = ps.contract.suit;
  const currentTrick = ps.currentTrick;
  const seat         = ps.currentPlayer;

  if (seat !== 'E' && seat !== 'W') {
    // NS 的回合：通知客户端启用手牌操作
    io.to(room.id).emit('probPlayUpdate', {
      currentPlayer: seat,
      nsTricks:      ps.nsTricks,
      ewTricks:      ps.ewTricks,
      completedCount: ps.completedTricks.length,
      handSizes: { E: ps.ewHands.E.length, W: ps.ewHands.W.length },
    });
    return false;
  }

  const tc     = ps.testCases[ps.testCaseIdx];
  const script = ps.activeScript;
  let card = null;

  console.log(`[PROB] autoDefense seat=${seat} tc=${ps.testCaseIdx} ptr=${ps.scriptPtr} abandoned=${ps.scriptAbandoned} trick=[${ps.currentTrick.map(e=>`${e.seat}:${e.card.suit}${e.card.rank}`).join(',')}]`);

  // 当前剧本若正好指挥本座防守出牌，则不得被兑现击宕逻辑覆盖。
  const scriptHasPlayHere = !ps.scriptAbandoned && script && ps.scriptPtr < script.length && script[ps.scriptPtr].seat === seat;

  // 0. 中途触发器：匹配特定出牌模式，执行换牌并强制出牌（优先于脚本和 DDS）
  if (!card && ps.midTrickTriggers && ps.midTrickTriggers.length > 0) {
    for (const trig of ps.midTrickTriggers) {
      if (!trig.repeatable && ps.firedTriggers.has(trig.id)) continue;
      if (trig.triggerSeat !== seat) continue;
      if (!checkMidTrickTrigger(trig, ps)) continue;
      const fp = trig.forcedPlay;
      // 若需要换牌才能出该花色，且该座位曾在该花色上垫过牌，则拒绝（仅有 forcedPlay 时检查）
      if (fp && trig.swap && !ps.ewHands[seat].some(c => c.suit === fp.suit)) {
        if (hasShownVoid(ps, seat, fp.suit)) continue;
      }
      if (trig.swap) applyMidTrickTriggerSwap(trig, ps);
      if (!trig.repeatable) ps.firedTriggers.add(trig.id);
      if (!fp) continue; // swap-only 触发器：换牌后继续走后续逻辑，不强制出牌
      const forcedCard = (fp.rank === 'MIN' || fp.rank === 'MAX')
        ? resolveScriptCard(fp, ps.ewHands[seat])
        : ps.ewHands[seat].find(c => c.suit === fp.suit && c.rank === fp.rank) || null;
      if (forcedCard) { card = forcedCard; break; }
    }
  }

  // 1. 脚本防守（含换牌机制，支持 rank:'MAX'/'MIN' 动态选择器）
  // 脚本未耗尽、未被放弃，且下一个脚本项正好是本家 → 按脚本出牌
  if (!card && !ps.scriptAbandoned && script && ps.scriptPtr < script.length) {
    const expected = script[ps.scriptPtr];
    if (expected.seat === seat) {
      const sc = expected.card;
      const isDynamic = sc.rank === 'MAX' || sc.rank === 'MIN' || sc.rank === 'WIN';
      if (isDynamic) {
        // 动态选择器：WIN=最小赢牌；MAX/MIN先从本家找，找不到则换牌
        let resolved;
        if (sc.rank === 'WIN') {
          resolved = resolveWinCard(sc, seat, ps);
        } else {
          resolved = resolveScriptCard(sc, ps.ewHands[seat]);
          if (!resolved) {
            const partner = ewPartner(seat);
            const fromPartner = resolveScriptCard(sc, ps.ewHands[partner]);
            if (fromPartner) {
              ps.ewHands[partner] = removeCard(ps.ewHands[partner], fromPartner);
              ps.ewHands[seat]    = [...ps.ewHands[seat], fromPartner];
              resolved = fromPartner;
            }
          }
        }
        if (resolved) {
          card = resolved;
          ps.scriptPtr++;
        }
      } else {
        if (handHasCard(ps.ewHands[seat], sc)) {
          card = sc;
          ps.scriptPtr++;
        } else {
          // 换牌：同伴手中有此牌则借入本家再出（仅脚本触发）
          // 若该座位曾在此花色上垫过牌，拒绝换牌
          const partner = ewPartner(seat);
          if (handHasCard(ps.ewHands[partner], sc) && !hasShownVoid(ps, seat, sc.suit)) {
            ps.ewHands[partner] = removeCard(ps.ewHands[partner], sc);
            ps.ewHands[seat]    = [...ps.ewHands[seat], sc];
            card = sc;
            ps.scriptPtr++;
          }
        }
      }
    }
  }

  // 1.5 跟花色强制：脚本或触发器给出的牌若违反跟花色规则，废除脚本并改用 DDS
  if (card && currentTrick.length > 0) {
    const ledSuit = currentTrick[0].card.suit;
    if (card.suit !== ledSuit && ps.ewHands[seat].some(c => c.suit === ledSuit)) {
      console.log(`[PROB] step1.5 ABANDON: seat=${seat} card=${card.suit}${card.rank} ledSuit=${ledSuit}`);
      ps.scriptAbandoned = true;
      card = null;
    }
  }

  // 2. 兑现击宕优先：若EW合力兑现若干墩即可达到宕约标准，则一定这么做
  // 但不得覆盖剧本/触发器已指定的防守行为。
  if (!card && !scriptHasPlayHere && solveBoard) {
    try {
      const ewNeeded = 14 - ps.tricksNeeded;
      if (currentTrick.length > 0) {
        card = pickWinThenCashCard(
          seat,
          ps.ewHands,
          ps.hands,
          currentTrick,
          trumpSuit,
          ps.ewTricks,
          ewNeeded);
        if (card) {
          console.log(`[PROB] cash-defense follow-win seat=${seat} card=${card.suit}${card.rank}`);
        }
      }
      const trickLeader0 = currentTrick.length > 0 ? currentTrick[0].seat : seat;
      const ddsCheck = await solveBoard({
        trump:       trumpSuit,
        trickLeader: trickLeader0,
        trickPlayed: currentTrick.map(e => e.card),
        hands: { N: ps.hands.N, S: ps.hands.S, E: ps.ewHands.E, W: ps.ewHands.W },
      });
      if (!card && ddsCheck && ps.ewTricks + ddsCheck.score >= ewNeeded) {
        const cands = ddsCheck.cards.filter(c => handHasCard(ps.ewHands[seat], c));
        card = pickBestConsecutiveCard(cands, seat, ps.ewHands, ps.hands, currentTrick, trumpSuit);
      }
    } catch (_) { /* 预检失败则继续走普通 DDS */ }
  }

  // 3. DDS 双明手最优防守（对当前手牌求解，不换牌）
  if (!card && solveBoard) {
    try {
      const trickLeader = currentTrick.length > 0 ? currentTrick[0].seat : seat;
      const ddsResult   = await solveBoard({
        trump:       trumpSuit,
        trickLeader,
        trickPlayed: currentTrick.map(e => e.card),
        hands: {
          N: ps.hands.N,
          S: ps.hands.S,
          E: ps.ewHands.E,
          W: ps.ewHands.W,
        },
      });
      if (ddsResult.cards.length > 0) {
        const cands = ddsResult.cards.filter(c => handHasCard(ps.ewHands[seat], c));
        if (cands.length > 0) card = cands[0];
      }
    } catch (err) {
      console.error('[DDS] solveBoard error:', err.message);
    }
  }

  // 4. 桥牌启发式回退
  if (!card) {
    card = autoDefenseCardFallback(seat, ps.ewHands[seat], currentTrick, trumpSuit);
  }

  if (!card || ps.finished) return false;

  console.log(`[PROB] autoDefense PLAY seat=${seat} card=${card.suit}${card.rank} method=${card === null?'none': ps.scriptAbandoned?'DDS/fallback':'script/trigger'}`);

  // 执行出牌
  ps.ewHands[seat] = removeCard(ps.ewHands[seat], card);
  ps.currentTrick.push({ seat, card });

  io.to(room.id).emit('probCardPlayed', {
    seat, card,
    currentTrick: ps.currentTrick,
    handSizes: { E: ps.ewHands.E.length, W: ps.ewHands.W.length },
  });
  emitProblemSpectatorHands(room);

  if (ps.currentTrick.length === 4) {
    probFinishTrick(room);
  } else {
    ps.currentPlayer = nextSeat(seat);
    if (ps.currentPlayer === 'E' || ps.currentPlayer === 'W') {
      setTimeout(() => probAutoDefense(room), 350);
    } else {
      // NS 的回合：立即通知，不走延迟计时器（避免竞态污染下一墩）
      io.to(room.id).emit('probPlayUpdate', {
        currentPlayer: ps.currentPlayer,
        nsTricks:      ps.nsTricks,
        ewTricks:      ps.ewTricks,
        completedCount: ps.completedTricks.length,
        handSizes: { E: ps.ewHands.E.length, W: ps.ewHands.W.length },
      });
    }
  }
  return true;
}

function probFinishTrick(room) {
  const ps = room.probState;
  const trick = ps.currentTrick;
  const trumpSuit = ps.contract.suit;
  const winner = trickWinner2(trick, trumpSuit);

  const nsSide = (winner === 'N' || winner === 'S');
  if (nsSide) ps.nsTricks++; else ps.ewTricks++;
  ps.completedTricks.push({ cards: [...trick], winner });
  ps.currentTrick = [];
  ps.leader = winner;
  ps.currentPlayer = winner;
  ps.awaitingCollect = true;  // 等玩家点击收牌再做判断

  io.to(room.id).emit('probTrickEnd', {
    trick: { cards: trick, winner },
    nsTricks: ps.nsTricks,
    ewTricks: ps.ewTricks,
    completedCount: ps.completedTricks.length,
  });
}

function buildProblemSnapshot(room, isOwner) {
  const ps = room.probState;
  const prob = room.problem;
  if (!ps || !prob) return null;
  const snapshot = {
    contract:     ps.contract,
    tricksNeeded: ps.tricksNeeded,
    totalTCs:     ps.testCases.length,
    testCaseIdx:  ps.testCaseIdx,
    hands:        { N: ps.hands.N, S: ps.hands.S },
    handSizes:    { E: ps.ewHands.E.length, W: ps.ewHands.W.length },
    currentPlayer: ps.currentPlayer,
    leader:       ps.leader,
    currentTrick:  ps.currentTrick,
    completedTricks: ps.completedTricks,
    awaitingCollect: !!ps.awaitingCollect,
    nsTricks:     ps.nsTricks,
    ewTricks:     ps.ewTricks,
    memoryUses:   ps.memoryUses,
    startTime:    ps.startTime,
    vulnerability: prob.vulnerability || 'NONE',
    problemName:  prob.name || prob.id,
    flavorText:   prob.flavorText || '',
    auction:      prob.auction || [],
    ownerSocketId: room.ownerSocketId,
    roomId:       room.id,
    isOwner:      !!isOwner,
    phase:        room.phase,
  };
  if (!isOwner) {
    snapshot.spectatorHands = {
      E: ps.ewHands.E.map(c => ({ ...c })),
      W: ps.ewHands.W.map(c => ({ ...c })),
    };
  }
  return snapshot;
}

function emitProblemSpectatorHands(room) {
  const ps = room.probState;
  if (!ps) return;
  const sockets = io.sockets.adapter.rooms.get(room.id);
  if (!sockets) return;
  const spectatorHands = {
    E: ps.ewHands.E.map(c => ({ ...c })),
    W: ps.ewHands.W.map(c => ({ ...c })),
  };
  for (const socketId of sockets) {
    if (socketId === room.ownerSocketId) continue;
    io.to(socketId).emit('probSpectatorHands', {
      hands: spectatorHands,
      handSizes: { E: spectatorHands.E.length, W: spectatorHands.W.length },
    });
  }
}

function startPostCG(room) {
  const prob = room.problem;
  const pcg  = prob.postCG;
  room.phase = 'PROB_POST_CG';

  const nsHands = { N: prob.hands.N.map(c=>({...c})), S: prob.hands.S.map(c=>({...c})) };
  const ewHands = { E: prob.ewHands.E.map(c=>({...c})), W: prob.ewHands.W.map(c=>({...c})) };
  const leader  = prob.openingLeader || nextSeat(prob.contract.declarer);
  const script  = pcg.openingLead ? [{ seat: leader, card: pcg.openingLead }] : [];

  room.probState = {
    contract: prob.contract,
    tricksNeeded: prob.tricksNeeded,
    testCases: [{ script }],
    testCaseIdx: 0,
    currentTC: { script },
    hands: nsHands,
    ewHands,
    initialNsHands: { N: nsHands.N.map(c=>({...c})), S: nsHands.S.map(c=>({...c})) },
    probEwHands: { E: ewHands.E.map(c=>({...c})), W: ewHands.W.map(c=>({...c})) },
    tcInitialHands: { N: nsHands.N.map(c=>({...c})), S: nsHands.S.map(c=>({...c})),
                      E: ewHands.E.map(c=>({...c})), W: ewHands.W.map(c=>({...c})) },
    completedTricks: [],
    currentTrick: [],
    nsTricks: 0,
    ewTricks: 0,
    currentPlayer: leader,
    leader,
    scriptPtr: 0,
    scriptAbandoned: false,
    activeScript: script,
    midTrickTriggers: [],
    finished: false,
    startTime: Date.now(),
    memoryUses: 0,
    viewedOldTricks: [],
    viewedCounters: [],
    firedTriggers: new Set(),
    deviationBranches: [],
  };

  io.to(room.id).emit('probStart', {
    problemId:    prob.id,
    problemName:  prob.name,
    flavorText:   prob.flavorText,
    contract:     prob.contract,
    vulnerability: prob.vulnerability || 'NONE',
    tricksNeeded: prob.tricksNeeded,
    totalTCs:     1,
    auction:      prob.auction || [],
    hands:        nsHands,
    handSizes:    { E: ewHands.E.length, W: ewHands.W.length },
    currentPlayer: leader,
    leader,
    isPostCG:     true,
  });
  emitProblemSpectatorHands(room);

  if (leader === 'E' || leader === 'W') setTimeout(() => probAutoDefense(room), 600);
}

function probEndGame(room, forcedResult, gaveUp = false) {
  const ps   = room.probState;
  const prob = room.problem;

  // AC 时：若有 postCG 且尚未播放，先进入 postCG 演示
  if (!gaveUp && (forcedResult === 'AC' || (!forcedResult && ps.nsTricks >= ps.tricksNeeded))) {
    const result = forcedResult || 'AC';
    if (result === 'AC' && prob.postCG && !room.postCGPlayed) {
      room.postCGPlayed = true;
      // 保存主局结算数据，供 postCG 结束后使用
      const mainElapsed = (Date.now() - ps.startTime) / 1000;
      const mainFinal = { N: [...ps.hands.N], S: [...ps.hands.S], E: [...ps.ewHands.E], W: [...ps.ewHands.W] };
      for (const trick of ps.completedTricks) for (const e of trick.cards) mainFinal[e.seat].push(e.card);
      for (const e of (ps.currentTrick || [])) mainFinal[e.seat].push(e.card);
      room.mainGameData = {
        nsTricks:        ps.nsTricks,
        ewTricks:        ps.ewTricks,
        elapsed:         Math.round(mainElapsed),
        memoryUses:      ps.memoryUses,
        needed:          ps.tricksNeeded,
        completedTricks: ps.completedTricks,
        initialHands:    ps.tcInitialHands,
        finalHands:      mainFinal,
      };
      startPostCG(room);
      return;
    }
  }

  ps.finished = true;
  room.phase = 'PROB_SCORING';

  const elapsed = (Date.now() - ps.startTime) / 1000;
  const needed  = ps.tricksNeeded;

  let result = forcedResult;
  if (!result) {
    if (ps.nsTricks < needed)  result = 'WA';
    else if (elapsed > 400)    result = 'TLE';
    else if (ps.memoryUses > 3) result = 'MLE';
    else                        result = 'AC';
  }

  ps.result = result;
  // 重建换牌后实际分布：剩余手牌 + 已出牌（含当前墩）
  const finalHands = { N: [...ps.hands.N], S: [...ps.hands.S], E: [...ps.ewHands.E], W: [...ps.ewHands.W] };
  for (const trick of ps.completedTricks) {
    for (const e of trick.cards) finalHands[e.seat].push(e.card);
  }
  for (const e of (ps.currentTrick || [])) finalHands[e.seat].push(e.card);

  ps.lastResult = {
    result,
    nsTricks:       ps.nsTricks,
    ewTricks:       ps.ewTricks,
    elapsed:        Math.round(elapsed),
    memoryUses:     ps.memoryUses,
    needed,
    gaveUp,
    completedTricks: ps.completedTricks,
    initialHands:    ps.tcInitialHands,
    finalHands,
  };
  io.to(room.id).emit('probGameEnd', ps.lastResult);
}

function emitProbTCStart(room, message = null, auction = null) {
  const ps        = room.probState;
  io.to(room.id).emit('probTCStart', {
    tcIdx:          ps.testCaseIdx,
    totalTCs:       ps.testCases.length,
    hands:          ps.hands,
    handSizes:      { E: ps.ewHands.E.length, W: ps.ewHands.W.length },
    currentPlayer:  ps.currentPlayer,
    leader:         ps.leader,
    nsTricks:       ps.nsTricks,
    ewTricks:       ps.ewTricks,
    completedCount: ps.completedTricks.length,
    contract:       ps.contract,
    tricksNeeded:   ps.tricksNeeded,
    startTime:      ps.startTime,
    memoryUses:     ps.memoryUses,
    auction,
    message,
  });
  emitProblemSpectatorHands(room);

  if (ps.leader === 'E' || ps.leader === 'W') {
    setTimeout(() => probAutoDefense(room), 600);
  }
}

function resetTestCaseState(room, tcIdx) {
  const ps = room.probState;
  const tc = ps.testCases[tcIdx];
  if (!tc) return false;
  const branchTrick = tc.branchTrick || 0;

  // 每个测试点应从题目主合同开始，再应用测试点级覆盖。
  ps.contract     = room.problem.contract;
  ps.tricksNeeded = room.problem.tricksNeeded;
  // 重建 NS 手牌（TC 自带则直接用，否则从初始手牌减去分支点前已出的牌）
  const nsHands = tc.nsHands
    ? { N: tc.nsHands.N.map(c => ({...c})), S: tc.nsHands.S.map(c => ({...c})) }
    : { N: ps.initialNsHands.N.map(c => ({...c})), S: ps.initialNsHands.S.map(c => ({...c})) };
  // 获取本测试点的 EW 初始手牌（TC 自带或继承题目默认）
  const ewHands = tc.ewHands
    ? { E: tc.ewHands.E.map(c => ({...c})), W: tc.ewHands.W.map(c => ({...c})) }
    : { E: ps.probEwHands.E.map(c => ({...c})), W: ps.probEwHands.W.map(c => ({...c})) };

  let nsTricks = 0, ewTricks = 0;
  for (let t = 0; t < branchTrick; t++) {
    const trickData = ps.completedTricks[t];
    for (const { seat, card } of trickData.cards) {
      if (seat === 'N' || seat === 'S') nsHands[seat] = removeCard(nsHands[seat], card);
      else                              ewHands[seat] = removeCard(ewHands[seat], card);
    }
    if (trickData.winner === 'N' || trickData.winner === 'S') nsTricks++;
    else ewTricks++;
  }

  // 截断已完成墩记录至分支点
  ps.completedTricks.splice(branchTrick);

  const leader = branchTrick === 0
    ? (room.problem.openingLeader || nextSeat(room.problem.contract.declarer))
    : ps.completedTricks[branchTrick - 1].winner;

  // 测试点级合同覆盖
  if (tc.contract) {
    ps.contract     = tc.contract;
    ps.tricksNeeded = tc.tricksNeeded ?? (tc.contract.level + 6);
  }

  if (tc.nsHands) {
    ps.initialNsHands = { N: nsHands.N.map(c=>({...c})), S: nsHands.S.map(c=>({...c})) };
  }
  if (tc.midTrickTriggers !== undefined) {
    ps.midTrickTriggers = tc.midTrickTriggers;
  } else {
    ps.midTrickTriggers = room.problem.midTrickTriggers || [];
  }

  ps.hands         = nsHands;
  ps.ewHands       = ewHands;
  ps.tcInitialHands = { N: nsHands.N.map(c=>({...c})), S: nsHands.S.map(c=>({...c})), E: ewHands.E.map(c=>({...c})), W: ewHands.W.map(c=>({...c})) };
  ps.nsTricks      = nsTricks;
  ps.ewTricks      = ewTricks;
  ps.leader        = leader;
  ps.currentPlayer = leader;
  ps.currentTrick  = [];
  ps.testCaseIdx    = tcIdx;
  ps.activeScript   = tc.script || null;
  ps.scriptPtr      = 0;
  ps.scriptAbandoned = false;
  ps.firedTriggers  = new Set();
  ps.awaitingCollect = false;
  ps.finished       = false;
  ps.result         = null;
  ps.lastResult     = null;
  room.phase        = 'PROB_PLAYING';
  return true;
}

// 回滚至分支点，切换东西家手牌，开始下一测试点
function startNextTestCase(room) {
  const ps = room.probState;
  const nextTCIdx = ps.testCaseIdx + 1;
  const nextTC = ps.testCases[nextTCIdx];
  if (!resetTestCaseState(room, nextTCIdx)) return;
  emitProbTCStart(room, nextTC.message ?? null, nextTC.auction ?? null);
}

function restartCurrentTestCase(room) {
  const ps = room.probState;
  if (!ps) return;
  const tcIdx = ps.testCaseIdx || 0;
  const tc = ps.testCases[tcIdx] || {};
  if (!resetTestCaseState(room, tcIdx)) return;
  ps.startTime = Date.now();
  ps.memoryUses = 0;
  ps.viewedOldTricks = [];
  ps.viewedCounters = [];
  emitProbTCStart(room, '已从当前测试点开头重试', tc.auction ?? null);
}

function startProblemGame(room, problemId) {
  const prob = loadProblem(problemId);
  if (!prob) { io.to(room.id).emit('appError', { msg: '题目加载失败' }); return; }

  room.problem = prob;

  // 若题目有 CG 且本次尚未播放过，先进入 CG 阶段（用 CG 合同跑一局正常游戏）
  if (prob.cg && !room.cgPlayed) {
    room.phase = 'PROB_CG';
    room.pendingProblemId = problemId;

    const cg = prob.cg;
    const cgHands   = { N: prob.hands.N.map(c=>({...c})), S: prob.hands.S.map(c=>({...c})) };
    const cgEwHands = { E: prob.ewHands.E.map(c=>({...c})), W: prob.ewHands.W.map(c=>({...c})) };
    const cgLeader  = prob.openingLeader || nextSeat(cg.contract.declarer);
    const cgScript  = cg.openingLead
      ? [{ seat: cgLeader, card: cg.openingLead }]
      : [];

    room.probState = {
      contract:        cg.contract,
      tricksNeeded:    cg.contract.level + 6,
      testCases:       [{ script: cgScript }],
      initialNsHands:  { N: prob.hands.N.map(c=>({...c})), S: prob.hands.S.map(c=>({...c})) },
      probEwHands:     { E: prob.ewHands.E.map(c=>({...c})), W: prob.ewHands.W.map(c=>({...c})) },
      tcInitialHands:  { N: cgHands.N.map(c=>({...c})), S: cgHands.S.map(c=>({...c})), E: cgEwHands.E.map(c=>({...c})), W: cgEwHands.W.map(c=>({...c})) },
      hands:           cgHands,
      ewHands:         cgEwHands,
      completedTricks: [],
      currentTrick:    [],
      nsTricks:        0,
      ewTricks:        0,
      leader:          cgLeader,
      currentPlayer:   cgLeader,
      startTime:       Date.now(),
      memoryUses:      0,
      viewedOldTricks: [],
      viewedCounters:  [],
      testCaseIdx:     0,
      activeScript:    cgScript,
      scriptPtr:       0,
      scriptAbandoned: false,
      midTrickTriggers: [],
      firedTriggers:   new Set(),
      dummyRevealed:   false,
      finished:        false,
      result:          null,
    };

    io.to(room.id).emit('probStart', {
      problemId:    prob.id,
      problemName:  prob.name,
      flavorText:   cg.flavorText,
      contract:     cg.contract,
      vulnerability: prob.vulnerability || 'NONE',
      tricksNeeded: cg.contract.level + 6,
      totalTCs:     1,
      auction:      cg.auction || [],
      hands:        cgHands,
      handSizes:    { E: cgEwHands.E.length, W: cgEwHands.W.length },
      currentPlayer: cgLeader,
      leader:       cgLeader,
      isCG:         true,
    });
    emitProblemSpectatorHands(room);

    if (cgLeader === 'E' || cgLeader === 'W') {
      setTimeout(() => probAutoDefense(room), 600);
    }
    return;
  }

  room.phase = 'PROB_PLAYING';

  // 深拷贝手牌（运行时修改）
  const hands = {
    N: prob.hands.N.map(c => ({ ...c })),
    S: prob.hands.S.map(c => ({ ...c })),
  };
  const ewHands = {
    E: prob.ewHands.E.map(c => ({ ...c })),
    W: prob.ewHands.W.map(c => ({ ...c })),
  };

  if (!prob.testCases || prob.testCases.length === 0) {
    io.to(room.id).emit('appError', { msg: '题目格式错误：缺少 testCases' }); return;
  }

  const firstTC = prob.testCases[0];
  const ewSrc   = firstTC.ewHands || prob.ewHands;
  const ewHands2 = {
    E: ewSrc.E.map(c => ({ ...c })),
    W: ewSrc.W.map(c => ({ ...c })),
  };
  const leader = prob.openingLeader || nextSeat(prob.contract.declarer);

  const tc0 = prob.testCases[0];
  room.probState = {
    contract:       prob.contract,
    tricksNeeded:   prob.tricksNeeded,
    testCases:      prob.testCases,
    initialNsHands: { N: prob.hands.N.map(c => ({...c})), S: prob.hands.S.map(c => ({...c})) },
    probEwHands:    { E: prob.ewHands.E.map(c => ({...c})), W: prob.ewHands.W.map(c => ({...c})) },
    tcInitialHands: { N: hands.N.map(c=>({...c})), S: hands.S.map(c=>({...c})), E: ewHands2.E.map(c=>({...c})), W: ewHands2.W.map(c=>({...c})) },
    hands,
    ewHands:        ewHands2,
    completedTricks: [],
    currentTrick:    [],
    nsTricks:        0,
    ewTricks:        0,
    leader,
    currentPlayer:   leader,
    startTime:       Date.now(),
    memoryUses:      0,
    viewedOldTricks: [],
    viewedCounters:  [],
    testCaseIdx:     0,
    activeScript:    tc0 ? tc0.script : null,
    scriptPtr:        0,
    scriptAbandoned:  false,
    midTrickTriggers: prob.midTrickTriggers || [],
    firedTriggers:    new Set(),
    dummyRevealed:    false,
    finished:         false,
    result:           null,
  };

  io.to(room.id).emit('probStart', {
    problemId:    prob.id,
    problemName:  prob.name,
    flavorText:   prob.flavorText,
    contract:     prob.contract,
    vulnerability: prob.vulnerability,
    tricksNeeded: prob.tricksNeeded,
    totalTCs:     prob.testCases.length,
    auction:      prob.auction || [],
    hands,
    handSizes:    { E: ewHands2.E.length, W: ewHands2.W.length },
    currentPlayer: leader,
    leader,
  });
  emitProblemSpectatorHands(room);

  if (leader === 'E' || leader === 'W') {
    setTimeout(() => probAutoDefense(room), 600);
  }
}

// 做题模式 Socket 事件
io.on('connection', (socket) => {
  // ── 做题模式：选题 ───────────────────────────────────────────
  socket.on('probChooseProblem', ({ problemId }) => {
    const roomId = sockRoom[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'problem') return;
    if (room.phase !== 'PROB_SELECT') return;
    if (room.ownerSocketId !== socket.id) {
      socket.emit('appError', { msg: '只有房主可以选题' }); return;
    }
    startProblemGame(room, problemId);
  });

  // ── 做题模式：出牌 ───────────────────────────────────────────
  socket.on('probPlayCard', ({ seat, card }) => {
    const roomId = sockRoom[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'problem' || (room.phase !== 'PROB_PLAYING' && room.phase !== 'PROB_CG' && room.phase !== 'PROB_POST_CG')) return;
    if (room.ownerSocketId !== socket.id) return;

    const ps = room.probState;
    if (ps.finished) return;
    if (ps.currentPlayer !== seat) {
      socket.emit('appError', { msg: `现在轮到 ${ps.currentPlayer} 出牌` }); return;
    }
    if (seat !== 'N' && seat !== 'S') {
      socket.emit('appError', { msg: '只能为庄家/明手出牌' }); return;
    }
    if (!handHasCard(ps.hands[seat], card)) {
      socket.emit('appError', { msg: '手中没有此牌' }); return;
    }

    // 跟花色验证
    if (ps.currentTrick.length > 0) {
      const ledSuit = ps.currentTrick[0].card.suit;
      const hasSuit = ps.hands[seat].some(c => c.suit === ledSuit);
      if (hasSuit && card.suit !== ledSuit) {
        socket.emit('appError', { msg: `必须跟${ledSuit}花色` }); return;
      }
    }

    // 出牌
    ps.hands[seat] = removeCard(ps.hands[seat], card);
    ps.currentTrick.push({ seat, card });

    // 脚本验证：推进 scriptPtr 或标记 scriptAbandoned（或切换偏离分支）
    if (!ps.scriptAbandoned) {
      const tc     = ps.testCases[ps.testCaseIdx];
      const script = ps.activeScript;
      if (script && ps.scriptPtr < script.length) {
        const expected = script[ps.scriptPtr];
        if (expected.seat === seat) {
          const ec = expected.card;
          const isDynamic = ec.rank === 'MAX' || ec.rank === 'MIN' || ec.rank === 'WIN';
          // ANY：无花色则接受任意牌；有花色则只校验花色；动态选择器：只校验花色；精确牌：花色+点数
          // LT_10：花色匹配且点数 < 10
          if (ec.rank === 'ANY') {
            if (!ec.suit || card.suit === ec.suit) {
              ps.scriptPtr++;
            } else {
              ps.scriptAbandoned = true;
            }
          } else if (ec.rank === 'LT_10') {
            if (card.suit === ec.suit && card.rank < 10) {
              ps.scriptPtr++;
            } else {
              ps.scriptAbandoned = true;
            }
          } else if (isDynamic ? card.suit === ec.suit : (card.suit === ec.suit && card.rank === ec.rank)) {
            ps.scriptPtr++;
          } else {
            // 检查是否有偏离分支
            const branches = (tc && tc.deviationBranches) || [];
            const branch = branches.find(b => b.at === ps.scriptPtr);
            if (branch) {
              console.log(`[PROB] NS BRANCH: seat=${seat} played=${card.suit}${card.rank} at ptr=${ps.scriptPtr} → switching script`);
              ps.activeScript = branch.script;
              ps.scriptPtr++;  // 当前 NS 出牌已消费（对应分支脚本中同位置的条目）
            } else {
              console.log(`[PROB] NS ABANDON: seat=${seat} played=${card.suit}${card.rank} expected=${ec.suit}${ec.rank} ptr=${ps.scriptPtr}`);
              ps.scriptAbandoned = true;
            }
          }
        }
      }
    }

    // 首攻摊明手
    if (!ps.dummyRevealed && ps.completedTricks.length === 0 && ps.currentTrick.length === 1) {
      ps.dummyRevealed = true;
    }

    io.to(room.id).emit('probCardPlayed', {
      seat, card,
      currentTrick: ps.currentTrick,
      handSizes: { E: ps.ewHands.E.length, W: ps.ewHands.W.length },
    });

    if (ps.currentTrick.length === 4) {
      probFinishTrick(room);
    } else {
      ps.currentPlayer = nextSeat(seat);
      // 若下一家是防守方，自动出牌
      if (ps.currentPlayer === 'E' || ps.currentPlayer === 'W') {
        setTimeout(() => probAutoDefense(room), 350);
      } else {
        io.to(room.id).emit('probPlayUpdate', {
          currentPlayer: ps.currentPlayer,
          nsTricks: ps.nsTricks,
          ewTricks: ps.ewTricks,
          completedCount: ps.completedTricks.length,
          handSizes: { E: ps.ewHands.E.length, W: ps.ewHands.W.length },
        });
      }
    }
  });

  // ── 做题模式：查看历史墩（计入记忆消耗）──────────────────────
  socket.on('probViewTrick', ({ trickIndex }) => {
    const roomId = sockRoom[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'problem') return;
    if (room.ownerSocketId !== socket.id) return;
    const ps = room.probState;
    if (!ps || ps.finished) return;
    const currentTrickNo = ps.completedTricks.length; // 当前是第几墩（完成数）
    if (trickIndex >= currentTrickNo) return; // 不计非历史墩
    if (!ps.viewedOldTricks.includes(trickIndex)) {
      ps.viewedOldTricks.push(trickIndex);
      ps.memoryUses++;
    }
    const trick = ps.completedTricks[trickIndex];
    socket.emit('probTrickData', { trickIndex, trick, memoryUses: ps.memoryUses });
  });

  // ── 做题模式：调出记牌器（计入记忆消耗）──────────────────────
  socket.on('probOpenCounter', ({ counterType }) => {
    const roomId = sockRoom[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'problem') return;
    if (room.ownerSocketId !== socket.id) return;
    const ps = room.probState;
    if (!ps || ps.finished) return;
    // 同一墩同一种记牌器只计费一次
    const key = `${ps.completedTricks.length}_${counterType}`;
    if (!ps.viewedCounters.includes(key)) {
      ps.viewedCounters.push(key);
      ps.memoryUses++;
    }
    socket.emit('probCounterAck', { counterType, memoryUses: ps.memoryUses });
  });

  // ── 做题模式：测试点通过 → 进入下一测试点 ──────────────────────
  socket.on('probTCAdvance', () => {
    const roomId = sockRoom[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'problem' || (room.phase !== 'PROB_PLAYING' && room.phase !== 'PROB_CG' && room.phase !== 'PROB_POST_CG')) return;
    if (room.ownerSocketId !== socket.id) return;
    const ps = room.probState;
    if (!ps || ps.finished) return;
    const nextTCIdx = ps.testCaseIdx + 1;
    if (nextTCIdx < ps.testCases.length) {
      startNextTestCase(room);
    }
  });

  // ── 做题模式：收牌确认（EW赢墩后客户端点击收牌触发）────────
  socket.on('probTrickCollect', () => {
    const roomId = sockRoom[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'problem' || (room.phase !== 'PROB_PLAYING' && room.phase !== 'PROB_CG' && room.phase !== 'PROB_POST_CG')) return;
    if (room.ownerSocketId !== socket.id) return;
    const ps = room.probState;
    if (!ps || ps.finished) return;
    if (!ps.awaitingCollect) return;
    ps.awaitingCollect = false;

    const lastTrick = ps.completedTricks[ps.completedTricks.length - 1] || null;
    if (lastTrick) {
      io.to(room.id).emit('probTrickCollected', {
        trick: lastTrick,
        nsTricks: ps.nsTricks,
        ewTricks: ps.ewTricks,
        completedCount: ps.completedTricks.length,
        currentPlayer: ps.currentPlayer,
        handSizes: { E: ps.ewHands.E.length, W: ps.ewHands.W.length },
      });
    }

    const needed = ps.tricksNeeded;
    const defenseNeeded = 14 - needed;

    // EW 击宕
    if (ps.ewTricks >= defenseNeeded) {
      if (room.phase === 'PROB_CG') {
        ps.finished = true;
        io.to(room.id).emit('probCGVerdictReady');
      } else if (room.phase === 'PROB_POST_CG') {
        ps.finished = true;
        io.to(room.id).emit('probPostCGVerdictReady', {
          verdictText: room.problem.postCG.verdictText || '',
        });
      } else {
        probEndGame(room, 'WA');
      }
      return;
    }

    // NS 完约
    if (ps.nsTricks >= needed) {
      const nextTCIdx = ps.testCaseIdx + 1;
      if (nextTCIdx >= ps.testCases.length) {
        probEndGame(room, null);
      } else {
        io.to(room.id).emit('probTCPassed', {
          tcIdx:     ps.testCaseIdx,
          nextTcIdx: nextTCIdx,
          totalTCs:  ps.testCases.length,
        });
      }
      return;
    }

    // 13 墩打完但 NS 未完约
    if (ps.completedTricks.length === 13) {
      if (room.phase === 'PROB_CG') {
        ps.finished = true;
        io.to(room.id).emit('probCGVerdictReady');
      } else if (room.phase === 'PROB_POST_CG') {
        ps.finished = true;
        io.to(room.id).emit('probPostCGVerdictReady', {
          verdictText: room.problem.postCG.verdictText || '',
        });
      } else {
        probEndGame(room, 'WA');
      }
      return;
    }

    // 继续出牌
    const cur = ps.currentPlayer;
    if (cur === 'E' || cur === 'W') {
      setTimeout(() => probAutoDefense(room), 300);
    } else {
      io.to(room.id).emit('probPlayUpdate', {
        currentPlayer: ps.currentPlayer,
        nsTricks: ps.nsTricks,
        ewTricks: ps.ewTricks,
        completedCount: ps.completedTricks.length,
        handSizes: { E: ps.ewHands.E.length, W: ps.ewHands.W.length },
      });
    }
  });

  // ── 做题模式：放弃当前题目 ──────────────────────────────────
  socket.on('probGiveUp', () => {
    const roomId = sockRoom[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'problem') return;
    if (room.ownerSocketId !== socket.id) return;
    const ps = room.probState;
    if (room.phase === 'PROB_PLAYING') {
      if (!ps || ps.finished) return;
      probEndGame(room, 'WA', true);
    } else if (room.phase === 'PROB_CG') {
      // pre-CG 放弃：跳过 CG 直接进入正题
      if (!ps || ps.finished) return;
      ps.finished = true;
      room.cgPlayed = true;
      room.phase = 'PROB_PLAYING';
      const probId = room.pendingProblemId;
      room.pendingProblemId = null;
      startProblemGame(room, probId);
    } else if (room.phase === 'PROB_POST_CG') {
      // post-CG 放弃：直接结算 AC
      if (!ps || ps.finished) return;
      ps.finished = true;
      room.phase = 'PROB_SCORING';
      const d = room.mainGameData || {};
      const payload = {
        result: 'AC', nsTricks: d.nsTricks ?? 0, ewTricks: d.ewTricks ?? 0,
        elapsed: d.elapsed ?? 0, memoryUses: d.memoryUses ?? 0,
        needed: d.needed ?? 0, gaveUp: false,
        completedTricks: d.completedTricks ?? [], initialHands: d.initialHands ?? null,
        finalHands: d.finalHands ?? null,
      };
      room.probState.lastResult = payload;
      io.to(room.id).emit('probGameEnd', payload);
    }
  });

  // ── 做题模式：返回选题 ───────────────────────────────────────
  // ── CG 播完，进入正题 ────────────────────────────────────────
  socket.on('probCGAck', () => {
    const roomId = sockRoom[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'problem' || room.phase !== 'PROB_CG') return;
    if (room.ownerSocketId !== socket.id) return;
    room.cgPlayed = true;
    room.phase = 'PROB_PLAYING';
    const probId = room.pendingProblemId;
    room.pendingProblemId = null;
    startProblemGame(room, probId);
  });

  // ── postCG 播完，正式结算 AC ─────────────────────────────────
  socket.on('probPostCGAck', () => {
    const roomId = sockRoom[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'problem' || room.phase !== 'PROB_POST_CG') return;
    if (room.ownerSocketId !== socket.id) return;
    room.phase = 'PROB_SCORING';
    room.probState.finished = true;
    const d = room.mainGameData || {};
    const payload = {
      result:          'AC',
      nsTricks:        d.nsTricks  ?? 0,
      ewTricks:        d.ewTricks  ?? 0,
      elapsed:         d.elapsed   ?? 0,
      memoryUses:      d.memoryUses ?? 0,
      needed:          d.needed    ?? 0,
      gaveUp:          false,
      completedTricks: d.completedTricks ?? [],
      initialHands:    d.initialHands    ?? null,
      finalHands:      d.finalHands      ?? null,
    };
    room.probState.lastResult = payload;
    io.to(room.id).emit('probGameEnd', payload);
  });

  socket.on('probBackToSelect', () => {
    const roomId = sockRoom[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'problem') return;
    if (room.ownerSocketId !== socket.id) return;
    room.phase = 'PROB_SELECT';
    room.problem = null;
    room.probState = null;
    io.to(room.id).emit('probSelectStart', { problems: PROBLEM_LIST });
  });

  // ── 做题模式：重试本题 ────────────────────────────────────────
  socket.on('probRetry', () => {
    const roomId = sockRoom[socket.id];
    const room   = rooms[roomId];
    if (!room || room.mode !== 'problem') return;
    if (room.ownerSocketId !== socket.id) return;
    if (!room.probState) return;
    restartCurrentTestCase(room);
  });
});

// 做题模式 createRoom 支持 & ownerStartGame 路由（补丁）
// 在现有 createRoom handler 末尾已经有 mode 存储逻辑，
// 这里修补 ownerStartGame 以支持 problem 模式：
// （实际修改在下方的 io.on 中已注册，通过第二个 connection handler 无法覆盖；
//  改为直接在 server.js 加载时 patch rooms[id] 的 phase 逻辑）
// NOTE: 实际 ownerStartGame 的 problem 路由在主 io.on('connection') 里通过修改 makeRoom 完成，
// 见下方 PATCH 注释。

server.listen(PORT, () => {
  console.log(`\n🃏  Stepstone 桥牌服务器已启动`);
  console.log(`    本地访问: http://localhost:${PORT}`);
  console.log(`    使用路由侠等工具映射端口 ${PORT} 即可联机\n`);
});
