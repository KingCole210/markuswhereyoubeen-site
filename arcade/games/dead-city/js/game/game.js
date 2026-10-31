import * as THREE from 'three/webgpu';
import { HeroModel, HERO_KINDS, HERO_INFO } from './hero-models.js';
import { FX } from './fx.js';
import { createWorld } from './world.js';
import { ZombieSystem, ZOMBIE_STATE as ST } from './zombies.js';
import { createNet } from './net.js';
import { Vega } from './vega.js';
import { Sfx } from './sfx.js';
import { TELEPORT_LOCATIONS, isTypingInField } from '../city-config.js';

// Dead City: three flying heroes against a city of fast, climbing, pinning zombies. Solo or co-op.

const TUNE = {
  survivor: { fly: 0, boost: 0, climb: 0, ground: 5.4, sprint: 7.6, accel: 10, turn: 2.6, grabDps: 5.5, pinAt: 2, regen: 0 },
  suit: { fly: 30, boost: 64, climb: 14, ground: 7.0, accel: 2.4, turn: 2.3, grabDps: 5.2, pinAt: 3, regen: 0 },
  paragon: { fly: 36, boost: 84, climb: 18, ground: 8.2, accel: 3.0, turn: 2.6, grabDps: 4.6, pinAt: 4, regen: 3.2 },
  coldfront: { fly: 26, boost: 44, climb: 11, ground: 7.4, accel: 3.4, turn: 2.8, grabDps: 5.2, pinAt: 3, regen: 0 }
};
const ENERGY_NAME = { survivor: 'Stamina', suit: 'Thrusters', paragon: 'Solar', coldfront: 'Cryo' };
const LIVES = 3;
const LIVES_AWAKENED = 2; // downs left after the Survivor wakes up with a power
const POWERS = ['suit', 'paragon', 'coldfront'];
const FLAG = { DOWN: 1, BEAM: 2, GROUND: 4, BOOST: 8, PINNED: 16, FLY: 32, SLAM: 64, PUNCH: 128, KICK: 256, PISTOL: 512 };
const FXT = { REPULSOR: 1, BOOM: 3, PULSE: 4, SLAM: 5, NOVA: 6, PUNCH: 7, KICK: 8, GUN: 9, PISTOL: 10 };
// the Survivor's guns
const GUNS = {
  m4: { name: 'M4', rate: 11, dmg: 26, mag: 30, reload: 2.3, spreadHip: 0.032, spreadAim: 0.009, knock: 2.5, flash: 0.17, range: 150, recoil: 0.007 },
  pistol: { name: 'Pistol', rate: 4.5, dmg: 34, mag: 15, reload: 1.5, spreadHip: 0.026, spreadAim: 0.011, knock: 3, flash: 0.12, range: 80, recoil: 0.018 }
};
const M4_RESERVE = 210;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _f = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _proj = new THREE.Vector3();
const num = (v) => (typeof v === 'number' ? v : v ? 1 : 0);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const $ = (id) => document.getElementById(id);

function createGame({ scene, controllers, cameraSystem, trafficSystem, audioSystem, onAllowTeleport }) {
  const world = createWorld(controllers);
  const fx = new FX(scene);
  const sfx = new Sfx();
  const vega = new Vega($('vega'));
  const net = createNet();
  const camera = cameraSystem.camera;
  const ent = controllers.entities.helicopter;
  ent.tiltPivot.visible = false;
  ent.hero = true;
  ent.chaseDistance = 6.2;
  ent.chaseHeight = 2.1;
  ent.cameraTargetOffset.set(0, 1.25, 0);

  const models = {};
  for (const kind of HERO_KINDS) {
    models[kind] = new HeroModel(kind);
    models[kind].root.visible = false;
    ent.mesh.add(models[kind].root);
  }
  const remoteGroup = new THREE.Group();
  remoteGroup.name = 'SquadHeroes';
  scene.add(remoteGroup);

  // ---------------------------------------------------------------------------------------------------------------
  // state
  let mode = 'title';
  let selected = 'survivor';
  try { selected = HERO_KINDS.includes(localStorage.getItem('dc-hero')) ? localStorage.getItem('dc-hero') : 'survivor'; } catch { /* storage off */ }
  let callsign = '';
  try { callsign = localStorage.getItem('dc-callsign') || ''; } catch { /* storage off */ }

  const H = {
    kind: selected, hp: 100, maxHp: 100, energy: 100, heat: 0, overheated: false,
    vx: 0, vy: 0, vz: 0, fspeed: 0, flying: true, gy: 0, grounded: false, stalled: false,
    grabbers: 0, pinned: false, struggle: 0, down: false, downT: 0, invuln: 0, regenDelay: 0,
    lives: LIVES, fireCd: 0, cd2: 0, cd3: 0, punchT: 0, kickT: 0, slamming: false, beaming: false, firing: false,
    kills: 0, time: 0, iceDist: 0, hurtT: 0, aim: new THREE.Vector3(0, 0, 1), target: null, streak: [], revivedBy: null
  };
  const me = { key: 'me', x: 0, y: 0, z: 0, vx: 0, vz: 0, speed: 0, heading: 0, down: false, dead: false, grounded: false, local: true };
  let threat = 1;
  let surgeT = 45;
  let shake = 0;
  let missiles = [];
  let chain = [];
  let chainCount = 0, chainClock = 0;
  const pendingHits = new Map(); // owner key -> Map(zid -> [dmg, kx, kz, ky, freeze])
  const outHits = {}; // owner key -> recent entries
  let hitSeq = 0;
  const fxOut = [];
  let fxSeq = 0;
  let rv = null;
  let rvSeq = 0;
  let rvClearT = 0;
  const remotes = new Map(); // peer -> squad member
  const lastHitSeq = new Map();
  const lastRv = new Map();
  let publishT = 0;
  let hudT = 0;
  let best = 0;
  try { best = Number(localStorage.getItem('dc-best')) || 0; } catch { /* storage off */ }

  // ---------------------------------------------------------------------------------------------------------------
  // zombies
  const zombies = new ZombieSystem({
    scene, controllers, world, fx,
    nodes: trafficSystem.network.nodes,
    peds: trafficSystem.peds,
    onKill: (zb, mine, shattered) => {
      if (mine) countKill(shattered);
      if (mine && H.kind === 'survivor' && Math.random() < 0.13) dropAmmo(zb.x, zb.y, zb.z);
      if (shattered) chain.push({ x: zb.x, y: zb.y + 1, z: zb.z, t: 0.07, depth: 0 });
    },
    onSound: (name, x, y, z) => {
      if (name === 'grab' || name === 'leap') sfx.play('scream', atten(x, y, z, 40));
      else if (name === 'shatter') sfx.play('shatter', atten(x, y, z, 80));
    }
  });

  function atten(x, y, z, range) {
    const d = Math.hypot(x - camera.position.x, y - camera.position.y, z - camera.position.z);
    return clamp(1 - d / range, 0, 1) ** 1.5;
  }

  function countKill(shattered) {
    H.kills++;
    H.streak.push(H.time);
    if (shattered) chainCount++;
  }

  // hits on a zombie from this device; remote ones are queued for their owner
  function sendHit(zb, dmg, kx, kz, ky, freeze) {
    let m = pendingHits.get(zb.owner);
    if (!m) pendingHits.set(zb.owner, (m = new Map()));
    const e = m.get(zb.id) || [0, 0, 0, 0, 0];
    e[0] += dmg; e[1] += kx; e[2] += kz; e[3] += ky; e[4] += freeze;
    m.set(zb.id, e);
  }

  function hitZombie(zb, dmg, kx = 0, kz = 0, ky = 0, freeze = 0) {
    const r = zombies.hit(zb, dmg, kx, kz, ky, freeze, sendHit);
    if (zb.remote && (r === 'kill' || r === 'shatter')) {
      countKill(r === 'shatter');
      if (H.kind === 'survivor' && Math.random() < 0.13) dropAmmo(zb.x, zb.y, zb.z);
      if (r === 'shatter') chain.push({ x: zb.x, y: zb.y + 1, z: zb.z, t: 0.07, depth: 0 });
    }
    return r;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // input: keyboard + mouse, gamepad, touch
  const input = { fireKey: false, mouseFire: false, touchFire: false, boostKey: false, touchBoost: false, a2: false, a3: false, mash: false, padFire: false, padBoost: false, mouseAim: false, padAim: false };
  window.addEventListener('keydown', (e) => {
    if (isTypingInField(e)) return;
    if (e.code === 'KeyF') input.fireKey = true;
    else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.boostKey = true;
    else if (e.code === 'KeyR' && !e.repeat) input.a2 = true;
    else if (e.code === 'KeyG' && !e.repeat) input.a3 = true;
    else if (e.code === 'Space' && !e.repeat) input.mash = true;
    else if (e.code === 'KeyK' && !e.repeat) vega.setEnabled(!vega.enabled);
    else if (e.code === 'Enter' && mode === 'awaken') choosePower(POWERS[awakenSel]);
    else if (e.code === 'Enter' && mode !== 'playing') deploy();
    else if (mode === 'awaken' && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) selectPower(awakenSel + (e.code === 'ArrowRight' ? 1 : -1));
    else if (mode === 'awaken' && /^Digit[123]$/.test(e.code)) selectPower(Number(e.code.slice(5)) - 1);
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyF') input.fireKey = false;
    else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.boostKey = false;
  });
  window.addEventListener('blur', () => { input.fireKey = input.boostKey = input.mouseFire = false; });
  const canvas = cameraSystem.domElement;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (e.button === 0) input.mouseFire = true;
    if (e.button === 2) input.mouseAim = true;
    // mouse look: lock the pointer to the game while playing
    if (mode === 'playing' && document.pointerLockElement !== canvas) {
      try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch { /* not allowed here */ }
    }
  });
  window.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (e.button === 0) input.mouseFire = false;
    if (e.button === 2) input.mouseAim = false;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas || mode !== 'playing') return;
    const sens = H.kind === 'survivor' && (input.mouseAim || input.padAim) ? 0.0013 : 0.0024;
    cameraSystem.orbitYawOffset -= e.movementX * sens;
    cameraSystem.orbitPitchOffset = clamp(cameraSystem.orbitPitchOffset + e.movementY * sens * 0.8, -0.32, cameraSystem.maxPitch?.() ?? 0.68);
    cameraSystem.userOrbitTimer = 4;
  });

  const holdButton = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); input[key] = true; el.setPointerCapture?.(e.pointerId); });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, () => { input[key] = false; });
  };
  holdButton('t-fire', 'touchFire');
  holdButton('t-boost', 'touchBoost');
  $('t-a2')?.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); input.a2 = true; });
  $('t-a3')?.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); input.a3 = true; input.mash = true; });

  const padPrev = [];
  let padState = '';
  function showPadState(state, id) {
    if (state === padState) return;
    padState = state;
    const el = $('pad-status');
    if (!el) return;
    el.classList.toggle('is-on', state === 'connected');
    el.textContent = state === 'connected' ? `Controller connected: ${String(id).replace(/\s*\(.*$/, '').slice(0, 40) || 'gamepad'}.`
      : state === 'blocked' ? 'This view blocks controllers. Keyboard and mouse still work here.'
        : 'Controller: press any button to connect it.';
  }
  function readPad() {
    let pad = null;
    let blocked = false;
    try {
      if (typeof navigator.getGamepads !== 'function') blocked = true;
      else for (const p of navigator.getGamepads() || []) if (p?.connected && p.mapping === 'standard') { pad = p; break; }
    } catch { blocked = true; }
    showPadState(blocked ? 'blocked' : pad ? 'connected' : 'none', pad?.id);
    if (!pad) { input.padFire = input.padBoost = input.padAim = false; return; }
    const b = (i) => pad.buttons[i]?.pressed || (pad.buttons[i]?.value || 0) > 0.35;
    const edge = (i) => b(i) && !padPrev[i];
    if (mode === 'playing' && H.kind === 'survivor') {
      // shooter layout: LT aims, RT fires, LB / L3 sprint, X reloads, Y swaps guns, B shoves
      input.padFire = (pad.buttons[7]?.value || 0) > 0.3;
      input.padAim = (pad.buttons[6]?.value || 0) > 0.3;
      input.padBoost = b(4) || b(10);
      if (edge(2)) input.a2 = true;
      if (edge(3) || edge(5)) input.a3 = true;
      if (edge(0)) input.mash = true;
    } else if (mode === 'playing') {
      input.padAim = false;
      input.padFire = (pad.buttons[7]?.value || 0) > 0.3;
      input.padBoost = (pad.buttons[6]?.value || 0) > 0.3 || b(10);
      if (edge(2) || edge(4)) input.a2 = true;
      if (edge(3) || edge(5)) input.a3 = true;
      if (edge(0)) input.mash = true;
    } else {
      input.padFire = input.padBoost = input.padAim = false;
      const ax = pad.axes?.[0] || 0;
      const left = edge(14) || (ax < -0.6 && !padPrev.stickL);
      const right = edge(15) || (ax > 0.6 && !padPrev.stickR);
      padPrev.stickL = ax < -0.6;
      padPrev.stickR = ax > 0.6;
      if (mode === 'title' && (left || right)) {
        const i = HERO_KINDS.indexOf(selected);
        selectHero(HERO_KINDS[(i + (right ? 1 : -1) + HERO_KINDS.length) % HERO_KINDS.length]);
      }
      if (mode === 'awaken') {
        if (left || right) selectPower(awakenSel + (right ? 1 : -1));
        if (edge(0) || edge(9)) choosePower(POWERS[awakenSel]);
      } else if (edge(0) || edge(9)) deploy();
      if (mode === 'over' && edge(3)) showTitle();
    }
    for (let i = 0; i < 17; i++) padPrev[i] = b(i);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // title & game over screens
  const titleEl = $('game-title');
  const overEl = $('game-over');
  const hudEl = $('game-hud');
  const callsignEl = $('callsign');
  if (callsignEl) {
    callsignEl.value = callsign;
    callsignEl.addEventListener('input', () => {
      callsign = callsignEl.value.replace(/[^\x20-\x7E]/g, '').slice(0, 16);
      try { localStorage.setItem('dc-callsign', callsign); } catch { /* storage off */ }
    });
  }
  document.querySelectorAll('[data-hero]').forEach((btn) => btn.addEventListener('click', () => selectHero(btn.dataset.hero)));
  $('deploy-btn')?.addEventListener('click', deploy);
  $('redeploy-btn')?.addEventListener('click', deploy);
  $('change-hero-btn')?.addEventListener('click', showTitle);

  function selectHero(kind) {
    selected = kind;
    try { localStorage.setItem('dc-hero', kind); } catch { /* storage off */ }
    document.querySelectorAll('[data-hero]').forEach((b) => {
      const on = b.dataset.hero === kind;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-pressed', String(on));
    });
    sfx.play('ui', 0.6);
  }
  selectHero(selected);

  function showTitle() {
    mode = 'title';
    titleEl.hidden = false;
    overEl.hidden = true;
    hudEl.hidden = true;
    document.body.classList.remove('is-playing');
    net.clear();
    onAllowTeleport?.(false);
  }

  // ---- death as the Survivor: something wakes up -------------------------------------------------------------------
  const awakenEl = $('awaken');
  let awakenSel = 0;
  document.querySelectorAll('[data-power]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = POWERS.indexOf(btn.dataset.power);
      if (i === awakenSel && mode === 'awaken') choosePower(POWERS[i]);
      else selectPower(i);
    });
  });
  $('awaken-btn')?.addEventListener('click', () => { if (mode === 'awaken') choosePower(POWERS[awakenSel]); });

  function selectPower(i) {
    awakenSel = (i + POWERS.length) % POWERS.length;
    document.querySelectorAll('[data-power]').forEach((b) => {
      const on = b.dataset.power === POWERS[awakenSel];
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-pressed', String(on));
    });
    sfx.play('ui', 0.6);
  }

  function awaken() {
    mode = 'awaken';
    sfx.setLoop('wind', 0);
    sfx.setLoop('thrust', 0);
    try { document.exitPointerLock?.(); } catch { /* not locked */ }
    const place = $('awaken-place');
    if (place) place.textContent = (document.querySelector('#hud-location .street-sign')?.textContent || 'Manhattan') + ` · ${fmtTime(H.time)} survived · ${H.kills} kills`;
    selectPower(awakenSel);
    hudEl.hidden = true;
    awakenEl.hidden = false;
  }

  function choosePower(kind) {
    if (mode !== 'awaken' || !POWERS.includes(kind)) return;
    const info = HERO_INFO[kind];
    Object.assign(H, {
      kind, hp: info.maxHp, maxHp: info.maxHp, energy: 100, heat: 0, overheated: false, down: false, downT: 0,
      invuln: 4, lives: LIVES_AWAKENED, maxLives: LIVES_AWAKENED, awakened: true, stalled: false, grabbers: 0,
      pinned: false, struggle: 0, fireCd: 0, cd2: 0, cd3: 0, reloadT: 0, aiming: false, beaming: false
    });
    for (const k of HERO_KINDS) models[k].root.visible = k === kind;
    setCameraFor(kind);
    cameraSystem.zoomMultiplier = 1;
    awakenEl.hidden = true;
    hudEl.hidden = false;
    mode = 'playing';
    buildAbilityHud();
    // the awakening throws back everything around the body
    const p = ent.position;
    const color = kind === 'suit' ? 0x9ff4ff : kind === 'paragon' ? 0xffd28a : 0xbfe9ff;
    forEachNear(p.x, p.y + 1, p.z, 13, (zb, d, dx, dz) => {
      const l = Math.hypot(dx, dz) || 1;
      const k = 1 - d / 15;
      hitZombie(zb, 240 * k, dx / l * 22 * k, dz / l * 22 * k, 9 * k, kind === 'coldfront' ? 1.5 : 0);
    });
    fx.ring(_b.set(p.x, p.y, p.z), color, 14, 0.8, 5);
    fx.flash(_b.set(p.x, p.y + 1, p.z), color, 2.2, 0.4, 6, 2.5);
    fx.burst(_b, color, 50, 16, { glowing: true, size: 0.06, life: 0.7, gravity: 2 });
    sfx.play(kind === 'coldfront' ? 'nova' : 'slam', 1);
    shake = Math.max(shake, 0.9);
    // flyers rise out of the crowd
    H.flying = true;
    H.vy = 10;
    p.y += 0.3;
    vega.say(kind === 'suit' ? 'awakenSuit' : kind === 'paragon' ? 'awakenParagon' : 'awakenCold', {}, { cooldown: 2, priority: 2 });
  }

  function heroName() {
    return callsign.trim() || HERO_INFO[H.kind].name;
  }

  let revealed = false;
  function deploy() {
    if (mode === 'playing' || !revealed) return;
    sfx.start();
    audioSystem?.setEnabled?.(true);
    const kind = selected;
    const info = HERO_INFO[kind];
    Object.assign(H, {
      kind, hp: info.maxHp, maxHp: info.maxHp, energy: 100, heat: 0, overheated: false,
      vx: 0, vy: 0, vz: 0, fspeed: 0, flying: false, stalled: false, grabbers: 0, pinned: false, struggle: 0,
      down: false, downT: 0, invuln: 3, regenDelay: 0, lives: kind === 'survivor' ? 1 : LIVES, maxLives: kind === 'survivor' ? 1 : LIVES, awakened: false, fireCd: 0, cd2: 0, cd3: 0, punchT: 0, kickT: 0,
      slamming: false, beaming: false, kills: 0, time: 0, streak: [],
      weapon: 'm4', mag: { m4: GUNS.m4.mag, pistol: GUNS.pistol.mag }, reserve: M4_RESERVE, reloadT: 0, aiming: false,
      shoveCd: 0, prevDown: false, raiseT: 0, sprintLock: false
    });
    for (const k of HERO_KINDS) models[k].root.visible = k === kind;
    models.survivor.setWeapon('m4');
    setCameraFor(kind);
    for (const pk of pickups) pk.mesh.visible = false;
    pickups.length = 0;
    ent.label = heroName();
    threat = 1;
    zombies.setThreat(threat);
    surgeT = 50;
    zombies.clear();
    for (const m of missiles) fx.releaseMissile(m.mesh);
    missiles = [];
    // drop in near a partner if there is one, otherwise at Times Square: heroes on a rooftop, the Survivor in the street
    const partner = [...remotes.values()].find((r) => !r.down);
    const at = partner ? { x: partner.x, z: partner.z } : TELEPORT_LOCATIONS.timessq;
    if (kind === 'survivor') placeOnStreet(at.x, at.z);
    else placeOnRoof(at.x, at.z);
    mode = 'playing';
    titleEl.hidden = true;
    overEl.hidden = true;
    hudEl.hidden = false;
    document.body.classList.add('is-playing');
    onAllowTeleport?.(false);
    // a first wave close by, so the fight starts at once
    const firstWave = kind === 'survivor' ? 12 : 26;
    for (let i = 0; i < firstWave; i++) zombies.spawnNear(ent.position.x, ent.position.z, kind === 'survivor' ? 45 : 25, 100, camera);
    if (partner) vega.say('deploySquad', { name: partner.name }, { cooldown: 5, priority: 2 });
    else vega.say(kind === 'survivor' ? 'deploySurvivor' : 'deploy', {}, { cooldown: 5, priority: 2 });
    buildAbilityHud();
  }

  function gameOver() {
    mode = 'over';
    H.down = true;
    me.dead = true;
    vega.say('gameOver', {}, { cooldown: 1, priority: 2 });
    const t = H.time;
    if (t > best) {
      best = t;
      try { localStorage.setItem('dc-best', String(Math.round(best))); } catch { /* storage off */ }
    }
    $('go-time').textContent = fmtTime(t);
    $('go-kills').textContent = String(H.kills);
    $('go-threat').textContent = String(threat);
    $('go-best').textContent = fmtTime(best);
    $('go-civ').textContent = String(zombies.infected);
    overEl.hidden = false;
    hudEl.hidden = true;
    document.body.classList.remove('is-playing');
    net.clear();
  }

  function fmtTime(t) {
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // rooftops
  function findRoof(cx, cz, radius = 140, minH = 18, maxH = 95) {
    const list = controllers.nearColliders(cx, cz, radius).slice();
    const options = [];
    for (const c of list) {
      if (c.maxY < minH || c.maxY > maxH || (c.minY ?? 0) > 1) continue;
      const w = c.obb ? c.obb.hx * 2 : c.maxX - c.minX;
      const d = c.obb ? c.obb.hz * 2 : c.maxZ - c.minZ;
      if (w < 9 || d < 9) continue;
      const x = c.obb ? c.obb.cx : (c.minX + c.maxX) / 2;
      const z = c.obb ? c.obb.cz : (c.minZ + c.maxZ) / 2;
      const y = world.roofAt(x, z, c.maxY + 0.5);
      if (Math.abs(y - c.maxY) > 0.6) continue;
      let covered = false;
      for (const o of controllers.nearColliders(x, z, 0)) {
        if (o.maxY > c.maxY + 0.5 && (o.minY ?? 0) < c.maxY + 3 && world.inside(o, x, z)) { covered = true; break; }
      }
      if (covered) continue;
      options.push({ x, y, z, d: Math.hypot(x - cx, z - cz) });
    }
    options.sort((a, b) => a.d - b.d);
    return options[Math.floor(Math.random() * Math.min(6, options.length))] || null;
  }

  // the Survivor arrives at street level, at the nearest clear intersection
  function placeOnStreet(x, z) {
    let best = null, bd = Infinity;
    for (const n of zombies.nodes) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bd && world.clear(n.x, n.z, 0.8)) { bd = d; best = n; }
    }
    const p = ent.position;
    const sx = best ? best.x : x, sz = best ? best.z : z;
    p.set(sx, world.roofAt(sx, sz, 1), sz);
    H.flying = false;
    H.vx = H.vy = H.vz = H.fspeed = 0;
    ent.speed = 0;
    cameraSystem.resetForTeleport?.();
  }

  function setCameraFor(kind) {
    if (kind === 'survivor') {
      ent.chaseDistance = 3.4;
      ent.chaseHeight = 1.7;
      ent.cameraTargetOffset.set(0, 1.45, 0);
    } else {
      ent.chaseDistance = 6.2;
      ent.chaseHeight = 2.1;
      ent.cameraTargetOffset.set(0, 1.25, 0);
    }
  }

  function placeOnRoof(x, z) {
    const r = findRoof(x, z);
    const p = ent.position;
    if (r) {
      p.set(r.x, r.y, r.z);
      H.flying = false;
    } else {
      p.set(x, 45, z);
      H.flying = true;
    }
    H.vx = H.vy = H.vz = H.fspeed = 0;
    ent.speed = 0;
    cameraSystem.resetForTeleport?.();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // hero physics (runs inside the controller update, in place of the helicopter)
  controllers.updateHelicopter = (dt) => {
    const p = ent.position;
    const T = TUNE[H.kind];
    const k = controllers.keys;
    if (mode !== 'playing') {
      ent.speed = 0;
      ent.verticalSpeed = 0;
      return;
    }
    if (H.kind === 'survivor') {
      survivorMove(dt);
      return;
    }
    const fwd = num(k.forward) - num(k.backward);
    const turn = num(k.left) - num(k.right);
    const up = num(k.up), down = num(k.down);
    const boost = input.boostKey || input.touchBoost || input.padBoost;
    const canMove = !H.down && !H.pinned;
    H.boosting = boost && canMove && (H.flying || H.grounded);

    if (canMove) ent.heading += turn * T.turn * dt * (H.flying ? 1 : 1.25);
    const sn = Math.sin(ent.heading), cs = Math.cos(ent.heading);
    H.gy = world.roofAt(p.x, p.z, p.y + 0.3);
    const onGround = p.y <= H.gy + 0.06;
    const needsEnergy = H.kind !== 'paragon';
    if (H.stalled && H.energy >= 25) H.stalled = false;
    const canFly = !H.down && !H.pinned && (!needsEnergy || (!H.stalled && H.energy > 4));

    if (H.down) {
      H.flying = false;
      H.fspeed *= Math.exp(-dt * 6);
      H.vy = onGround ? 0 : H.vy - 24 * dt;
    } else if (H.slamming) {
      H.vy = -78;
      H.fspeed *= Math.exp(-dt * 2);
    } else if (H.flying) {
      if (needsEnergy) {
        const speedN = Math.abs(H.fspeed) / T.fly;
        const drain = (H.kind === 'suit' ? 1.7 : 2.3) + speedN * 3 + (boost ? 12 : 0) + (up > 0 ? 3 : 0) + H.grabbers * 6;
        H.energy -= drain * dt;
        if (H.energy <= 0) {
          H.energy = 0;
          H.flying = false;
          H.stalled = true;
          vega.say(H.kind === 'suit' ? 'energyOut' : 'coldOut', {}, { cooldown: 12, priority: 2 });
          sfx.play('alarm', 1);
        }
      }
      const maxH = boost ? T.boost : T.fly;
      const want = fwd * maxH * (fwd < 0 ? 0.45 : 1);
      H.fspeed += (want - H.fspeed) * (1 - Math.exp(-dt * T.accel * (boost ? 1.5 : 1)));
      const vyWant = (up - down) * T.climb * (boost ? 1.4 : 1);
      H.vy += (vyWant - H.vy) * (1 - Math.exp(-dt * 4));
      H.vy -= H.grabbers * 5 * dt;
      if (onGround && H.vy <= 0.5 && (down > 0 || H.fspeed < 4)) {
        H.flying = false;
        H.vy = 0;
      }
    } else if (onGround) {
      H.vy = 0;
      const run = T.ground * (boost ? 1.3 : 1);
      const want = canMove ? fwd * run * (fwd < 0 ? 0.5 : 1) : 0;
      H.fspeed += (want - H.fspeed) * (1 - Math.exp(-dt * 8));
      if (needsEnergy) H.energy = Math.min(100, H.energy + (H.kind === 'suit' ? 15 : 17) * dt);
      if (up > 0 && canFly) {
        H.flying = true;
        H.vy = 8;
      }
    } else {
      H.vy -= 24 * dt;
      if (up > 0 && canFly && H.energy > 12) H.flying = true;
    }
    if (H.kind === 'paragon') H.energy = Math.min(100, H.energy + 7 * dt);

    H.vx = sn * H.fspeed;
    H.vz = cs * H.fspeed;
    p.x += H.vx * dt;
    p.z += H.vz * dt;
    p.y += H.vy * dt;
    world.push(p, 0.45, 1.9, null);
    H.gy = world.roofAt(p.x, p.z, p.y + 0.35);
    if (p.y <= H.gy) {
      const impact = -H.vy;
      p.y = H.gy;
      if (H.slamming) {
        H.slamming = false;
        slamImpact(14, 160, 20);
      } else if (!H.flying && impact > 26 && H.kind !== 'paragon') {
        hurt((impact - 26) * 2.4, true);
      }
      if (H.vy < 0) H.vy = 0;
    }
    p.y = Math.min(p.y, 460);
    H.grounded = p.y <= H.gy + 0.06 && !H.flying;
    ent.speed = Math.hypot(H.vx, H.vz);
    ent.verticalSpeed = H.vy;
    ent.label = heroName();

    // Coldfront leaves a trail of ice behind his board
    if (H.kind === 'coldfront' && H.flying) {
      H.iceDist += ent.speed * dt + Math.abs(H.vy) * dt;
      if (H.iceDist > 0.85) {
        H.iceDist = 0;
        fx.iceSegment(p.x, p.y - 0.02, p.z, ent.heading, 4.5);
      }
    }
  };

  // On foot: the camera turns the Survivor (mouse or right stick), the left stick walks and strafes.
  let jumpLatch = false;
  function survivorMove(dt) {
    const p = ent.position;
    const T = TUNE.survivor;
    const k = controllers.keys;
    const canMove = !H.down && !H.pinned;
    // heading follows the camera
    if (canMove) ent.heading += cameraSystem.orbitYawOffset;
    cameraSystem.orbitYawOffset = 0;
    const fwd = num(k.forward) - num(k.backward);
    const strafe = num(k.left) - num(k.right);
    const sn = Math.sin(ent.heading), cs = Math.cos(ent.heading);
    H.aiming = !H.down && (input.mouseAim || input.padAim);
    const wantSprint = (input.boostKey || input.touchBoost || input.padBoost) && fwd > 0.3 && !H.aiming;
    if (H.energy <= 1) H.sprintLock = true;
    if (H.sprintLock && H.energy > 30) H.sprintLock = false;
    const sprinting = canMove && wantSprint && !H.sprintLock && H.reloadT <= 0.3;
    H.boosting = sprinting;
    H.energy = sprinting ? Math.max(0, H.energy - 21 * dt) : Math.min(100, H.energy + 15 * dt);
    const speed = !canMove ? 0 : sprinting ? T.sprint : H.aiming ? 2.7 : T.ground;
    let wx = sn * fwd + cs * strafe * 0.9;
    let wz = cs * fwd - sn * strafe * 0.9;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    H.gy = world.roofAt(p.x, p.z, p.y + 0.35);
    const grounded = p.y <= H.gy + 0.06 && H.vy <= 0.01;
    const kAcc = 1 - Math.exp(-dt * (grounded ? T.accel : 1.5));
    H.vx += (wx * speed - H.vx) * kAcc;
    H.vz += (wz * speed - H.vz) * kAcc;
    // jump
    const up = num(k.up) > 0.5;
    if (up && !jumpLatch && grounded && canMove) {
      H.vy = 5.6;
      jumpLatch = true;
    }
    if (!up) jumpLatch = false;
    if (!grounded || H.vy > 0) H.vy -= 22 * dt;
    p.x += H.vx * dt;
    p.z += H.vz * dt;
    p.y += H.vy * dt;
    world.push(p, 0.35, 1.8, null);
    H.gy = world.roofAt(p.x, p.z, p.y + 0.35);
    if (p.y <= H.gy) {
      const impact = -H.vy;
      p.y = H.gy;
      if (impact > 11) hurt((impact - 11) * 7, true);
      if (H.vy < 0) H.vy = 0;
    }
    H.flying = false;
    H.grounded = p.y <= H.gy + 0.06;
    H.fspeed = H.vx * sn + H.vz * cs;
    ent.speed = Math.hypot(H.vx, H.vz);
    ent.verticalSpeed = H.vy;
    ent.label = heroName();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // targeting
  const cands = [];
  function pickTarget(origin, dir, range, coneCos) {
    cands.length = 0;
    zombies.forEachLive((zb) => {
      if (zb.state === ST.RISE && zb.t < 1.6) return;
      const dx = zb.x - origin.x, dy = zb.y + 1.2 - origin.y, dz = zb.z - origin.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > range || d < 0.5) return;
      const c = (dx * dir.x + dy * dir.y + dz * dir.z) / d;
      if (c < coneCos) return;
      cands.push([(1 - c) * 600 + d * 0.35, zb]);
    });
    cands.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < Math.min(4, cands.length); i++) {
      const zb = cands[i][1];
      if (world.lineOfSight(origin.x, origin.y, origin.z, zb.x, zb.y + 1.2, zb.z)) return zb;
    }
    return null;
  }

  function aimDir(out) {
    return camera.getWorldDirection(out).normalize();
  }

  function pushFx(type, a, b = a) {
    fxSeq++;
    fxOut.push([fxSeq, type, Math.round(a.x * 10), Math.round(a.y * 10), Math.round(a.z * 10), Math.round(b.x * 10), Math.round(b.y * 10), Math.round(b.z * 10)]);
    if (fxOut.length > 6) fxOut.shift();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // abilities
  function chest(out) {
    return out.set(ent.position.x, ent.position.y + 1.35, ent.position.z);
  }

  function forEachNear(cx, cy, cz, radius, fn) {
    zombies.each(cx, cy, cz, radius, fn);
  }

  function repulsor(target, dir) {
    if (H.fireCd > 0 || H.energy < 2) return;
    H.fireCd = 0.21;
    H.energy -= 2.2;
    const model = models.suit;
    const from = model.muzzle(_a);
    let to;
    if (target) {
      to = _b.set(target.x, target.y + 1.2, target.z);
      _c.subVectors(to, from).normalize();
      hitZombie(target, 36, _c.x * 7, _c.z * 7, 1.5);
      forEachNear(to.x, to.y, to.z, 1.6, (zb) => { if (zb !== target) hitZombie(zb, 14, _c.x * 4, _c.z * 4, 1); });
    } else {
      const t = world.rayHit(from.x, from.y, from.z, dir.x, dir.y, dir.z, 120, _hit);
      to = t ? _b.copy(_hit) : _b.copy(from).addScaledVector(dir, 120);
    }
    fx.beam(from, to, 0x9ff4ff, 0.05, 0.1, 7);
    fx.flash(from, 0x9ff4ff, 0.14, 0.08, 6);
    fx.flash(to, 0x9ff4ff, 0.4, 0.16, 5);
    fx.burst(to, 0xbff8ff, 6, 6, { glowing: true, size: 0.04, life: 0.3, gravity: 4 });
    sfx.play('repulsor', 0.9);
    pushFx(FXT.REPULSOR, from, to);
  }

  function startReload() {
    const W = GUNS[H.weapon];
    if (H.reloadT > 0 || H.mag[H.weapon] >= W.mag) return;
    if (H.weapon === 'm4' && H.reserve <= 0) {
      vega.say('noAmmo', {}, { cooldown: 12 });
      return;
    }
    H.reloadT = W.reload;
    sfx.play('reload', 0.9);
  }

  function finishReload() {
    const W = GUNS[H.weapon];
    const need = W.mag - H.mag[H.weapon];
    if (H.weapon === 'm4') {
      const take = Math.min(need, H.reserve);
      H.reserve -= take;
      H.mag.m4 += take;
    } else H.mag.pistol = W.mag;
  }

  function switchGun() {
    H.weapon = H.weapon === 'm4' ? 'pistol' : 'm4';
    H.reloadT = 0;
    H.fireCd = 0.35;
    models.survivor.setWeapon(H.weapon);
    sfx.play('reload', 0.5);
  }

  function shoot(target, dir) {
    const W = GUNS[H.weapon];
    if (H.reloadT > 0 || H.fireCd > 0) return;
    if (H.mag[H.weapon] <= 0) {
      sfx.play('empty', 0.8);
      H.fireCd = 0.25;
      startReload();
      return;
    }
    H.fireCd = 1 / W.rate;
    H.mag[H.weapon]--;
    H.raiseT = 1.2;
    const from = models.survivor.muzzle(_a);
    const moving = ent.speed > 3 ? 0.02 : 0;
    const spread = (H.aiming ? W.spreadAim : W.spreadHip) + moving;
    let to = null;
    if (target) {
      const tx = target.x, ty = target.y + 1.2, tz = target.z;
      const d = Math.hypot(tx - from.x, ty - from.y, tz - from.z);
      if (Math.random() < 0.5 / (0.5 + spread * d)) {
        const head = H.aiming && Math.random() < 0.3;
        to = _b.set(tx + (Math.random() - 0.5) * 0.2, head ? target.y + 1.62 : ty + (Math.random() - 0.5) * 0.4, tz + (Math.random() - 0.5) * 0.2);
        hitZombie(target, W.dmg * (head ? 2.3 : 1), dir.x * W.knock, dir.z * W.knock, 0.4);
        if (head) fx.burst(to, 0x3d0605, 6, 4, { size: 0.03, life: 0.5, gravity: 12 });
      }
    }
    if (!to) {
      _c.copy(dir);
      _c.x += (Math.random() - 0.5) * spread * 2;
      _c.y += (Math.random() - 0.5) * spread * 2;
      _c.z += (Math.random() - 0.5) * spread * 2;
      _c.normalize();
      const t = world.rayHit(from.x, from.y, from.z, _c.x, _c.y, _c.z, W.range, _hit);
      to = t ? _b.copy(_hit) : _b.copy(from).addScaledVector(_c, W.range);
      if (t) fx.burst(to, 0xcfc6b8, 3, 3, { size: 0.025, life: 0.35, gravity: 9 });
    }
    gunFx(from, to, H.weapon);
    // ejected brass
    fx.burst(_d.copy(from).addScaledVector(dir, -0.35), 0xc9a24a, 1, 2.5, { size: 0.012, life: 0.7, gravity: 14, up: 1.2 });
    sfx.play(H.weapon === 'm4' ? 'm4' : 'pistol', 1);
    pushFx(H.weapon === 'm4' ? FXT.GUN : FXT.PISTOL, from, to);
    // recoil nudges the view up
    cameraSystem.orbitPitchOffset = Math.max(-0.32, cameraSystem.orbitPitchOffset - W.recoil * (H.aiming ? 0.6 : 1));
    shake = Math.max(shake, H.weapon === 'm4' ? 0.03 : 0.05);
  }

  function gunFx(from, to, weapon) {
    fx.beam(from, to, 0xffe2a0, 0.011, 0.045, 7);
    fx.flash(from, 0xffc45c, GUNS[weapon].flash, 0.05, 7, 0.5);
    fx.burst(from, 0xffd27a, 2, 3, { glowing: true, size: 0.025, life: 0.08, gravity: 0 });
  }

  // shove: a short push that buys a second when they get close
  function shove() {
    if (H.shoveCd > 0) return;
    H.shoveCd = 1.1;
    H.punchT = 0.25;
    const n = melee(2.3, 8, 10, 0.2, FXT.PUNCH);
    H.struggle += 0.45;
    return n;
  }

  // ammo boxes some of the dead leave behind
  const pickups = [];
  const pickupGeo = new THREE.BoxGeometry(0.42, 0.22, 0.28);
  const pickupMat = new THREE.MeshStandardNodeMaterial({ color: 0x4d5534, roughness: 0.7, metalness: 0.1, emissive: 0xffc94a, emissiveIntensity: 0.35 });
  function dropAmmo(x, y, z) {
    if (pickups.length >= 10) return;
    const m = new THREE.Mesh(pickupGeo, pickupMat);
    m.castShadow = true;
    m.position.set(x, y + 0.2, z);
    fx.group.add(m);
    pickups.push({ mesh: m, x, y, z, t: 0 });
  }
  function updatePickups(dt) {
    const p = ent.position;
    let w = 0;
    for (const pk of pickups) {
      pk.t += dt;
      pk.mesh.rotation.y += dt * 1.5;
      pk.mesh.position.y = pk.y + 0.25 + Math.sin(pk.t * 3) * 0.06;
      const near = Math.hypot(pk.x - p.x, pk.z - p.z) < 1.4 && Math.abs(pk.y - p.y) < 1.5;
      if ((near && H.kind === 'survivor' && !H.down) || pk.t > 40) {
        if (near) {
          H.reserve = Math.min(300, H.reserve + 30);
          sfx.play('ui', 1);
          vega.say('ammo', {}, { cooldown: 20 });
        }
        fx.group.remove(pk.mesh);
        continue;
      }
      pickups[w++] = pk;
    }
    pickups.length = w;
  }

  function launchMissiles(dir) {
    if (H.cd2 > 0 || H.energy < 18) return false;
    H.cd2 = 8;
    H.energy -= 18;
    const origin = chest(_a);
    cands.length = 0;
    zombies.forEachLive((zb) => {
      const dx = zb.x - origin.x, dy = zb.y + 1 - origin.y, dz = zb.z - origin.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 140 || d < 3) return;
      const c = (dx * dir.x + dy * dir.y + dz * dir.z) / d;
      if (c < 0.45) return;
      cands.push([(1 - c) * 200 + d * 0.3, zb]);
    });
    cands.sort((a, b) => a[0] - b[0]);
    const targets = cands.slice(0, 6).map((c) => c[1]);
    for (let i = 0; i < 6; i++) {
      const m = fx.takeMissile();
      const side = i % 2 ? 1 : -1;
      const pos = new THREE.Vector3(ent.position.x, ent.position.y + 1.55, ent.position.z);
      pos.x -= Math.sin(ent.heading) * 0.25;
      pos.z -= Math.cos(ent.heading) * 0.25;
      const vel = new THREE.Vector3(dir.x * 14 + Math.cos(ent.heading) * side * (4 + i), 7 + i * 1.2, dir.z * 14 - Math.sin(ent.heading) * side * (4 + i));
      missiles.push({ mesh: m, pos, vel, target: targets.length ? targets[i % targets.length] : null, dir: dir.clone(), t: -i * 0.06 });
    }
    sfx.play('missile', 1);
    return true;
  }

  function updateMissiles(dt) {
    let w = 0;
    for (const m of missiles) {
      m.t += dt;
      if (m.t < 0) { m.mesh.mesh.visible = false; missiles[w++] = m; continue; }
      m.mesh.mesh.visible = true;
      const tgt = m.target && m.target.state !== ST.DEAD && !m.target.predDead ? m.target : null;
      const goal = tgt ? _a.set(tgt.x, tgt.y + 1, tgt.z) : _a.copy(m.pos).addScaledVector(m.dir, 30);
      const speed = Math.min(78, 18 + m.t * 70);
      _b.subVectors(goal, m.pos).normalize().multiplyScalar(speed);
      const steer = m.t < 0.25 ? 1.5 : 7;
      m.vel.lerp(_b, 1 - Math.exp(-dt * steer));
      _c.copy(m.pos);
      m.pos.addScaledVector(m.vel, dt);
      m.mesh.mesh.position.copy(m.pos);
      m.mesh.mesh.lookAt(_d.copy(m.pos).add(m.vel));
      fx.burst(m.pos, 0x6b6e73, 1, 0.6, { size: 0.14, life: 0.6, gravity: -1, up: 0.2 });
      fx.burst(m.pos, 0xffb070, 1, 1, { glowing: true, size: 0.07, life: 0.12, gravity: 0 });
      let boom = m.t > 4.5;
      if (tgt && m.pos.distanceTo(goal) < 1.4) boom = true;
      if (!boom && m.t > 0.15) {
        const len = _c.distanceTo(m.pos);
        _d.subVectors(m.pos, _c).normalize();
        if (world.rayHit(_c.x, _c.y, _c.z, _d.x, _d.y, _d.z, len + 0.3, _hit) !== null) { boom = true; m.pos.copy(_hit); }
      }
      if (boom) {
        explode(m.pos.clone(), 6.5, 130);
        fx.releaseMissile(m.mesh);
        continue;
      }
      missiles[w++] = m;
    }
    missiles.length = w;
  }

  function explode(pos, radius, dmg, local = true) {
    fx.flash(pos, 0xffa040, 1.6, 0.32, 7, 2.2);
    fx.flash(pos, 0xffffff, 0.7, 0.12, 8, 1);
    fx.ring(pos, 0xffa050, radius * 1.1, 0.5, 3);
    fx.burst(pos, 0xff9a40, 26, 16, { glowing: true, size: 0.08, life: 0.5, gravity: 10 });
    fx.burst(pos, 0x3c3a38, 14, 8, { size: 0.22, life: 1.4, gravity: -1.5, up: 1 });
    sfx.play('boom', atten(pos.x, pos.y, pos.z, 260));
    shake = Math.max(shake, clamp(1 - pos.distanceTo(ent.position) / 60, 0, 1) * 0.5);
    if (!local) return;
    forEachNear(pos.x, pos.y, pos.z, radius, (zb, d, dx, dz) => {
      const l = Math.hypot(dx, dz) || 1;
      const k = 1 - d / (radius * 1.15);
      hitZombie(zb, dmg * k, dx / l * 15 * k, dz / l * 15 * k, 8 * k);
    });
    pushFx(FXT.BOOM, pos);
  }

  function shockPulse() {
    if (H.cd3 > 0 || H.energy < 22) return false;
    H.cd3 = 3.5;
    H.energy -= 22;
    const c = chest(_a);
    forEachNear(c.x, c.y, c.z, 8.5, (zb, d, dx, dz) => {
      const l = Math.hypot(dx, dz) || 1;
      hitZombie(zb, 50 * (1 - d / 12), dx / l * 17, dz / l * 17, 6);
    });
    pulseFx(c, 0x9ff4ff, 9.5);
    pushFx(FXT.PULSE, c);
    H.struggle = 0;
    return true;
  }

  function pulseFx(c, color, r) {
    fx.ring(_b.set(c.x, ent.position.y, c.z), color, r, 0.45, 5);
    fx.flash(c, color, 1.1, 0.2, 5, 2.5);
    fx.burst(c, color, 20, 12, { glowing: true, size: 0.05, life: 0.35, gravity: 2 });
    sfx.play('pulse', 1);
  }

  function heatVision(target, dir, dt) {
    const model = models.paragon;
    const from = model.muzzle(_a);
    let to;
    if (target) {
      to = _b.set(target.x, target.y + 1.25, target.z);
      _c.subVectors(to, from).normalize();
      hitZombie(target, 150 * dt, _c.x * 0.8, _c.z * 0.8, 0);
      forEachNear(to.x, to.y, to.z, 1.7, (zb) => { if (zb !== target) hitZombie(zb, 35 * dt); });
    } else {
      const t = world.rayHit(from.x, from.y, from.z, dir.x, dir.y, dir.z, 90, _hit);
      to = t ? _b.copy(_hit) : _b.copy(from).addScaledVector(dir, 90);
    }
    drawHeat(from, to, ent.heading);
    H.aim.subVectors(to, from).normalize();
  }

  function drawHeat(from, to, heading) {
    const ox = Math.cos(heading) * 0.035, oz = -Math.sin(heading) * 0.035;
    for (const s of [1, -1]) {
      _c.set(from.x + ox * s, from.y, from.z + oz * s);
      fx.beam(_c, to, 0xff3b22, 0.022, 0.05, 9);
    }
    fx.flash(to, 0xff5a2a, 0.3, 0.06, 6, 0.5);
    if (Math.random() < 0.5) fx.burst(to, 0xff7a30, 2, 5, { glowing: true, size: 0.04, life: 0.3, gravity: 6 });
  }

  function slamImpact(radius, dmg, knock) {
    const p = ent.position;
    forEachNear(p.x, p.y + 1, p.z, radius, (zb, d, dx, dz) => {
      const l = Math.hypot(dx, dz) || 1;
      const k = 1 - d / (radius * 1.1);
      hitZombie(zb, dmg * k, dx / l * knock * k, dz / l * knock * k, 9 * k);
    });
    fx.ring(_b.set(p.x, p.y, p.z), 0xffd28a, radius, 0.6, 4);
    fx.flash(_b.set(p.x, p.y + 0.5, p.z), 0xffe0b0, 1.8, 0.25, 4, 2);
    fx.burst(_b, 0x6d655c, 30, 12, { size: 0.16, life: 1.2, gravity: 14, up: 1.2 });
    sfx.play('slam', 1);
    shake = Math.max(shake, 0.8);
    pushFx(FXT.SLAM, _b.set(p.x, p.y, p.z));
    H.struggle = 0;
  }

  function skySlam() {
    if (H.cd2 > 0 || H.energy < 18) return false;
    const air = ent.position.y - H.gy;
    if (air > 3) {
      if (H.energy < 30) return false;
      H.energy -= 30;
      H.cd2 = 6;
      H.slamming = true;
      H.flying = false;
    } else {
      H.energy -= 18;
      H.cd2 = 4;
      slamImpact(7, 80, 13);
    }
    return true;
  }

  // melee cone in front (or all around while pinned)
  function melee(range, dmg, knock, arc, fxType) {
    const p = ent.position;
    const fx0 = Math.sin(ent.heading), fz0 = Math.cos(ent.heading);
    const around = H.grabbers > 0;
    let n = 0;
    forEachNear(p.x, p.y + 1, p.z, range, (zb, d, dx, dz) => {
      const l = Math.hypot(dx, dz) || 1;
      const inArc = (dx * fx0 + dz * fz0) / l > arc;
      if (!inArc && !(around && d < 1.9)) return;
      hitZombie(zb, dmg, dx / l * knock, dz / l * knock, 6);
      n++;
    });
    const hand = _b.set(p.x + fx0 * 0.9, p.y + 1.3, p.z + fz0 * 0.9);
    fx.flash(hand, 0xffffff, 0.3, 0.09, 4, 2);
    if (n) fx.burst(hand, 0xffffff, 8, 7, { glowing: true, size: 0.04, life: 0.25, gravity: 3 });
    sfx.play('punch', n ? 1 : 0.4);
    pushFx(fxType, hand);
    if (around) H.struggle = 0;
    if (H.grounded) H.fspeed += 3;
    return n;
  }

  function freezeRay(target, dir, dt) {
    const model = models.coldfront;
    const from = model.muzzle(_a);
    _c.copy(target ? _d.set(target.x, target.y + 1.2, target.z).sub(from).normalize() : dir);
    const t = world.rayHit(from.x, from.y, from.z, _c.x, _c.y, _c.z, 42, _hit);
    const range = t ?? 42;
    const to = _b.copy(from).addScaledVector(_c, range);
    // everything within a narrow cone along the beam gets colder
    zombies.forEachLive((zb) => {
      if (zb.state === ST.FROZEN) return;
      const dx = zb.x - from.x, dy = zb.y + 1 - from.y, dz = zb.z - from.z;
      const along = dx * _c.x + dy * _c.y + dz * _c.z;
      if (along < 0 || along > range + 1) return;
      const px = dx - _c.x * along, py = dy - _c.y * along, pz = dz - _c.z * along;
      if (Math.hypot(px, py * 0.6, pz) > 1.1 + along * 0.05) return;
      hitZombie(zb, 0, 0, 0, 0, 2.6 * dt);
    });
    drawFreeze(from, to);
    H.aim.copy(_c);
    H.energy -= 8 * dt;
  }

  function drawFreeze(from, to) {
    fx.beam(from, to, 0xbfe9ff, 0.07 + Math.random() * 0.03, 0.05, 3.2);
    fx.beam(from, to, 0xffffff, 0.022, 0.05, 6);
    if (Math.random() < 0.7) {
      const k = Math.random();
      _d.lerpVectors(from, to, k);
      fx.burst(_d, 0xdff6ff, 2, 1.5, { glowing: true, size: 0.09, life: 0.5, gravity: -0.5 });
    }
    fx.flash(to, 0xcff2ff, 0.35, 0.06, 3, 0.6);
  }

  function frostNova() {
    if (H.cd2 > 0 || H.energy < 28) return false;
    H.cd2 = 9;
    H.energy -= 28;
    const c = chest(_a);
    forEachNear(c.x, c.y, c.z, 11.5, (zb, d, dx, dz) => {
      const l = Math.hypot(dx, dz) || 1;
      hitZombie(zb, 0, dx / l * 2, dz / l * 2, 0, 1.6);
    });
    fx.ring(_b.set(c.x, ent.position.y, c.z), 0xbfe9ff, 12, 0.7, 4);
    fx.flash(c, 0xdff6ff, 1.6, 0.3, 4, 3);
    fx.burst(c, 0xe6f8ff, 40, 14, { size: 0.08, life: 1.0, gravity: 8, up: 0.6 });
    fx.burst(c, 0xbfe9ff, 30, 16, { glowing: true, size: 0.05, life: 0.5, gravity: 1 });
    sfx.play('nova', 1);
    pushFx(FXT.NOVA, c);
    H.struggle = 0;
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // damage, down, revive
  function hurt(d, quiet = false) {
    if (H.down || H.invuln > 0 || mode !== 'playing') return;
    H.hp -= d;
    H.regenDelay = 5;
    H.hurtT = Math.min(1, H.hurtT + d * 0.05 + 0.1);
    if (!quiet && Math.random() < d * 0.6) sfx.play('hurt', 0.8);
    if (H.hp / H.maxHp < 0.15) vega.say('hp15', {}, { cooldown: 25, priority: 2 });
    else if (H.hp / H.maxHp < 0.35) vega.say('hp35', {}, { cooldown: 30, priority: 1 });
    if (H.hp <= 0) goDown();
  }

  function goDown() {
    H.hp = 0;
    H.down = true;
    H.downT = 0;
    H.flying = false;
    H.slamming = false;
    H.pinned = false;
    for (const zb of zombies.local) if (zb.grabKey === me.key) zombies.release(zb, me);
    const partner = [...remotes.values()].find((r) => !r.down);
    if (partner) vega.say('downSquad', { name: partner.name }, { cooldown: 3, priority: 2 });
    else vega.say(H.kind === 'survivor' ? 'survivorDown' : 'down', {}, { cooldown: 3, priority: 2 });
    sfx.play('alarm', 1);
  }

  function bleedTime() {
    return [...remotes.values()].some((r) => !r.down) ? 25 : H.kind === 'survivor' ? 3.5 : 5;
  }

  function standUp(revived) {
    H.down = false;
    H.hp = revived ? H.maxHp * 0.45 : H.maxHp;
    H.invuln = revived ? 2 : 3;
    H.energy = Math.max(H.energy, revived ? 50 : 100);
    H.struggle = 0;
    if (!revived) {
      if (H.kind === 'survivor') {
        placeOnStreet(ent.position.x + (Math.random() - 0.5) * 120, ent.position.z + (Math.random() - 0.5) * 120);
        H.mag.m4 = GUNS.m4.mag;
        H.reserve = Math.max(H.reserve, 90);
      } else placeOnRoof(ent.position.x, ent.position.z);
      vega.say(H.lives === 1 ? 'lastLife' : 'reboot', { n: H.lives }, { cooldown: 3, priority: 2 });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // co-op
  let knownPeers = new Set();
  net.onChange = () => {
    const now = new Set(net.others.keys());
    for (const peer of now) {
      if (!knownPeers.has(peer) && mode === 'playing') {
        const pr = net.others.get(peer);
        vega.say('partnerJoin', { name: cleanName(pr.presence.nm) }, { cooldown: 5 });
      }
    }
    for (const peer of knownPeers) {
      if (!now.has(peer) && mode === 'playing') vega.say('partnerLeft', { name: remotes.get(peer)?.name || 'your partner' }, { cooldown: 5 });
    }
    knownPeers = now;
    if (net.myKey && me.key !== net.myKey) me.key = net.myKey;
    renderTitleSquad();
  };

  function cleanName(s) {
    return typeof s === 'string' && s.trim() ? s.replace(/[^\x20-\x7E]/g, '').slice(0, 16) : 'Hero';
  }

  function renderTitleSquad() {
    const el = $('title-squad');
    if (!el) return;
    if (!net.available) {
      el.textContent = net.status === 'connecting' ? 'Looking for other heroes in this city…' : 'Solo. Co-op needs the shared link, opened while signed in.';
      return;
    }
    const n = net.others.size;
    el.textContent = n === 0 ? 'No one else is in the city yet. Share this page\'s link to bring a partner.'
      : `${n} other hero${n > 1 ? 'es' : ''} already fighting: ${[...net.others.values()].map((o) => cleanName(o.presence.nm)).join(', ')}.`;
  }
  renderTitleSquad();

  function syncRemotes(dt) {
    const keys = new Set();
    for (const [peer, o] of net.others) {
      const h = o.presence.h;
      if (!Array.isArray(h) || h.length < 12) continue;
      keys.add(peer);
      let r = remotes.get(peer);
      const kind = HERO_KINDS[h[0]] || 'suit';
      if (!r || r.kind !== kind) {
        if (r) remoteGroup.remove(r.model.root);
        const model = new HeroModel(kind);
        remoteGroup.add(model.root);
        r = { peer, key: o.key, kind, model, x: h[1] / 10, y: h[2] / 10, z: h[3] / 10, heading: h[4] / 100, fxSeq: 0, tagEl: null,
          hero: { key: o.key, x: 0, y: 0, z: 0, vx: 0, vz: 0, speed: 0, heading: 0, down: false, dead: false, grounded: false, local: false } };
        remotes.set(peer, r);
        const tag = document.createElement('div');
        tag.className = 'name-tag';
        tag.innerHTML = '<span class="name-tag-name"></span><span class="name-tag-bar"><span></span></span>';
        $('name-tags')?.appendChild(tag);
        r.tagEl = tag;
      }
      r.key = o.key;
      r.name = cleanName(o.presence.nm);
      r.tx = h[1] / 10; r.ty = h[2] / 10; r.tz = h[3] / 10;
      r.th = h[4] / 100;
      r.hp = h[5]; r.maxHp = h[6] || 100;
      r.flags = h[7] | 0;
      r.vx = h[8] / 10; r.vy = h[9] / 10; r.vz = h[10] / 10;
      r.lives = h[11];
      const wasDown = r.down;
      r.down = !!(r.flags & FLAG.DOWN);
      if (r.down && !wasDown && mode === 'playing') vega.say('partnerDown', { name: r.name }, { cooldown: 6, priority: 2 });
      if (!r.down && wasDown && mode === 'playing') vega.say('partnerUp', { name: r.name }, { cooldown: 6 });
      r.aim = Array.isArray(o.presence.a) ? _f.set(o.presence.a[0] / 100, o.presence.a[1] / 100, o.presence.a[2] / 100).clone() : null;
      // their effects, once each
      if (Array.isArray(o.presence.fx)) {
        for (const e of o.presence.fx) {
          if (!Array.isArray(e) || e[0] <= r.fxSeq) continue;
          r.fxSeq = e[0];
          playRemoteFx(e, r);
        }
      }
      zombies.applySnapshot(o.key, o.presence.z);
      // hits they landed on my zombies
      const hits = o.presence.hits?.[me.key];
      if (Array.isArray(hits)) {
        const last = lastHitSeq.get(peer) || 0;
        let top = last;
        for (const e of hits) {
          if (!Array.isArray(e) || e[0] <= last) continue;
          top = Math.max(top, e[0]);
          const zb = zombies.local.find((z) => z.id === e[1]);
          if (zb) zombies.applyHit(zb, e[2], e[3], e[4], e[5], (e[6] || 0) / 100, false);
        }
        lastHitSeq.set(peer, top);
      }
      // revives addressed to me
      const rvIn = o.presence.rv;
      if (Array.isArray(rvIn) && rvIn[0] === me.key && rvIn[1] > (lastRv.get(peer) || 0)) {
        lastRv.set(peer, rvIn[1]);
        if (H.down && mode === 'playing') {
          standUp(true);
          vega.say('revived', { name: r.name }, { cooldown: 3, priority: 2 });
        }
      }
    }
    for (const [peer, r] of remotes) {
      if (keys.has(peer)) continue;
      remoteGroup.remove(r.model.root);
      r.tagEl?.remove();
      remotes.delete(peer);
    }
    // move & pose
    for (const r of remotes.values()) {
      const k = 1 - Math.exp(-dt * 12);
      if (Math.hypot(r.tx - r.x, r.tz - r.z) > 40) { r.x = r.tx; r.y = r.ty; r.z = r.tz; }
      r.x += (r.tx + r.vx * 0.08 - r.x) * k;
      r.y += (r.ty + r.vy * 0.08 - r.y) * k;
      r.z += (r.tz + r.vz * 0.08 - r.z) * k;
      r.heading += Math.atan2(Math.sin(r.th - r.heading), Math.cos(r.th - r.heading)) * k;
      const root = r.model.root;
      root.position.set(r.x, r.y, r.z);
      root.rotation.y = r.heading;
      const f = r.flags;
      const speed = Math.hypot(r.vx, r.vz);
      const fwdS = r.vx * Math.sin(r.heading) + r.vz * Math.cos(r.heading);
      const m = f & FLAG.DOWN ? 'down' : f & FLAG.FLY ? (r.kind === 'coldfront' ? 'surf' : 'fly') : f & FLAG.GROUND || r.kind === 'survivor' ? 'ground' : 'fall';
      if (r.kind === 'survivor') r.model.setWeapon(f & FLAG.PISTOL ? 'pistol' : 'm4');
      root.updateMatrixWorld(true);
      r.model.pose(dt, {
        mode: m, speed, fwd: fwdS, vy: r.vy, turn: 0, boost: !!(f & FLAG.BOOST), thrust: m === 'fly' ? 0.5 + Math.min(0.5, speed / 60) : 0.3,
        aim: f & FLAG.BEAM ? r.aim : null, firing: !!(f & FLAG.BEAM), beam: !!(f & FLAG.BEAM) && r.kind === 'paragon',
        punchT: f & FLAG.PUNCH ? 0.12 : 0, kickT: f & FLAG.KICK ? 0.15 : 0, slam: !!(f & FLAG.SLAM), pinned: !!(f & FLAG.PINNED)
      });
      if ((f & FLAG.BEAM) && r.aim && r.kind !== 'survivor') {
        const from = r.model.muzzle(_a);
        const range = r.kind === 'paragon' ? 90 : 42;
        const t = world.rayHit(from.x, from.y, from.z, r.aim.x, r.aim.y, r.aim.z, range, _hit);
        const to = t ? _b.copy(_hit) : _b.copy(from).addScaledVector(r.aim, range);
        if (r.kind === 'paragon') drawHeat(from, to, r.heading);
        else drawFreeze(from, to);
      }
      Object.assign(r.hero, { x: r.x, y: r.y, z: r.z, vx: r.vx, vz: r.vz, speed, heading: r.heading, down: r.down, grounded: !!(f & FLAG.GROUND) });
      r.hero.key = r.key;
    }
  }

  function playRemoteFx(e, r) {
    const a = _c.set(e[2] / 10, e[3] / 10, e[4] / 10);
    const b = _d.set(e[5] / 10, e[6] / 10, e[7] / 10);
    const vol = atten(a.x, a.y, a.z, 200);
    switch (e[1]) {
      case FXT.REPULSOR:
        fx.beam(a, b, 0x9ff4ff, 0.05, 0.1, 7);
        fx.flash(b, 0x9ff4ff, 0.4, 0.16, 5);
        sfx.play('repulsor', vol * 0.7);
        break;
      case FXT.BOOM: explode(a.clone(), 6.5, 0, false); break;
      case FXT.PULSE: fx.ring(a, 0x9ff4ff, 9.5, 0.45, 5); fx.flash(a, 0x9ff4ff, 1.1, 0.2, 5, 2.5); sfx.play('pulse', vol); break;
      case FXT.SLAM: fx.ring(a, 0xffd28a, 14, 0.6, 4); fx.burst(a, 0x6d655c, 24, 12, { size: 0.16, life: 1.2, gravity: 14, up: 1.2 }); sfx.play('slam', vol); break;
      case FXT.NOVA: fx.ring(a, 0xbfe9ff, 12, 0.7, 4); fx.burst(a, 0xe6f8ff, 30, 14, { size: 0.08, life: 1.0, gravity: 8, up: 0.6 }); sfx.play('nova', vol); break;
      case FXT.PUNCH:
      case FXT.KICK: fx.flash(a, 0xffffff, 0.3, 0.09, 4, 2); sfx.play('punch', vol * 0.8); break;
      case FXT.GUN:
      case FXT.PISTOL:
        gunFx(a, b, e[1] === FXT.GUN ? 'm4' : 'pistol');
        sfx.play(e[1] === FXT.GUN ? 'm4' : 'pistol', vol * 0.8);
        break;
      default: break;
    }
  }

  function publish() {
    // flush accumulated hits into short per-owner histories
    for (const [owner, m] of pendingHits) {
      const list = outHits[owner] || (outHits[owner] = []);
      for (const [zid, e] of m) {
        hitSeq++;
        list.push([hitSeq, zid, Math.round(e[0] * 10) / 10, Math.round(e[1]), Math.round(e[2]), Math.round(e[3]), Math.round(e[4] * 100)]);
      }
      while (list.length > 12) list.shift();
    }
    pendingHits.clear();
    for (const owner of Object.keys(outHits)) if (![...net.others.values()].some((o) => o.key === owner)) delete outHits[owner];
    const p = ent.position;
    let flags = 0;
    if (H.down) flags |= FLAG.DOWN;
    if (H.beaming) flags |= FLAG.BEAM;
    if (H.grounded) flags |= FLAG.GROUND;
    if (H.boosting) flags |= FLAG.BOOST;
    if (H.pinned) flags |= FLAG.PINNED;
    if (H.flying) flags |= FLAG.FLY;
    if (H.slamming) flags |= FLAG.SLAM;
    if (H.punchT > 0) flags |= FLAG.PUNCH;
    if (H.kickT > 0) flags |= FLAG.KICK;
    if (H.kind === 'survivor' && H.weapon === 'pistol') flags |= FLAG.PISTOL;
    const others = [...remotes.values()].map((r) => r.hero);
    net.publish({
      v: 1,
      nm: heroName(),
      h: [HERO_KINDS.indexOf(H.kind), Math.round(p.x * 10), Math.round(p.y * 10), Math.round(p.z * 10), Math.round(ent.heading * 100),
        Math.round(H.hp), H.maxHp, flags, Math.round(H.vx * 10), Math.round(H.vy * 10), Math.round(H.vz * 10), H.lives],
      a: H.beaming ? [Math.round(H.aim.x * 100), Math.round(H.aim.y * 100), Math.round(H.aim.z * 100)] : null,
      fx: fxOut.slice(),
      z: others.length ? zombies.snapshot(others, 70) : [],
      hits: { ...outHits },
      rv
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // HUD
  const hud = {
    hp: $('hp-fill'), hpNum: $('hp-num'), en: $('en-fill'), enNum: $('en-num'), enLabel: $('en-label'),
    heatWrap: $('heat-wrap'), heat: $('heat-fill'), threat: $('threat-num'), time: $('time-num'), kills: $('kills-num'),
    lives: $('lives'), civ: $('civ-num'), prompt: $('prompt'), vignette: $('damage-vignette'), reticle: $('reticle'),
    lock: $('lock-marker'), squad: $('squad-list'), heroName: $('hud-hero-name'), heroRole: $('hud-hero-role')
  };

  function buildAbilityHud() {
    const info = HERO_INFO[H.kind];
    const keys = H.kind === 'survivor' ? [['Click', 'RT'], ['R', 'X'], ['G', 'Y']] : [['F', 'RT'], ['R', 'X'], ['G', 'Y']];
    for (let i = 0; i < 3; i++) {
      const el = $(`ab-${i + 1}`);
      if (!el) continue;
      el.querySelector('.ab-name').textContent = info.abilities[i];
      el.querySelector('.ab-key').textContent = keys[i][0];
      el.querySelector('.ab-pad').textContent = keys[i][1];
    }
    hud.heroName.textContent = heroName();
    hud.heroRole.textContent = info.name === heroName() ? info.role : `${info.name} · ${info.role}`;
    hud.enLabel.textContent = ENERGY_NAME[H.kind];
    hud.heatWrap.hidden = H.kind !== 'paragon';
    document.body.dataset.hero = H.kind;
  }

  function updateHud(dt) {
    const hpK = clamp(H.hp / H.maxHp, 0, 1);
    hud.hp.style.transform = `scaleX(${hpK})`;
    hud.hp.parentElement.classList.toggle('is-low', hpK < 0.35);
    hud.hpNum.textContent = String(Math.ceil(Math.max(0, H.hp)));
    hud.en.style.transform = `scaleX(${clamp(H.energy / 100, 0, 1)})`;
    hud.en.parentElement.classList.toggle('is-low', H.energy < 25 && H.kind !== 'paragon');
    hud.hp.parentElement.parentElement.querySelector('.dc-bar-label').textContent = H.kind === 'survivor' ? 'Health' : 'Armor';
    hud.enNum.textContent = String(Math.floor(H.energy));
    if (H.kind === 'paragon') {
      hud.heat.style.transform = `scaleX(${clamp(H.heat / 100, 0, 1)})`;
      hud.heat.parentElement.classList.toggle('is-low', H.overheated);
    }
    const cds = H.kind === 'survivor'
      ? [[H.mag[H.weapon] === 0 ? 1 : 0, 1], [H.reloadT, GUNS[H.weapon].reload], [0, 1]]
      : [[H.overheated ? 1 : 0, 1], [H.cd2, H.kind === 'suit' ? 8 : H.kind === 'paragon' ? 6 : 9], [H.cd3, H.kind === 'suit' ? 3.5 : 0.6]];
    if (H.kind === 'survivor') {
      $('ab-1').querySelector('.ab-name').textContent = H.weapon === 'm4' ? `M4 ${H.mag.m4} / ${H.reserve}` : `Pistol ${H.mag.pistol} / ∞`;
      $('ab-2').querySelector('.ab-name').textContent = H.reloadT > 0 ? 'Reloading' : 'Reload';
      $('ab-3').querySelector('.ab-name').textContent = H.weapon === 'm4' ? 'Pistol' : 'M4';
    }
    for (let i = 0; i < 3; i++) {
      const el = $(`ab-${i + 1}`);
      const k = clamp(cds[i][0] / cds[i][1], 0, 1);
      el.style.setProperty('--cd', String(k));
      el.classList.toggle('is-ready', k === 0);
      el.classList.toggle('is-active', i === 0 && (H.beaming || input.fireKey || input.mouseFire || input.padFire || input.touchFire));
    }
    hud.threat.textContent = String(threat);
    hud.time.textContent = fmtTime(H.time);
    hud.kills.textContent = String(H.kills);
    hud.civ.textContent = String(zombies.infected);
    hud.lives.replaceChildren(...Array.from({ length: H.maxLives || LIVES }, (_, i) => {
      const s = document.createElement('span');
      s.className = 'life' + (i < H.lives ? ' is-on' : '');
      return s;
    }));
    // prompt
    let prompt = '';
    if (H.down) {
      const left = Math.ceil(bleedTime() - H.downT);
      prompt = bleedTime() > 6 ? `Down. A partner can revive you · ${left}s` : H.kind === 'survivor' ? `Flatlining · ${left}s` : `Rebooting · ${left}s`;
    } else if (H.pinned) prompt = `Pinned · mash Space / A, or ${HERO_INFO[H.kind].abilities[2]}`;
    else if (H.reviving) prompt = `Reviving ${H.reviving.name} · ${Math.round(H.reviving.k * 100)}%`;
    else if (H.stalled && H.kind !== 'paragon' && H.kind !== 'survivor') prompt = `${ENERGY_NAME[H.kind]} empty · land to recharge`;
    else if (H.kind === 'survivor' && H.weapon === 'm4' && H.mag.m4 === 0 && H.reserve === 0) prompt = 'Rifle empty · switch to the pistol (Y / G)';
    hud.prompt.textContent = prompt;
    hud.prompt.hidden = !prompt;
    hud.prompt.classList.toggle('is-danger', H.down || H.pinned);
    // squad
    const rows = [];
    for (const r of remotes.values()) {
      const row = document.createElement('div');
      row.className = 'squad-row' + (r.down ? ' is-down' : '');
      const n = document.createElement('span');
      n.className = 'squad-name';
      n.textContent = r.name;
      const st = document.createElement('span');
      st.className = 'squad-state';
      st.textContent = r.down ? 'DOWN' : `${Math.max(0, Math.round((r.hp / r.maxHp) * 100))}%`;
      row.append(n, st);
      rows.push(row);
    }
    hud.squad.replaceChildren(...rows);
    hud.squad.hidden = rows.length === 0;
  }

  function updateScreenMarkers() {
    const w = window.innerWidth, h = window.innerHeight;
    // target lock
    if (H.target && mode === 'playing') {
      _proj.set(H.target.x, H.target.y + 1.2, H.target.z).project(camera);
      const on = _proj.z < 1 && Math.abs(_proj.x) < 1.1 && Math.abs(_proj.y) < 1.1;
      hud.lock.hidden = !on;
      if (on) hud.lock.style.transform = `translate(${(_proj.x * 0.5 + 0.5) * w}px, ${(-_proj.y * 0.5 + 0.5) * h}px)`;
    } else hud.lock.hidden = true;
    // partner name tags
    for (const r of remotes.values()) {
      if (!r.tagEl) continue;
      _proj.set(r.x, r.y + 2.3, r.z).project(camera);
      const on = _proj.z < 1 && Math.abs(_proj.x) < 1 && Math.abs(_proj.y) < 1 && mode === 'playing';
      r.tagEl.hidden = !on;
      if (!on) continue;
      r.tagEl.style.transform = `translate(${(_proj.x * 0.5 + 0.5) * w}px, ${(-_proj.y * 0.5 + 0.5) * h}px)`;
      r.tagEl.querySelector('.name-tag-name').textContent = r.down ? `${r.name} · DOWN` : r.name;
      r.tagEl.querySelector('.name-tag-bar span').style.transform = `scaleX(${clamp(r.hp / r.maxHp, 0, 1)})`;
      r.tagEl.classList.toggle('is-down', r.down);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // per-frame
  function update(dt) {
    readPad();
    vega.tick(dt);
    const p = ent.position;
    const model = models[H.kind];
    // the hero moved in the controller step: bring its transform up to date before aiming from it
    ent.mesh.position.copy(p);
    ent.mesh.rotation.y = ent.heading;
    ent.mesh.updateMatrixWorld(true);
    me.x = p.x; me.y = p.y; me.z = p.z; me.vx = H.vx; me.vz = H.vz; me.speed = ent.speed; me.heading = ent.heading;
    me.down = H.down || mode !== 'playing'; me.dead = mode !== 'playing' && mode !== 'awaken'; me.grounded = H.grounded;
    if (net.myKey) me.key = net.myKey;

    syncRemotes(dt);
    const heroes = [me, ...[...remotes.values()].map((r) => r.hero)];

    if (mode === 'playing') {
      H.time += dt;
      H.fireCd -= dt; H.cd2 -= dt; H.cd3 -= dt; H.invuln -= dt; H.regenDelay -= dt;
      H.punchT -= dt; H.kickT -= dt;
      H.hurtT = Math.max(0, H.hurtT - dt * 1.5);

      // threat & surges
      const lvl = Math.min(12, 1 + Math.floor(H.time / 70));
      if (lvl !== threat) {
        threat = lvl;
        zombies.setThreat(threat);
        vega.say('threat', { n: threat }, { cooldown: 10, priority: 2 });
      }
      surgeT -= dt;
      if (surgeT <= 0 && !H.down) {
        surgeT = Math.max(28, 52 - threat * 2);
        const a = Math.random() * Math.PI * 2;
        const cx = p.x + Math.cos(a) * 60, cz = p.z + Math.sin(a) * 60;
        for (let i = 0; i < 14 + threat * 2; i++) zombies.spawnNear(cx, cz, 0, 22, camera, { ring: true, runner: true, rise: true });
        const dirs = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
        // Manhattan's grid north is roughly -z (uptown)
        const ang = Math.atan2(-Math.sin(a), Math.cos(a));
        vega.say('surge', { dir: dirs[((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8] }, { cooldown: 15, priority: 2 });
      }

      // grabbed / pinned
      H.grabbers = H.down ? 0 : zombies.countGrabbing(me.key, p.x, p.y, p.z);
      const T = TUNE[H.kind];
      const wasPinned = H.pinned;
      H.pinned = !H.down && H.grabbers >= T.pinAt && (H.grounded || p.y - H.gy < 2.5);
      if (H.grabbers > 0) {
        // each extra biter hurts, but a full pile-up tops out so there is time to react
        hurt(Math.min(H.grabbers, 4) * T.grabDps * dt, true);
        if (Math.random() < dt * 2) sfx.play('hurt', 0.5);
        vega.say('grabbed', {}, { cooldown: 25 });
      }
      if (H.pinned && !wasPinned) {
        vega.say(H.kind === 'suit' ? 'pinnedSuit' : H.kind === 'paragon' ? 'pinnedParagon' : 'pinnedCold', {}, { cooldown: 15, priority: 2 });
      }
      // break free by mashing
      H.struggle = Math.max(0, H.struggle - dt * 0.45);
      if (input.mash && H.grabbers > 0 && !H.down) {
        H.struggle += H.kind === 'paragon' ? 0.3 : 0.2;
        if (H.struggle >= 1) {
          H.struggle = 0;
          for (const zb of zombies.local) if (zb.state === ST.GRAB && zb.grabKey === me.key) zombies.release(zb, me);
          zombies.each(p.x, p.y + 1, p.z, 1.9, (zb, d, dx, dz) => {
            const l = Math.hypot(dx, dz) || 1;
            if (zb.state === ST.GRAB) hitZombie(zb, 5, dx / l * 9, dz / l * 9, 3);
          });
          sfx.play('punch', 0.8);
        }
      }
      // regeneration (Paragon)
      if (T.regen && H.regenDelay <= 0 && !H.down) H.hp = Math.min(H.maxHp, H.hp + T.regen * dt);
      // energy warnings
      if (H.kind !== 'paragon' && H.flying && H.energy < 22 && !H.down) vega.say(H.kind === 'suit' ? 'energyLowSuit' : 'energyLowCold', {}, { cooldown: 35 });

      // down / bleed out / reboot
      if (H.down) {
        H.downT += dt;
        if (H.downT >= bleedTime()) {
          if (H.kind === 'survivor' && !H.awakened) awaken();
          else {
            H.lives--;
            if (H.lives <= 0) gameOver();
            else standUp(false);
          }
        }
      }

      // abilities
      const firing = input.fireKey || input.mouseFire || input.padFire || input.touchFire;
      const dir = aimDir(_f);
      const origin = chest(_c);
      const range = H.kind === 'survivor' ? GUNS[H.weapon].range : H.kind === 'suit' ? 120 : H.kind === 'paragon' ? 90 : 42;
      const cone = H.kind === 'survivor' ? (H.aiming ? 0.992 : 0.975) : H.kind === 'coldfront' ? 0.97 : 0.955;
      H.target = H.down ? null : pickTarget(origin, dir, range, cone);
      if (H.target) _d.set(H.target.x, H.target.y + 1.2, H.target.z).sub(origin).normalize();
      else _d.copy(dir);
      H.beaming = false;
      H.firing = firing && !H.down;
      if (!H.down) {
        if (H.kind === 'survivor') {
          H.shoveCd -= dt;
          H.raiseT -= dt;
          if (H.reloadT > 0) {
            H.reloadT -= dt;
            if (H.reloadT <= 0) { H.reloadT = 0; finishReload(); }
          }
          if (firing) shoot(H.target, _d);
          if (input.a2) startReload();
          if (input.a3) switchGun();
          // B / C: shove
          const downNow = num(controllers.keys.down) > 0.5;
          if (downNow && !H.prevDown) shove();
          H.prevDown = downNow;
          H.aim.copy(_d);
          H.beaming = H.aiming || H.raiseT > 0 || firing;
          if (H.weapon === 'm4' && H.mag.m4 + H.reserve <= 15) vega.say('lowAmmo', {}, { cooldown: 40 });
          if (H.mag[H.weapon] === 0 && H.reloadT <= 0 && !(H.weapon === 'm4' && H.reserve <= 0)) startReload();
        } else if (H.kind === 'suit') {
          if (firing) { repulsor(H.target, _d); H.aim.copy(_d); }
          if (input.a2) launchMissiles(_d);
          if (input.a3) shockPulse();
        } else if (H.kind === 'paragon') {
          if (H.overheated) {
            H.heat -= 28 * dt;
            if (H.heat < 25) H.overheated = false;
          } else if (firing) {
            H.heat += 30 * dt;
            H.beaming = true;
            heatVision(H.target, _d, dt);
            sfx.setLoop('beam', 0.09, 1600);
            if (H.heat >= 100) {
              H.overheated = true;
              vega.say('overheat', {}, { cooldown: 15 });
            }
          } else H.heat = Math.max(0, H.heat - 42 * dt);
          if (input.a2) skySlam();
          if (input.a3 && H.cd3 <= 0) { H.cd3 = 0.5; H.punchT = 0.3; melee(3.4, 95, 24, 0.35, FXT.PUNCH); }
        } else {
          if (firing && H.energy > 3) {
            H.beaming = true;
            freezeRay(H.target, _d, dt);
            sfx.setLoop('freeze', 0.22, 3400);
          }
          if (input.a2) frostNova();
          if (input.a3 && H.cd3 <= 0) { H.cd3 = 0.55; H.kickT = 0.3; melee(3.6, 55, 18, 0.15, FXT.KICK); }
        }
      }
      if (!(H.beaming && H.kind === 'paragon')) sfx.setLoop('beam', 0);
      if (!(H.beaming && H.kind === 'coldfront')) sfx.setLoop('freeze', 0);

      // revive downed partners by standing next to them
      H.reviving = null;
      for (const r of remotes.values()) {
        r.revK = r.revK || 0;
        if (r.down && !H.down && Math.hypot(r.x - p.x, r.z - p.z) < 3.2 && Math.abs(r.y - p.y) < 2.5) {
          r.revK += dt / 2.5;
          H.reviving = { name: r.name, k: Math.min(1, r.revK) };
          if (r.revK >= 1) {
            r.revK = 0;
            rvSeq++;
            rv = [r.key, rvSeq];
            rvClearT = 3;
            vega.say('partnerUp', { name: r.name }, { cooldown: 5 });
          }
        } else r.revK = Math.max(0, r.revK - dt);
      }

      // VEGA situational awareness
      let close = 0, climbers = 0;
      for (const zb of zombies.local) {
        if (zb.state === ST.DEAD) continue;
        const d = Math.hypot(zb.x - p.x, zb.z - p.z);
        if (d < 35) close++;
        if (zb.state === ST.PILE && zb.pile?.heroKey === me.key && d < 60) climbers++;
      }
      if (close >= 10) vega.say('contacts', { n: close }, { cooldown: 40 });
      if (climbers >= 6) vega.say('climbing', {}, { cooldown: 35, priority: 2 });
      H.streak = H.streak.filter((t) => H.time - t < 6);
      if (H.streak.length >= 10) { vega.say('streak', {}, { cooldown: 40 }); H.streak.length = 0; }
    } else {
      sfx.setLoop('beam', 0);
      sfx.setLoop('freeze', 0);
    }
    input.a2 = input.a3 = input.mash = false;

    // shatter chains
    chainClock -= dt;
    for (const c of chain) c.t -= dt;
    const ready = chain.filter((c) => c.t <= 0);
    chain = chain.filter((c) => c.t > 0);
    for (const c of ready) {
      if (c.depth > 14) continue;
      zombies.each(c.x, c.y, c.z, 2.7, (zb) => {
        if (zb.state !== ST.FROZEN) return;
        const r = hitZombie(zb, 1);
        if (r === 'shatter' && !zb.remote) chain.push({ x: zb.x, y: zb.y + 1, z: zb.z, t: 0.07, depth: c.depth + 1 });
      });
    }
    if (chainCount >= 4) { vega.say('shatterChain', {}, { cooldown: 30 }); }
    if (chainClock <= 0) { chainCount = 0; chainClock = 2; }

    updateMissiles(dt);
    updatePickups(dt);
    zombies.update(dt, { heroes, camera, me, threat });

    // pose the local hero
    const fwdS = H.vx * Math.sin(ent.heading) + H.vz * Math.cos(ent.heading);
    const kturn = num(controllers.keys.left) - num(controllers.keys.right);
    const heroMode = H.down ? 'down' : H.flying ? (H.kind === 'coldfront' ? 'surf' : 'fly') : H.grounded ? 'ground' : 'fall';
    const aimNow = H.kind === 'suit' && (H.firing || H.fireCd > 0) ? H.aim : H.beaming ? H.aim : null;
    if (H.kind === 'survivor') models.survivor.setWeapon(H.weapon);
    model.pose(dt, {
      mode: heroMode, speed: ent.speed, fwd: fwdS, vy: H.vy, turn: kturn, boost: H.boosting,
      thrust: heroMode === 'fly' ? 0.45 + Math.min(0.55, ent.speed / 55) + (H.boosting ? 0.3 : 0) + Math.max(0, H.vy / 30) : H.stalled ? 0 : 0.3,
      aim: aimNow, firing: H.beaming, beam: H.beaming && H.kind === 'paragon', punchT: H.punchT, kickT: H.kickT,
      slam: H.slamming, pinned: H.pinned
    });

    // flight sound beds
    if (mode === 'playing') {
      sfx.setLoop('wind', clamp((ent.speed + Math.abs(H.vy)) / 70, 0, 1) * 0.5, 300 + ent.speed * 18);
      sfx.setLoop('thrust', H.kind === 'suit' && H.flying ? 0.12 + (H.boosting ? 0.12 : 0) : 0, H.boosting ? 520 : 380);
    } else {
      sfx.setLoop('wind', 0);
      sfx.setLoop('thrust', 0);
    }

    // aiming down the sights pulls the camera in
    if (H.kind === 'survivor' && mode === 'playing') {
      const want = H.aiming ? 0.62 : 1;
      cameraSystem.zoomMultiplier += (want - cameraSystem.zoomMultiplier) * (1 - Math.exp(-dt * 10));
    }

    // over-the-shoulder view on foot: keep the Survivor off the centre of the screen
    if (H.kind === 'survivor' && mode === 'playing' && cameraSystem.getActivePreset?.().id === 'chase') {
      const off = H.aiming ? 0.42 : 0.6;
      camera.position.x -= Math.cos(ent.heading) * off;
      camera.position.z += Math.sin(ent.heading) * off;
      camera.position.y += 0.1;
    }

    // camera shake from impacts
    if (shake > 0.001) {
      camera.position.x += (Math.random() - 0.5) * shake;
      camera.position.y += (Math.random() - 0.5) * shake;
      shake *= Math.exp(-dt * 7);
    }

    fx.update(dt);

    publishT -= dt;
    if (publishT <= 0 && mode === 'playing') {
      publishT = 1 / 12;
      publish();
      if (rv && (rvClearT -= 1 / 12) <= 0) rv = null;
    }

    hudT -= dt;
    if (hudT <= 0 && mode === 'playing') {
      hudT = 0.1;
      updateHud(dt);
    }
    if (hud.vignette) hud.vignette.style.opacity = String(mode === 'playing' ? Math.max(H.hurtT, H.hp / H.maxHp < 0.25 ? 0.35 + Math.sin(H.time * 6) * 0.1 : 0) : 0);
    updateScreenMarkers();
  }

  function reveal() {
    // after the loading screen: show the title
    revealed = true;
    titleEl.hidden = false;
    renderTitleSquad();
  }

  // read-only handle for debugging from the console
  window.__deadCity = { H, zombies, remotes, ent, net, fx, input, selectHero, deploy, world, cameraSystem, models, choosePower, getMode: () => mode };

  return {
    update,
    reveal,
    roots: [fx.group, remoteGroup],
    isPlaying: () => mode === 'playing'
  };
}

export { createGame };
