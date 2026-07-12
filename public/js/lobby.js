// lobby.js — 大厅逻辑

const socket = io();
let myName        = '';
let myRoomId      = '';
let mySeat        = null;
let isOwner       = false;
let ownerSocketId = null;
let roomMode      = 'classic';
let myCharId      = null;

// 大招模式角色列表（与 skills/characters.json 同步，共10个）
const CHARACTERS = [
  { id: 'liubei',      name: '刘备',   faction: '蜀汉', desc: '仁德：叫牌结束送至多2张牌给同伴，点数+1' },
  { id: 'zhugeliang',  name: '诸葛亮', faction: '蜀汉', desc: '尽瘁：叫牌开始窥牌堆顶7张；智哲：叫牌结束复制1张' },
  { id: 'caocao',      name: '曹操',   faction: '魏国', desc: '奸雄CD:2：我方输墩后，与赢墩者互换所打的牌' },
  { id: 'zhangliao',   name: '张辽',   faction: '魏国', desc: '突袭：叫牌结束从两名对手各随机夺1张牌' },
  { id: 'sunquan',     name: '孙权',   faction: '吴国', desc: '制衡：叫牌开始弃至多4张，摸等量的牌' },
  { id: 'lvmeng',      name: '吕蒙',   faction: '吴国', desc: '克己CD:1：有手牌时可打出PASS（不消耗手牌）' },
  { id: 'dongzhuo',    name: '董卓',   faction: '群雄', desc: '酒池CD:1：打出♠时可令其点数+π（最大到A）' },
  { id: 'zhangxiu',    name: '张绣',   faction: '群雄', desc: '雄乱CD:2：引出前令一角色本墩强制PASS' },
  { id: 'liuxie',      name: '刘协',   faction: '汉朝', desc: '密诏CD:2：叫牌结束将全部手牌交给同伴' },
  { id: 'hetaihou',    name: '何太后', faction: '汉朝', desc: '戚乱CD:1：我方赢得击宕敌方的那一墩时摸3张' },
];

// ─── 页面切换 ──────────────────────────────────────────────────
function showCreate(mode) {
  myName = document.getElementById('input-name').value.trim();
  if (!myName) { showToast('请先输入你的名字'); return; }
  roomMode = mode;
  socket.emit('createRoom', { playerName: myName, mode });
}

function createWithMode(mode) {
  showCreate(mode);
}

function showJoin() {
  myName = document.getElementById('input-name').value.trim();
  if (!myName) { showToast('请先输入你的名字'); return; }
  hide('section-name');
  show('section-join');
  document.getElementById('input-room-code').focus();
}

function doJoin() {
  const code = document.getElementById('input-room-code').value.trim();
  if (!/^\d{3}$/.test(code)) { showToast('请输入3位数字房间号'); return; }
  socket.emit('joinRoom', { roomId: code, playerName: myName });
}

function backToMain() {
  hide('section-join');
  show('section-name');
}

function copyRoomId() {
  if (!myRoomId) return;
  navigator.clipboard.writeText(myRoomId).then(() => showToast('房间号已复制'));
}

function chooseSeat(seat) {
  if (!myRoomId) return;
  if (seat === mySeat) {
    socket.emit('leaveSeat');
    return;
  }
  socket.emit('chooseSeat', { seat, playerName: myName });
}

function ownerStartGame() {
  socket.emit('ownerStartGame');
}

function leaveRoom() {
  socket.disconnect();
  window.location.href = '/';
}


// ─── Socket 事件 ───────────────────────────────────────────────
socket.on('roomCreated', ({ roomId, ownerSocketId: ownId, mode, teachingMode }) => {
  myRoomId      = roomId;
  isOwner       = true;
  ownerSocketId = ownId;
  roomMode      = teachingMode ? 'teaching' : (mode || 'classic');

  if (roomMode === 'problem') {
    // 做题模式：房主直接进入做题页面，保存原始 socketId 作为 owner token
    sessionStorage.setItem('ss_prob_roomId', roomId);
    sessionStorage.setItem('ss_prob_isOwner', 'true');
    sessionStorage.setItem('ss_prob_ownerToken', ownId); // 原始 socketId 作验证
    sessionStorage.setItem('ss_prob_name', myName);
    window.location.href = 'problem.html';
    return;
  }

  enterLobby(roomId);
  navigator.clipboard.writeText(roomId)
    .then(() => showToast(`房间号 ${roomId} 已复制到剪贴板`))
    .catch(() => showToast(`房间号：${roomId}`));
  updateOwnerUI([]);

  renderModeTag();
  renderTeachingHint();
});

socket.on('roomJoined', ({ roomId, playerNames, readyStatus, ownerSocketId: ownId, mode, teachingMode }) => {
  myRoomId      = roomId;
  ownerSocketId = ownId;
  isOwner       = false;
  roomMode      = teachingMode ? 'teaching' : (mode || 'classic');
  enterLobby(roomId);
  updateSeats(playerNames);

  renderModeTag();
  renderTeachingHint();
});

// 加入做题模式房间（旁观者）
socket.on('probRoomJoined', ({ roomId, ownerSocketId: ownId }) => {
  myRoomId = roomId;
  isOwner  = false;
  sessionStorage.setItem('ss_prob_roomId', roomId);
  sessionStorage.setItem('ss_prob_isOwner', 'false');
  sessionStorage.setItem('ss_prob_name', myName);
  window.location.href = 'problem.html';
});

socket.on('roomUpdate', ({ playerNames, ownerSocketId: ownId, mode, teachingMode, characters }) => {
  ownerSocketId = ownId;
  if (teachingMode !== undefined) roomMode = teachingMode ? 'teaching' : (mode || 'classic');
  else if (mode) roomMode = mode;
  updateSeats(playerNames);
  renderTeachingHint();
});


socket.on('appError', ({ msg }) => {
  showToast(msg);
  if (msg === '房间不存在') setTimeout(() => { window.location.href = '/'; }, 1500);
});

socket.on('playerDisconnected', ({ seat }) => {
  const nameEl = document.getElementById('name-' + seat);
  if (nameEl) nameEl.textContent = '空位';
  const slotEl = document.getElementById('seat-' + seat);
  if (slotEl) slotEl.classList.remove('occupied', 'mine');
  if (seat === mySeat) { mySeat = null; }
  updateOwnerUI(null);
});

socket.on('seatLeft', () => {
  mySeat = null;
  updateOwnerUI(null);
});

socket.on('gameStart', ({ seat }) => {
  sessionStorage.setItem('ss_roomId', myRoomId);
  sessionStorage.setItem('ss_seat',   seat);
  sessionStorage.setItem('ss_name',   myName);
  window.location.href = 'game.html';
});

// 新流程：ultCharOptions 触发跳转（含 seat）
socket.on('ultCharOptions', ({ seat }) => {
  sessionStorage.setItem('ss_roomId', myRoomId);
  sessionStorage.setItem('ss_seat',   seat);
  sessionStorage.setItem('ss_name',   myName);
  window.location.href = 'ult.html';
});

// 兼容旧事件（如果服务端旧代码路径仍发此事件）
socket.on('ultGameStart', ({ seat }) => {
  sessionStorage.setItem('ss_roomId', myRoomId);
  sessionStorage.setItem('ss_seat',   seat);
  sessionStorage.setItem('ss_name',   myName);
  window.location.href = 'ult.html';
});

// ─── UI 工具 ───────────────────────────────────────────────────
function enterLobby(roomId) {
  hide('section-name');
  hide('section-join');
  show('section-lobby');
  document.getElementById('display-room-id').textContent = roomId;
}

function updateSeats(playerNames) {
  const SEATS = ['N','E','S','W'];
  let seatedCount = 0;
  SEATS.forEach(s => {
    const nameEl = document.getElementById('name-' + s);
    const slotEl = document.getElementById('seat-' + s);
    const name   = playerNames[s];
    if (name) {
      seatedCount++;
      nameEl.textContent = name;
      slotEl.classList.add('occupied');
      if (name === myName && !mySeat) {
        mySeat = s;
        slotEl.classList.add('mine');
      }
    } else {
      nameEl.textContent = '空位';
      slotEl.classList.remove('occupied', 'mine');
    }
  });
  updateOwnerUI(seatedCount);
  if (window.lucide) lucide.createIcons();
}


function renderModeTag() {
  const el = document.getElementById('display-room-mode');
  if (!el) return;
  const labels = { classic: '经典', ult: '大招', teaching: '教学', problem: '做题' };
  const cls    = { classic: '', ult: 'mode-tag-ult', teaching: 'mode-tag-teach', problem: 'mode-tag-quiz' };
  el.textContent = labels[roomMode] || roomMode;
  el.className   = 'room-mode-tag ' + (cls[roomMode] || '');
}

function renderTeachingHint() {
  const panel = document.getElementById('teaching-hint-panel');
  if (!panel) return;
  if (roomMode === 'teaching') panel.classList.remove('hidden');
  else panel.classList.add('hidden');
}

function updateOwnerUI(seatedCount) {
  const btn      = document.getElementById('btn-start-game');
  const hintEl   = document.getElementById('lobby-hint');
  if (!btn) return;

  if (!isOwner) {
    btn.classList.add('hidden');
    if (hintEl) hintEl.textContent = '等待房主开始游戏…';
    return;
  }

  if (seatedCount === null) {
    const SEATS = ['N','E','S','W'];
    seatedCount = SEATS.filter(s => {
      const el = document.getElementById('name-' + s);
      return el && el.textContent !== '空位';
    }).length;
  }

  btn.classList.remove('hidden');
  const isTeaching = roomMode === 'teaching';
  const isProblem  = roomMode === 'problem';
  const canStart   = isTeaching || isProblem ? true : seatedCount === 4;
  btn.disabled = !canStart;
  btn.style.opacity = canStart ? '1' : '0.45';
  if (hintEl) {
    if (isProblem) {
      hintEl.textContent = '做题模式：点击开始进入选题';
    } else if (isTeaching) {
      hintEl.textContent = canStart
        ? `已就座 ${seatedCount}/4，房主填充剩余座位`
        : '教学模式：需至少1名玩家入座';
    } else {
      hintEl.textContent = canStart
        ? '4人已就座，可以开始游戏'
        : `已就座 ${seatedCount}/4，等待玩家入座…`;
    }
  }
}

function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id) { document.getElementById(id)?.classList.add('hidden'); }

let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}
