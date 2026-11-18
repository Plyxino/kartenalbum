/* Pokémon Kartenalbum – Web-App mit Live-Scanner
   Kamera → Kartenrahmen → Nummer lesen (Tesseract) → Karte in der TCGdex-Datenbank suchen → Doppelt-Prüfung → speichern. */
(function(){
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const ruhig = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const Z = {
  konto:null, karten:[], modus:'scannen',
  aktuell:null, aktuellBild:'', aktuellTreffer:null, letztesUrteil:'',
  pause:false, letzteLesung:'', lesungZaehler:0, lesungen:[], ignoriere:'', ignoriereBis:0, autoTimer:null, debug:false,
  suche:'', sortierung:'neu', typFilter:'', loeschSuche:''
};
const FELDER = ['name','nummer','setname','setcode','setId','localId','jahr','datum','serie','seltenheit','typ','kp','art','stufe','besonderheit','sprache','illustrator','bildDb'];

/* ---------- Hilfen ---------- */
function toast(text, dauer){
  const t = $('#toast'); t.textContent = text; t.classList.add('sichtbar');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('sichtbar'), dauer || 2600);
}
function lokalLesen(k){ try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
function lokalSchreiben(k, v){ try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function slug(name){
  return String(name || '').trim().toLowerCase()
    .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/[^a-z0-9_.-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);
}
function neueId(){ return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8); }
async function hashen(text){
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  } catch (e) { let h = 0; for (const c of text) { h = (h * 31 + c.charCodeAt(0)) | 0; } return 'einfach-' + (h >>> 0).toString(16); }
}
function normText(t){ return String(t == null ? '' : t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,''); }
function normNummer(n){ return String(n == null ? '' : n).toLowerCase().replace(/\s+/g,'').replace(/(^|[^0-9])0+(?=\d)/g, '$1'); }
function normLokal(s){ return String(s || '').toUpperCase().replace(/\s+/g,'').replace(/^([A-Z]*)0+(?=\d)/, '$1'); }
function datumText(iso){ if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return ''; return d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' }); }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function zahlOderNull(v){ if (v === '' || v == null) return null; const n = Number(v); return isNaN(n) ? null : n; }
function neuAnimieren(el, klasse){ el.classList.remove(klasse); void el.offsetWidth; el.classList.add(klasse); }
function istHolo(k){ return /holo|shiny|full ?art|illustration|vmax|vstar|gx|\bex\b|\bv\b|rainbow|gold|hyper|secret/i.test(String((k.besonderheit || '') + ' ' + (k.seltenheit || ''))); }

/* ---------- Speicher: IndexedDB auf dem Gerät, Notfall localStorage ---------- */
const IDB = {
  db:null, kaputt:false,
  oeffnen(){
    return new Promise((res, rej) => {
      if (this.db) return res(this.db);
      if (!window.indexedDB) return rej(new Error('kein IndexedDB'));
      const r = indexedDB.open('kartenalbum', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('konten')) d.createObjectStore('konten', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('karten')) { const s = d.createObjectStore('karten', { keyPath: 'schluessel' }); s.createIndex('konto', 'kontoId'); }
      };
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(store, modus, fn){
    const d = await this.oeffnen();
    return new Promise((res, rej) => {
      const t = d.transaction(store, modus); const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
};
const Speicher = {
  async kontoHolen(id){
    try { return (await IDB.tx('konten', 'readonly', s => s.get(id))) || null; }
    catch (e) { const alle = lokalLesen('ks_konten') || {}; return alle[id] || null; }
  },
  async kontoAnlegen(id, daten){
    try { await IDB.tx('konten', 'readwrite', s => s.put(Object.assign({ id: id }, daten))); }
    catch (e) { const alle = lokalLesen('ks_konten') || {}; alle[id] = daten; lokalSchreiben('ks_konten', alle); }
  },
  async kartenLaden(kontoId){
    try { const l = await IDB.tx('karten', 'readonly', s => s.index('konto').getAll(kontoId)); return (l || []).map(k => { const o = Object.assign({}, k); delete o.schluessel; delete o.kontoId; return o; }); }
    catch (e) { return lokalLesen('ks_karten_' + kontoId) || []; }
  },
  async karteSpeichern(kontoId, karte){
    try { await IDB.tx('karten', 'readwrite', s => s.put(Object.assign({}, karte, { schluessel: kontoId + '/' + karte.id, kontoId: kontoId }))); }
    catch (e) {
      const alle = lokalLesen('ks_karten_' + kontoId) || []; const i = alle.findIndex(k => k.id === karte.id);
      if (i >= 0) alle[i] = karte; else alle.push(karte); lokalSchreiben('ks_karten_' + kontoId, alle);
    }
  },
  async karteLoeschen(kontoId, karteId){
    try { await IDB.tx('karten', 'readwrite', s => s.delete(kontoId + '/' + karteId)); }
    catch (e) { lokalSchreiben('ks_karten_' + kontoId, (lokalLesen('ks_karten_' + kontoId) || []).filter(k => k.id !== karteId)); }
  }
};

/* ---------- Anmelden ---------- */
$$('.tabs button').forEach(b => b.addEventListener('click', () => {
  $$('.tabs button').forEach(x => x.classList.toggle('aktiv', x === b));
  $('#formAnmelden').hidden = b.dataset.form !== 'anmelden';
  $('#formErstellen').hidden = b.dataset.form !== 'erstellen';
}));
$('#formAnmelden').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fehler = $('#anFehler'); fehler.textContent = '';
  const name = $('#anName').value.trim(), pin = $('#anPin').value; const id = slug(name);
  if (!id) { fehler.textContent = 'Bitte gib deinen Namen ein.'; return; }
  $('#anKnopf').disabled = true;
  try {
    const konto = await Speicher.kontoHolen(id);
    if (!konto) { fehler.textContent = 'Dieses Konto gibt es auf diesem Gerät nicht. Erstelle zuerst eins.'; return; }
    if ((await hashen(konto.salz + ':' + pin)) !== konto.hash) { fehler.textContent = 'Die PIN stimmt nicht.'; return; }
    await angemeldet(id, konto);
  } catch (e) { fehler.textContent = 'Anmelden hat nicht geklappt. Versuch es noch einmal.'; }
  finally { $('#anKnopf').disabled = false; }
});
$('#formErstellen').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fehler = $('#erFehler'); fehler.textContent = '';
  const name = $('#erName').value.trim(), pin = $('#erPin').value, pin2 = $('#erPin2').value; const id = slug(name);
  if (!id || name.length < 2) { fehler.textContent = 'Der Name braucht mindestens 2 Buchstaben.'; return; }
  if (pin.length < 4) { fehler.textContent = 'Die PIN braucht mindestens 4 Zeichen.'; return; }
  if (pin !== pin2) { fehler.textContent = 'Die beiden PINs sind nicht gleich.'; return; }
  $('#erKnopf').disabled = true;
  try {
    if (await Speicher.kontoHolen(id)) { fehler.textContent = 'Diesen Namen gibt es schon. Nimm einen anderen.'; return; }
    const salz = neueId();
    const konto = { name: name, salz: salz, hash: await hashen(salz + ':' + pin), erstellt: new Date().toISOString() };
    await Speicher.kontoAnlegen(id, konto);
    await angemeldet(id, konto);
    toast('Konto erstellt. Viel Spaß beim Sammeln!');
  } catch (e) { fehler.textContent = 'Speichern hat nicht geklappt.'; }
  finally { $('#erKnopf').disabled = false; }
});
async function angemeldet(id, konto){
  Z.konto = { id: id, name: konto.name };
  lokalSchreiben('ks_sitzung', { id: id, name: konto.name });
  $('#kopfName').textContent = konto.name; $('#kopfKonto').hidden = false;
  $('#seiteAnmelden').hidden = true; $('#seiteApp').hidden = false; $('#modi').hidden = false;
  try { Z.karten = await Speicher.kartenLaden(id); } catch (e) { Z.karten = []; toast('Die Karten konnten nicht geladen werden.'); }
  Z.karten.forEach(k => { if (!k.anzahl) k.anzahl = 1; });
  modusSetzen('scannen');
}
$('#knopfAbmelden').addEventListener('click', () => {
  lokalSchreiben('ks_sitzung', null); kameraStoppen();
  Z.konto = null; Z.karten = []; scanZuruecksetzen();
  $('#kopfKonto').hidden = true; $('#seiteApp').hidden = true; $('#modi').hidden = true; $('#seiteAnmelden').hidden = false; $('#anPin').value = '';
});

/* ---------- Modus ---------- */
const ERKL = {
  scannen: 'Kamera starten und die Karte in den Rahmen halten. Die App liest die Nummer unten auf der Karte, holt Name, Set und Jahr aus der Kartendatenbank und sagt dir, ob du sie schon hast.',
  tauschen: 'Halte eine Karte in den Rahmen. Die App sagt nur: Ja, hast du schon, oder Nein, hast du noch nicht. Gespeichert wird nichts.',
  loeschen: 'Halte eine Karte in den Rahmen, die du weggegeben hast, und nimm sie aus der Sammlung.'
};
function modusSetzen(m){
  Z.modus = m;
  $$('.modi button').forEach(b => b.classList.toggle('aktiv', b.dataset.modus === m));
  $('#scanBox').hidden = m === 'suchen';
  $('#suchBox').hidden = m !== 'suchen';
  $('#tauschBox').hidden = m !== 'tauschen';
  $('#loeschBox').hidden = m !== 'loeschen';
  $('#scanErkl').textContent = ERKL[m] || '';
  if (m === 'suchen') kameraStoppen();
  if (Z.aktuell) urteilZeichnen(); else scanZuruecksetzen();
  allesZeichnen();
  $$('#seiteApp .box').forEach(b => { if (!b.hidden) neuAnimieren(b, 'rein'); });
  window.scrollTo({ top: 0, behavior: ruhig ? 'auto' : 'smooth' });
}
$$('.modi button').forEach(b => b.addEventListener('click', () => modusSetzen(b.dataset.modus)));

/* ---------- Kamera ---------- */
const video = $('#video'), standbild = $('#standbild'), scanner = $('#scanner'), rahmen = $('#rahmen');
const Kamera = { strom:null, richtung:'environment', aktiv:false, spur:null, timer:null, beschaeftigt:false, licht:false };
function scanStatusSetzen(text){ $('#scanStatus').textContent = text; }
async function kameraStarten(){
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { scanStatusSetzen('Dieser Browser hat keinen Kamera-Zugriff. Nimm „Bild wählen“.'); return; }
  if (!window.isSecureContext) { scanStatusSetzen('Kamera geht nur über eine sichere Adresse (https) oder localhost.'); return; }
  kameraStoppen(); audioAn();
  scanStatusSetzen('Kamera startet …');
  try {
    Kamera.strom = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: Kamera.richtung }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
  } catch (e) {
    scanStatusSetzen(e && e.name === 'NotAllowedError' ? 'Kamera nicht erlaubt. Erlaube sie in den Einstellungen des Browsers.' : 'Kamera konnte nicht gestartet werden. Nimm „Bild wählen“.');
    return;
  }
  standbild.hidden = true; video.hidden = false; video.srcObject = Kamera.strom;
  try { await video.play(); } catch (e) {}
  Kamera.spur = Kamera.strom.getVideoTracks()[0]; Kamera.aktiv = true;
  const faehig = Kamera.spur && Kamera.spur.getCapabilities ? Kamera.spur.getCapabilities() : {};
  try { if (faehig.focusMode && faehig.focusMode.includes('continuous')) await Kamera.spur.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) {}
  $('#knopfLicht').hidden = !faehig.torch; $('#knopfWechsel').hidden = false;
  $('#knopfKamera').textContent = 'Kamera stoppen'; $('#strahl').hidden = false;
  scanStatusSetzen('Halte die Karte in den Rahmen');
  try { await ocrBereit(); } catch (e) { scanStatusSetzen('Texterkennung konnte nicht geladen werden. Prüfe das Internet.'); return; }
  if (Kamera.aktiv) { scanStatusSetzen('Halte die Karte in den Rahmen'); schleifeStarten(); }
}
function kameraStoppen(){
  clearInterval(Kamera.timer); Kamera.timer = null; Kamera.aktiv = false; Kamera.licht = false;
  if (Kamera.strom) { Kamera.strom.getTracks().forEach(t => t.stop()); Kamera.strom = null; }
  video.srcObject = null;
  $('#knopfKamera').textContent = 'Kamera starten'; $('#strahl').hidden = true; $('#gelesen').hidden = true;
  $('#knopfLicht').hidden = true; $('#knopfWechsel').hidden = true; rahmen.classList.remove('treffer');
  if (standbild.hidden) scanStatusSetzen('Kamera ist aus');
}
$('#knopfKamera').addEventListener('click', () => { if (Kamera.aktiv) kameraStoppen(); else kameraStarten(); });
$('#knopfWechsel').addEventListener('click', () => { Kamera.richtung = Kamera.richtung === 'environment' ? 'user' : 'environment'; kameraStarten(); });
$('#knopfLicht').addEventListener('click', async () => {
  if (!Kamera.spur) return; Kamera.licht = !Kamera.licht;
  try { await Kamera.spur.applyConstraints({ advanced: [{ torch: Kamera.licht }] }); } catch (e) { toast('Licht geht bei dieser Kamera nicht.'); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) kameraStoppen(); });
function schleifeStarten(){ clearInterval(Kamera.timer); Kamera.timer = setInterval(scanSchritt, 120); }

function quellRahmen(qw, qh){
  const bw = scanner.clientWidth, bh = scanner.clientHeight;
  const scale = Math.max(bw / qw, bh / qh);
  const ox = (bw - qw * scale) / 2, oy = (bh - qh * scale) / 2;
  const fh = bh * 0.78, fw = fh * 63 / 88, fx = (bw - fw) / 2, fy = (bh - fh) / 2;
  return { sx: (fx - ox) / scale, sy: (fy - oy) / scale, sw: fw / scale, sh: fh / scale };
}
function rahmenAusschneiden(quelle, qw, qh){
  const r = quellRahmen(qw, qh);
  const c = document.createElement('canvas'); c.width = 1008; c.height = 1408;
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(quelle, r.sx, r.sy, r.sw, r.sh, 0, 0, 1008, 1408);
  return c;
}
function miniatur(canvas){
  const t = document.createElement('canvas'); t.width = 360; t.height = 503;
  t.getContext('2d').drawImage(canvas, 0, 0, 360, 503);
  return t.toDataURL('image/jpeg', 0.8);
}

async function scanSchritt(){
  if (!Kamera.aktiv || Kamera.beschaeftigt || Z.pause || !video.videoWidth) return;
  Kamera.beschaeftigt = true;
  try {
    const karte = rahmenAusschneiden(video, video.videoWidth, video.videoHeight);
    const nummer = await nummerAusKarte(karte);
    if (nummer) Kamera.fehlversuche = 0; else if (!Z.pause) {
      Kamera.fehlversuche = (Kamera.fehlversuche || 0) + 1;
      if (Kamera.fehlversuche === 6) scanStatusSetzen('Tipp: Karte flach hinlegen, näher ran, bis sie den Rahmen füllt. Glänzt sie? Licht aus und die Karte leicht kippen, bis die Nummer nicht spiegelt.');
      if (Kamera.fehlversuche === 14) scanStatusSetzen('Die Nummer unten muss scharf sein. Kurz still halten, unten von Hand eintippen, oder „Ohne Nummer“ für Münzen und alte Energien.');
      if (Kamera.fehlversuche > 20) Kamera.fehlversuche = 0;
    }
    await lesungVerarbeiten(nummer, karte);
  } catch (e) { /* nächster Versuch */ }
  finally { Kamera.beschaeftigt = false; }
}
async function lesungVerarbeiten(nummer, karte){
  const g = $('#gelesen');
  if (!nummer) { g.hidden = true; return; }
  g.textContent = nummer.anzeige; g.hidden = false;
  if (Z.ignoriere === nummer.anzeige && Date.now() < Z.ignoriereBis) return;
  // Zweimal dieselbe Nummer (innerhalb der letzten vier Lesungen) gilt immer.
  // Eine saubere, plausible Einzel-Lesung darf schon vorgeprüft werden: Sie zählt nur, wenn Name/KP/Bild sie bestätigen.
  Z.lesungen.push(nummer.anzeige); if (Z.lesungen.length > 4) Z.lesungen.shift();
  const gleiche = Z.lesungen.filter(x => x === nummer.anzeige).length;
  const plausibel = await nennerPlausibel(nummer);
  if (gleiche === 1) {
    if (plausibel && nummer.sicher) { await nummerErkannt(nummer, karte, true); return; }
    scanStatusSetzen(nummer.anzeige + ' gelesen, kurz still halten …'); return;
  }
  if (!plausibel && !nummer.sicher && gleiche < 3) { scanStatusSetzen(nummer.anzeige + ' gelesen, bin noch nicht sicher …'); return; }
  Z.lesungen = []; await nummerErkannt(nummer, karte, false);
}
async function nennerPlausibel(nummer){
  if (nummer.promo) return true;
  try {
    const sets = await setsAlle();
    return sets.liste.some(s => s.cardCount && (s.cardCount.official === nummer.nenner || s.cardCount.total === nummer.nenner));
  } catch (e) { return true; }
}

/* ---------- Texterkennung ---------- */
let ocrWorker = null, ocrLaden = null;
function ocrBereit(){
  if (ocrWorker) return Promise.resolve(ocrWorker);
  if (ocrLaden) return ocrLaden;
  if (!window.Tesseract) return Promise.reject(new Error('Tesseract fehlt'));
  scanStatusSetzen('Lade Texterkennung (einmalig) …');
  ocrLaden = (async () => {
    const w = await Tesseract.createWorker('eng', 1, { logger: () => {} });
    await w.setParameters({ tessedit_char_whitelist: ZEICHEN_NUMMER, tessedit_pageseg_mode: '6', preserve_interword_spaces: '1', tessedit_do_invert: '0' });
    ocrWorker = w; return w;
  })();
  ocrLaden.catch(() => { ocrLaden = null; });
  return ocrLaden;
}
/* Ein Ausschnitt der Karte als Schwarz-Weiß-Bild (vergrößert, lokale Schwelle, helle Schrift wird umgedreht). */
function schwarzweiss(karte, sx, sy, sw, sh, zielBreite, fenster, abzug){
  const faktor = zielBreite / sw, rand = 24;
  const zw = Math.round(sw * faktor), zh = Math.round(sh * faktor);
  const ziel = document.createElement('canvas'); ziel.width = zw + 2 * rand; ziel.height = zh + 2 * rand;
  const c = ziel.getContext('2d'); c.imageSmoothingQuality = 'high';
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, ziel.width, ziel.height);
  c.drawImage(karte, sx, sy, sw, sh, rand, rand, zw, zh);
  const img = c.getImageData(rand, rand, zw, zh); const p = img.data; const n = zw * zh;
  const grau = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < p.length; i += 4, j++) grau[j] = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000;
  const bw = adaptiveSchwelle(grau, zw, zh, fenster || 31, abzug == null ? 10 : abzug);
  let schwarz = 0; for (let j = 0; j < n; j++) if (bw[j] === 0) schwarz++;
  const umdrehen = schwarz > n / 2; // Schrift ist die Minderheit: helle Schrift auf dunklem Grund umdrehen
  for (let i = 0, j = 0; i < p.length; i += 4, j++) { const v = umdrehen ? 255 - bw[j] : bw[j]; p[i] = p[i + 1] = p[i + 2] = v; p[i + 3] = 255; }
  c.putImageData(img, rand, rand);
  return ziel;
}
/* Streifen: unterer Teil der Karte (dort steht die Nummer). Teil = ganz, links oder rechts. */
function streifenMachen(karte, teil, glanz){
  const W = karte.width, H = karte.height;
  const sy = Math.round(H * 0.83), sh = H - sy;
  const bereiche = { ganz: [0, W], links: [0, Math.round(W * 0.58)], rechts: [Math.round(W * 0.42), W] };
  const b = bereiche[teil] || bereiche.ganz;
  return schwarzweiss(karte, b[0], sy, b[1] - b[0], sh, 1500 * (b[1] - b[0]) / W, glanz ? 51 : 31, glanz ? 5 : 10);
}
/* Namensstreifen: oberer Rand der Karte, dort steht der Name (hinter „Basis“/„Phase“, vor den KP). */
function namensStreifen(karte){
  const W = karte.width, H = karte.height;
  return schwarzweiss(karte, 0, Math.round(H * 0.02), Math.round(W * 0.95), Math.round(H * 0.095), 1500 * 0.95);
}
function adaptiveSchwelle(grau, w, h, fenster, abzug){
  const W1 = w + 1; const integ = new Float64Array(W1 * (h + 1));
  for (let y = 1; y <= h; y++) { let zeile = 0; for (let x = 1; x <= w; x++) { zeile += grau[(y - 1) * w + (x - 1)]; integ[y * W1 + x] = integ[(y - 1) * W1 + x] + zeile; } }
  const out = new Uint8ClampedArray(w * h); const r = fenster >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const anz = (x1 - x0 + 1) * (y1 - y0 + 1);
      const s = integ[(y1 + 1) * W1 + (x1 + 1)] - integ[y0 * W1 + (x1 + 1)] - integ[(y1 + 1) * W1 + x0] + integ[y0 * W1 + x0];
      out[y * w + x] = grau[y * w + x] < (s / anz - abzug) ? 0 : 255;
    }
  }
  return out;
}
async function nummerAusKarte(karte){
  const w = await ocrBereit();
  const texte = [];
  // Reihenfolge nach Häufigkeit: neue Karten unten links, alte unten rechts. Der ganze Streifen nur jedes zweite Mal (spart Zeit).
  Kamera.schritt = (Kamera.schritt || 0) + 1;
  const glanz = ((Kamera.fehlversuche || 0) % 4) >= 2; // bei Fehlversuchen abwechselnd weichere Schwelle gegen Glanz
  const teile = ['links', 'rechts']; if (Kamera.schritt % 2 === 0 || !Kamera.aktiv) teile.push('ganz');
  for (const teil of teile) {
    const streifen = streifenMachen(karte, teil, glanz);
    const text = await textLesen(w, streifen, ZEICHEN_NUMMER);
    const nummer = nummerParsen(text);
    texte.push('[' + teil + (glanz ? ', weich' : '') + '] ' + text.trim().replace(/\s+/g, ' ').slice(0, 120));
    if (Z.debug) debugZeigen(streifen, texte, nummer);
    if (nummer) return nummer;
  }
  return null;
}
function debugZeigen(streifen, texte, nummer){
  const c = $('#debugStreifen'); c.width = streifen.width; c.height = streifen.height; c.getContext('2d').drawImage(streifen, 0, 0);
  $('#debugText').textContent = (nummer ? 'Gelesen: ' + nummer.anzeige + (nummer.sicher ? ' (sicher)' : ' (unsicher)') : 'Keine Nummer gefunden') + '\n' + texte.join('\n');
}
$('#debugSchalter').addEventListener('change', (ev) => { Z.debug = ev.target.checked; $('#debug').hidden = !Z.debug; });
function nummerParsen(text){
  const t = String(text || '').toUpperCase().replace(/[^A-Z0-9\/\n ]/g, ' ');
  const fix = (s) => s.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/Z(?=\d)/g, '2');
  const re = /([A-Z0-9]{1,6})\s*\/\s*([A-Z0-9]{1,6})/g; let m;
  while ((m = re.exec(t))) {
    const pa = /^([A-Z]{0,4})(\d{1,3})$/.exec(fix(m[1])), pb = /^([A-Z]{0,4})(\d{1,3})$/.exec(fix(m[2]));
    if (!pa || !pb) continue;
    const zaehler = parseInt(pa[2], 10), nenner = parseInt(pb[2], 10);
    if (!nenner || nenner > 400 || nenner < 10) continue;
    if (!pa[1] && zaehler > nenner + 80) continue;
    const sicher = fix(m[1]) === m[1] && fix(m[2]) === m[2] && zaehler <= nenner + 30;
    return { lokal: pa[1] + pa[2], praefix: pa[1], zahl: zaehler, nenner: nenner, anzeige: pa[1] + pa[2] + '/' + pb[1] + pb[2], sicher: sicher };
  }
  const promo = /\b(SWSH|SVP|SV|SM|XY|BW|DP|HGSS)\s?(\d{2,3})\b/.exec(t);
  if (promo) return { lokal: promo[1] + promo[2], praefix: promo[1], zahl: parseInt(promo[2], 10), nenner: 0, anzeige: promo[1] + promo[2], promo: true };
  return null;
}


/* ---------- Gegenproben: Name und KP oben auf der Karte lesen, Bild mit der Datenbank vergleichen ---------- */
const ZEICHEN_NUMMER = '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ ';
const ZEICHEN_KOPF = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÄÖÜäöüéÉ0123456789\'-. ';
let ocrZeichen = ZEICHEN_NUMMER;
async function textLesen(w, bild, zeichen){
  if (ocrZeichen !== zeichen) { await w.setParameters({ tessedit_char_whitelist: zeichen, tessedit_pageseg_mode: '6' }); ocrZeichen = zeichen; }
  const erg = await w.recognize(bild); return String(erg.data.text || '');
}
/* Kopfzeile lesen: Name und KP. KP ist die letzte Zahl rechts, immer ein Vielfaches von 10. */
async function kopfLesen(karte){
  let text = '';
  try { const w = await ocrBereit(); text = await textLesen(w, namensStreifen(karte), ZEICHEN_KOPF); } catch (e) { text = ''; }
  let kp = null;
  const zahlen = (text.match(/\d{2,3}/g) || []).map(Number).filter(z => z % 10 === 0 && z >= 30 && z <= 340);
  if (zahlen.length) kp = zahlen[zahlen.length - 1];
  return { text: text, kp: kp };
}
function buchstaben(s){
  return String(s || '').toUpperCase().replace(/Ä/g, 'A').replace(/Ö/g, 'O').replace(/Ü/g, 'U').replace(/É|È/g, 'E').replace(/[^A-Z]/g, '');
}
function editAbstand(a, b){
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let vorher = new Array(n + 1), jetzt = new Array(n + 1);
  for (let j = 0; j <= n; j++) vorher[j] = j;
  for (let i = 1; i <= m; i++) {
    jetzt[0] = i;
    for (let j = 1; j <= n; j++) jetzt[j] = Math.min(vorher[j] + 1, jetzt[j - 1] + 1, vorher[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    const t = vorher; vorher = jetzt; jetzt = t;
  }
  return vorher[n];
}
/* Wie gut passt der Kartenname in den gelesenen Text? 1 = perfekt, 0 = gar nicht. Fenster über den Text schieben. */
function namensAehnlichkeit(gelesen, name){
  const t = buchstaben(gelesen), z = buchstaben(name);
  if (z.length < 3 || t.length < 3) return 0;
  let best = Infinity;
  for (const laenge of [z.length - 1, z.length, z.length + 1]) {
    if (laenge < 2) continue;
    if (t.length <= laenge) { best = Math.min(best, editAbstand(t, z)); continue; }
    for (let i = 0; i + laenge <= t.length; i++) best = Math.min(best, editAbstand(t.slice(i, i + laenge), z));
  }
  return Math.max(0, 1 - best / z.length);
}
/* Kandidaten nach Namen bewerten. Rückgabe: Liste mit .name (0..1), absteigend sortiert. */
function namenAbgleichen(gelesen, kandidaten){
  const lesbar = buchstaben(gelesen).length >= 4;
  const liste = kandidaten.map(k => {
    const namen = k.namen && k.namen.length ? k.namen : [k.name];
    let best = 0, bestName = namen[0];
    if (lesbar) namen.forEach(n => { const s = namensAehnlichkeit(gelesen, n); if (s > best) { best = s; bestName = n; } });
    // Sprache nach dem Namen wählen, der auf der Karte steht (deutsche oder englische Karte)
    let sprache = k.sprache || 'de';
    if (lesbar && k.nameEn && k.nameDe && bestName === k.nameEn && best >= 0.65 && namensAehnlichkeit(gelesen, k.nameDe) < best - 0.15) sprache = 'en';
    return { karte: k, name: best, kp: null, bild: null, details: null, punkte: 0, sprache: sprache, ohneName: false };
  });
  liste.sort((a, b) => b.name - a.name);
  return { liste: liste, lesbar: lesbar };
}

/* Bildvergleich: Das Bildfeld der Karte (ohne Rand und Text) grob verkleinern und mit dem Datenbankbild vergleichen. */
const BildCache = new Map();
function bildLaden(url){
  if (BildCache.has(url)) return BildCache.get(url);
  const p = new Promise((res) => {
    const im = new Image(); im.crossOrigin = 'anonymous';
    const t = setTimeout(() => res(null), 5000);
    im.onload = () => { clearTimeout(t); res(im); }; im.onerror = () => { clearTimeout(t); res(null); };
    im.src = url;
  });
  BildCache.set(url, p); return p;
}
function bildMerkmale(quelle, qw, qh){
  const grob = document.createElement('canvas'); grob.width = 48; grob.height = 36;
  grob.getContext('2d').drawImage(quelle, qw * 0.08, qh * 0.11, qw * 0.84, qh * 0.36, 0, 0, 48, 36);
  const c = document.createElement('canvas'); c.width = 24; c.height = 18; const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
  x.drawImage(grob, 0, 0, 24, 18);
  const d = x.getImageData(0, 0, 24, 18).data; const grau = [], farbe = [];
  for (let i = 0; i < d.length; i += 4) { grau.push((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000); farbe.push(d[i], d[i + 1], d[i + 2]); }
  return { grau: grau, farbe: farbe };
}
function korrelation(a, b){
  const n = Math.min(a.length, b.length); if (!n) return 0;
  let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  if (!saa || !sbb) return 0;
  return sab / Math.sqrt(saa * sbb);
}
async function bildAehnlichkeit(karte, url){
  try {
    const im = await bildLaden(url); if (!im || !im.naturalWidth) return null;
    const A = bildMerkmale(karte, karte.width, karte.height), B = bildMerkmale(im, im.naturalWidth, im.naturalHeight);
    return 0.6 * korrelation(A.grau, B.grau) + 0.4 * korrelation(A.farbe, B.farbe);
  } catch (e) { return null; }
}
/* Alle Proben zu einem Urteil zusammenfassen. */
function probenBewerten(eintrag, lesbar){
  let p = eintrag.name * 0.6;
  if (eintrag.kp === true) p += 0.15; else if (eintrag.kp === false) p -= 0.2;
  if (eintrag.bild != null) p += Math.max(-0.25, Math.min(0.25, eintrag.bild * 0.25));
  eintrag.punkte = p; return p;
}
function probenUrteil(liste, lesbar){
  const b = liste[0]; if (!b) return 'passt nicht';
  const z = liste[1];
  // Energiekarten tragen oben keinen Namen, nur „Energie“: Der Name zählt dort nicht.
  const lesbarB = lesbar && !b.ohneName;
  const nameKlar = lesbarB && b.name >= 0.65 && (!z || b.name - z.name >= 0.2);
  if (nameKlar && b.kp !== false) return 'passt';
  if (nameKlar && b.name >= 0.85) return 'passt';
  if (lesbarB && b.name < 0.4 && b.bild != null && b.bild < 0.3) return 'passt nicht';
  if (lesbarB && b.name < 0.4 && b.bild == null) return 'passt nicht';
  if (b.kp === false && b.bild != null && b.bild < 0.2) return 'passt nicht';
  if (!lesbarB && b.bild != null && b.bild >= 0.55 && b.kp !== false && (!z || z.bild == null || b.bild - z.bild >= 0.15)) return 'passt';
  return 'unklar';
}
function pruefText(nummer, eintrag, lesbar, genau){
  const haken = (ok) => ok === true ? '✓' : ok === false ? '✗' : '?';
  const teile = ['Nummer ' + haken(true), 'Set-Größe ' + haken(genau ? true : null), 'Name ' + haken(!lesbar ? null : eintrag.name >= 0.65 ? true : eintrag.name < 0.4 ? false : null), 'KP ' + haken(eintrag.kp)];
  if (eintrag.bild != null) teile.push('Bild ' + haken(eintrag.bild >= 0.45 ? true : eintrag.bild < 0.1 ? false : null));
  return 'Geprüft: ' + teile.join(' · ');
}

/* ---------- Kartendatenbank (TCGdex, kostenlos) ---------- */
const DB = { basis: 'https://api.tcgdex.net/v2', sets: {}, setDetails: {} };
async function setsLaden(sprache){
  if (DB.sets[sprache]) return DB.sets[sprache];
  const c = lokalLesen('ks_sets_' + sprache);
  if (c && Date.now() - c.zeit < 86400e3) { DB.sets[sprache] = c.liste; return c.liste; }
  const r = await fetch(DB.basis + '/' + sprache + '/sets'); if (!r.ok) throw new Error('sets');
  const liste = await r.json(); DB.sets[sprache] = liste; lokalSchreiben('ks_sets_' + sprache, { zeit: Date.now(), liste: liste });
  return liste;
}
async function setsAlle(){
  const [de, en] = await Promise.all([setsLaden('de').catch(() => []), setsLaden('en').catch(() => [])]);
  const map = new Map(); en.forEach(s => map.set(s.id, s)); de.forEach(s => map.set(s.id, s));
  return { map: map, liste: Array.from(map.values()), reihenfolge: new Map(en.map((s, i) => [s.id, i])) };
}
/* Kandidaten in beiden Sprachen suchen (Deutsch hat weniger Sets als Englisch) und nach Karten-ID zusammenführen. */
async function kandidatenSuchen(nummer){
  const sets = await setsAlle();
  const ziel = normLokal(nummer.lokal);
  const holen = async (sprache) => {
    try {
      const r = await fetch(DB.basis + '/' + sprache + '/cards?localId=' + encodeURIComponent(nummer.lokal)); if (!r.ok) return [];
      const l = await r.json(); return Array.isArray(l) ? l.filter(k => normLokal(k.localId) === ziel) : [];
    } catch (e) { return []; }
  };
  const [de, en] = await Promise.all([holen('de'), holen('en')]);
  const nachId = new Map();
  en.forEach(k => nachId.set(k.id, { id: k.id, localId: k.localId, name: k.name, nameDe: '', nameEn: k.name, image: k.image, sprache: 'en' }));
  de.forEach(k => {
    const e = nachId.get(k.id);
    if (e) { e.name = k.name; e.nameDe = k.name; e.sprache = 'de'; if (!e.image) e.image = k.image; }
    else nachId.set(k.id, { id: k.id, localId: k.localId, name: k.name, nameDe: k.name, nameEn: '', image: k.image, sprache: 'de' });
  });
  const karten = Array.from(nachId.values());
  karten.forEach(k => { k.setId = k.id.slice(0, k.id.lastIndexOf('-')); k.set = sets.map.get(k.setId) || null; k.namen = [k.nameDe, k.nameEn].filter(Boolean); });
  if (!karten.length) return { passend: [], sprache: 'de', genau: false };
  let passend = karten;
  if (nummer.nenner) passend = karten.filter(k => k.set && k.set.cardCount && (k.set.cardCount.official === nummer.nenner || k.set.cardCount.total === nummer.nenner));
  const genau = passend.length > 0;
  if (!passend.length) passend = karten;
  passend.sort((a, b) => (sets.reihenfolge.get(b.setId) || 0) - (sets.reihenfolge.get(a.setId) || 0));
  return { passend: passend, sprache: 'de', genau: genau };
}
async function karteDetails(id, sprache){ const r = await fetch(DB.basis + '/' + sprache + '/cards/' + id); if (!r.ok) throw new Error('karte'); return r.json(); }
async function setDetails(setId, sprache){
  const k = sprache + ':' + setId;
  if (DB.setDetails[k]) return DB.setDetails[k];
  const c = lokalLesen('ks_set_' + k); if (c) { DB.setDetails[k] = c; return c; }
  let d = {}; try { const r = await fetch(DB.basis + '/' + sprache + '/sets/' + setId); if (r.ok) d = await r.json(); } catch (e) {}
  const kurz = { id: setId, name: d.name || '', releaseDate: d.releaseDate || '', serie: d.serie ? d.serie.name : '', official: d.cardCount ? d.cardCount.official : null, total: d.cardCount ? d.cardCount.total : null };
  DB.setDetails[k] = kurz; lokalSchreiben('ks_set_' + k, kurz); return kurz;
}
async function karteAusDb(kurz, sprache, details){
  const d = details || await karteDetails(kurz.id, sprache); const s = await setDetails(d.set.id, sprache);
  const official = (d.set.cardCount && d.set.cardCount.official) || s.official;
  const bes = [];
  if (d.suffix) bes.push(d.suffix);
  if (d.variants && d.variants.holo && !d.variants.normal) bes.push('Holo');
  if (/Full Art|Illustration|Hyper|Secret|Shiny|Gold|Rainbow/i.test(d.rarity || '')) bes.push(d.rarity);
  return {
    name: d.name || 'Karte', nummer: d.localId + (official ? '/' + official : ''), setname: d.set.name || s.name, setcode: d.set.id, setId: d.set.id, localId: d.localId,
    jahr: s.releaseDate ? parseInt(s.releaseDate.slice(0, 4), 10) : null, datum: s.releaseDate || '', serie: s.serie || '',
    seltenheit: d.rarity || '', typ: (d.types || [])[0] || '', kp: d.hp || null, art: d.category || 'Pokémon', stufe: d.stage || '',
    besonderheit: bes.join(', ') || 'keine', illustrator: d.illustrator || '', sprache: sprache === 'de' ? 'Deutsch' : 'Englisch',
    bildDb: d.image ? d.image + '/high.webp' : ''
  };
}

/* ---------- Nummer erkannt → Karte suchen ---------- */
async function detailsHolen(id, sprache){
  try { return { d: await karteDetails(id, sprache), sprache: sprache }; } catch (e) {}
  const andere = sprache === 'de' ? 'en' : 'de';
  try { return { d: await karteDetails(id, andere), sprache: andere }; } catch (e) { return { d: null, sprache: sprache }; }
}
async function nummerErkannt(nummer, karteCanvas, einzel){
  Z.pause = true; rahmen.classList.add('treffer'); if (!einzel) piep('tick');
  scanStatusSetzen('Nummer ' + nummer.anzeige + ' erkannt, prüfe Karte …');
  const foto = karteCanvas ? miniatur(karteCanvas) : '';
  const weiterLesen = (text) => { scanStatusSetzen(text); Z.pause = false; rahmen.classList.remove('treffer'); };
  try {
    // Kopfzeile lesen, während die Datenbank antwortet (läuft parallel)
    const kopfP = karteCanvas ? kopfLesen(karteCanvas) : Promise.resolve({ text: '', kp: null });
    const erg = await kandidatenSuchen(nummer);
    if (!erg.passend.length) {
      if (einzel) { weiterLesen(nummer.anzeige + ' gelesen, noch nicht in der Datenbank gefunden, lese weiter …'); return; }
      ergebnisLeer(nummer, foto); return;
    }
    const kopf = await kopfP;
    const ab = namenAbgleichen(kopf.text, erg.passend);
    const top = ab.liste.slice(0, 3);
    await Promise.all(top.map(async (e) => {
      const dh = await detailsHolen(e.karte.id, e.sprache); e.details = dh.d; e.sprache = dh.sprache;
      e.ohneName = !!(e.details && /energ/i.test(e.details.category || ''));
      if (kopf.kp && e.details && e.details.hp) e.kp = Number(e.details.hp) === kopf.kp;
      if (karteCanvas && e.karte.image) e.bild = await bildAehnlichkeit(karteCanvas, e.karte.image + '/low.webp');
      probenBewerten(e, ab.lesbar);
    }));
    top.sort((a, b) => b.punkte - a.punkte);
    const urteil = probenUrteil(top, ab.lesbar);
    const beste = top[0];
    if (Z.debug) $('#debugText').textContent += '\n[kopf] ' + kopf.text.trim().replace(/\s+/g, ' ').slice(0, 80) + ' | KP ' + (kopf.kp || '?') + ' → ' + urteil + (einzel ? ' (Einzel-Lesung)' : '') + ' (' + beste.karte.name + ': Name ' + Math.round(beste.name * 100) + ' %, KP ' + beste.kp + ', Bild ' + (beste.bild == null ? '–' : beste.bild.toFixed(2)) + ')';
    const geordnet = top.map(x => x.karte).concat(ab.liste.slice(3).map(x => x.karte));
    if (urteil === 'passt nicht') {
      // Nummer wahrscheinlich falsch gelesen (z. B. 15 als 18). Noch einmal von vorn lesen; beim dritten Mal darf man selbst wählen.
      Z.namensAblehnung = (Z.namensAblehnung && Z.namensAblehnung.nummer === nummer.anzeige) ? { nummer: nummer.anzeige, anzahl: Z.namensAblehnung.anzahl + 1 } : { nummer: nummer.anzeige, anzahl: 1 };
      if (Z.namensAblehnung.anzahl < 3) {
        Z.lesungen = [];
        weiterLesen('Nummer ' + nummer.anzeige + ' gelesen, aber Name oder KP passen nicht zu „' + beste.karte.name + '“. Ich lese noch einmal, kurz still halten …');
        return;
      }
      erg.passend = geordnet;
      kandidatenZeigen(erg, foto, nummer, 'Name und KP oben auf der Karte passen zu keiner davon. Vielleicht wurde die Nummer falsch gelesen. Ist deine Karte dabei?');
      return;
    }
    Z.namensAblehnung = null;
    const annehmen = urteil === 'passt' || (!einzel && urteil === 'unklar' && erg.passend.length === 1 && erg.genau && beste.kp !== false);
    if (annehmen) {
      Z.lesungen = []; piep('tick');
      const karte = await karteAusDb(beste.karte, beste.sprache, beste.details);
      karte.pruefung = pruefText(nummer, beste, ab.lesbar && !beste.ohneName, erg.genau);
      ergebnisZeigen(karte, foto); return;
    }
    if (einzel) { weiterLesen(nummer.anzeige + ' gelesen, prüfe noch einmal …'); return; }
    erg.passend = geordnet;
    kandidatenZeigen(erg, foto, nummer);
  } catch (e) {
    scanStatusSetzen('Kartendatenbank nicht erreichbar. Prüfe das Internet.'); toast('Kartendatenbank nicht erreichbar.', 3500);
    Z.pause = false; rahmen.classList.remove('treffer');
  }
}
function ergebnisGrund(foto){
  const e = $('#ergebnis'); e.hidden = false; neuAnimieren(e, 'rein');
  $('#kandidaten').hidden = true; $('#kandidatenListe').innerHTML = '';
  const f = $('#ergFoto'); if (foto) { f.src = foto; f.hidden = false; } else { f.hidden = true; f.removeAttribute('src'); }
  $('#ergBildDb').hidden = true; $('#ergBildDb').removeAttribute('src');
  $('#ergPlatz').hidden = !!foto;
  $('#ergPruefung').hidden = true;
  $('#aktionen').innerHTML = '';
  Z.aktuellBild = foto || '';
  e.scrollIntoView({ behavior: ruhig ? 'auto' : 'smooth', block: 'start' });
}
function kandidatenZeigen(erg, foto, nummer, hinweis){
  Z.aktuell = null;
  ergebnisGrund(foto);
  $('#ergName').textContent = 'Nummer ' + nummer.anzeige;
  $('#ergZeile1').textContent = hinweis || (erg.genau ? 'Mehrere Sets passen. Welche ist es?' : 'Kein Set mit genau dieser Gesamtzahl gefunden. Vielleicht eine davon:');
  $('#ergZeile2').textContent = ''; $('#ergZeile3').textContent = '';
  const u = $('#urteil'); u.className = 'urteil unklar'; u.innerHTML = '<h3>Tippe auf die richtige Karte</h3><p>Vergleiche das Bild mit deiner Karte.</p>';
  const liste = $('#kandidatenListe'); $('#kandidaten').hidden = false;
  erg.passend.slice(0, 12).forEach(k => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'kandidat';
    b.innerHTML = (k.image ? '<img src="' + esc(k.image) + '/low.webp" alt="" loading="lazy">' : '<div class="platz" style="aspect-ratio:63/88;border-radius:6px;background:var(--flaeche2)"></div>') +
      '<span>' + esc(k.name) + '</span><span class="hinweis">' + esc(k.set ? k.set.name : k.setId) + '</span>';
    b.addEventListener('click', async () => {
      $$('.kandidat').forEach(x => x.classList.toggle('aktiv', x === b)); b.disabled = true;
      try { const dh = await detailsHolen(k.id, k.sprache || erg.sprache); ergebnisZeigen(await karteAusDb(k, dh.sprache, dh.d), Z.aktuellBild); } catch (e) { toast('Karte konnte nicht geladen werden.'); b.disabled = false; }
    });
    liste.appendChild(b);
  });
  const a = $('#aktionen');
  a.appendChild(knopf('Keine davon', 'zweit', () => ergebnisLeer(nummer, Z.aktuellBild)));
  a.appendChild(knopf('Weiter scannen', 'leise', () => scanZuruecksetzen(nummer.anzeige)));
}
function ergebnisLeer(nummer, foto){
  ergebnisGrund(foto);
  Z.aktuell = null;
  $('#ergName').textContent = 'Karte ' + nummer.anzeige;
  $('#ergZeile1').textContent = 'Diese Nummer steht nicht in der Datenbank.'; $('#ergZeile2').textContent = ''; $('#ergZeile3').textContent = '';
  const u = $('#urteil'); u.className = 'urteil unklar'; u.innerHTML = '<h3>Nicht gefunden</h3><p>Du kannst die Karte trotzdem mit Namen speichern.</p>';
  const a = $('#aktionen');
  a.appendChild(knopf('Mit Namen speichern', 'haupt', () => nameFragen(nummer, foto)));
  a.appendChild(knopf('Weiter scannen', 'leise', () => scanZuruecksetzen(nummer.anzeige)));
}
function nameFragen(nummer, foto){ ohneNummerFragen(foto, nummer); }
/* Karte, Münze oder Energie ohne lesbare Nummer von Hand eintragen, mit Foto aus der Kamera. */
function ohneNummerFragen(foto, nummer){
  const n = nummer || { anzeige: '', lokal: '' };
  Z.pause = true;
  const html = '<h2>' + (n.anzeige ? 'Wie heißt die Karte?' : 'Ohne Nummer eintragen') + '</h2>' +
    (foto ? '<img src="' + foto + '" alt="" class="vorschau">' : '') +
    '<label class="feld">Name<input type="text" id="dlgName" maxlength="40" placeholder="z. B. Feuer-Energie, Pikachu-Münze"></label>' +
    '<label class="feld">Was ist es?<select id="dlgArt"><option>Pokémon</option><option>Trainer</option><option>Energie</option><option>Münze</option><option>Sonstiges</option></select></label>' +
    '<label class="feld">Set (wenn du es weißt)<input type="text" id="dlgSet" maxlength="40"></label>' +
    '<label class="feld">Jahr auf der Karte<input type="number" id="dlgJahr" min="1996" max="2100"></label>';
  dialogZeigen(html, [
    knopf('Übernehmen', 'haupt', () => {
      const name = $('#dlgName').value.trim(); if (!name) { $('#dlgName').focus(); return; }
      const art = $('#dlgArt').value;
      dialogSchliessen();
      ergebnisZeigen({ name: name, nummer: n.anzeige, setname: $('#dlgSet').value.trim(), setcode: '', setId: '', localId: n.lokal, jahr: zahlOderNull($('#dlgJahr').value), datum: '', serie: '', seltenheit: '', typ: art === 'Energie' ? name.replace(/-?Energie/i, '').trim() : '', kp: null, art: art, stufe: '', besonderheit: 'keine', sprache: '', illustrator: '', bildDb: '' }, foto);
    }),
    knopf('Abbrechen', 'leise', () => { dialogSchliessen(); if (!Z.aktuell) Z.pause = false; })
  ]);
  setTimeout(() => { const el = $('#dlgName'); if (el) el.focus(); }, 50);
}
$('#knopfOhneNummer').addEventListener('click', () => {
  let foto = '';
  try {
    if (Kamera.aktiv && video.videoWidth) foto = miniatur(rahmenAusschneiden(video, video.videoWidth, video.videoHeight));
    else if (!standbild.hidden && standbild.naturalWidth) foto = miniatur(rahmenAusschneiden(standbild, standbild.naturalWidth, standbild.naturalHeight));
  } catch (e) { foto = ''; }
  audioAn();
  ohneNummerFragen(foto, null);
});

function ergebnisZeigen(karte, foto){
  Z.aktuell = karte; Z.letztesUrteil = '';
  ergebnisGrund(foto);
  const db = $('#ergBildDb');
  if (karte.bildDb) { db.src = karte.bildDb; db.hidden = false; $('#ergPlatz').hidden = true; neuAnimieren(db, 'klappen'); }
  $('#ergName').textContent = karte.name;
  $('#ergZeile1').textContent = [karte.nummer, karte.setname, karte.serie && karte.serie !== karte.setname ? karte.serie : ''].filter(Boolean).join(' · ');
  $('#ergZeile2').textContent = [karte.jahr, karte.seltenheit, karte.typ, karte.kp ? karte.kp + ' KP' : ''].filter(Boolean).join(' · ');
  $('#ergZeile3').textContent = [karte.besonderheit && karte.besonderheit !== 'keine' ? karte.besonderheit : '', karte.stufe, karte.illustrator, karte.sprache].filter(Boolean).join(' · ');
  const pz = $('#ergPruefung'); pz.textContent = karte.pruefung || ''; pz.hidden = !karte.pruefung;
  scanStatusSetzen(karte.name + ' gefunden');
  urteilZeichnen();
}

/* ---------- Vergleich: Ist das dieselbe Karte? ---------- */
function gleicheKarte(a, b){
  if (a.setId && b.setId && a.localId && b.localId) return a.setId === b.setId && normLokal(a.localId) === normLokal(b.localId);
  const na = normNummer(a.nummer), nb = normNummer(b.nummer);
  if (na && nb) {
    if (na !== nb) return false;
    const sa = normText(a.setname), sb = normText(b.setname);
    if (sa && sb && sa !== sb) return normText(a.name) === normText(b.name);
    return true;
  }
  return normText(a.name) && normText(a.name) === normText(b.name) && normText(a.setname) === normText(b.setname);
}
function pruefen(karte){
  const gleich = Z.karten.filter(k => gleicheKarte(karte, k));
  const andere = Z.karten.filter(k => normText(k.name) && normText(k.name) === normText(karte.name) && !gleich.includes(k));
  if (!gleich.length) return { status: 'neu', treffer: null, andere: andere };
  const jahrNeu = zahlOderNull(karte.jahr);
  const aelteste = gleich.slice().sort((a, b) => (zahlOderNull(a.jahr) || 9999) - (zahlOderNull(b.jahr) || 9999))[0];
  const jahrAlt = zahlOderNull(aelteste.jahr);
  if (jahrNeu && jahrAlt && jahrNeu < jahrAlt) return { status: 'aelter', treffer: aelteste, andere: andere };
  const exakt = gleich.find(k => zahlOderNull(k.jahr) === jahrNeu) || gleich[0];
  return { status: 'doppelt', treffer: exakt, andere: andere };
}
function urteilZeichnen(){
  if (!Z.aktuell) return;
  const u = $('#urteil'), a = $('#aktionen'); const alteAnim = u.classList.contains('anim'); a.innerHTML = '';
  const k = Z.aktuell, m = Z.modus;
  const erg = pruefen(k); Z.aktuellTreffer = erg.treffer;
  const bez = (x) => esc(x.name || 'Karte') + (x.nummer ? ' · ' + esc(x.nummer) : '') + (x.setname ? ' · ' + esc(x.setname) : '');
  const andereText = erg.andere.length ? '<p class="klein">Vom gleichen Pokémon hast du schon ' + erg.andere.length + ' andere Karte' + (erg.andere.length > 1 ? 'n' : '') + ' (andere Nummer oder anderes Set). Das zählt nicht als doppelt.</p>' : '';
  if (erg.status === 'neu') {
    u.className = 'urteil neu';
    if (m === 'tauschen') u.innerHTML = '<h3>Nein, hast du noch nicht.</h3><p>' + bez(k) + '</p>' + andereText;
    else if (m === 'loeschen') u.innerHTML = '<h3>Nicht in deiner Sammlung</h3><p>' + bez(k) + ' ist nicht gespeichert.</p>' + andereText;
    else u.innerHTML = '<h3>Neu! Die hast du noch nicht.</h3><p>' + bez(k) + '</p>' + andereText;
  } else if (erg.status === 'aelter') {
    const t = erg.treffer; u.className = 'urteil aelter';
    const text = '<p>Du hast diese Karte schon, aber die Ausgabe von ' + esc(t.jahr) + '. Diese hier ist von ' + esc(k.jahr) + ', also älter.</p>';
    if (m === 'tauschen') u.innerHTML = '<h3>Ja, hast du schon, aber nur die neuere Ausgabe.</h3>' + text;
    else if (m === 'loeschen') u.innerHTML = '<h3>Ähnliche Karte gefunden</h3>' + text + '<p class="klein">Gespeichert ist: ' + bez(t) + ' (' + t.anzahl + '×)</p>';
    else u.innerHTML = '<h3>Ältere Ausgabe! Zählt als neue Karte.</h3>' + text;
  } else {
    const t = erg.treffer, seit = datumText(t.hinzugefuegt); u.className = 'urteil doppelt';
    const text = '<p>' + bez(t) + (t.jahr ? ' · ' + esc(t.jahr) : '') + '</p><p class="klein">' + (t.anzahl > 1 ? 'Du hast sie schon ' + t.anzahl + '-mal' : 'Du hast sie schon einmal') + (seit ? ', seit ' + seit : '') + '.</p>' + andereText;
    if (m === 'tauschen') u.innerHTML = '<h3>Ja, hast du schon' + (t.anzahl > 1 ? ' (' + t.anzahl + '×)' : '') + '.</h3>' + text;
    else if (m === 'loeschen') u.innerHTML = '<h3>Gefunden</h3>' + text;
    else u.innerHTML = '<h3>Doppelt! Die hast du schon.</h3>' + text;
  }
  const schluessel = erg.status + '|' + m;
  if (schluessel !== Z.letztesUrteil) { neuAnimieren(u, 'anim'); piep(erg.status === 'doppelt' ? 'doppelt' : 'neu'); } else if (alteAnim) u.classList.add('anim');
  Z.letztesUrteil = schluessel;

  const weiter = () => scanZuruecksetzen(k.nummer);
  if (m === 'scannen') {
    if (erg.status === 'doppelt') { a.appendChild(knopf('Trotzdem speichern (als Doppelte)', 'zweit', () => speichern(true))); a.appendChild(knopf('Weiter scannen', 'leise', weiter)); }
    else { a.appendChild(knopf('In die Sammlung speichern', 'haupt', () => speichern(false))); a.appendChild(knopf('Verwerfen', 'leise', weiter)); }
    if ($('#schnellmodus').checked && Kamera.aktiv) {
      clearTimeout(Z.autoTimer);
      if (erg.status === 'doppelt') { scanStatusSetzen('Doppelt: ' + k.name + '. Nächste Karte …'); Z.autoTimer = setTimeout(weiter, 2600); }
      else { scanStatusSetzen('Neu: ' + k.name + ' wird gespeichert …'); Z.autoTimer = setTimeout(() => speichern(false), 1000); }
    }
  } else if (m === 'tauschen') {
    // Beim Tauschen nur die Antwort: Ja oder Nein. Danach geht es von allein weiter.
    a.appendChild(knopf('Weiter scannen', 'haupt', weiter));
    if (Kamera.aktiv) { clearTimeout(Z.autoTimer); scanStatusSetzen((erg.status === 'neu' ? 'Nein: ' : 'Ja: ') + k.name + '. Nächste Karte …'); Z.autoTimer = setTimeout(weiter, 4000); }
  } else if (m === 'loeschen') {
    if (erg.treffer) {
      const t = erg.treffer;
      if (t.anzahl > 1) a.appendChild(knopf('Ein Exemplar entfernen (' + t.anzahl + ' → ' + (t.anzahl - 1) + ')', 'gefahr', () => entfernen(t, false)));
      a.appendChild(knopf(t.anzahl > 1 ? 'Alle ' + t.anzahl + ' löschen' : 'Karte löschen', 'gefahr', () => entfernen(t, true)));
    }
    a.appendChild(knopf('Weiter scannen', 'leise', weiter));
  }
}
function knopf(text, klasse, handler){ const b = document.createElement('button'); b.type = 'button'; b.className = klasse; b.textContent = text; b.addEventListener('click', handler); return b; }
function scanZuruecksetzen(ignorierNummer){
  clearTimeout(Z.autoTimer); Z.autoTimer = null;
  Z.aktuell = null; Z.aktuellBild = ''; Z.aktuellTreffer = null; Z.letztesUrteil = ''; Z.letzteLesung = ''; Z.lesungZaehler = 0; Z.lesungen = [];
  if (ignorierNummer) { Z.ignoriere = String(ignorierNummer).toUpperCase(); Z.ignoriereBis = Date.now() + 6000; }
  $('#ergebnis').hidden = true; $('#gelesen').hidden = true; rahmen.classList.remove('treffer');
  Z.pause = false;
  if (Kamera.aktiv) scanStatusSetzen('Halte die nächste Karte in den Rahmen');
}

/* ---------- Bild wählen und Nummer von Hand ---------- */
$('#dateiBild').addEventListener('change', async (ev) => {
  const file = ev.target.files[0]; ev.target.value = ''; if (!file) return;
  kameraStoppen(); scanZuruecksetzen(); audioAn();
  const url = URL.createObjectURL(file);
  try {
    await new Promise((res, rej) => { standbild.onload = res; standbild.onerror = rej; standbild.src = url; });
    standbild.hidden = false; video.hidden = true;
    scanStatusSetzen('Lese die Nummer …'); $('#strahl').hidden = false;
    await ocrBereit();
    const karte = rahmenAusschneiden(standbild, standbild.naturalWidth, standbild.naturalHeight);
    const nummer = await nummerAusKarte(karte);
    $('#strahl').hidden = true;
    if (!nummer) { scanStatusSetzen('Keine Nummer gelesen. Die Karte muss den Rahmen füllen, oder tippe die Nummer unten ein.'); return; }
    $('#gelesen').textContent = nummer.anzeige; $('#gelesen').hidden = false;
    await nummerErkannt(nummer, karte);
  } catch (e) { $('#strahl').hidden = true; scanStatusSetzen('Das Bild konnte nicht gelesen werden.'); }
  finally { URL.revokeObjectURL(url); }
});
$('#labelBild').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); $('#dateiBild').click(); } });
$('#formManuell').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const nummer = nummerParsen($('#manuellNummer').value);
  if (!nummer) { toast('Schreib die Nummer wie auf der Karte, zum Beispiel 025/198.'); return; }
  scanZuruecksetzen(); await nummerErkannt(nummer, null); $('#manuellNummer').value = '';
});

/* ---------- Töne ---------- */
let audio = null;
function audioAn(){ try { if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch (e) {} }
function piep(art){
  if (!audio || ruhig) return;
  const t = audio.currentTime;
  const toene = art === 'neu' ? [[660, 0, .12], [990, .13, .2]] : art === 'doppelt' ? [[220, 0, .22], [170, .2, .3]] : [[1200, 0, .05]];
  toene.forEach(([f, s, d]) => {
    const o = audio.createOscillator(), g = audio.createGain(); o.type = art === 'doppelt' ? 'square' : 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + s); g.gain.exponentialRampToValueAtTime(art === 'tick' ? 0.08 : 0.2, t + s + .01); g.gain.exponentialRampToValueAtTime(0.0001, t + s + d);
    o.connect(g); g.connect(audio.destination); o.start(t + s); o.stop(t + s + d + .03);
  });
}

/* ---------- Speichern und Löschen ---------- */
async function speichern(alsDoppelte){
  if (!Z.aktuell || !Z.konto) return;
  clearTimeout(Z.autoTimer);
  const k = Z.aktuell; const knoepfe = $$('#aktionen button'); knoepfe.forEach(b => b.disabled = true);
  try {
    if (alsDoppelte && Z.aktuellTreffer) {
      const t = Z.aktuellTreffer;
      const neu = Object.assign({}, t, { anzahl: (t.anzahl || 1) + 1, geaendert: new Date().toISOString() });
      if (!neu.bild && Z.aktuellBild) neu.bild = Z.aktuellBild;
      await Speicher.karteSpeichern(Z.konto.id, neu); Object.assign(t, neu);
      toast(t.name + ' ist jetzt ' + t.anzahl + '-mal in der Sammlung.');
    } else {
      const karte = { id: neueId(), anzahl: 1, hinzugefuegt: new Date().toISOString(), bild: Z.aktuellBild || '' };
      FELDER.forEach(f => { karte[f] = (f === 'jahr' || f === 'kp') ? zahlOderNull(k[f]) : String(k[f] == null ? '' : k[f]).trim(); });
      if (!karte.name) karte.name = 'Unbekannte Karte';
      await Speicher.karteSpeichern(Z.konto.id, karte); Z.karten.push(karte);
      konfetti(); toast(karte.name + ' gespeichert.');
    }
    scanZuruecksetzen(k.nummer); allesZeichnen();
  } catch (e) { toast('Speichern hat nicht geklappt. Ist der Speicher voll?', 4000); knoepfe.forEach(b => b.disabled = false); }
}
async function entfernen(karte, ganz){
  if (!Z.konto) return;
  try {
    if (!ganz && karte.anzahl > 1) {
      const neu = Object.assign({}, karte, { anzahl: karte.anzahl - 1, geaendert: new Date().toISOString() });
      await Speicher.karteSpeichern(Z.konto.id, neu); Object.assign(karte, neu);
      toast('Ein Exemplar entfernt. ' + karte.name + ' hast du noch ' + karte.anzahl + '-mal.');
    } else {
      await Speicher.karteLoeschen(Z.konto.id, karte.id); Z.karten = Z.karten.filter(x => x.id !== karte.id);
      toast(karte.name + ' gelöscht.');
    }
    dialogSchliessen(); scanZuruecksetzen(karte.nummer); allesZeichnen();
  } catch (e) { toast('Löschen hat nicht geklappt.', 4000); }
}

/* ---------- Sichern und Laden (Datei) ---------- */
$('#knopfSichern').addEventListener('click', () => {
  if (!Z.konto) return;
  const daten = { app: 'kartenalbum', version: 1, konto: Z.konto.name, gesichert: new Date().toISOString(), karten: Z.karten };
  const blob = new Blob([JSON.stringify(daten)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'kartenalbum-' + slug(Z.konto.name) + '.json';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Sicherung erstellt (' + Z.karten.length + ' Karten).');
});
$('#dateiSicherung').addEventListener('change', async (ev) => {
  const file = ev.target.files[0]; ev.target.value = ''; if (!file || !Z.konto) return;
  try {
    const daten = JSON.parse(await file.text());
    if (!daten || !Array.isArray(daten.karten)) throw new Error('Format');
    let neu = 0;
    for (const k of daten.karten) {
      if (!k || !k.id || Z.karten.some(x => x.id === k.id)) continue;
      if (!k.anzahl) k.anzahl = 1;
      await Speicher.karteSpeichern(Z.konto.id, k); Z.karten.push(k); neu++;
    }
    allesZeichnen(); toast(neu + ' Karten aus der Sicherung übernommen.');
  } catch (e) { toast('Das ist keine Kartenalbum-Sicherung.', 3500); }
});

/* ---------- Anzeige ---------- */
function allesZeichnen(){
  zahlSetzen($('#zahlGesamt'), Z.karten.reduce((s, k) => s + (k.anzahl || 1), 0));
  zahlSetzen($('#zahlVerschieden'), Z.karten.length);
  zahlSetzen($('#zahlDoppelt'), Z.karten.filter(k => (k.anzahl || 1) > 1).length);
  if (Z.modus === 'suchen') rasterZeichnen();
  if (Z.modus === 'tauschen') tauschListeZeichnen();
  if (Z.modus === 'loeschen') loeschListeZeichnen();
}
function zahlSetzen(el, neu){
  const alt = Number(el.textContent) || 0;
  if (alt === neu || ruhig) { el.textContent = neu; return; }
  if (el._tick) cancelAnimationFrame(el._tick);
  const start = performance.now(), dauer = 650; el.classList.toggle('hoch', neu > alt);
  const tick = (t) => { const p = Math.min(1, (t - start) / dauer); const e = 1 - Math.pow(1 - p, 3); el.textContent = Math.round(alt + (neu - alt) * e); if (p < 1) el._tick = requestAnimationFrame(tick); else { el._tick = null; setTimeout(() => el.classList.remove('hoch'), 400); } };
  el._tick = requestAnimationFrame(tick);
}
function passtZurSuche(k, text){
  if (!text) return true;
  const t = normText(text), n = normNummer(text);
  return ['name','nummer','setname','setcode','serie','typ','seltenheit','besonderheit','sprache','illustrator','jahr','art'].some(f => t && normText(k[f]).includes(t)) || (n && normNummer(k.nummer).includes(n));
}
function sortiert(liste){
  const l = liste.slice(), s = Z.sortierung;
  if (s === 'name') l.sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));
  else if (s === 'nummer') l.sort((a, b) => String(a.nummer).localeCompare(String(b.nummer), 'de', { numeric: true }));
  else if (s === 'jahr') l.sort((a, b) => (a.jahr || 9999) - (b.jahr || 9999));
  else if (s === 'anzahl') l.sort((a, b) => (b.anzahl || 1) - (a.anzahl || 1));
  else l.sort((a, b) => String(b.hinzugefuegt || '').localeCompare(String(a.hinzugefuegt || '')));
  return l;
}
function bildHtml(k){
  const src = k.bild || k.bildDb;
  return src ? '<img src="' + esc(src) + '" alt="" loading="lazy">' : '<div class="platz">kein Foto</div>';
}
function rasterZeichnen(){
  const typen = Array.from(new Set(Z.karten.map(k => k.typ).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'de'));
  const chips = $('#chips'); chips.innerHTML = '';
  if (typen.length) {
    chips.appendChild(chip('Alle', '' === Z.typFilter, () => { Z.typFilter = ''; rasterZeichnen(); }));
    typen.forEach(t => chips.appendChild(chip(t, t === Z.typFilter, () => { Z.typFilter = Z.typFilter === t ? '' : t; rasterZeichnen(); })));
  }
  const liste = sortiert(Z.karten.filter(k => passtZurSuche(k, Z.suche) && (!Z.typFilter || k.typ === Z.typFilter)));
  $('#suchAnzahl').textContent = Z.karten.length === 0 ? '' : liste.length + ' von ' + Z.karten.length + ' Karten';
  const r = $('#raster'); r.innerHTML = '';
  if (!Z.karten.length) { r.innerHTML = '<p class="leer-hinweis">Noch keine Karten. Geh auf „Scannen“ und halte deine erste Karte vor die Kamera.</p>'; return; }
  if (!liste.length) { r.innerHTML = '<p class="leer-hinweis">Nichts gefunden.</p>'; return; }
  liste.forEach(k => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'kk' + (istHolo(k) ? ' holo' : '');
    b.innerHTML = '<div class="bildbox">' + bildHtml(k) + '</div>' + ((k.anzahl || 1) > 1 ? '<span class="anz">' + k.anzahl + '×</span>' : '') +
      '<div class="n">' + esc(k.name) + '</div><div class="d">' + esc([k.nummer, k.setname || k.setcode, k.jahr].filter(Boolean).join(' · ')) + '</div>';
    b.addEventListener('click', () => detailZeigen(k));
    if (!ruhig) {
      b.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') return;
        const rect = b.getBoundingClientRect(); const px = (e.clientX - rect.left) / rect.width, py = (e.clientY - rect.top) / rect.height;
        b.style.setProperty('--mx', (px * 100) + '%'); b.style.setProperty('--my', (py * 100) + '%');
        b.style.transform = 'perspective(600px) rotateX(' + ((.5 - py) * 10).toFixed(2) + 'deg) rotateY(' + ((px - .5) * 10).toFixed(2) + 'deg) translateY(-2px)';
      });
      b.addEventListener('pointerleave', () => { b.style.transform = ''; });
    }
    r.appendChild(b);
  });
}
function chip(text, aktiv, handler){ const b = document.createElement('button'); b.type = 'button'; b.textContent = text; if (aktiv) b.classList.add('aktiv'); b.addEventListener('click', handler); return b; }
$('#suchFeld').addEventListener('input', (ev) => { Z.suche = ev.target.value; rasterZeichnen(); });
$('#sortierung').addEventListener('change', (ev) => { Z.sortierung = ev.target.value; rasterZeichnen(); });
function zeile(k, aktionen){
  const z = document.createElement('div'); z.className = 'zeile';
  z.innerHTML = bildHtml(k) + '<div class="txt"><div class="n">' + esc(k.name) + ((k.anzahl || 1) > 1 ? ' · ' + k.anzahl + '×' : '') + '</div><div class="d">' + esc([k.nummer, k.setname || k.setcode, k.jahr, k.besonderheit && k.besonderheit !== 'keine' ? k.besonderheit : ''].filter(Boolean).join(' · ')) + '</div></div>';
  aktionen.forEach(b => z.appendChild(b)); return z;
}
function tauschListeZeichnen(){
  const l = $('#tauschListe'); l.innerHTML = '';
  const doppelte = sortiert(Z.karten.filter(k => (k.anzahl || 1) > 1));
  if (!doppelte.length) { l.innerHTML = '<p class="leer-hinweis">Du hast gerade keine doppelten Karten.</p>'; return; }
  doppelte.forEach(k => l.appendChild(zeile(k, [knopf('Weggegeben', 'zweit', () => entfernen(k, false))])));
}
function loeschListeZeichnen(){
  const l = $('#loeschListe'); l.innerHTML = '';
  const liste = sortiert(Z.karten.filter(k => passtZurSuche(k, Z.loeschSuche))).slice(0, 60);
  if (!Z.karten.length) { l.innerHTML = '<p class="leer-hinweis">Deine Sammlung ist leer.</p>'; return; }
  if (!liste.length) { l.innerHTML = '<p class="leer-hinweis">Nichts gefunden.</p>'; return; }
  liste.forEach(k => l.appendChild(zeile(k, [knopf('Löschen', 'gefahr', () => loeschenFragen(k))])));
}
$('#loeschSuche').addEventListener('input', (ev) => { Z.loeschSuche = ev.target.value; loeschListeZeichnen(); });

/* ---------- Dialoge ---------- */
const dialog = $('#dialog');
function dialogZeigen(html, knoepfe){
  const inhalt = $('#dialogInhalt'); inhalt.innerHTML = html;
  const a = document.createElement('div'); a.className = 'aktionen'; knoepfe.forEach(b => a.appendChild(b)); inhalt.appendChild(a);
  if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); } else dialog.setAttribute('open', '');
}
function dialogSchliessen(){ if (dialog.open) dialog.close(); dialog.removeAttribute('open'); }
dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialogSchliessen(); });
function detailZeigen(k){
  const reihen = [['Nummer', k.nummer], ['Set', k.setname], ['Serie', k.serie], ['Jahr', k.jahr], ['Erschienen', datumText(k.datum)], ['Art', k.art], ['Typ', k.typ], ['KP', k.kp], ['Stufe', k.stufe], ['Seltenheit', k.seltenheit], ['Besonderheit', k.besonderheit], ['Sprache', k.sprache], ['Illustrator', k.illustrator], ['Anzahl', (k.anzahl || 1) + '×'], ['Gespeichert am', datumText(k.hinzugefuegt)]]
    .filter(r => r[1] !== '' && r[1] != null);
  const bilder = (k.bildDb ? '<img src="' + esc(k.bildDb) + '" alt="">' : '') + (k.bild ? '<img src="' + k.bild + '" alt="">' : '');
  const html = '<h2>' + esc(k.name) + '</h2><div class="detail"><div class="bilder">' + (bilder || '<div class="platz">kein Foto</div>') + '</div><dl>' + reihen.map(r => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>').join('') + '<dt>Wert</dt><dd class="wert" id="detailWert">wird berechnet …</dd></dl></div>';
  const knoepfe = [knopf('Schließen', 'haupt', dialogSchliessen)];
  if (k.setId) knoepfe.push(knopf('Ganzes Set ansehen', 'zweit', () => setUebersicht(k)));
  if ((k.anzahl || 1) > 1) knoepfe.push(knopf('Ein Exemplar entfernen', 'gefahr', () => entfernen(k, false)));
  knoepfe.push(knopf('Löschen', 'gefahr', () => loeschenFragen(k)));
  dialogZeigen(html, knoepfe);
  wertEintragen(k, $('#detailWert'));
}
/* Set-Übersicht: alle Karten eines Sets aus der Datenbank, die eigenen markiert, die fehlenden grau. */
const SetVoll = {};
async function setVollLaden(setId, sprache){
  const key = sprache + ':' + setId; if (SetVoll[key]) return SetVoll[key];
  for (const s of [sprache, sprache === 'de' ? 'en' : 'de']) {
    try { const r = await fetch(DB.basis + '/' + s + '/sets/' + setId); if (r.ok) { const d = await r.json(); d.sprache = s; SetVoll[key] = d; return d; } } catch (e) {}
  }
  throw new Error('set');
}
async function setUebersicht(k){
  const sprache = k.sprache === 'Englisch' ? 'en' : 'de';
  dialogZeigen('<h2>' + esc(k.setname || k.setId) + '</h2><p class="hinweis">Lade das Set …</p>', [knopf('Schließen', 'leise', dialogSchliessen)]);
  let set; try { set = await setVollLaden(k.setId, sprache); } catch (e) { $('#dialogInhalt').querySelector('.hinweis').textContent = 'Das Set konnte nicht geladen werden. Prüfe das Internet.'; return; }
  const karten = (set.cards || []).slice().sort((a, b) => normLokal(a.localId).localeCompare(normLokal(b.localId), undefined, { numeric: true }));
  const eigene = new Map(); Z.karten.filter(x => x.setId === k.setId).forEach(x => eigene.set(normLokal(x.localId), x));
  const habe = karten.filter(c => eigene.has(normLokal(c.localId))).length;
  const nurFehlende = { an: false };
  const zeichnen = () => {
    const liste = nurFehlende.an ? karten.filter(c => !eigene.has(normLokal(c.localId))) : karten;
    const html = '<h2>' + esc(set.name || k.setname) + '</h2><p class="hinweis">Du hast <strong>' + habe + ' von ' + karten.length + '</strong> Karten' + (set.releaseDate ? ' · erschienen ' + esc(datumText(set.releaseDate)) : '') + '.' + (karten.length - habe > 0 ? ' Es fehlen noch ' + (karten.length - habe) + '.' : ' Das Set ist vollständig!') + '</p>' +
      '<label class="schalter"><input type="checkbox" id="nurFehlende"' + (nurFehlende.an ? ' checked' : '') + '><span>Nur fehlende zeigen</span></label>' +
      '<div class="setraster">' + liste.map(c => { const hab = eigene.get(normLokal(c.localId)); return '<div class="sk ' + (hab ? 'hab' : 'fehlt') + '" title="' + esc(c.name) + '">' + (c.image ? '<img src="' + esc(c.image) + '/low.webp" alt="" loading="lazy">' : '<div class="platz">?</div>') + (hab ? '<span class="haken">✓' + ((hab.anzahl || 1) > 1 ? ' ' + hab.anzahl + '×' : '') + '</span>' : '') + '<span class="sn">' + esc(c.localId) + ' ' + esc(c.name) + '</span></div>'; }).join('') + '</div>';
    dialogZeigen(html, [knopf('Schließen', 'haupt', dialogSchliessen), knopf('Zurück zur Karte', 'leise', () => detailZeigen(k))]);
    $('#nurFehlende').addEventListener('change', (ev) => { nurFehlende.an = ev.target.checked; zeichnen(); });
  };
  zeichnen();
}
function loeschenFragen(k){
  const n = k.anzahl || 1;
  const html = '<h2>Wirklich löschen?</h2><p>' + esc(k.name) + (k.nummer ? ' · ' + esc(k.nummer) : '') + (n > 1 ? ' (' + n + '×)' : '') + ' wird aus deiner Sammlung entfernt. Das kannst du nicht rückgängig machen.</p>';
  const knoepfe = [];
  if (n > 1) knoepfe.push(knopf('Nur ein Exemplar entfernen', 'zweit', () => entfernen(k, false)));
  knoepfe.push(knopf(n > 1 ? 'Alle ' + n + ' löschen' : 'Ja, löschen', 'gefahr', () => entfernen(k, true)));
  knoepfe.push(knopf('Abbrechen', 'leise', dialogSchliessen));
  dialogZeigen(html, knoepfe);
}


/* ---------- Kartenwert (Cardmarket-Preise über TCGdex, Umrechnung in Franken) ---------- */
async function kursHolen(){
  const c = lokalLesen('ks_kurs');
  if (c && Date.now() - c.zeit < 86400e3) return c.chf;
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=CHF'); const d = await r.json();
    const chf = d && d.rates && d.rates.CHF; if (chf) { lokalSchreiben('ks_kurs', { zeit: Date.now(), chf: chf }); return chf; }
  } catch (e) {}
  return c ? c.chf : 0.93;
}
function preisAusDetails(d){
  const cm = d && d.pricing && d.pricing.cardmarket; if (!cm) return null;
  const nimm = (...k) => { for (const x of k) { const v = cm[x]; if (typeof v === 'number' && v > 0) return v; } return null; };
  const varianten = [];
  const normal = nimm('trend', 'avg', 'avg7', 'avg30', 'low'); if (normal) varianten.push({ name: 'Normal', eur: normal });
  const holo = nimm('trend-holo', 'avg-holo', 'avg7-holo', 'avg30-holo'); if (holo) varianten.push({ name: 'Holo', eur: holo });
  const reverse = nimm('trend-reverse', 'avg-reverse', 'avg7-reverse', 'avg30-reverse'); if (reverse) varianten.push({ name: 'Reverse Holo', eur: reverse });
  const erste = nimm('trend-firstEdition', 'avg-firstEdition', 'avg7-firstEdition'); if (erste) varianten.push({ name: '1. Edition', eur: erste });
  if (!varianten.length) return null;
  return { eur: varianten[0].eur, stand: cm.updated || '', varianten: varianten };
}
async function wertEintragen(k, el){
  try {
    const [preis, kurs] = await Promise.all([preisHolen(k), kursHolen()]);
    if (!preis) { el.textContent = 'kein Preis bekannt' + (k.setId ? '' : ' (Karte ohne Nummer)'); return; }
    // Glänzende Karte? Dann zählt der Holo-Preis, wenn es einen gibt.
    const glanz = /holo|glänz|shiny|full art|illustration|rainbow|gold/i.test((k.besonderheit || '') + ' ' + (k.seltenheit || ''));
    const haupt = (glanz && preis.varianten.find(v => v.name === 'Holo')) || preis.varianten[0];
    const n = k.anzahl || 1;
    el.innerHTML = '<strong>' + esc(geld(haupt.eur * kurs, 'CHF')) + '</strong> · ' + esc(geld(haupt.eur, '€')) + (k.jahr ? ' <span class="klein">(Ausgabe ' + esc(k.jahr) + (haupt.name !== 'Normal' ? ', ' + esc(haupt.name) : '') + ')</span>' : '') +
      (preis.varianten.length > 1 ? '<br><span class="klein">Je nach Ausführung: ' + preis.varianten.map(v => esc(v.name) + ' ' + esc(geld(v.eur * kurs, 'CHF'))).join(' · ') + '</span>' : '') +
      (n > 1 ? '<br><span class="klein">' + n + ' Stück zusammen: ' + esc(geld(haupt.eur * kurs * n, 'CHF')) + ' · ' + esc(geld(haupt.eur * n, '€')) + '</span>' : '') +
      '<br><span class="klein">Cardmarket-Durchschnitt für genau diese Karte (Set und Nummer)' + (preis.stand ? ', Stand ' + esc(datumText(preis.stand)) : '') + '. Alter und Seltenheit stecken schon im Preis; der Zustand entscheidet den Rest.</span>';
  } catch (e) { el.textContent = 'Preis gerade nicht abrufbar'; }
}
async function preisHolen(k){
  if (!k.setId || !k.localId) return null;
  const id = k.setId + '-' + k.localId, sprache = k.sprache === 'Englisch' ? 'en' : 'de';
  const c = lokalLesen('ks_preis_' + id); if (c && Date.now() - c.zeit < 43200e3) return c.preis;
  let preis = null;
  try { preis = preisAusDetails(await karteDetails(id, sprache)); } catch (e) { preis = null; }
  if (!preis && sprache === 'de') { try { preis = preisAusDetails(await karteDetails(id, 'en')); } catch (e) {} }
  lokalSchreiben('ks_preis_' + id, { zeit: Date.now(), preis: preis });
  return preis;
}
function geld(wert, waehrung){ return wert.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + waehrung; }
async function sammlungswertZeigen(knopfEl){
  if (!Z.karten.length) { toast('Noch keine Karten in der Sammlung.'); return; }
  knopfEl.disabled = true; const urtext = knopfEl.textContent;
  try {
    const kurs = await kursHolen(); let summe = 0, ohne = 0, fertig = 0;
    for (const k of Z.karten) {
      knopfEl.textContent = 'Rechne … ' + (++fertig) + '/' + Z.karten.length;
      const p = await preisHolen(k); if (p) summe += p.eur * (k.anzahl || 1); else ohne++;
    }
    const el = $('#sammlungswert'); el.hidden = false;
    el.innerHTML = 'Deine Sammlung ist ungefähr <strong>' + esc(geld(summe * kurs, 'CHF')) + '</strong> wert (' + esc(geld(summe, '€')) + ').' + (ohne ? ' Für ' + ohne + ' Karte' + (ohne > 1 ? 'n' : '') + ' gibt es keinen Preis.' : '');
    neuAnimieren(el, 'pop');
  } finally { knopfEl.disabled = false; knopfEl.textContent = urtext; }
}
$('#knopfWert').addEventListener('click', (ev) => sammlungswertZeigen(ev.currentTarget));

/* ---------- Konfetti ---------- */
function konfetti(){
  if (ruhig) return;
  const c = $('#konfetti'); const dpr = window.devicePixelRatio || 1; const W = window.innerWidth, H = window.innerHeight;
  c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const farben = ['#d3302f', '#f1c232', '#2f9a5c', '#378add', '#7f77dd', '#ffffff'];
  const teile = Array.from({ length: 110 }, () => ({ x: W / 2, y: H * 0.4, vx: (Math.random() - .5) * 16, vy: -Math.random() * 13 - 4, g: .38, w: 6 + Math.random() * 6, h: 4 + Math.random() * 4, r: Math.random() * Math.PI, vr: (Math.random() - .5) * .3, f: farben[Math.floor(Math.random() * farben.length)] }));
  const start = performance.now();
  const tick = (t) => {
    const p = (t - start) / 1900; ctx.clearRect(0, 0, W, H); if (p >= 1) return;
    ctx.globalAlpha = 1 - Math.max(0, p - .6) / .4;
    teile.forEach(k => { k.vy += k.g; k.x += k.vx; k.y += k.vy; k.vx *= .99; k.r += k.vr; ctx.save(); ctx.translate(k.x, k.y); ctx.rotate(k.r); ctx.fillStyle = k.f; ctx.fillRect(-k.w / 2, -k.h / 2, k.w, k.h); ctx.restore(); });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------- Start ---------- */
async function start(){
  if ('serviceWorker' in navigator && location.protocol === 'https:') { try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (e) {} }
  const sitzung = lokalLesen('ks_sitzung');
  if (sitzung && sitzung.id) {
    try { const konto = await Speicher.kontoHolen(sitzung.id); if (konto) { await angemeldet(sitzung.id, konto); return; } } catch (e) {}
    lokalSchreiben('ks_sitzung', null);
  }
}
start();
// Nur zum Testen am PC (localhost): Lesefunktionen von außen erreichbar machen.
if (location.hostname === 'localhost') window.__kartenTest = { nummerAusKarte, kopfLesen, namenAbgleichen, namensAehnlichkeit, bildAehnlichkeit, nummerErkannt, nummerParsen, streifenMachen, namensStreifen, preisHolen, kursHolen, kandidatenSuchen, setsAlle, setUebersicht, Z };
})();
