const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function newDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 0; r < 13; r++) deck.push({ r: r + 2, label: RANKS[r], s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Score d'une main de 5 cartes : tableau comparable [catégorie, ...départages]
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
  ranks.forEach(r => counts[r] = (counts[r] || 0) + 1);
  const groups = Object.entries(counts)
    .map(([r, n]) => [n, +r])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const tiebreak = groups.map(g => g[1]);
  if (straightHigh && flush) return [8, straightHigh];
  if (groups[0][0] === 4) return [7, ...tiebreak];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, ...tiebreak];
  if (flush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][0] === 3) return [3, ...tiebreak];
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...tiebreak];
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

// Meilleure main de 5 parmi 7 cartes
function best7(cards) {
  let best = null;
  for (let i = 0; i < 7; i++) for (let j = i + 1; j < 7; j++) {
    const five = cards.filter((_, k) => k !== i && k !== j);
    const sc = score5(five);
    if (!best || compare(sc, best) > 0) best = sc;
  }
  return best;
}

const HAND_NAMES = ['Carte haute','Paire','Double paire','Brelan','Suite','Couleur','Full','Carré','Quinte flush'];const tables = {};

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join(''); }
  while (tables[c]);
  return c;
}

function activePlayers(t) { return t.players.filter(p => !p.folded && p.chips + p.bet > 0 || (!p.folded && p.allIn)); }
function inHand(t) { return t.players.filter(p => !p.folded && p.inHand); }

function nextIndex(t, from) {
  const n = t.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    const p = t.players[idx];
    if (p.inHand && !p.folded && !p.allIn) return idx;
  }
  return -1;
}

function postBlind(t, idx, amount) {
  const p = t.players[idx];
  const pay = Math.min(amount, p.chips);
  p.chips -= pay; p.bet += pay; p.totalBet += pay;
  if (p.chips === 0) p.allIn = true;
}

function startHand(t) {
  t.players = t.players.filter(p => p.chips > 0);
  if (t.players.length < 2) { t.phase = 'over'; broadcast(t); return; }
  t.deck = newDeck();
  t.board = [];
  t.phase = 'preflop';
  t.message = '';
  t.results = null;
  t.players.forEach(p => {
    p.hand = [t.deck.pop(), t.deck.pop()];
    p.bet = 0; p.totalBet = 0; p.folded = false; p.allIn = false;
    p.inHand = true; p.acted = false;
  });
  t.dealer = (t.dealer + 1) % t.players.length;
  const n = t.players.length;
  const sb = n === 2 ? t.dealer : (t.dealer + 1) % n;
  const bb = (sb + 1) % n;
  postBlind(t, sb, t.smallBlind);
  postBlind(t, bb, t.smallBlind * 2);
  t.currentBet = t.smallBlind * 2;
  t.minRaise = t.smallBlind * 2;
  t.turn = nextIndex(t, bb);
  broadcast(t);
}

function pot(t) { return t.players.reduce((s, p) => s + p.totalBet, 0); }

function bettingDone(t) {
  const live = t.players.filter(p => p.inHand && !p.folded && !p.allIn);
  return live.every(p => p.acted && p.bet === t.currentBet);
}

function advance(t) {
  const alive = t.players.filter(p => p.inHand && !p.folded);
  if (alive.length === 1) return finishHand(t, alive);
  if (!bettingDone(t)) { t.turn = nextIndex(t, t.turn); return broadcast(t); }
  // fin du tour d'enchères
  t.players.forEach(p => { p.bet = 0; p.acted = false; });
  t.currentBet = 0;
  t.minRaise = t.smallBlind * 2;
  const canAct = t.players.filter(p => p.inHand && !p.folded && !p.allIn);
  const next = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' }[t.phase];
  t.phase = next;
  if (next === 'flop') t.board.push(t.deck.pop(), t.deck.pop(), t.deck.pop());
  else if (next === 'turn' || next === 'river') t.board.push(t.deck.pop());
  if (next === 'showdown') return finishHand(t, alive);
  if (canAct.length < 2) return advance(t); // tout le monde est all-in : on dévoile la suite
  t.turn = nextIndex(t, t.dealer);
  broadcast(t);
}

function finishHand(t, alive) {
  // si tous les autres ont foldé, pas besoin de compléter le board
  const total = pot(t);
  let winners = alive;
  let detail = {};
  if (alive.length > 1) {
    while (t.board.length < 5) t.board.push(t.deck.pop());
    alive.forEach(p => { p.score = best7([...p.hand, ...t.board]); });
    alive.sort((a, b) => compare(b.score, a.score));
    winners = alive.filter(p => compare(p.score, alive[0].score) === 0);
    alive.forEach(p => { detail[p.id] = HAND_NAMES[p.score[0]]; });
  }
  // pots annexes simplifiés : on rend l'excédent à celui qui a mis plus que les autres
  const share = Math.floor(total / winners.length);
  winners.forEach(w => { w.chips += share; });
  winners[0].chips += total - share * winners.length;
  t.phase = 'showdown';
  t.results = {
    winners: winners.map(w => w.name),
    amount: total,
    hands: alive.length > 1 ? alive.map(p => ({ name: p.name, hand: p.hand, label: detail[p.id] })) : []
  };
  t.message = winners.map(w => w.name).join(' et ') + ' remporte ' + total + ' jetons';
  t.turn = -1;
  broadcast(t);
}

// Vue personnalisée : chacun ne voit que ses propres cartes
function viewFor(t, socketId) {
  return {
    code: t.code, phase: t.phase, board: t.board, pot: pot(t),
    currentBet: t.currentBet, minRaise: t.minRaise, message: t.message,
    results: t.results, host: t.host, dealer: t.dealer, turn: t.turn,
    smallBlind: t.smallBlind,
    players: t.players.map((p, i) => ({
      id: p.id, name: p.name, chips: p.chips, bet: p.bet,
      folded: p.folded, allIn: p.allIn, isYou: p.id === socketId,
      hand: (p.id === socketId || (t.phase === 'showdown' && t.results && t.results.hands.length && !p.folded))
        ? p.hand : null
    }))
  };
}

function broadcast(t) {
  t.players.forEach(p => io.to(p.id).emit('state', viewFor(t, p.id)));
  t.lobby.forEach(id => io.to(id).emit('state', viewFor(t, id)));
}io.on('connection', (socket) => {
  let current = null;

  socket.on('create', (name) => {
    const code = makeCode();
    const t = {
      code, host: socket.id, players: [], lobby: [], deck: [], board: [],
      phase: 'lobby', dealer: -1, turn: -1, currentBet: 0, minRaise: 20,
      smallBlind: 10, message: '', results: null
    };
    tables[code] = t;
    t.players.push({ id: socket.id, name: String(name).slice(0, 14) || 'Joueur', chips: 1000,
      bet: 0, totalBet: 0, folded: false, allIn: false, inHand: false, acted: false, hand: [] });
    current = code;
    socket.join(code);
    broadcast(t);
  });

  socket.on('join', ({ code, name }) => {
    const t = tables[String(code).toUpperCase()];
    if (!t) return socket.emit('error-msg', 'Table introuvable');
    if (t.phase !== 'lobby') return socket.emit('error-msg', 'La partie a déjà commencé');
    if (t.players.length >= 8) return socket.emit('error-msg', 'Table pleine (8 joueurs max)');
    t.players.push({ id: socket.id, name: String(name).slice(0, 14) || 'Joueur', chips: 1000,
      bet: 0, totalBet: 0, folded: false, allIn: false, inHand: false, acted: false, hand: [] });
    current = t.code;
    socket.join(t.code);
    broadcast(t);
  });

  socket.on('start', () => {
    const t = tables[current];
    if (!t || t.host !== socket.id || t.players.length < 2) return;
    if (t.phase !== 'lobby') return;
    startHand(t);
  });

  socket.on('next', () => {
    const t = tables[current];
    if (!t || t.host !== socket.id || t.phase !== 'showdown') return;
    startHand(t);
  });

  socket.on('action', ({ type, amount }) => {
    const t = tables[current];
    if (!t || !['preflop', 'flop', 'turn', 'river'].includes(t.phase)) return;
    const idx = t.players.findIndex(p => p.id === socket.id);
    if (idx !== t.turn) return;
    const p = t.players[idx];
    const toCall = t.currentBet - p.bet;

    if (type === 'fold') {
      p.folded = true;
    } else if (type === 'check') {
      if (toCall > 0) return;
    } else if (type === 'call') {
      const pay = Math.min(toCall, p.chips);
      p.chips -= pay; p.bet += pay; p.totalBet += pay;
      if (p.chips === 0) p.allIn = true;
    } else if (type === 'raise') {
      // amount = total visé pour ce tour d'enchères
      let target = Math.floor(Number(amount));
      if (!Number.isFinite(target)) return;
      const maxTarget = p.bet + p.chips;
      target = Math.min(target, maxTarget);
      if (target < t.currentBet + t.minRaise && target < maxTarget) return;
      const pay = target - p.bet;
      if (pay <= 0) return;
      p.chips -= pay; p.bet += pay; p.totalBet += pay;
      if (target - t.currentBet >= t.minRaise) t.minRaise = target - t.currentBet;
      if (target > t.currentBet) {
        t.currentBet = target;
        // une relance oblige les autres à reparler
        t.players.forEach(o => { if (o !== p && o.inHand && !o.folded && !o.allIn) o.acted = false; });
      }
      if (p.chips === 0) p.allIn = true;
    } else return;

    p.acted = true;
    advance(t);
  });

  socket.on('disconnect', () => {
    const t = tables[current];
    if (!t) return;
    const p = t.players.find(x => x.id === socket.id);
    if (!p) return;
    if (t.phase === 'lobby') {
      t.players = t.players.filter(x => x.id !== socket.id);
      if (t.host === socket.id && t.players.length) t.host = t.players[0].id;
    } else {
      const wasTurn = t.players[t.turn] === p;
      p.folded = true; p.chips = 0;
      if (t.host === socket.id) {
        const other = t.players.find(x => x.id !== socket.id);
        if (other) t.host = other.id;
      }
      const alive = t.players.filter(x => x.inHand && !x.folded);
      if (alive.length === 1 && ['preflop', 'flop', 'turn', 'river'].includes(t.phase)) return finishHand(t, alive);
      if (wasTurn) return advance(t);
    }
    if (t.players.length === 0) delete tables[current];
    else broadcast(t);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Poker prêt sur http://localhost:' + PORT));
