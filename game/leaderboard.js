const fs = require('fs');
const path = require('path');

const LB_FILE = path.join(__dirname, '..', 'data', 'leaderboard.json');
const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
  } catch(e) {
    return {};
  }
}

function saveAccounts(data) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
}

function syncUsername(secretId, newName) {
  const accounts = loadAccounts();
  const oldName = accounts[secretId];
  
  // Jika nama sama persis (termasuk besar-kecil huruf), return OK
  if (oldName === newName) return { ok: true };

  // Case-insensitive check untuk accounts.json
  const newNameLower = newName.toLowerCase();
  for (const [sId, name] of Object.entries(accounts)) {
    if (name.toLowerCase() === newNameLower && sId !== secretId) {
      return { ok: false, error: 'Username ini sudah dipakai oleh pemain lain' };
    }
  }

  // Cek apakah nama baru ini sudah ada di LEADERBOARD tapi BUKAN milik orang ini.
  // (Kasus di mana data belum masuk accounts.json tapi leaderboard.json duluan terbuat)
  const data = loadLB();
  
  // Cek apakah di daily scores ada username yang mirip
  if (data.daily?.scores) {
    const existingNames = Object.keys(data.daily.scores);
    const conflict = existingNames.find(n => n.toLowerCase() === newNameLower);
    if (conflict && conflict !== oldName) {
       return { ok: false, error: 'Username ini sudah ada di Leaderboard!' };
    }
  }
  // Cek apakah di weekly scores ada username yang mirip
  if (data.weekly?.scores) {
    const existingNames = Object.keys(data.weekly.scores);
    const conflict = existingNames.find(n => n.toLowerCase() === newNameLower);
    if (conflict && conflict !== oldName) {
       return { ok: false, error: 'Username ini sudah ada di Leaderboard!' };
    }
  }

  // Lolos semua pengecekan, lanjutkan migrasi nama lama -> baru
  if (oldName) {
    let isChanged = false;
    
    if (data.daily?.scores && data.daily.scores[oldName] !== undefined) {
      data.daily.scores[newName] = data.daily.scores[oldName];
      delete data.daily.scores[oldName];
      isChanged = true;
    }
    
    if (data.weekly?.scores && data.weekly.scores[oldName] !== undefined) {
      data.weekly.scores[newName] = data.weekly.scores[oldName];
      delete data.weekly.scores[oldName];
      isChanged = true;
    }
    
    if (isChanged) saveLB(data);
  }

  // Simpan record account baru ke accounts.json
  accounts[secretId] = newName;
  saveAccounts(accounts);
  return { ok: true };
}
const POINTS = { n5: 10, n4: 20, n3: 30, n2: 40, n1: 50 };

function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay()||7));
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
    var weekNo = Math.ceil(( ( (d - yearStart) / 86400000) + 1)/7);
    return d.getUTCFullYear() + '-W' + weekNo;
}

function loadLB() {
  if (!fs.existsSync(LB_FILE)) return { daily: {}, weekly: {} };
  try {
    return JSON.parse(fs.readFileSync(LB_FILE, 'utf-8'));
  } catch(e) {
    return { daily: {}, weekly: {} };
  }
}

function saveLB(data) {
  fs.writeFileSync(LB_FILE, JSON.stringify(data, null, 2));
}

function updateLeaderboard(winner, finalPlayers, level) {
  const data = loadLB();
  // Waktu Bangkok (Asia/Jakarta)
  const now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Bangkok"}));
  const today = now.toISOString().split('T')[0];
  const thisWeek = getWeekNumber(now);

  if (data.daily?.date !== today) {
    data.daily = { date: today, scores: {} };
  }
  if (data.weekly?.week !== thisWeek) {
    data.weekly = { week: thisWeek, scores: {} };
  }

  const pts = POINTS[level] || 10;
  // Jangan masukkan skor untuk bot
  const winners = finalPlayers.filter(p => p.team === winner && !p.isBot);

  winners.forEach(p => {
    data.daily.scores[p.name] = (data.daily.scores[p.name] || 0) + pts;
    data.weekly.scores[p.name] = (data.weekly.scores[p.name] || 0) + pts;
  });

  saveLB(data);
}

function getLeaderboard() {
  const data = loadLB();
  const sortScores = (scoresObj) => {
    return Object.entries(scoresObj || {})
      .map(([name, score]) => ({ name, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  };
  
  return {
    daily: sortScores(data.daily?.scores),
    weekly: sortScores(data.weekly?.scores)
  };
}

module.exports = { updateLeaderboard, getLeaderboard, syncUsername };
