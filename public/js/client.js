/**
 * client.js — Main SPA controller (Nintendo 2001 chrome style)
 *
 * Integrasi:
 *  - Socket.IO real-time
 *  - Audio Manager (BGM per view, SFX per event)
 *  - Event delegation untuk click handler (anti re-render issue)
 *  - Optimized untuk Android (touch, compact)
 */

// URL Backend (Kosongkan jika berjalan di server yang sama, atau isi dengan URL Cloudflare Tunnel-mu)
const BACKEND_URL = 'https://greg-presentations--indexes.trycloudflare.com'; // Ganti dengan 'https://xxx.trycloudflare.com' jika frontend di hosting

const Client = {
  socket: null,
  state: {
    username: null,
    secretId: null,
    view: 'lobby',
    selectedMode: '1v1',
    selectedLevel: 'n5',

    roomCode: null,
    roomMode: null,
    roomPlayers: [],
    roomCanStart: false,
    roomChats: [],

    battleMode: null,
    battlePlayers: [],
    roundNumber: 1,
    maxRounds: 10,
    question: null,
    options: [],
    endsAt: null,
    answered: false,
    selectedAnswer: null,
    lastResult: null,
    matchEnd: null,

    pendingConfirm: null,

    // Daftar room yang tersedia (auto-detect setiap 3 detik dari server)
    availableRooms: [],
  },

  timerInterval: null,
  lastViewBGM: null,

  // ─── Init ─────────────────────────────────────────────
  init() {
    this.state.username = localStorage.getItem('kanji-username') || null;
    
    // Inisialisasi/Ambil Secret ID perangkat
    let sId = localStorage.getItem('kanji-secret-id');
    if (!sId) {
      sId = 'USR_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
      localStorage.setItem('kanji-secret-id', sId);
    }
    this.state.secretId = sId;
    
    // Auto-fill Room dari URL jika ada (?room=XXXXXX)
    const urlParams = new URLSearchParams(window.location.search);
    const roomFromUrl = urlParams.get('room');
    if (roomFromUrl) {
      this.state.pendingJoinRoom = roomFromUrl.toUpperCase();
      // Bersihkan URL dari parameter setelah ditangkap
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    // Audio: diinisialisasi tapi TIDAK play BGM sampai user gesture
    if (typeof AudioManager !== 'undefined') AudioManager.init();

    // Hapus "transports" config agar Socket.io bisa melakukan polling otomatis (bagus untuk Cloudflare)
    // Trim backslash '/' jika user tidak sengaja menambahkannya di ujung URL
    let ioUrl = BACKEND_URL || window.location.origin;
    if (ioUrl.endsWith('/')) ioUrl = ioUrl.slice(0, -1);

    // Menggunakan konfigurasi Socket.io yang disarankan untuk tunneling/proxy eksternal
    this.socket = io(ioUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'], // Prioritaskan websocket lagi (Cloudflare kadang menolak polling panjang)
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      secure: true // Memaksa komunikasi aman (WSS) jika menggunakan https (Wajib untuk Cloudflare)
    });

    this.bindSocketEvents();
    this.bindGlobalEvents(); // ← event delegation untuk SEMUA click
    this.render();

    console.log('[KanjiDuel] client initialized, menembak ke:', ioUrl);
  },

  // ─── Socket event subscriptions ─────────────────────
  bindSocketEvents() {
    const safe = (label, fn) => (data) => {
      try { fn(data); }
      catch (err) {
        console.error(`[KanjiDuel] error in ${label}:`, err);
        UI.toast('Error, coba refresh', { variant: 'error' });
      }
    };

    this.socket.on('room:update', safe('room:update', (state) => {
      if (this.state.view === 'room' && state.code === this.state.roomCode) {
        this.state.roomPlayers = state.players;
        this.state.roomCanStart = state.canStart;
        this.state.roomMode = state.mode;
        this.renderRoom();
      }
    }));

    // Server broadcast daftar room setiap 3 detik (hanya untuk yang di lobby)
    this.socket.on('room:list', safe('room:list', (list) => {
      this.state.availableRooms = list || [];
      // Update UI hanya jika di lobby
      if (this.state.view === 'lobby') {
        const container = document.getElementById('room-list');
        if (container) container.innerHTML = Views.roomList(this.state.availableRooms);
        const counter = document.getElementById('room-list-count');
        if (counter) counter.textContent = this.state.availableRooms.length;
      }
    }));

    this.socket.on('round:start', safe('round:start', (data) => {
      this.state.view = 'battle';
      this.state.battleMode = data.mode;
      this.state.battlePlayers = data.players;
      this.state.roundNumber = data.roundNumber;
      this.state.maxRounds = data.maxRounds;
      this.state.question = data.question;
      this.state.options = data.options;
      this.state.endsAt = data.endsAt;
      this.state.answered = false;
      this.state.selectedAnswer = null;
      this.state.lastResult = null;
      this.state.matchEnd = null;

      this.renderBattle();
      this.startTimer(data.endsAt);
    }));

    this.socket.on('round:result', safe('round:result', (data) => {
      this.stopTimer();
      this.state.lastResult = data;
      this.state.battlePlayers = data.players;
      this.state.answered = true;
      this.renderBattle();

      // Audio: SFX berdasarkan hasil
      const myResult = data.results.find((r) => r.playerId === Client.socket?.id);
      if (myResult) {
        if (typeof AudioManager !== 'undefined') {
          if (myResult.shielded) AudioManager.sfx('shield');
          else if (!myResult.correct) AudioManager.sfx('wrong');
          else AudioManager.sfx('correct');
        }
      }
    }));

    this.socket.on('match:end', safe('match:end', (data) => {
      this.stopTimer();
      this.state.matchEnd = data;
      this.state.battlePlayers = data.finalPlayers;
      this.renderBattle();

      // Audio: victory/defeat BGM
      if (typeof AudioManager !== 'undefined') {
        const me = data.finalPlayers.find((p) => p.id === Client.socket?.id);
        if (data.winner === 'draw') {
          AudioManager.bgm('lobby'); // neutral, kembali ke lobby theme
          AudioManager.sfx('defeat');
        } else if (me?.team === data.winner) {
          AudioManager.bgm('victory');
          AudioManager.sfx('victory');
        } else {
          AudioManager.bgm('defeat');
          AudioManager.sfx('defeat');
        }
      }
    }));

    this.socket.on('error', (data) => {
      if (typeof AudioManager !== 'undefined') AudioManager.sfx('wrong');
      UI.toast(data.message || 'Terjadi kesalahan', { variant: 'error' });
    });

    this.socket.on('room:chat', safe('room:chat', (msg) => {
      if (this.state.view === 'room') {
        msg.isMe = (msg.playerId === Client.socket?.id);
        this.state.roomChats.push(msg);
        this.renderRoom();
        
        // Auto scroll ke bawah
        setTimeout(() => {
          const container = document.getElementById('chat-messages');
          if (container) container.scrollTop = container.scrollHeight;
        }, 50);
      }
    }));

    this.socket.on('room:kicked', () => {
      UI.toast('Kamu telah dikeluarkan oleh Host.', { variant: 'error' });
      this.socket.emit('room:leave', {});
      this.resetToLobby();
    });

    this.socket.on('connect', () => {
      const overlay = document.getElementById('maintenance-overlay');
      const debugEl = document.getElementById('debug-error-msg');
      if (overlay) overlay.style.display = 'none';
      if (debugEl) debugEl.textContent = '';
      console.log('[KanjiDuel] terhubung ke server');

      // Cek apakah ada parameter room dari URL yang belum dieksekusi
      if (this.state.pendingJoinRoom && this.state.username) {
        this.socket.emit('room:join', { roomCode: this.state.pendingJoinRoom, playerName: this.state.username }, (resp) => {
          if (resp?.ok) {
            this.state.view = 'room';
            this.state.roomCode = resp.roomCode;
            this.state.roomMode = resp.roomMode;
            this.state.roomPlayers = [resp.player];
            this.state.roomCanStart = false;
            this.state.roomChats = [];
            this.renderRoom();
            if (typeof AudioManager !== 'undefined') AudioManager.bgm('room');
          } else {
            UI.toast(resp?.error || 'Gagal join dari URL', { variant: 'error' });
          }
        });
        this.state.pendingJoinRoom = null;
      }
    });

    this.socket.on('disconnect', () => {
      const overlay = document.getElementById('maintenance-overlay');
      if (overlay) overlay.style.display = 'flex';
    });

    this.socket.on('connect_error', (err) => {
      const overlay = document.getElementById('maintenance-overlay');
      const debugEl = document.getElementById('debug-error-msg');
      if (overlay) overlay.style.display = 'flex';
      if (debugEl && err) {
        debugEl.textContent = `[DEBUG] connect_error: ${err.message}`;
      }
      console.error('[KanjiDuel] Socket Connect Error:', err);
    });
  },

  bindGlobalEvents() {
    // ─── Event delegation di document.body ─────────────
    // 1 listener untuk SEMUA click — robust terhadap re-render.
    document.body.addEventListener('change', (e) => {
      const target = e.target;
      if (target.id === 'create-level') {
        this.state.selectedLevel = target.value;
      }
    });

    document.body.addEventListener('click', (e) => {
      // Unlock audio context pada interaksi pertama
      if (typeof AudioManager !== 'undefined') AudioManager.unlock();

      const target = e.target;
      const handle = (fn) => {
        try { fn(); }
        catch (err) { console.error('[click] error:', err); }
      };

      // ── Audio toggle (top nav) ──
      if (target.closest('#btn-audio-toggle')) {
        handle(() => {
          if (typeof AudioManager !== 'undefined') {
            const muted = AudioManager.toggleMute();
            const icon = document.getElementById('audio-icon');
            if (icon) icon.textContent = muted ? '🔇' : '🔊';
          }
        });
        return;
      }

      // ── Home button ──
      if (target.closest('#nav-home')) {
        handle(() => this.resetToLobby());
        return;
      }

      // ── Mode pill (lobby) ──
      const modePill = target.closest('[data-mode]');
      if (modePill && this.state.view === 'lobby') {
        handle(() => {
          const mode = modePill.dataset.mode;
          if (['1v1', '2v2'].includes(mode)) {
            this.state.selectedMode = mode;
            // Re-render lobby untuk update mode pill
            if (this.state.view === 'lobby') this.renderLobby();
          }
        });
        return;
      }

      // ── Show Leaderboard ──
      if (target.closest('#btn-show-leaderboard')) {
        handle(() => {
          if (typeof AudioManager !== 'undefined') AudioManager.sfx('click');
          
          let apiUrl = BACKEND_URL || window.location.origin;
          if (apiUrl.endsWith('/')) apiUrl = apiUrl.slice(0, -1);
          
          fetch(apiUrl + '/api/leaderboard')
            .then(res => res.json())
            .then(data => {
              const modalHtml = Views.leaderboardModal(data);
              const div = document.createElement('div');
              div.id = 'leaderboard-container';
              div.innerHTML = modalHtml;
              document.body.appendChild(div);
            })
            .catch(err => {
              console.error('Leaderboard fetch error:', err);
              UI.toast('Gagal memuat leaderboard', { variant: 'error' });
            });
        });
        return;
      }

      // ── Close Leaderboard ──
      if (target.closest('#btn-close-leaderboard')) {
        handle(() => {
          if (typeof AudioManager !== 'undefined') AudioManager.sfx('click');
          const container = document.getElementById('leaderboard-container');
          if (container) container.remove();
        });
        return;
      }

      // ── Edit Username ──
      if (target.closest('#btn-edit-username')) {
        handle(() => {
          this.state.username = null; // Memaksa renderModal untuk muncul kembali
          this.renderLobby();
          
          // Fokuskan input dan isi dengan username lama jika ada di local storage
          setTimeout(() => {
            const input = UI.qs('#global-username-input');
            if (input) {
              const oldName = localStorage.getItem('kanji-username') || '';
              input.value = oldName;
              input.focus();
            }
          }, 50);
        });
        return;
      }

      // ── Save Username ──
      if (target.closest('#btn-save-username')) {
        handle(() => {
          const input = UI.qs('#global-username-input');
          const val = (input?.value || '').trim();
          if (!val) {
            UI.toast('Masukkan username', { variant: 'error' });
            return;
          }

          // Validasi ke server sebelum menyimpan di client
          this.socket.emit('player:setUsername', { 
            secretId: this.state.secretId, 
            newName: val 
          }, (resp) => {
            if (!resp?.ok) {
              UI.toast(resp?.error || 'Username gagal disimpan', { variant: 'error' });
              return;
            }

            // Jika server mengizinkan (atau update sukses)
            localStorage.setItem('kanji-username', val);
            this.state.username = val;
            this.render();

            // Jika setelah set username ternyata dia bawa room link dari WA, auto-join
            if (this.state.pendingJoinRoom && this.socket?.connected) {
              this.socket.emit('room:join', { 
                roomCode: this.state.pendingJoinRoom, 
                playerName: this.state.username, 
                secretId: this.state.secretId 
              }, (joinResp) => {
                if (joinResp?.ok) {
                  this.state.view = 'room';
                  this.state.roomCode = joinResp.roomCode;
                  this.state.roomMode = joinResp.roomMode;
                  this.state.roomPlayers = [joinResp.player];
                  this.state.roomCanStart = false;
                  this.state.roomChats = [];
                  this.renderRoom();
                  if (typeof AudioManager !== 'undefined') AudioManager.bgm('room');
                } else {
                  UI.toast(joinResp?.error || 'Gagal join dari URL', { variant: 'error' });
                }
              });
              this.state.pendingJoinRoom = null;
            }
          });
        });
        return;
      }

      // ── Create room ──
      if (target.closest('#btn-create')) {
        handle(() => {
          const name = this.state.username;
          const level = this.state.selectedLevel || 'n5';
          if (!name) { UI.toast('Username belum diset', { variant: 'error' }); return; }
          this.socket.emit('room:create', { 
            mode: this.state.selectedMode, 
            playerName: name, 
            level, 
            secretId: this.state.secretId 
          }, (resp) => {
            if (!resp?.ok) { UI.toast(resp?.error || 'Gagal membuat room', { variant: 'error' }); return; }
            if (typeof AudioManager !== 'undefined') AudioManager.sfx('click');
            this.state.view = 'room';
            this.state.roomCode = resp.roomCode;
            this.state.roomMode = resp.roomMode;
            this.state.roomPlayers = [resp.player];
            this.state.roomCanStart = false;
            this.state.roomChats = [];
            this.renderRoom();
            if (typeof AudioManager !== 'undefined') AudioManager.bgm('room');
          });
        });
        return;
      }

      // ── Join room ──
      if (target.closest('#btn-join')) {
        handle(() => {
          const code = (UI.qs('#join-code')?.value || '').trim().toUpperCase();
          const name = this.state.username;
          if (!code) { UI.toast('Masukkan kode room', { variant: 'error' }); return; }
          if (!name) { UI.toast('Username belum diset', { variant: 'error' }); return; }
          this.socket.emit('room:join', { 
            roomCode: code, 
            playerName: name, 
            secretId: this.state.secretId 
          }, (resp) => {
            if (!resp?.ok) { UI.toast(resp?.error || 'Gagal join room', { variant: 'error' }); return; }
            if (typeof AudioManager !== 'undefined') AudioManager.sfx('click');
            this.state.view = 'room';
            this.state.roomCode = resp.roomCode;
            this.state.roomMode = resp.roomMode;
            this.state.roomPlayers = [resp.player];
            this.state.roomCanStart = false;
            this.state.roomChats = [];
            this.renderRoom();
            if (typeof AudioManager !== 'undefined') AudioManager.bgm('room');
          });
        });
        return;
      }

      if (target.closest('[data-join-room]')) {
        handle(() => {
          const code = target.closest('[data-join-room]').dataset.joinRoom;
          const name = this.state.username;
          if (!name) { UI.toast('Username belum diset', { variant: 'error' }); return; }
          this.socket.emit('room:join', { 
            roomCode: code, 
            playerName: name, 
            secretId: this.state.secretId 
          }, (resp) => {
            if (!resp?.ok) { UI.toast(resp?.error || 'Gagal join room', { variant: 'error' }); return; }
            if (typeof AudioManager !== 'undefined') AudioManager.sfx('click');
            this.state.view = 'room';
            this.state.roomCode = resp.roomCode;
            this.state.roomMode = resp.roomMode;
            this.state.roomPlayers = [resp.player];
            this.state.roomCanStart = false;
            this.state.roomChats = [];
            this.renderRoom();
            if (typeof AudioManager !== 'undefined') AudioManager.bgm('room');
          });
        });
        return;
      }

      // ── Answer button (battle) ──
      const answerBtn = target.closest('.n-answer__btn');
      if (answerBtn && !answerBtn.disabled) {
        handle(() => {
          if (this.state.answered || this.state.lastResult) return;
          const answer = answerBtn.dataset.answer;
          if (!answer) return;
          this.state.selectedAnswer = answer;
          this.state.answered = true;
          this.renderBattle();

          if (typeof AudioManager !== 'undefined') AudioManager.sfx('click');

          const emitTimeout = setTimeout(() => {
            UI.toast('Timeout - coba lagi', { variant: 'error' });
            this.state.answered = false;
            this.state.selectedAnswer = null;
            this.renderBattle();
          }, 5000);

          this.socket.emit('round:answer', { answer }, (resp) => {
            clearTimeout(emitTimeout);
            if (!resp?.ok) {
              UI.toast(resp?.error || 'Gagal mengirim jawaban', { variant: 'error' });
              this.state.answered = false;
              this.state.selectedAnswer = null;
              this.renderBattle();
            }
          });
        });
        return;
      }

      // ── Kick Player ──
      const kickBtn = target.closest('[data-kick-player]');
      if (kickBtn) {
        handle(() => {
          const playerId = kickBtn.dataset.kickPlayer;
          if (typeof AudioManager !== 'undefined') AudioManager.sfx('click');
          this.socket.emit('room:kick', { playerId }, (resp) => {
            if (!resp?.ok) UI.toast(resp?.error || 'Gagal melakukan kick', { variant: 'error' });
          });
        });
        return;
      }

      // ── Ready toggle ──
      if (target.closest('#btn-ready')) {
        handle(() => {
          if (typeof AudioManager !== 'undefined') AudioManager.sfx('click');
          this.socket.emit('room:toggleReady', {}, (resp) => {
            if (!resp?.ok) UI.toast(resp?.error || 'Gagal toggle siap', { variant: 'error' });
          });
        });
        return;
      }

      // ── Start match ──
      if (target.closest('#btn-start')) {
        handle(() => {
          console.log('[KanjiDuel] Start clicked, canStart=', this.state.roomCanStart);
          if (!this.state.roomCanStart) {
            UI.toast('Belum semua pemain siap', { variant: 'error' });
            return;
          }
          if (typeof AudioManager !== 'undefined') AudioManager.sfx('shield');
          this.socket.emit('match:start', {}, (resp) => {
            console.log('[KanjiDuel] match:start response', resp);
            if (!resp?.ok) UI.toast(resp?.error || 'Gagal memulai pertandingan', { variant: 'error' });
          });
        });
        return;
      }

      // ── Leave room ──
      if (target.closest('#btn-leave')) {
        handle(() => {
          this.showConfirm({
            title: 'Keluar dari Room?',
            message: 'Kamu akan kembali ke lobby. Pemain lain akan melihat slot kosong.',
            confirmText: 'Ya, keluar',
            cancelText: 'Batal',
            danger: false,
            onConfirm: () => {
              if (typeof AudioManager !== 'undefined') AudioManager.sfx('click');
              this.performLeave();
            },
          });
        });
        return;
      }

      // ── Pindah Tim (2v2) ──
      if (target.closest('#btn-switch-team')) {
        handle(() => {
          if (typeof AudioManager !== 'undefined') AudioManager.sfx('click');
          this.socket.emit('room:switchTeam', {}, (resp) => {
            if (!resp?.ok) UI.toast(resp?.error || 'Gagal pindah tim', { variant: 'error' });
          });
        });
        return;
      }

      // ── Share WhatsApp ──
      if (target.closest('#btn-share-wa')) {
        handle(() => {
          if (typeof AudioManager !== 'undefined') AudioManager.sfx('click');
          const url = `${window.location.origin}${window.location.pathname}?room=${this.state.roomCode}`;
          const text = `Ayo main Kanji Duel bersamaku! Join room: ${this.state.roomCode}\n\nKlik link ini: ${url}`;
          window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, '_blank');
        });
        return;
      }

      // ── Send Chat ──
      if (target.closest('#btn-send-chat')) {
        handle(() => {
          const input = UI.qs('#chat-input');
          const text = (input?.value || '').trim();
          if (!text) return;
          this.socket.emit('room:chat', { text }, (resp) => {
            if (!resp?.ok) UI.toast(resp?.error || 'Gagal mengirim pesan', { variant: 'error' });
          });
          input.value = '';
          input.focus();
        });
        return;
      }

      // ── Leave battle ──
      if (target.closest('#btn-leave-battle')) {
        handle(() => {
          this.showConfirm({
            title: 'Keluar dari Pertandingan?',
            message: 'Tim kamu akan langsung kalah. Yakin?',
            confirmText: 'Ya, keluar',
            cancelText: 'Lanjut main',
            danger: true,
            onConfirm: () => {
              this.socket.emit('room:leave', {});
              this.resetToLobby();
            },
          });
        });
        return;
      }

      // ── Back to lobby ──
      if (target.closest('#btn-back-room')) {
        handle(() => {
          if (typeof AudioManager !== 'undefined') AudioManager.bgm('room');
          
          this.state.view = 'room';
          this.state.lastResult = null;
          this.state.matchEnd = null;
          this.state.answered = false;
          this.state.selectedAnswer = null;

          // PERBAIKAN: Reset status 'ready' secara manual untuk semua player di state UI-mu
          if (this.state.roomPlayers && this.state.roomPlayers.length > 0) {
            this.state.roomPlayers.forEach(player => {
              player.ready = false;
            });
          }
          
          this.renderRoom();
        });
        return;
      }

      // ── Confirm OK ──
      if (target.closest('#btn-confirm-ok')) {
        handle(() => {
          const cb = this.state.pendingConfirm?.onConfirm;
          this.state.pendingConfirm = null;
          this.state.view = this.state.pendingConfirmReturnView;
          this.state.pendingConfirmReturnView = null;
          if (cb) cb();
          this.render();
        });
        return;
      }

      // ── Confirm Cancel ──
      if (target.closest('#btn-confirm-cancel')) {
        handle(() => {
          this.state.pendingConfirm = null;
          this.state.view = this.state.pendingConfirmReturnView;
          this.state.pendingConfirmReturnView = null;
          this.render();
        });
        return;
      }
    });

    // ─── Keyboard Enter shortcut ─────────────────
    document.body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (UI.qs('#join-code') === document.activeElement || UI.qs('#join-name') === document.activeElement) {
          UI.qs('#btn-join')?.click();
        } else if (UI.qs('#create-name') === document.activeElement) {
          UI.qs('#btn-create')?.click();
        } else if (UI.qs('#chat-input') === document.activeElement) {
          UI.qs('#btn-send-chat')?.click();
        } else if (this.state.view === 'battle' && !this.state.answered) {
          UI.qs('.n-answer__btn:not([disabled])')?.click();
        }
      }
    });
  },

  // ════════════════════════════════════════════════════════════
  // Render
  // ════════════════════════════════════════════════════════════
  render() {
    switch (this.state.view) {
      case 'lobby': this.renderLobby(); break;
      case 'room': this.renderRoom(); break;
      case 'battle': this.renderBattle(); break;
      case 'confirm': this.renderConfirm(); break;
      default: this.renderLobby();
    }
  },

  renderLobby() {
    document.getElementById('app').innerHTML = Views.lobby(this.state) + (!this.state.username ? Views.usernameModal() : '');
    // BGM lobby (hanya jika pindah dari view lain)
    if (typeof AudioManager !== 'undefined' && this.lastViewBGM !== 'lobby') {
      AudioManager.bgm('lobby');
      this.lastViewBGM = 'lobby';
    }
  },

  renderRoom() {
    document.getElementById('app').innerHTML = Views.room({
      code: this.state.roomCode,
      mode: this.state.roomMode,
      players: this.state.roomPlayers,
      capacity: this.state.roomMode === '2v2' ? 4 : 2,
      canStart: this.state.roomCanStart,
      chats: this.state.roomChats,
    }) + (!this.state.username ? Views.usernameModal() : '');
    if (typeof AudioManager !== 'undefined' && this.lastViewBGM !== 'room') {
      AudioManager.bgm('room');
      this.lastViewBGM = 'room';
    }
  },

  renderBattle() {
    document.getElementById('app').innerHTML = Views.battle({
      roomCode: this.state.roomCode,
      mode: this.state.battleMode,
      players: this.state.battlePlayers,
      roundNumber: this.state.roundNumber,
      maxRounds: this.state.maxRounds,
      question: this.state.question,
      options: this.state.options,
      answered: this.state.answered,
      selectedAnswer: this.state.selectedAnswer,
      lastResult: this.state.lastResult,
      matchEnd: this.state.matchEnd,
    }) + (!this.state.username ? Views.usernameModal() : '');
    if (typeof AudioManager !== 'undefined' && this.lastViewBGM !== 'battle') {
      AudioManager.bgm('battle');
      this.lastViewBGM = 'battle';
    }

    if (this.state.endsAt && !this.state.lastResult && !this.state.matchEnd) {
      this.startTimer(this.state.endsAt);
    } else {
      this.stopTimer();
    }
  },

  renderConfirm() {
    if (!this.state.pendingConfirm) {
      this.state.view = this.state.pendingConfirmReturnView || 'lobby';
      return this.render();
    }
    document.getElementById('app').innerHTML = Views.confirmDialog(this.state.pendingConfirm);
  },

  // ════════════════════════════════════════════════════════════
  // Helpers
  // ════════════════════════════════════════════════════════════
  performLeave() {
    this.socket.emit('room:leave', {}, () => {
      this.resetToLobby();
    });
  },

  showConfirm(opts) {
    this.state.pendingConfirm = opts;
    this.state.pendingConfirmReturnView = this.state.view;
    this.state.view = 'confirm';
    this.render();
  },

  startTimer(endsAt) {
    this.stopTimer();
    const tick = () => {
      // Hitung sisa waktu aktual (pastikan tidak minus)
      const rawRemaining = (endsAt - Date.now()) / 1000;
      const remaining = Math.max(0, rawRemaining);
      
      const el = UI.qs('#battle-timer');
      if (!el) return;
      el.textContent = UI.formatSeconds(remaining);
      
      // Saat timer menyentuh 2.0 sampai 0.1, berikan animasi dan SFX tick
      if (rawRemaining <= 2.0 && rawRemaining > 0) {
        el.classList.add('n-timer--warning');
        
        // Membunyikan SFX tepat pada perpindahan detik (hanya memicu 1x per detik bulat)
        const currentSec = Math.floor(rawRemaining);
        if (typeof AudioManager !== 'undefined' && currentSec !== this._lastTickSec) {
          this._lastTickSec = currentSec;
          AudioManager.sfx('tick');
        }
      } else {
        el.classList.remove('n-timer--warning');
      }

      // Jika waktu sudah habis, reset statenya dan stop setInterval
      if (rawRemaining <= 0) {
        this.stopTimer();
      }
    };
    tick();
    this.timerInterval = setInterval(tick, 100);
  },

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    this._lastTickSec = null; // Reset perhitungan detik tick
  },

  resetToLobby() {
    this.stopTimer();
    this.state.view = 'lobby';
    this.state.roomCode = null;
    this.state.roomMode = null;
    this.state.roomPlayers = [];
    this.state.roomCanStart = false;
            this.state.roomChats = [];
    this.state.roomChats = [];
    this.state.battleMode = null;
    this.state.battlePlayers = [];
    this.state.question = null;
    this.state.options = [];
    this.state.endsAt = null;
    this.state.answered = false;
    this.state.selectedAnswer = null;
    this.state.lastResult = null;
    this.state.matchEnd = null;
    this.state.pendingConfirm = null;
    this.state.pendingConfirmReturnView = null;
    this.lastViewBGM = null; // Reset agar BGM lobby play saat kembali
    this.render();
  },
};

// ─── Boot ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => Client.init());
