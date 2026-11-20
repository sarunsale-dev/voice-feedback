(function () {
  'use strict';

  var API_URL = ((window.APP_CONFIG && window.APP_CONFIG.API_URL) || '').trim();
  var K = { user: 'vf_user', queue: 'vf_queue', hist: 'vf_history', draft: 'vf_draft' };
  var BATCH_SIZE = 20;
  var RETRY_MS = 30000;
  var REQUEST_TIMEOUT_MS = 30000;
  var SILENCE_STOP_MS = 60000;   // เงียบนานเท่านี้ หยุดฟังเอง (ประหยัดแบต)
  var HISTORY_KEEP = 20;
  var HISTORY_SHOW = 5;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    hello: $('hello'), net: $('net'), app: $('app'), noUser: $('noUser'),
    mic: $('mic'), micHint: $('micHint'), text: $('text'),
    save: $('save'), clear: $('clear'), status: $('status'),
    list: $('list'), sendNow: $('sendNow'), toast: $('toast')
  };

  // ---------- storage (ทนต่อกรณี localStorage ใช้ไม่ได้) ----------
  var memory = {};
  function load(key, def) {
    try {
      var v = localStorage.getItem(key);
      return v == null ? def : JSON.parse(v);
    } catch (e) {
      return key in memory ? memory[key] : def;
    }
  }
  function persist(key, val) {
    memory[key] = val;
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ใช้ memory แทน */ }
  }

  // ---------- ผู้ใช้ ----------
  var params = new URLSearchParams(location.search);
  var user = (params.get('u') || '').trim();
  if (user) persist(K.user, user); else user = load(K.user, '');

  // ---------- UI helpers ----------
  var toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, 3500);
  }
  function showStatus(msg, kind) {
    els.status.textContent = msg || '';
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }
  function fmtTime(ts) {
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  }
  function joinText(a, b) {
    a = (a || '').trim(); b = (b || '').trim();
    if (!a) return b;
    if (!b) return a;
    return a + ' ' + b;
  }
  function onTextChanged() {
    els.save.disabled = !els.text.value.trim();
    persist(K.draft, els.text.value);
  }
  function updateNet() {
    els.net.classList.toggle('off', !navigator.onLine);
    els.net.title = navigator.onLine ? 'ออนไลน์' : 'ออฟไลน์';
  }

  function render() {
    var queue = load(K.queue, []);
    var hist = load(K.hist, []);
    els.sendNow.hidden = queue.length === 0;
    els.list.textContent = '';
    hist.slice(0, HISTORY_SHOW).forEach(function (h) {
      var li = document.createElement('li');
      var meta = document.createElement('div');
      meta.className = 'meta';
      var when = document.createElement('span');
      when.textContent = fmtTime(h.ts);
      var st = document.createElement('span');
      st.className = h.sent ? 'sent' : 'pending';
      st.textContent = h.sent ? '✓ ส่งแล้ว' : '⏳ รอส่ง';
      meta.appendChild(when); meta.appendChild(st);
      var txt = document.createElement('div');
      txt.className = 'txt';
      txt.textContent = h.text;
      li.appendChild(meta); li.appendChild(txt);
      els.list.appendChild(li);
    });
  }

  // ---------- แปลงเสียงเป็นข้อความ ----------
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null;          // session ปัจจุบัน
  var wantOn = false;      // ผู้ใช้ต้องการให้ฟังอยู่ไหม
  var committed = '';      // ข้อความที่ยืนยันแล้วก่อน session นี้
  var lastHeard = 0;
  var sessionStart = 0;
  var quickFails = 0;
  var restartTimer = null;
  var silenceTimer = null;

  function setMicUI(on) {
    els.mic.classList.toggle('on', on);
    els.mic.setAttribute('aria-pressed', on ? 'true' : 'false');
    els.micHint.textContent = on ? 'กำลังฟัง… แตะอีกครั้งเพื่อหยุด' : 'แตะเพื่อเริ่มพูด';
  }

  function startListening() {
    if (!SR) {
      toast('เครื่องนี้แปลงเสียงในแอพไม่ได้ ใช้ปุ่มไมค์บนคีย์บอร์ดแทนได้');
      els.text.focus();
      return;
    }
    if (!navigator.onLine) {
      showStatus('ตอนนี้ไม่มีอินเทอร์เน็ต แปลงเสียงไม่ได้ — พิมพ์แทนแล้วกดบันทึกได้ ระบบจะส่งให้เมื่อมีเน็ต', 'warn');
      return;
    }
    wantOn = true;
    quickFails = 0;
    committed = els.text.value;
    lastHeard = Date.now();
    setMicUI(true);
    showStatus('');
    clearInterval(silenceTimer);
    silenceTimer = setInterval(function () {
      if (wantOn && Date.now() - lastHeard > SILENCE_STOP_MS) {
        stopListening();
        toast('หยุดฟังอัตโนมัติ เพราะเงียบนาน');
      }
    }, 2000);
    beginSession();
  }

  function beginSession() {
    if (!wantOn) return;
    var r;
    try { r = new SR(); } catch (e) { stopListening(); showStatus('เปิดการแปลงเสียงไม่ได้ — พิมพ์แทนได้', 'err'); return; }
    // continuous=false + เริ่มใหม่อัตโนมัติ: เสถียรกว่าบน Chrome Android (โหมด continuous มีปัญหาข้อความซ้ำ)
    r.lang = 'th-TH';
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = function (ev) {
      var fin = '', inter = '';
      for (var i = 0; i < ev.results.length; i++) {
        var res = ev.results[i];
        if (res.isFinal) fin += res[0].transcript; else inter += res[0].transcript;
      }
      lastHeard = Date.now();
      els.text.value = joinText(committed, fin + inter);
      els.text.scrollTop = els.text.scrollHeight;
      onTextChanged();
    };

    r.onerror = function (ev) {
      var err = ev.error;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        wantOn = false;
        showStatus('ยังไม่ได้อนุญาตไมโครโฟน: แตะไอคอนหน้าช่องที่อยู่เว็บ > สิทธิ์ > ไมโครโฟน > อนุญาต แล้วลองใหม่', 'err');
      } else if (err === 'network') {
        wantOn = false;
        showStatus('สัญญาณเน็ตไม่พอสำหรับแปลงเสียง — พิมพ์แทนได้ แล้วกดบันทึก', 'warn');
      } else if (err === 'audio-capture') {
        wantOn = false;
        showStatus('ไม่พบไมโครโฟน หรือแอพอื่นกำลังใช้อยู่', 'err');
      }
      // no-speech / aborted → ปล่อยให้ onend เริ่มใหม่เอง
    };

    r.onend = function () {
      if (rec !== r) return;
      rec = null;
      committed = els.text.value;   // เก็บทุกอย่างที่แสดงอยู่ (รวมคำที่ยังไม่ยืนยัน) ไม่ให้หาย
      onTextChanged();
      if (!wantOn) { finishListening(); return; }
      quickFails = (Date.now() - sessionStart < 1000) ? quickFails + 1 : 0;
      if (quickFails >= 5) {
        finishListening();
        showStatus('ไมโครโฟนหยุดทำงานบ่อย ลองแตะไมค์ใหม่อีกครั้ง หรือพิมพ์แทน', 'warn');
        return;
      }
      restartTimer = setTimeout(beginSession, quickFails ? 600 : 150);
    };

    rec = r;
    sessionStart = Date.now();
    try {
      r.start();
    } catch (e) {
      rec = null;
      restartTimer = setTimeout(beginSession, 600);
    }
  }

  function finishListening() {
    wantOn = false;
    clearInterval(silenceTimer);
    clearTimeout(restartTimer);
    setMicUI(false);
  }

  /** หยุดแบบนุ่มนวล: รอผลสุดท้ายแล้วค่อยปิด */
  function stopListening() {
    wantOn = false;
    clearTimeout(restartTimer);
    if (rec) { try { rec.stop(); } catch (e) { finishListening(); } }
    else finishListening();
  }

  /** หยุดทันที ไม่รับผลที่ค้างอยู่ (ใช้ตอนกดบันทึก/ล้าง) */
  function hardStop() {
    wantOn = false;
    if (rec) {
      var r = rec;
      rec = null;
      r.onresult = null; r.onend = null; r.onerror = null;
      try { r.abort(); } catch (e) { /* ignore */ }
    }
    finishListening();
  }

  // ---------- คิวและการส่ง ----------
  var sending = false;

  function saveEntry() {
    var text = els.text.value.trim();
    if (!text) return;
    hardStop();
    var item = { id: uuid(), ts: Date.now(), text: text };

    var queue = load(K.queue, []);
    queue.push(item);
    persist(K.queue, queue);

    var hist = load(K.hist, []);
    hist.unshift({ id: item.id, ts: item.ts, text: text, sent: false });
    persist(K.hist, hist.slice(0, HISTORY_KEEP));

    els.text.value = '';
    committed = '';
    onTextChanged();
    render();
    showStatus('⏳ กำลังส่ง…');
    if (navigator.vibrate) navigator.vibrate(40);
    flush();
  }

  function markSent(ids) {
    var queue = load(K.queue, []).filter(function (q) { return !ids[q.id]; });
    persist(K.queue, queue);
    var hist = load(K.hist, []);
    hist.forEach(function (h) { if (ids[h.id]) h.sent = true; });
    persist(K.hist, hist);
    return queue.length;
  }

  function flush() {
    var queue = load(K.queue, []);
    if (sending || !queue.length) { render(); return; }
    if (!API_URL) {
      showStatus('ยังไม่ได้ตั้งค่า API_URL ใน config.js — ข้อมูลเก็บไว้ในเครื่องก่อน', 'warn');
      render();
      return;
    }
    if (!navigator.onLine) {
      showStatus('📴 ไม่มีอินเทอร์เน็ต — เก็บไว้ในเครื่อง ' + queue.length + ' รายการ จะส่งให้อัตโนมัติเมื่อมีเน็ต', 'warn');
      render();
      return;
    }

    sending = true;
    var batch = queue.slice(0, BATCH_SIZE);
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, REQUEST_TIMEOUT_MS);
    var again = false;

    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },  // เลี่ยง CORS preflight
      body: JSON.stringify({ user: user, items: batch }),
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.ok) {
          var ids = {};
          (data.saved || []).forEach(function (id) { ids[id] = true; });
          var left = markSent(ids);
          again = left > 0 && Object.keys(ids).length > 0;
          if (left) showStatus('⏳ ส่งแล้วบางส่วน เหลือ ' + left + ' รายการ', 'warn');
          else showStatus('✓ บันทึกลง Google Sheet แล้ว', 'ok');
        } else if (data && data.error === 'unknown_user') {
          showStatus('ชื่อ "' + user + '" ไม่อยู่ในรายชื่อของระบบ — แจ้งหัวหน้าให้เพิ่มชื่อ (ข้อมูลยังเก็บไว้ในเครื่อง)', 'err');
        } else {
          throw new Error((data && data.error) || 'bad_response');
        }
      })
      .catch(function () {
        var n = load(K.queue, []).length;
        showStatus('⏳ ยังส่งไม่สำเร็จ ' + n + ' รายการ — ข้อมูลไม่หาย ระบบจะลองส่งใหม่อัตโนมัติ', 'warn');
      })
      .then(function () {
        clearTimeout(timer);
        sending = false;
        render();
        if (again) flush();
      });
  }

  /** ตรวจว่าชื่อในลิงก์ถูกต้อง (ไม่บล็อกการใช้งาน) */
  function checkUser() {
    if (!API_URL || !navigator.onLine) return;
    fetch(API_URL + '?u=' + encodeURIComponent(user))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok && d.valid === false) {
          showStatus('ชื่อ "' + user + '" ไม่อยู่ในรายชื่อของระบบ — ตรวจลิงก์อีกครั้ง หรือแจ้งหัวหน้า', 'err');
        }
      })
      .catch(function () { /* ไม่เป็นไร */ });
  }

  // ---------- เริ่มต้น ----------
  function init() {
    updateNet();
    if (!user) {
      els.hello.textContent = 'บันทึกเสียงลูกค้า';
      els.noUser.hidden = false;
      return;
    }
    els.hello.textContent = 'สวัสดี ' + user;
    els.app.hidden = false;
    if (!SR) els.micHint.textContent = 'เครื่องนี้ใช้ไมค์บนคีย์บอร์ดแทนได้';

    els.text.value = load(K.draft, '');
    onTextChanged();
    render();

    els.mic.addEventListener('click', function () {
      if (wantOn || rec) stopListening(); else startListening();
    });
    els.text.addEventListener('input', onTextChanged);
    els.text.addEventListener('focus', function () { if (wantOn) stopListening(); });
    els.save.addEventListener('click', saveEntry);
    els.clear.addEventListener('click', function () {
      if (!els.text.value.trim()) return;
      if (!confirm('ล้างข้อความที่ยังไม่บันทึก?')) return;
      hardStop();
      els.text.value = '';
      committed = '';
      onTextChanged();
    });
    els.sendNow.addEventListener('click', flush);

    window.addEventListener('online', function () { updateNet(); flush(); });
    window.addEventListener('offline', updateNet);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') flush();
      else if (wantOn) stopListening();
    });
    window.addEventListener('storage', render);
    setInterval(flush, RETRY_MS);

    flush();
    checkUser();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* ไม่มี SW ก็ใช้ได้ */ });
    });
  }

  init();
})();
