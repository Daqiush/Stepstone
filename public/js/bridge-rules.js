// bridge-rules.js — 客户端共享的桥牌常量与工具函数

const BR = (() => {
  const SEATS      = ['N', 'E', 'S', 'W'];
  const SUITS      = ['S', 'H', 'D', 'C'];
  const SUIT_ORDER = { C:0, D:1, H:2, S:3, NT:4 };
  const RANK_VAL   = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };

  const SUIT_SYMBOL = { S:'♠', H:'♥', D:'♦', C:'♣', NT:'NT' };
  const SUIT_CLASS  = { S:'black', H:'red',  D:'red',  C:'black' };

  const SEAT_LABEL  = { N:'北', E:'东', S:'南', W:'西' };
  const VUL_LABEL   = { NONE:'无局', NS:'南北有局', EW:'东西有局', BOTH:'双方有局' };

  function nextSeat(s)  { return SEATS[(SEATS.indexOf(s) + 1) % 4]; }
  function partner(s)   { return SEATS[(SEATS.indexOf(s) + 2) % 4]; }
  function sideOf(s)    { return (s === 'N' || s === 'S') ? 'NS' : 'EW'; }
  function opponents(s) { return SEATS.filter(x => sideOf(x) !== sideOf(s)); }

  function rankDisplay(r) { return r === 'T' ? '10' : r; }

  function bidDisplay(bid) {
    if (['Pass','Double','Redouble'].includes(bid)) {
      return { Pass:'通', Double:'加倍', Redouble:'再加倍' }[bid];
    }
    const level = bid[0];
    const suit  = bid.slice(1);
    return level + (suit === 'NT' ? 'NT' : SUIT_SYMBOL[suit]);
  }

  function bidVal(bid) {
    if (['Pass','Double','Redouble'].includes(bid)) return -1;
    return parseInt(bid[0]) * 5 + SUIT_ORDER[bid.slice(1)];
  }

  // 判断局况中某方是否有局
  function isVul(vulStr, side) {
    if (vulStr === 'BOTH') return true;
    if (vulStr === 'NONE') return false;
    return vulStr === side;
  }

  // 花色显示顺序：将牌在左，其余按黑红交替
  const TRUMP_SUIT_ORDER = {
    S:  ['S','H','C','D'],
    H:  ['H','S','D','C'],
    D:  ['D','S','H','C'],
    C:  ['C','H','S','D'],
    NT: ['S','H','C','D'],
  };

  function suitOrder(trump) {
    return TRUMP_SUIT_ORDER[trump] || ['S','H','C','D'];
  }

  // 排序手牌：将牌在左，黑红交替，每花色内从大到小
  function sortHand(hand, trump) {
    const order = suitOrder(trump);
    const pri = {};
    order.forEach((s, i) => { pri[s] = order.length - 1 - i; });
    return [...hand].sort((a, b) => {
      const sd = pri[b.suit] - pri[a.suit];
      if (sd !== 0) return sd;
      return RANK_VAL[b.rank] - RANK_VAL[a.rank];
    });
  }

  // 按花色分组（尊重将牌顺序）
  function groupBySuit(hand, trump) {
    const g = { S:[], H:[], D:[], C:[] };
    for (const c of hand) g[c.suit].push(c);
    for (const s of SUITS) g[s].sort((a,b) => RANK_VAL[b.rank] - RANK_VAL[a.rank]);
    return g;
  }

  // 有效叫品判断（客户端渲染用）
  function getValidBids(currentContract, mySeat, currentBidder) {
    if (mySeat !== currentBidder) return {};
    const valid = { Pass: true };
    const cc = currentContract;
    const ccVal = cc ? cc.level * 5 + SUIT_ORDER[cc.suit] : -1;

    // 正常叫品
    for (let lv = 1; lv <= 7; lv++) {
      for (const suit of ['C','D','H','S','NT']) {
        const bid = `${lv}${suit}`;
        valid[bid] = lv * 5 + SUIT_ORDER[suit] > ccVal;
      }
    }

    // 加倍
    if (cc && sideOf(cc.seat) !== sideOf(mySeat) && !cc.doubled) {
      valid['Double'] = true;
    }

    // 再加倍（只有在 X 之后才能 XX，已经 XX 则不能再次 XX）
    if (cc && cc.doubled && !cc.redoubled && sideOf(cc.doublerSeat) !== sideOf(mySeat)) {
      valid['Redouble'] = true;
    }

    return valid;
  }

  return {
    SEATS, SUITS, SUIT_SYMBOL, SUIT_CLASS, SEAT_LABEL, VUL_LABEL,
    RANK_VAL, SUIT_ORDER,
    nextSeat, partner, sideOf, opponents,
    rankDisplay, bidDisplay, bidVal,
    isVul, sortHand, groupBySuit, getValidBids, suitOrder,
  };
})();
