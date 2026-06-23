/**
 * Room.js
 * --------------------------------
 * Representasi satu room/lobby:
 *  - Kode room, mode (1v1 / 2v2)
 *  - Daftar players (otomatis di-assign ke Tim 1 / Tim 2)
 *  - Status: 'lobby' | 'playing' | 'finished'
 *  - Transisi ke Match saat match:start dipanggil oleh host.
 */

const Match = require('./Match');

class Room {
  constructor(code, mode, level, io, questions) {
    this.code = code;
    this.mode = mode; // '1v1' | '2v2'
    this.level = level; // 'n5' | 'n4' | 'n3' | 'n2' | 'n1'
    this.io = io;
    this.questions = questions;
    this.createdAt = Date.now();

    this.players = []; // Array of { id, name, team, ready, host, hp, isBot, skill }
    this.status = 'lobby';
    this.match = null;

    this.capacity = mode === '1v1' ? 2 : 4;
  }

  addPlayer(playerId, name) {
    if (this.players.length >= this.capacity) return null;
    
    // Tentukan kapasitas per tim (1v1 = 1 orang/tim, 2v2 = 2 orang/tim)
    const maxPerTeam = this.capacity / 2;
    
    // Hitung jumlah pemain di masing-masing tim saat ini
    const countTeam1 = this.players.filter(p => p.team === 1).length;
    const countTeam2 = this.players.filter(p => p.team === 2).length;
    
    // Pilih tim yang kosong atau masih memiliki slot
    let team;
    if (countTeam1 < maxPerTeam && countTeam2 < maxPerTeam) {
      // Jika kedua tim masih punya slot kosong, utamakan tim 1 dulu, lalu selang-seling ke tim 2
      team = countTeam1 <= countTeam2 ? 1 : 2;
    } else if (countTeam1 < maxPerTeam) {
      team = 1;
    } else if (countTeam2 < maxPerTeam) {
      team = 2;
    } else {
      // Seharusnya tidak mungkin masuk ke sini karena this.capacity membatasi
      return null;
    }

    const player = {
      id: playerId,
      name: (name || `Pemain ${this.players.length + 1}`).trim().slice(0, 20),
      team,
      ready: false,
      host: this.players.length === 0,
      hp: 100,
    };
    this.players.push(player);
    return player;
  }

  removePlayer(playerId, _opts = {}) {
    const wasHost = this.isHost(playerId);
    this.players = this.players.filter((p) => p.id !== playerId);
    if (wasHost && this.players.length > 0) {
      this.players[0].host = true;
    }
    this.broadcastState();
  }

  isEmpty() { return this.players.length === 0; }
  isFull() { return this.players.length >= this.capacity; }

  isHost(playerId) {
    return this.players.find((p) => p.id === playerId)?.host === true;
  }

  /**
   * Toggle status siap untuk player non-host.
   * Host otomatis dianggap siap dan tidak bisa toggle.
   */
  toggleReady(playerId) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player || player.host) return false;
    player.ready = !player.ready;
    this.broadcastState();
    return true;
  }

  /**
   * Sama seperti toggleReady tapi mengembalikan info state baru
   * untuk dikirim balik ke client sebagai callback.
   */
  toggleReadyWithResult(playerId) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player) return { ok: false, error: 'Pemain tidak ditemukan' };
    if (player.host) return { ok: false, error: 'Host tidak perlu toggle ready' };
    player.ready = !player.ready;
    this.broadcastState();
    return { ok: true, ready: player.ready };
  }

  /**
   * Cek apakah pertandingan bisa dimulai:
   *  - Room penuh
   *  - Semua player non-host sudah siap
   */
  canStart() {
    if (this.status !== 'lobby') return false;
    // Host TIDAK BISA mulai jika player belum penuh
    if (this.players.length !== this.capacity) return false;
    return this.players.filter((p) => !p.host).every((p) => p.ready);
  }

  startMatch() {
    if (!this.canStart()) return false;
    this.status = 'playing';
    this.players.forEach((p) => (p.hp = 100));
    this.match = new Match(this.mode, this.players, this.questions, this.io, this.code);
    this.match.onMatchEnd = (winner, finalPlayers) => {
      this.status = 'lobby';
      this.players.forEach(p => { p.ready = false; });
      if (this.onGameFinish) this.onGameFinish(winner, finalPlayers);
    };
    
    // Trigger hook pembentukan match untuk bot (agar onRoundStart tertempel sebelum match.start)
    if (this.onMatchCreate) this.onMatchCreate(this.match);
    
    this.match.start();
    return true;
  }

  submitAnswer(playerId, answer) {
    if (this.match) return this.match.submitAnswer(playerId, answer);
    return false;
  }

  switchTeam(playerId) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player) return { ok: false, error: 'Player tidak ditemukan' };
    
    if (this.mode !== '2v2') return { ok: false, error: 'Hanya bisa pindah tim di mode 2v2' };

    const newTeam = player.team === 1 ? 2 : 1;
    const maxPerTeam = this.capacity / 2;
    const newTeamCount = this.players.filter((p) => p.team === newTeam).length;
    
    if (newTeamCount >= maxPerTeam) {
      return { ok: false, error: 'Tim yang dituju sudah penuh' };
    }
    
    player.team = newTeam;
    this.broadcastState();
    return { ok: true };
  }

  broadcastState() {
    const state = {
      code: this.code,
      mode: this.mode,
      level: this.level,
      status: this.status,
      capacity: this.capacity,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        ready: p.ready,
        host: p.host,
        hp: p.hp,
      })),
      canStart: this.canStart(),
    };
    this.io.to(this.code).emit('room:update', state);
  }
}

module.exports = Room;
