const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'V', 'D', 'R', 'A'];
const START_CHIPS = 1000;
const SMALL_BLIND = 10;
const MAX_PLAYERS = 8;

function newDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 0; r < 13; r++) deck.push({ r: r + 2, label: RANKS[r], s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/* Score d'une main de 5 cartes : un tableau qu'on peut comparer.
   Premier nombre = catégorie (0 carte haute ... 8 quinte flush), puis les départages. */
function score5(cards) {
  const ranks = cards.map(c => c.r).sort((a, b) => b - a);
  const flush = cards.every(c => c.s === cards[0].s);
  const uniq = [...new Set(ranks)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks.join() === '14,5,4,3,2') straightHigh = 5;
  }
  const counts = {};
  ranks.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  const groups = Object.entries(counts)
    .map(([r, n]) => [n, +r])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const tiebreak = groups.map(g => g[1]);
  if (straightHigh && flush) return [8, straightHigh];
  if (groups[0][0] === 4) return [7, ...tiebreak];
  if (groups[0][0] === 3 && groups[1] && groups[1][0] === 2) return [6, ...tiebreak];
  if (flush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][0] === 3) return [3, ...tiebreak];
  if (groups[0][0] === 2 && groups[1] && groups[1][0] === 2) return [2, ...tiebreak];
  if (groups[0][0] === 2) return [1, ...tiebreak];
  return [0, ...ranks];
}

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

/* Meilleure main parmi 5, 6 ou 7 cartes (sert aussi au badge en direct) */
function bestScore(cards) {
  if (cards.length < 5) return null;
  let best = null;
  const n = cards.length;
  const pick = (start, chosen) => {
    if (chosen.length === 5) {
      const sc = score5(chosen);
      if (!best || compare(sc, best) > 0) best = sc;
      return;
    }
    for (let i = start; i < n; i++) pick(i + 1, chosen.concat(cards[i]));
  };
  pick(0, []);
  return best;
}

const RANK_NAMES = { 2: 'deux', 3: 'trois', 4: 'quatre', 5: 'cinq', 6: 'six', 7: 'sept', 8: 'huit', 9: 'neuf',
  10: 'dix', 11: 'valets', 12: 'dames', 13: 'rois', 14: 'as' };
const RANK_SING = { 2: 'deux', 3: 'trois', 4: 'quatre', 5: 'cinq', 6: 'six', 7: 'sept', 8: 'huit', 9: 'neuf',
  10: 'dix', 11: 'valet', 12: 'dame', 13: 'roi', 14: 'as' };

/* Nom lisible de la main, pour le badge en direct et pour l'abattage */
function handName(sc) {
  if (!sc) return '';
  const [cat, a, b] = sc;
  switch (cat) {
    case 8: return a === 14 ? 'Quinte flush royale' : 'Quinte flush au ' + RANK_SING[a];
    case 7: return 'Carré de ' + RANK_NAMES[a];
    case 6: return 'Full aux ' + RANK_NAMES[a] + ' par les ' + RANK_NAMES[b];
    case 5: return 'Couleur, ' + RANK_SING[a] + ' haut';
    case 4: return 'Quinte au ' + RANK_SING[a];
    case 3: return 'Brelan de ' + RANK_NAMES[a];
    case 2: return 'Double paire, ' + RANK_NAMES[a] + ' et ' + RANK_NAMES[b];
    case 1: return 'Paire de ' + RANK_NAMES[a];
    default: return RANK_SING[a].charAt(0).toUpperCase() + RANK_SING[a].slice(1) + ' haut';
  }
}

/* Pour deux cartes seulement (avant le flop) */
function preflopName(hand) {
  const [x, y] = hand;
  if (x.r === y.r) return 'Paire de ' + RANK_NAMES[x.r];
  const hi = Math.max(x.r, y.r);
  return RANK_SING[hi].charAt(0).toUpperCase() + RANK_SING[hi].slice(1) + ' haut' + (x.s === y.s ? ', assorties' : '');
}

function liveHandName(hand, board) {
  if (!hand || hand.length < 2) return '';
  const all = hand.concat(board);
  if (all.length < 5) return preflopName(hand);
  return handName(bestScore(all));
}

const tables = {};

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join(''); }
  while (tables[c]);
  return c;
}

function newPlayer(pid, name, socketId) {
  return {
    pid, socketId, name: String(name || '').trim().slice(0, 14) || 'Joueur',
    chips: START_CHIPS, bet: 0, totalBet: 0, hand: [],
    folded: false, allIn: false, inHand: false, acted: false,
    connected: true, out: false
  };
}function pot(t) { return t.players.reduce((s, p) => s + p.totalBet, 0); }
function seated(t) { return t.players.filter(p => !p.out); }
function contenders(t) { return t.players.filter(p => p.inHand && !p.folded); }

/* Prochain joueur qui doit parler, en partant de l'index donné */
function nextToAct(t, from) {
  const n = t.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    const p = t.players[idx];
    if (p.inHand && !p.folded && !p.allIn && !p.out) return idx;
  }
  return -1;
}

function nextSeated(t, from) {
  const n = t.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    if (!t.players[idx].out) return idx;
  }
  return from;
}

function postBlind(t, idx, amount) {
  const p = t.players[idx];
  const pay = Math.min(amount, p.chips);
  p.chips -= pay; p.bet += pay; p.totalBet += pay;
  if (p.chips === 0) p.allIn = true;
}

function startHand(t) {
  // les joueurs sans jetons deviennent spectateurs
  t.players.forEach(p => { if (p.chips <= 0) p.out = true; });
  const alive = seated(t);
  if (alive.length < 2) {
    t.phase = 'over';
    t.turn = -1;
    t.message = alive.length === 1 ? alive[0].name + ' remporte la partie !' : 'Partie terminée';
    return broadcast(t);
  }
  t.deck = newDeck();
  t.board = [];
  t.phase = 'preflop';
  t.message = '';
  t.results = null;
  t.handNo += 1;
  t.players.forEach(p => {
    p.bet = 0; p.totalBet = 0; p.folded = false; p.allIn = false; p.acted = false;
    p.inHand = !p.out;
    p.hand = p.out ? [] : [t.deck.pop(), t.deck.pop()];
  });
  t.dealer = nextSeated(t, t.dealer);
  const n = alive.length;
  const sb = n === 2 ? t.dealer : nextSeated(t, t.dealer);
  const bb = nextSeated(t, sb);
  postBlind(t, sb, SMALL_BLIND);
  postBlind(t, bb, SMALL_BLIND * 2);
  t.currentBet = SMALL_BLIND * 2;
  t.minRaise = SMALL_BLIND * 2;
  t.turn = nextToAct(t, bb);
  if (t.turn === -1) return runOut(t);
  broadcast(t);
}

function bettingDone(t) {
  const live = t.players.filter(p => p.inHand && !p.folded && !p.allIn);
  return live.every(p => p.acted && p.bet === t.currentBet);
}

/* Tout le monde (ou presque) est à tapis : on dévoile les cartes restantes */
function runOut(t) {
  while (t.board.length < 5) t.board.push(t.deck.pop());
  return finishHand(t);
}

function advance(t) {
  const alive = contenders(t);
  if (alive.length === 1) return finishHand(t);
  if (!bettingDone(t)) {
    t.turn = nextToAct(t, t.turn);
    if (t.turn === -1) return runOut(t);
    return broadcast(t);
  }
  // fin du tour d'enchères
  t.players.forEach(p => { p.bet = 0; p.acted = false; });
  t.currentBet = 0;
  t.minRaise = SMALL_BLIND * 2;
  const canAct = t.players.filter(p => p.inHand && !p.folded && !p.allIn);
  if (t.phase === 'river') return finishHand(t);
  const next = { preflop: 'flop', flop: 'turn', turn: 'river' }[t.phase];
  t.phase = next;
  if (next === 'flop') t.board.push(t.deck.pop(), t.deck.pop(), t.deck.pop());
  else t.board.push(t.deck.pop());
  if (canAct.length < 2) {
    // plus personne ne peut miser : on déroule le reste jusqu'à la river
    return runOut(t);
  }
  t.turn = nextToAct(t, t.dealer);
  broadcast(t);
}

/* Construit les pots (principal + annexes) d'après la mise totale de chacun */
function buildPots(t) {
  const bettors = t.players.filter(p => p.totalBet > 0);
  const levels = [...new Set(bettors.map(p => p.totalBet))].sort((a, b) => a - b);
  const pots = [];
  let prevLevel = 0;
  for (const lvl of levels) {
    const layer = lvl - prevLevel;
    const payers = bettors.filter(p => p.totalBet >= lvl);
    const amount = layer * payers.length;
    const eligible = payers.filter(p => !p.folded);
    if (amount > 0) pots.push({ amount, eligible });
    prevLevel = lvl;
  }
  // fusionne les pots consécutifs avec les mêmes joueurs éligibles
  const merged = [];
  for (const p of pots) {
    const last = merged[merged.length - 1];
    const same = last && last.eligible.length === p.eligible.length && last.eligible.every((x, i) => x === p.eligible[i]);
    if (same) last.amount += p.amount; else merged.push(p);
  }
  return merged;
}

function finishHand(t) {
  const alive = contenders(t);
  const total = pot(t);
  const revealed = alive.length > 1;
  if (revealed) {
    while (t.board.length < 5) t.board.push(t.deck.pop());
    alive.forEach(p => { p.score = bestScore(p.hand.concat(t.board)); });
  }
  const pots = buildPots(t);
  const winnings = {};
  const potResults = [];
  pots.forEach(pt => {
    let pool = pt.eligible;
    if (pool.length === 0) pool = alive; // sécurité
    let winners = pool;
    if (revealed && pool.length > 1) {
      let best = pool[0].score;
      pool.forEach(p => { if (compare(p.score, best) > 0) best = p.score; });
      winners = pool.filter(p => compare(p.score, best) === 0);
    }
    const share = Math.floor(pt.amount / winners.length);
    let rest = pt.amount - share * winners.length;
    winners.forEach(w => {
      let gain = share;
      if (rest > 0) { gain += 1; rest -= 1; }
      w.chips += gain;
      winnings[w.pid] = (winnings[w.pid] || 0) + gain;
    });
    potResults.push({ amount: pt.amount, winners: winners.map(w => w.name) });
  });
  const winnerNames = Object.keys(winnings).map(pid => t.players.find(p => p.pid === pid).name);
  t.phase = 'showdown';
  t.turn = -1;
  t.results = {
    total,
    winners: winnerNames,
    pots: potResults,
    hands: revealed ? alive.map(p => ({ name: p.name, hand: p.hand, label: handName(p.score) })) : [],
    gains: winnings
  };
  t.message = winnerNames.join(' et ') + ' remporte ' + total + ' jetons' +
    (revealed && winnerNames.length === 1 ? ' avec ' + handName(alive.find(p => p.name === winnerNames[0]).score).toLowerCase() : '');
  broadcast(t);
}

/* Ce que chaque joueur a le droit de voir */
function viewFor(t, pid) {
  const showdownReveal = t.phase === 'showdown' && t.results && t.results.hands.length > 0;
  const me = t.players.find(p => p.pid === pid);
  return {
    code: t.code, phase: t.phase, board: t.board, pot: pot(t),
    currentBet: t.currentBet, minRaise: t.minRaise, message: t.message,
    results: t.results, hostPid: t.hostPid, dealer: t.dealer, turn: t.turn,
    handNo: t.handNo, smallBlind: SMALL_BLIND, youPid: pid,
    liveHand: me && me.inHand && !me.folded && t.phase !== 'lobby' ? liveHandName(me.hand, t.board) : '',
    players: t.players.map(p => ({
      pid: p.pid, name: p.name, chips: p.chips, bet: p.bet, folded: p.folded, allIn: p.allIn,
      out: p.out, connected: p.connected, isYou: p.pid === pid, inHand: p.inHand,
      hand: (p.pid === pid || (showdownReveal && p.inHand && !p.folded)) ? p.hand : null,
      handLabel: showdownReveal && p.inHand && !p.folded
        ? (t.results.hands.find(h => h.name === p.name) || {}).label || '' : ''
    }))
  };
}

function broadcast(t) {
  t.players.forEach(p => { if (p.socketId && p.connected) io.to(p.socketId).emit('state', viewFor(t, p.pid)); });
}

function passHost(t) {
  const h = t.players.find(p => p.pid === t.hostPid);
  if (h && h.connected) return;
  const other = t.players.find(p => p.connected);
  if (other) t.hostPid = other.pid;
}

function currentTurnPlayer(t) { return t.turn >= 0 ? t.players[t.turn] : null; }

/* Quand quelqu'un se déconnecte en pleine main : on le couche si c'est son tour,
   sinon il sera couché automatiquement quand ce sera à lui de parler */
function autoFoldIfNeeded(t) {
  let guard = 0;
  while (['preflop', 'flop', 'turn', 'river'].includes(t.phase) && guard++ < 20) {
    const p = currentTurnPlayer(t);
    if (!p || p.connected) return;
    const toCall = t.currentBet - p.bet;
    if (toCall > 0) p.folded = true;
    p.acted = true;
    advance(t);
  }
}

io.on('connection', (socket) => {
  let tableCode = null, myPid = null;

  const T = () => tables[tableCode];

  socket.on('create', ({ name, pid }) => {
    if (!pid) return;
    const code = makeCode();
    const t = {
      code, hostPid: pid, players: [], deck: [], board: [], phase: 'lobby', dealer: -1, turn: -1,
      currentBet: 0, minRaise: SMALL_BLIND * 2, message: '', results: null, handNo: 0
    };
    tables[code] = t;
    const p = newPlayer(pid, name, socket.id);
    t.players.push(p);
    tableCode = code; myPid = pid;
    broadcast(t);
  });

  socket.on('join', ({ code, name, pid }) => {
    if (!pid) return;
    const t = tables[String(code || '').toUpperCase()];
    if (!t) return socket.emit('error-msg', 'Table introuvable');
    const existing = t.players.find(p => p.pid === pid);
    if (existing) {
      // reconnexion : le joueur retrouve sa place
      existing.socketId = socket.id; existing.connected = true;
      tableCode = t.code; myPid = pid;
      passHost(t);
      return broadcast(t);
    }
    if (t.phase !== 'lobby') return socket.emit('error-msg', 'La partie a déjà commencé');
    if (t.players.length >= MAX_PLAYERS) return socket.emit('error-msg', 'Table pleine (8 joueurs max)');
    t.players.push(newPlayer(pid, name, socket.id));
    tableCode = t.code; myPid = pid;
    broadcast(t);
  });

  socket.on('start', () => {
    const t = T();
    if (!t || t.hostPid !== myPid || t.phase !== 'lobby' || t.players.length < 2) return;
    startHand(t);
  });

  socket.on('next', () => {
    const t = T();
    if (!t || t.hostPid !== myPid || t.phase !== 'showdown') return;
    startHand(t);
  });

  socket.on('action', ({ type, amount }) => {
    const t = T();
    if (!t || !['preflop', 'flop', 'turn', 'river'].includes(t.phase)) return;
    const idx = t.players.findIndex(p => p.pid === myPid);
    if (idx < 0 || idx !== t.turn) return;
    const p = t.players[idx];
    const toCall = t.currentBet - p.bet;

    if (type === 'fold') {
      p.folded = true;
    } else if (type === 'check') {
      if (toCall > 0) return;
    } else if (type === 'call') {
      if (toCall <= 0) return;
      const pay = Math.min(toCall, p.chips);
      p.chips -= pay; p.bet += pay; p.totalBet += pay;
      if (p.chips === 0) p.allIn = true;
    } else if (type === 'raise') {
      let target = Math.floor(Number(amount));
      if (!Number.isFinite(target)) return;
      const maxTarget = p.bet + p.chips;
      target = Math.min(target, maxTarget);
      const isAllIn = target === maxTarget;
      if (target <= t.currentBet) {
        if (!isAllIn) return;
      } else if (target - t.currentBet < t.minRaise && !isAllIn) {
        return;
      }
      const pay = target - p.bet;
      if (pay <= 0) return;
      p.chips -= pay; p.bet += pay; p.totalBet += pay;
      if (target > t.currentBet) {
        const raiseSize = target - t.currentBet;
        if (raiseSize >= t.minRaise) {
          t.minRaise = raiseSize;
          // une vraie relance oblige les autres à reparler
          t.players.forEach(o => { if (o !== p && o.inHand && !o.folded && !o.allIn) o.acted = false; });
        }
        t.currentBet = target;
      }
      if (p.chips === 0) p.allIn = true;
    } else return;

    p.acted = true;
    advance(t);
    autoFoldIfNeeded(t);
  });

  socket.on('disconnect', () => {
    const t = T();
    if (!t) return;
    const p = t.players.find(x => x.pid === myPid);
    if (!p || p.socketId !== socket.id) return;
    p.connected = false;
    if (t.phase === 'lobby') {
      t.players = t.players.filter(x => x.pid !== myPid);
    }
    passHost(t);
    if (t.players.length === 0 || t.players.every(x => !x.connected)) {
      // plus personne : on garde la table 10 minutes au cas où tout le monde revienne
      setTimeout(() => {
        const tt = tables[t.code];
        if (tt && tt.players.every(x => !x.connected)) delete tables[t.code];
      }, 10 * 60 * 1000);
      return;
    }
    if (['preflop', 'flop', 'turn', 'river'].includes(t.phase)) {
      const alive = contenders(t);
      if (alive.length === 1) return finishHand(t);
      autoFoldIfNeeded(t);
    }
    broadcast(t);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Poker prêt sur http://localhost:' + PORT));
