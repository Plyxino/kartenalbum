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
  pause:false, letzteLesung:'', lesungZaehler:0, ignoriere:'', ignoriereBis:0, autoTimer:null,
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
  tauschen: 'Jemand bietet dir eine Karte an? Halte sie in den Rahmen. Du siehst, ob du sie schon hast oder ob sich der Tausch lohnt. Gespeichert wird nichts, außer du willst es.',
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
    Kamera.strom = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: Kamera.richtung }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  } catch (e) {
    scanStatusSetzen(e && e.name === 'NotAllowedError' ? 'Kamera nicht erlaubt. Erlaube sie in den Einstellungen des Browsers.' : 'Kamera konnte nicht gestartet werden. Nimm „Bild wählen“.');
    return;
  }
  standbild.hidden = true; video.hidden = false; video.srcObject = Kamera.strom;
  try { await video.play(); } catch (e) {}
  Kamera.spur = Kamera.strom.getVideoTracks()[0]; Kamera.aktiv = true;
  const faehig = Kamera.spur && Kamera.spur.getCapabilities ? Kamera.spur.getCapabilities() : {};
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
function schleifeStarten(){ clearInterval(Kamera.timer); Kamera.timer = setInterval(scanSchritt, 650); }

function quellRahmen(qw, qh){
  const bw = scanner.clientWidth, bh = scanner.clientHeight;
  const scale = Math.max(bw / qw, bh / qh);
  const ox = (bw - qw * scale) / 2, oy = (bh - qh * scale) / 2;
  const fh = bh * 0.78, fw = fh * 63 / 88, fx = (bw - fw) / 2, fy = (bh - fh) / 2;
  return { sx: (fx - ox) / scale, sy: (fy - oy) / scale, sw: fw / scale, sh: fh / scale };
}
function rahmenAusschneiden(quelle, qw, qh){
  const r = quellRahmen(qw, qh);
  const c = document.createElement('canvas'); c.width = 756; c.height = 1056;
  c.getContext('2d').drawImage(quelle, r.sx, r.sy, r.sw, r.sh, 0, 0, 756, 1056);
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
    await lesungVerarbeiten(nummer, karte);
  } catch (e) { /* nächster Versuch */ }
  finally { Kamera.beschaeftigt = false; }
}
async function lesungVerarbeiten(nummer, karte){
  const g = $('#gelesen');
  if (!nummer) { g.hidden = true; return; }
  g.textContent = nummer.anzeige; g.hidden = false;
  if (nummer.anzeige === Z.letzteLesung) Z.lesungZaehler++; else { Z.letzteLesung = nummer.anzeige; Z.lesungZaehler = 1; }
  if (Z.ignoriere === nummer.anzeige && Date.now() < Z.ignoriereBis) return;
  if (Z.lesungZaehler >= 2) { Z.lesungZaehler = 0; await nummerErkannt(nummer, karte); }
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
    await w.setParameters({ tessedit_char_whitelist: '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ ', tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    ocrWorker = w; return w;
  })();
  ocrLaden.catch(() => { ocrLaden = null; });
  return ocrLaden;
}
function streifenMachen(karte, invertieren){
  const W = karte.width, H = karte.height; const sy = Math.round(H * 0.85), sh = H - sy;
  const ziel = document.createElement('canvas'); ziel.width = 1600; ziel.height = Math.round(sh * 1600 / W);
  const c = ziel.getContext('2d'); c.imageSmoothingQuality = 'high';
  c.drawImage(karte, 0, sy, W, sh, 0, 0, ziel.width, ziel.height);
  const img = c.getImageData(0, 0, ziel.width, ziel.height); const p = img.data; let min = 255, max = 0;
  for (let i = 0; i < p.length; i += 4) { const g = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000; p[i] = g; if (g < min) min = g; if (g > max) max = g; }
  const span = Math.max(1, max - min);
  for (let i = 0; i < p.length; i += 4) { let v = (p[i] - min) * 255 / span; if (invertieren) v = 255 - v; p[i] = p[i + 1] = p[i + 2] = v; p[i + 3] = 255; }
  c.putImageData(img, 0, 0); return ziel;
}
async function nummerAusKarte(karte){
  const w = await ocrBereit();
  let erg = await w.recognize(streifenMachen(karte, false));
  let nummer = nummerParsen(erg.data.text);
  if (!nummer) { erg = await w.recognize(streifenMachen(karte, true)); nummer = nummerParsen(erg.data.text); }
  return nummer;
}
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
    return { lokal: pa[1] + pa[2], praefix: pa[1], zahl: zaehler, nenner: nenner, anzeige: pa[1] + pa[2] + '/' + pb[1] + pb[2] };
  }
  const promo = /\b(SWSH|SVP|SV|SM|XY|BW|DP|HGSS)\s?(\d{2,3})\b/.exec(t);
  if (promo) return { lokal: promo[1] + promo[2], praefix: promo[1], zahl: parseInt(promo[2], 10), nenner: 0, anzeige: promo[1] + promo[2], promo: true };
  return null;
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
async function kandidatenSuchen(nummer){
  for (const sprache of ['de', 'en']) {
    const sets = await setsLaden(sprache); const setMap = new Map(sets.map(s => [s.id, s])); const idx = new Map(sets.map((s, i) => [s.id, i]));
    const r = await fetch(DB.basis + '/' + sprache + '/cards?localId=' + encodeURIComponent(nummer.lokal));
    if (!r.ok) continue;
    let karten = await r.json(); if (!Array.isArray(karten)) karten = [];
    const ziel = normLokal(nummer.lokal);
    karten = karten.filter(k => normLokal(k.localId) === ziel);
    karten.forEach(k => { k.setId = k.id.slice(0, k.id.lastIndexOf('-')); k.set = setMap.get(k.setId) || null; k.sprache = sprache; });
    if (!karten.length) continue;
    let passend = karten;
    if (nummer.nenner) passend = karten.filter(k => k.set && k.set.cardCount && (k.set.cardCount.official === nummer.nenner || k.set.cardCount.total === nummer.nenner));
    const genau = passend.length > 0;
    if (!passend.length) passend = karten;
    passend.sort((a, b) => (idx.get(b.setId) || 0) - (idx.get(a.setId) || 0));
    return { passend: passend.slice(0, 12), sprache: sprache, genau: genau };
  }
  return { passend: [], sprache: 'de', genau: false };
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
async function karteAusDb(kurz, sprache){
  const d = await karteDetails(kurz.id, sprache); const s = await setDetails(d.set.id, sprache);
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
async function nummerErkannt(nummer, karteCanvas){
  Z.pause = true; rahmen.classList.add('treffer'); piep('tick');
  scanStatusSetzen('Nummer ' + nummer.anzeige + ' erkannt, suche Karte …');
  const foto = karteCanvas ? miniatur(karteCanvas) : '';
  try {
    const erg = await kandidatenSuchen(nummer);
    if (!erg.passend.length) { ergebnisLeer(nummer, foto); return; }
    if (erg.passend.length === 1 && erg.genau) { ergebnisZeigen(await karteAusDb(erg.passend[0], erg.sprache), foto); return; }
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
  $('#aktionen').innerHTML = '';
  Z.aktuellBild = foto || '';
  e.scrollIntoView({ behavior: ruhig ? 'auto' : 'smooth', block: 'start' });
}
function kandidatenZeigen(erg, foto, nummer){
  Z.aktuell = null;
  ergebnisGrund(foto);
  $('#ergName').textContent = 'Nummer ' + nummer.anzeige;
  $('#ergZeile1').textContent = erg.genau ? 'Mehrere Sets passen. Welche ist es?' : 'Kein Set mit genau dieser Gesamtzahl gefunden. Vielleicht eine davon:';
  $('#ergZeile2').textContent = ''; $('#ergZeile3').textContent = '';
  const u = $('#urteil'); u.className = 'urteil unklar'; u.innerHTML = '<h3>Tippe auf die richtige Karte</h3><p>Vergleiche das Bild mit deiner Karte.</p>';
  const liste = $('#kandidatenListe'); $('#kandidaten').hidden = false;
  erg.passend.forEach(k => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'kandidat';
    b.innerHTML = (k.image ? '<img src="' + esc(k.image) + '/low.webp" alt="" loading="lazy">' : '<div class="platz" style="aspect-ratio:63/88;border-radius:6px;background:var(--flaeche2)"></div>') +
      '<span>' + esc(k.name) + '</span><span class="hinweis">' + esc(k.set ? k.set.name : k.setId) + '</span>';
    b.addEventListener('click', async () => {
      $$('.kandidat').forEach(x => x.classList.toggle('aktiv', x === b)); b.disabled = true;
      try { ergebnisZeigen(await karteAusDb(k, erg.sprache), Z.aktuellBild); } catch (e) { toast('Karte konnte nicht geladen werden.'); b.disabled = false; }
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
function nameFragen(nummer, foto){
  const html = '<h2>Wie heißt die Karte?</h2><label class="feld">Name<input type="text" id="dlgName" maxlength="40"></label><label class="feld">Set (wenn du es weißt)<input type="text" id="dlgSet" maxlength="40"></label><label class="feld">Jahr auf der Karte<input type="number" id="dlgJahr" min="1996" max="2100"></label>';
  dialogZeigen(html, [
    knopf('Übernehmen', 'haupt', () => {
      const name = $('#dlgName').value.trim(); if (!name) { $('#dlgName').focus(); return; }
      dialogSchliessen();
      ergebnisZeigen({ name: name, nummer: nummer.anzeige, setname: $('#dlgSet').value.trim(), setcode: '', setId: '', localId: nummer.lokal, jahr: zahlOderNull($('#dlgJahr').value), datum: '', serie: '', seltenheit: '', typ: '', kp: null, art: 'Pokémon', stufe: '', besonderheit: 'keine', sprache: '', illustrator: '', bildDb: '' }, foto);
    }),
    knopf('Abbrechen', 'leise', dialogSchliessen)
  ]);
  setTimeout(() => { const el = $('#dlgName'); if (el) el.focus(); }, 50);
}

function ergebnisZeigen(karte, foto){
  Z.aktuell = karte; Z.letztesUrteil = '';
  ergebnisGrund(foto);
  const db = $('#ergBildDb');
  if (karte.bildDb) { db.src = karte.bildDb; db.hidden = false; $('#ergPlatz').hidden = true; neuAnimieren(db, 'klappen'); }
  $('#ergName').textContent = karte.name;
  $('#ergZeile1').textContent = [karte.nummer, karte.setname, karte.serie && karte.serie !== karte.setname ? karte.serie : ''].filter(Boolean).join(' · ');
  $('#ergZeile2').textContent = [karte.jahr, karte.seltenheit, karte.typ, karte.kp ? karte.kp + ' KP' : ''].filter(Boolean).join(' · ');
  $('#ergZeile3').textContent = [karte.besonderheit && karte.besonderheit !== 'keine' ? karte.besonderheit : '', karte.stufe, karte.illustrator, karte.sprache].filter(Boolean).join(' · ');
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
    if (m === 'tauschen') u.innerHTML = '<h3>Hast du noch nicht. Tausch lohnt sich!</h3><p>' + bez(k) + ' fehlt in deiner Sammlung.</p>' + andereText;
    else if (m === 'loeschen') u.innerHTML = '<h3>Nicht in deiner Sammlung</h3><p>' + bez(k) + ' ist nicht gespeichert.</p>' + andereText;
    else u.innerHTML = '<h3>Neu! Die hast du noch nicht.</h3><p>' + bez(k) + '</p>' + andereText;
  } else if (erg.status === 'aelter') {
    const t = erg.treffer; u.className = 'urteil aelter';
    const text = '<p>Du hast diese Karte schon, aber die Ausgabe von ' + esc(t.jahr) + '. Diese hier ist von ' + esc(k.jahr) + ', also älter.</p>';
    if (m === 'tauschen') u.innerHTML = '<h3>Ältere Ausgabe. Tausch lohnt sich!</h3>' + text;
    else if (m === 'loeschen') u.innerHTML = '<h3>Ähnliche Karte gefunden</h3>' + text + '<p class="klein">Gespeichert ist: ' + bez(t) + ' (' + t.anzahl + '×)</p>';
    else u.innerHTML = '<h3>Ältere Ausgabe! Zählt als neue Karte.</h3>' + text;
  } else {
    const t = erg.treffer, seit = datumText(t.hinzugefuegt); u.className = 'urteil doppelt';
    const text = '<p>' + bez(t) + (t.jahr ? ' · ' + esc(t.jahr) : '') + '</p><p class="klein">' + (t.anzahl > 1 ? 'Du hast sie schon ' + t.anzahl + '-mal' : 'Du hast sie schon einmal') + (seit ? ', seit ' + seit : '') + '.</p>' + andereText;
    if (m === 'tauschen') u.innerHTML = '<h3>Hast du schon. Lieber nicht tauschen.</h3>' + text;
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
    a.appendChild(knopf('Weiter scannen', 'haupt', weiter));
    if (erg.status !== 'doppelt') a.appendChild(knopf('Getauscht, jetzt speichern', 'zweit', () => speichern(false)));
    else a.appendChild(knopf('Trotzdem speichern (als Doppelte)', 'leise', () => speichern(true)));
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
  Z.aktuell = null; Z.aktuellBild = ''; Z.aktuellTreffer = null; Z.letztesUrteil = ''; Z.letzteLesung = ''; Z.lesungZaehler = 0;
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
  const html = '<h2>' + esc(k.name) + '</h2><div class="detail"><div class="bilder">' + (bilder || '<div class="platz">kein Foto</div>') + '</div><dl>' + reihen.map(r => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>').join('') + '</dl></div>';
  const knoepfe = [knopf('Schließen', 'haupt', dialogSchliessen)];
  if ((k.anzahl || 1) > 1) knoepfe.push(knopf('Ein Exemplar entfernen', 'gefahr', () => entfernen(k, false)));
  knoepfe.push(knopf('Löschen', 'gefahr', () => loeschenFragen(k)));
  dialogZeigen(html, knoepfe);
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
})();
