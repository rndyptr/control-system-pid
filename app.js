/*
 * Monitor Suhu via USB-to-RS232 (Web Serial API)
 *
 * Dua sketch Arduino, dua format data (dideteksi otomatis dari jumlah kolom):
 *   ON/OFF (relay) :  "<suhu>|<Setpoin>\n"                      contoh: "45.3|50.0\n"
 *   PID            :  "<suhu>|<Setpoin>|<Kp>|<Ki>|<Kd>\n"       contoh: "45.3|50.0|50|25|35\n"
 *
 * Kedua sketch TIDAK membaca Serial (tidak ada mySerial.read()), jadi PC
 * hanya bisa MEMBACA data. Switch ON/OFF | PID di header hanya mengatur
 * kartu mana yang ditampilkan di UI, bukan mengubah mode Arduino — mode
 * Arduino ditentukan oleh sketch mana yang sedang di-upload ke board.
 *
 * Hanya berjalan di browser berbasis Chromium (Chrome/Edge) yang mendukung
 * navigator.serial, dan harus dibuka sebagai file lokal / server lokal (bukan iframe sandbox).
 */

(() => {
  const els = {
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    btnBaudToggle: document.getElementById('btnBaudToggle'),
    pickedBaudLabel: document.getElementById('pickedBaudLabel'),
    baudPanel: document.getElementById('baudPanel'),
    btnPickPort: document.getElementById('btnPickPort'),
    pickedPortLabel: document.getElementById('pickedPortLabel'),
    modalOverlay: document.getElementById('portModalOverlay'),
    btnCloseModal: document.getElementById('btnCloseModal'),
    portCardList: document.getElementById('portCardList'),
    portListEmptyHint: document.getElementById('portListEmptyHint'),
    btnScanNewPort: document.getElementById('btnScanNewPort'),
    btnConnect: document.getElementById('btnConnect'),
    btnDisconnect: document.getElementById('btnDisconnect'),
    portInfo: document.getElementById('portInfo'),
    tempValue: document.getElementById('tempValue'),
    lastUpdate: document.getElementById('lastUpdate'),
    setpointValue: document.getElementById('setpointValue'),
    relayState: document.getElementById('relayState'),
    relayCard: document.getElementById('relayCard'),
    pidCard: document.getElementById('pidCard'),
    pidKp: document.getElementById('pidKp'),
    pidKi: document.getElementById('pidKi'),
    pidKd: document.getElementById('pidKd'),
    modeToggle: document.getElementById('modeToggle'),
    modeSwitchIcon: document.getElementById('modeSwitchIcon'),
    modeSwitchCaption: document.getElementById('modeSwitchCaption'),
    btnClear: document.getElementById('btnClear'),
    btnSave: document.getElementById('btnSave'),
    logBody: document.getElementById('logBody'),
    consoleBox: document.getElementById('consoleBox'),
    chartCanvas: document.getElementById('chartCanvas'),
  };

  const CHART_WINDOW = 60; // jumlah titik terakhir yang ditampilkan (~1 menit @ 1 data/detik)
  const chartCtx = els.chartCanvas.getContext('2d');

  const state = {
    port: null,
    selectedPort: null,
    reader: null,
    readableClosed: null,
    keepReading: false,
    currentTemp: null,
    currentSetpoint: null,
    relayOn: false,
    log: [],
    baudRate: 9600,
    chartPoints: [], // { t: detik sejak konek, temp, setpoint }
    startTime: null,
  };

  if (!('serial' in navigator)) {
    setStatus('error', 'Web Serial tidak didukung');
    logConsole('Browser ini tidak mendukung Web Serial API. Gunakan Chrome atau Edge terbaru.');
    els.btnPickPort.disabled = true;
  } else {
    refreshPortList();
  }
  resizeChart();

  // ---------- Custom port picker ----------

  let knownPorts = [];

  function portLabel(port, idx) {
    return `Port ${idx + 1}`;
  }

  function portDetail(port) {
    const info = port.getInfo ? port.getInfo() : {};
    if (info.usbVendorId == null && info.usbProductId == null) return '';
    return `VID ${info.usbVendorId ?? '?'} · PID ${info.usbProductId ?? '?'}`;
  }

  async function refreshPortList() {
    try {
      knownPorts = await navigator.serial.getPorts();
    } catch (_) {
      knownPorts = [];
    }
    renderPortCards();
  }

  function renderPortCards() {
    els.portCardList.innerHTML = '';
    els.portListEmptyHint.hidden = knownPorts.length > 0;

    knownPorts.forEach((port, idx) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'port-card';
      if (port === state.selectedPort) card.classList.add('selected');

      const detail = portDetail(port);
      card.innerHTML = `
        <span class="port-card-icon"></span>
        <span class="port-card-text">
          <span class="port-card-title">${portLabel(port, idx)}</span>
          ${detail ? `<span class="port-card-sub">${detail}</span>` : ''}
        </span>
      `;
      card.addEventListener('click', () => selectPort(port, idx));

      if (typeof port.forget === 'function') {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'port-card-remove';
        removeBtn.title = 'Lupakan port ini';
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await port.forget();
            if (state.selectedPort === port) {
              state.selectedPort = null;
              els.pickedPortLabel.textContent = 'Belum ada port dipilih';
              els.btnConnect.disabled = true;
            }
            await refreshPortList();
          } catch (err) {
            logConsole(`Gagal melupakan port: ${err.message}`);
          }
        });
        card.appendChild(removeBtn);
      }

      els.portCardList.appendChild(card);
    });
  }

  function selectPort(port, idx) {
    state.selectedPort = port;
    els.pickedPortLabel.textContent = portLabel(port, idx);
    els.btnConnect.disabled = false;
    closeModal();
  }

  function openModal() {
    renderPortCards();
    els.modalOverlay.hidden = false;
  }
  function closeModal() {
    els.modalOverlay.hidden = true;
  }

  els.btnPickPort.addEventListener('click', openModal);
  els.btnCloseModal.addEventListener('click', closeModal);
  els.modalOverlay.addEventListener('click', (e) => {
    if (e.target === els.modalOverlay) closeModal();
  });

  els.btnScanNewPort.addEventListener('click', async () => {
    try {
      const port = await navigator.serial.requestPort();
      await refreshPortList();
      const idx = knownPorts.indexOf(port);
      selectPort(port, idx >= 0 ? idx : knownPorts.length - 1);
    } catch (err) {
      if (err.name === 'NotFoundError') return; // dibatalkan user
      logConsole(`Error memilih port: ${err.message}`);
    }
  });

  // ---------- Custom baud rate dropdown ----------

  function toggleBaudPanel(show) {
    els.baudPanel.hidden = show === undefined ? !els.baudPanel.hidden : !show;
  }

  els.btnBaudToggle.addEventListener('click', () => toggleBaudPanel());

  els.baudPanel.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      const baud = parseInt(item.dataset.baud, 10);
      state.baudRate = baud;
      els.pickedBaudLabel.textContent = String(baud);
      els.baudPanel.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      toggleBaudPanel(false);
    });
  });

  document.addEventListener('click', (e) => {
    if (!els.baudPanel.hidden && !e.target.closest('#baudDropdown')) {
      toggleBaudPanel(false);
    }
  });

  // ---------- Grafik suhu ----------

  function resizeChart() {
    const rect = els.chartCanvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    els.chartCanvas.width = rect.width * dpr;
    els.chartCanvas.height = rect.height * dpr;
    chartCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawChart();
  }
  window.addEventListener('resize', resizeChart);

  function fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // Bulatkan step antar-garis grid ke angka "rapi" (1/2/5/10/25/50 dst)
  // biar labelnya enak dibaca, bukan angka desimal aneh.
  function niceStep(rough) {
    const STEPS = [1, 2, 2.5, 5, 10, 25, 50, 100];
    for (const s of STEPS) if (rough <= s) return s;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    return Math.ceil(rough / mag) * mag;
  }

  function computeYRange(points) {
    if (points.length === 0) return { min: 0, max: 100 };
    let lo = Infinity, hi = -Infinity;
    points.forEach(p => {
      lo = Math.min(lo, p.temp, p.setpoint);
      hi = Math.max(hi, p.temp, p.setpoint);
    });
    if (lo === hi) { lo -= 5; hi += 5; }
    const pad = (hi - lo) * 0.2;
    lo -= pad; hi += pad;

    const step = niceStep((hi - lo) / 4);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    return { min: lo, max: hi, step };
  }

  function drawChart() {
    const rect = els.chartCanvas.parentElement.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    const padL = 38, padR = 10, padT = 10, padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    chartCtx.clearRect(0, 0, W, H);

    const points = state.chartPoints;
    const { min: yMin, max: yMax, step: yStep } = computeYRange(points);
    const yOf = v => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    // grid & label sumbu Y (auto-scale sesuai rentang data)
    chartCtx.strokeStyle = '#e4e4e1';
    chartCtx.fillStyle = '#8a8a86';
    chartCtx.font = '11px "Google Sans Flex", "Segoe UI", sans-serif';
    chartCtx.textAlign = 'right';
    chartCtx.textBaseline = 'middle';
    for (let v = yMin; v <= yMax + 1e-6; v += (yStep || 25)) {
      const y = yOf(v);
      chartCtx.beginPath();
      chartCtx.moveTo(padL, y);
      chartCtx.lineTo(padL + plotW, y);
      chartCtx.lineWidth = 1;
      chartCtx.stroke();
      chartCtx.fillText(v % 1 === 0 ? String(v) : v.toFixed(1), padL - 8, y);
    }

    if (points.length === 0) {
      chartCtx.textAlign = 'center';
      chartCtx.fillText('Belum ada data', padL + plotW / 2, padT + plotH / 2);
      return;
    }

    const tMin = points[0].t;
    const tMax = Math.max(points[points.length - 1].t, tMin + 1);
    const xOf = t => padL + ((t - tMin) / (tMax - tMin)) * plotW;

    // label sumbu X (waktu mm:ss), 4 titik
    chartCtx.textAlign = 'center';
    chartCtx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const t = tMin + ((tMax - tMin) * i) / 4;
      chartCtx.fillText(fmtTime(t), xOf(t), padT + plotH + 6);
    }

    function drawLine(key, color, dashed) {
      chartCtx.beginPath();
      chartCtx.setLineDash(dashed ? [4, 3] : []);
      chartCtx.strokeStyle = color;
      chartCtx.lineWidth = 1.75;
      points.forEach((p, i) => {
        const x = xOf(p.t);
        const y = yOf(Math.max(yMin, Math.min(yMax, p[key])));
        if (i === 0) chartCtx.moveTo(x, y); else chartCtx.lineTo(x, y);
      });
      chartCtx.stroke();
      chartCtx.setLineDash([]);
    }

    drawLine('setpoint', '#8a8a86', true);
    drawLine('temp', '#1c1c1a', false);
  }

  function pushChartPoint(temp, setpoint) {
    if (state.startTime === null) state.startTime = Date.now();
    const t = (Date.now() - state.startTime) / 1000;
    state.chartPoints.push({ t, temp, setpoint });
    while (state.chartPoints.length > CHART_WINDOW) state.chartPoints.shift();
    drawChart();
  }

  // ---------- Mode switch: ON/OFF vs PID ----------

  function setControlMode(mode) {
    els.modeToggle.dataset.mode = mode;
    els.modeToggle.setAttribute('aria-checked', mode === 'pid' ? 'true' : 'false');
    els.modeSwitchIcon.textContent = mode === 'pid' ? 'P' : '⏻';
    els.modeSwitchCaption.textContent = mode === 'pid' ? 'PID' : 'ON/OFF';
    els.modeToggle.setAttribute('aria-label', `Mode kontrol suhu: ${mode === 'pid' ? 'PID' : 'ON/OFF'}`);
    els.relayCard.hidden = mode !== 'onoff';
    els.pidCard.hidden = mode !== 'pid';
  }

  els.modeToggle.addEventListener('click', () => {
    setControlMode(els.modeToggle.dataset.mode === 'onoff' ? 'pid' : 'onoff');
  });

  // ---------- UI helpers ----------

  function setStatus(kind, text) {
    els.statusDot.className = 'dot' + (kind ? ' ' + kind : '');
    els.statusText.textContent = text;
  }

  function logConsole(text) {
    const time = new Date().toLocaleTimeString();
    els.consoleBox.textContent += `[${time}] ${text}\n`;
    if (els.consoleBox.textContent.length > 20000) {
      els.consoleBox.textContent = els.consoleBox.textContent.slice(-15000);
    }
    els.consoleBox.scrollTop = els.consoleBox.scrollHeight;
  }

  function addLogRow(temp, setpoint, relay, kp, ki, kd) {
    const time = new Date().toLocaleTimeString();
    state.log.push({ time, temp, setpoint, relay, kp, ki, kd });

    const relayCell = relay === null || relay === undefined ? '-' : (relay ? 'ON' : 'OFF');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${time}</td><td>${temp ?? '-'}</td><td>${setpoint ?? '-'}</td><td>${relayCell}</td><td>${kp ?? '-'}</td><td>${ki ?? '-'}</td><td>${kd ?? '-'}</td>`;
    els.logBody.prepend(tr);

    // batasi baris tabel di DOM biar ringan
    while (els.logBody.rows.length > 500) {
      els.logBody.deleteRow(els.logBody.rows.length - 1);
    }
  }

  function setConnectedUI(connected) {
    els.btnConnect.disabled = connected || !state.selectedPort;
    els.btnDisconnect.disabled = !connected;
    els.btnBaudToggle.disabled = connected;
    els.btnPickPort.disabled = connected;
    if (!connected) {
      els.relayState.textContent = 'OFF';
      els.relayState.classList.remove('on');
    }
  }

  // ---------- Serial connect / disconnect ----------

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Setelah refresh/reload saat port masih terbuka, Chrome kadang butuh waktu
  // sejenak untuk melepas handle COM port di level OS sebelum bisa dibuka lagi.
  // Coba beberapa kali dengan jeda sebelum benar-benar menyerah.
  async function openPortWithRetry(port, baudRate, attempts = 4, delayMs = 600) {
    for (let i = 1; i <= attempts; i++) {
      try {
        await port.open({ baudRate });
        return;
      } catch (err) {
        const isBusy = err.name === 'NetworkError' || /Failed to open serial port/i.test(err.message || '');
        if (!isBusy || i === attempts) throw err;
        logConsole(`Port sepertinya masih dipakai, coba lagi… (${i}/${attempts})`);
        await sleep(delayMs);
      }
    }
  }

  els.btnConnect.addEventListener('click', async () => {
    try {
      const port = state.selectedPort;
      if (!port) {
        logConsole('Pilih port dulu sebelum menyambungkan.');
        return;
      }

      const baudRate = state.baudRate;
      await openPortWithRetry(port, baudRate);

      state.port = port;
      const info = port.getInfo ? port.getInfo() : {};
      els.portInfo.textContent = `Tersambung — VID:${info.usbVendorId ?? '?'} PID:${info.usbProductId ?? '?'} @ ${baudRate} baud`;

      state.chartPoints = [];
      state.startTime = null;

      setStatus('connected', 'Terhubung');
      setConnectedUI(true);
      logConsole(`Port terbuka pada ${baudRate} baud.`);

      startReading();
    } catch (err) {
      if (err.name === 'NotFoundError') {
        // user membatalkan pemilihan port
        return;
      }
      setStatus('error', 'Gagal terhubung');
      if (/Failed to open serial port/i.test(err.message || '')) {
        logConsole('Gagal membuka port setelah beberapa kali percobaan. Kemungkinan port masih dipakai program lain (mis. Arduino IDE Serial Monitor) — tutup program itu, atau cabut-colok ulang adaptor USB, lalu coba sambungkan lagi.');
      } else {
        logConsole(`Error: ${err.message}`);
      }
    }
  });

  els.btnDisconnect.addEventListener('click', disconnect);

  async function disconnect() {
    state.keepReading = false;

    try {
      if (state.reader) {
        await state.reader.cancel();
      }
    } catch (_) {}

    try {
      if (state.readableClosed) {
        await state.readableClosed;
      }
    } catch (_) {}

    try {
      if (state.port) {
        await state.port.close();
      }
    } catch (_) {}

    state.port = null;
    state.reader = null;

    setStatus('', 'Terputus');
    setConnectedUI(false);
    els.portInfo.textContent = 'Belum ada port dipilih.';
    logConsole('Koneksi diputus.');
  }

  // ---------- Reading loop ----------

  async function startReading() {
    state.keepReading = true;
    let buffer = '';

    const textDecoder = new TextDecoderStream();
    state.readableClosed = state.port.readable.pipeTo(textDecoder.writable).catch(() => {});
    const reader = textDecoder.readable.getReader();
    state.reader = reader;

    while (state.keepReading) {
      let value, done;
      try {
        ({ value, done } = await reader.read());
      } catch (err) {
        logConsole(`Error baca: ${err.message}`);
        break;
      }
      if (done) break;
      if (!value) continue;

      buffer += value;

      // Kalau buffer membengkak tanpa pernah ketemu newline, kemungkinan besar
      // ini noise/garbage (baud rate salah, wiring RS232 bermasalah) — bukan
      // data valid. Dibiarkan menumpuk bisa bikin tab freeze. Buang & lapor.
      if (buffer.length > 8192) {
        logConsole(`Buffer dibuang (${buffer.length} byte tanpa newline) — kemungkinan noise/wiring RS232 bermasalah, bukan data valid.`);
        buffer = '';
        continue;
      }

      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length) handleLine(line);
      }
    }

    reader.releaseLock();
  }

  function handleLine(line) {
    logConsole(line);
    parseLine(line);
  }

  function parseLine(line) {
    // ON/OFF : "<suhu>|<Setpoin>"                    -> 2 kolom
    // PID    : "<suhu>|<Setpoin>|<Kp>|<Ki>|<Kd>"      -> 5 kolom
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 2) return; // baris lain (mis. noise) hanya tampil di console mentah

    const temp = parseFloat(parts[0]);
    const setpoint = parseFloat(parts[1]);
    if (Number.isNaN(temp) || Number.isNaN(setpoint)) return;

    state.currentTemp = temp;
    state.currentSetpoint = setpoint;

    els.tempValue.textContent = temp.toFixed(1);
    els.setpointValue.textContent = setpoint.toFixed(1);
    els.lastUpdate.textContent = `Update terakhir: ${new Date().toLocaleTimeString()}`;

    let relayOn = null;
    let kp = null, ki = null, kd = null;

    if (parts.length >= 5) {
      // format PID
      kp = parseFloat(parts[2]);
      ki = parseFloat(parts[3]);
      kd = parseFloat(parts[4]);
      if (Number.isNaN(kp)) kp = null;
      if (Number.isNaN(ki)) ki = null;
      if (Number.isNaN(kd)) kd = null;
      if (kp !== null) els.pidKp.textContent = kp.toFixed(0);
      if (ki !== null) els.pidKi.textContent = ki.toFixed(0);
      if (kd !== null) els.pidKd.textContent = kd.toFixed(0);
    } else {
      // format ON/OFF (relay) — modul relay active-LOW, jadi ON saat suhu
      // di bawah setpoint (lagi memanaskan). Ada hysteresis ±0.5°C sesuai
      // firmware: di zona tengah, status relay dipertahankan (dead-band).
      const HYST = 0.5;
      if (temp <= setpoint - HYST) relayOn = true;
      else if (temp >= setpoint + HYST) relayOn = false;
      else relayOn = state.relayOn;

      state.relayOn = relayOn;
      els.relayState.textContent = relayOn ? 'ON' : 'OFF';
      els.relayState.classList.toggle('on', relayOn);
    }

    addLogRow(temp.toFixed(1), setpoint.toFixed(1), relayOn, kp, ki, kd);
    pushChartPoint(temp, setpoint);
  }

  // ---------- Log: clear & save CSV ----------

  els.btnClear.addEventListener('click', () => {
    state.log = [];
    els.logBody.innerHTML = '';
  });

  els.btnSave.addEventListener('click', () => {
    if (!state.log.length) {
      logConsole('Belum ada data untuk disimpan.');
      return;
    }
    const header = 'Waktu,Suhu (C),Setpoint (C),Relay,Kp,Ki,Kd\n';
    const rows = state.log
      .map(r => {
        const relayCell = r.relay === null || r.relay === undefined ? '' : (r.relay ? 'ON' : 'OFF');
        return `${r.time},${r.temp ?? ''},${r.setpoint ?? ''},${relayCell},${r.kp ?? ''},${r.ki ?? ''},${r.kd ?? ''}`;
      })
      .join('\n');
    const csv = header + rows;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `data-suhu-relay_${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    logConsole(`Data disimpan (${state.log.length} baris).`);
  });

  // Jika port terputus fisik (kabel dicabut), Chrome memicu event ini
  navigator.serial?.addEventListener('disconnect', () => {
    if (state.port) {
      logConsole('Perangkat terputus (kabel dicabut / port hilang).');
      disconnect();
    }
  });

  // Best-effort: lepaskan port sebelum halaman di-refresh/ditutup, biar
  // kesempatan dapat "Failed to open serial port" di percobaan sambung berikutnya lebih kecil.
  window.addEventListener('beforeunload', () => {
    if (state.port) {
      state.keepReading = false;
      try { state.reader?.cancel(); } catch (_) {}
      try { state.port.close(); } catch (_) {}
    }
  });
})();
