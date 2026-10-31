import * as THREE from 'three/webgpu';
import { attribute, vec3, color, float, mix, dot, sin, abs, smoothstep, step } from 'three/tsl';
import { PersonCrowd, PersonRig, PERSON_BONES } from '../pedestrians.js';

// The infected. Local zombies are simulated here (this device owns them); remote zombies are copies of another
// player's zombies, drawn from their snapshots and sent hits instead of being simulated.

const ST = { WALK: 0, GRAB: 2, LEAP: 3, CLIMB: 4, DEAD: 5, RISE: 6, KNOCK: 7, FROZEN: 8, PILE: 10 };
const PILE_MAX = 140;
const GRAVITY = 24;
const MAX_LOCAL = 150;
const MAX_REMOTE = 170;
const RADIUS = 0.36;
const GRAB_SLOTS = 7;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _sw = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _pm = new THREE.Matrix4();
const _sphere = new THREE.Sphere(new THREE.Vector3(), 1.4);

const rand = (a, b) => a + Math.random() * (b - a);
const wrap = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;

const DEBUG = new URLSearchParams(location.search);

// Rotting skin & clothes, dried blood, eyes that glow in the dark
function zombifyMaterial(mat) {
  const base = mat.colorNode;
  const q = attribute('position', 'vec3');
  const lum = dot(base, vec3(0.299, 0.587, 0.114));
  const rot = mix(vec3(lum), base, 0.28).mul(vec3(0.74, 0.82, 0.62));
  const grime = sin(q.x.mul(23.0)).mul(sin(q.y.mul(17.0))).mul(sin(q.z.mul(29.0).add(q.y.mul(7.0))));
  const blood = smoothstep(0.35, 0.55, grime).mul(step(q.y, 1.5));
  mat.colorNode = mix(rot, color(0x3b0907), blood.mul(0.85));
  const front = smoothstep(0.06, 0.08, q.z);
  const eyeX = abs(abs(q.x).sub(0.031));
  const eyes = smoothstep(0.013, 0.006, eyeX).mul(smoothstep(0.007, 0.002, abs(q.y.sub(1.627)))).mul(front);
  if (!DEBUG.has('noeyes')) mat.emissiveNode = color(0xff2a10).mul(eyes).mul(6.0);
  if (DEBUG.has('noblood')) mat.colorNode = rot;
}

function iceMaterial(mat) {
  const base = mat.colorNode;
  const q = attribute('position', 'vec3');
  const facets = sin(q.x.mul(41.0).add(q.y.mul(33.0))).mul(sin(q.z.mul(37.0).sub(q.y.mul(21.0))));
  mat.colorNode = mix(base.mul(0.25), color(0xcfefff), float(0.82).add(facets.mul(0.08)));
  mat.roughnessNode = float(0.1);
  mat.emissiveNode = color(0x2f9bff).mul(0.22);
}

// Zombie reach: rotate both arms rigidly about their shoulders, forward and up, after the rig has solved its pose
const SHOULDER = [[0.185, 1.43, -0.015], [0.165, 1.415, -0.015]];
function reachArms(rig, raise) {
  const a = rig.pose;
  const sh = SHOULDER[rig.female];
  _axis.set(Math.cos(rig.yaw), 0, -Math.sin(rig.yaw));
  for (let k = 0; k < 2; k++) {
    const side = k === 0 ? 1 : -1;
    const ub = k === 0 ? PERSON_BONES.UPPER_ARM_L : PERSON_BONES.UPPER_ARM_R;
    const fb = k === 0 ? PERSON_BONES.FOREARM_L : PERSON_BONES.FOREARM_R;
    let o = ub * 8;
    _q.set(a[o], a[o + 1], a[o + 2], a[o + 3]);
    // world shoulder = q * bindShoulder * s + t
    _sw.set(side * sh[0], sh[1], sh[2]).applyQuaternion(_q).multiplyScalar(a[o + 7]);
    _sw.x += a[o + 4]; _sw.y += a[o + 5]; _sw.z += a[o + 6];
    _q2.setFromAxisAngle(_axis, -(raise + side * 0.08));
    for (const b of [ub, fb]) {
      o = b * 8;
      _q.set(a[o], a[o + 1], a[o + 2], a[o + 3]).premultiply(_q2);
      a[o] = _q.x; a[o + 1] = _q.y; a[o + 2] = _q.z; a[o + 3] = _q.w;
      _v.set(a[o + 4] - _sw.x, a[o + 5] - _sw.y, a[o + 6] - _sw.z).applyQuaternion(_q2);
      a[o + 4] = _v.x + _sw.x; a[o + 5] = _v.y + _sw.y; a[o + 6] = _v.z + _sw.z;
    }
  }
}

const zGround = (z) => z.gy;

class ZombieSystem {
  constructor({ scene, controllers, world, fx, nodes, peds, onKill, onSound }) {
    this.controllers = controllers;
    this.world = world;
    this.fx = fx;
    this.nodes = nodes.filter((n) => !n.general);
    this.peds = peds || [];
    this.onKill = onKill || (() => {});
    this.onSound = onSound || (() => {});
    this.crowd = new PersonCrowd(MAX_LOCAL + MAX_REMOTE, { farDistance: 40 });
    this.iceCrowd = new PersonCrowd(120, { farDistance: 40 });
    for (const m of this.crowd.meshes) { if (!DEBUG.has('plain')) zombifyMaterial(m.material); scene.add(m); m.name = 'Zombies'; }
    for (const m of this.iceCrowd.meshes) { iceMaterial(m.material); scene.add(m); m.name = 'FrozenZombies'; }
    this.local = [];
    this.piles = []; // living heaps of zombies climbing over each other toward a hero above
    this.remote = new Map(); // key -> zombie
    this.nextId = 1;
    this.rigPool = [];
    this.spawnTimer = 0;
    this.infected = 0; // civilians turned
    this.grid = new Map();
    this.desired = 50;
    this.runnerShare = 0.55;
    this.speedMul = 1;
    this.hpMul = 1;
  }

  makeRig(seedOpts) {
    const o = seedOpts || {};
    const female = o.female ?? Math.random() < 0.45;
    return new PersonRig({
      // same seed family as the city's pedestrians (small values keep the shader's hash stable)
      seed: o.seed ?? Math.floor(Math.random() * 340) * 1.6180339 + 0.13,
      female,
      scale: o.scale ?? (female ? 0.92 : 0.98) + Math.random() * 0.09,
      girth: o.girth ?? 0.9 + Math.random() * 0.25,
      hair: o.hair ?? (female ? 0.6 + Math.random() * 0.4 : Math.random() * 0.35),
      armSwing: 0.4,
      stride: o.stride ?? 0.9 + Math.random() * 0.15
    });
  }

  newZombie(x, y, z, opts = {}) {
    const runner = opts.runner ?? Math.random() < this.runnerShare;
    const hp = (runner ? 55 : 75) * this.hpMul;
    return {
      id: this.nextId++, remote: false, owner: null,
      x, y, z, vx: 0, vy: 0, vz: 0, gy: y,
      heading: opts.heading ?? Math.random() * Math.PI * 2,
      hp, maxHp: hp, runner,
      speed: runner ? rand(5.4, 7.0) * this.speedMul : rand(1.2, 2.0),
      state: opts.state ?? ST.WALK, t: 0,
      target: null, targetKind: 0, think: Math.random() * 0.4,
      leapCd: rand(0.5, 2), grabKey: null, slot: 0,
      climb: null, frozen: 0, chill: 0, knockT: 0,
      wander: Math.random() * Math.PI * 2, raise: rand(1.1, 1.45),
      rig: this.makeRig(opts.look), lastHurt: 0
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  setThreat(level) {
    this.desired = Math.min(MAX_LOCAL - 10, 44 + level * 10);
    this.runnerShare = Math.min(0.85, 0.5 + level * 0.04);
    this.speedMul = 1 + (level - 1) * 0.035;
    this.hpMul = 1 + (level - 1) * 0.07;
  }

  spawnNear(cx, cz, rMin, rMax, camera, opts = {}) {
    if (this.local.length >= MAX_LOCAL) return null;
    let near = null;
    if (!opts.ring) {
      // street intersections around the spot (cached while the spot stays put)
      const key = `${Math.round(cx / 20)},${Math.round(cz / 20)},${rMin},${rMax}`;
      if (this._nearKey !== key) {
        this._nearKey = key;
        this._near = this.nodes.filter((n) => {
          const d = Math.hypot(n.x - cx, n.z - cz);
          return d >= rMin && d <= rMax;
        });
      }
      near = this._near;
      if (!near.length) return this.spawnNear(cx, cz, rMin, rMax, camera, { ...opts, ring: true });
    }
    for (let attempt = 0; attempt < 12; attempt++) {
      let x, z;
      if (opts.ring) {
        const a = Math.random() * Math.PI * 2, r = rand(rMin, rMax);
        x = cx + Math.cos(a) * r; z = cz + Math.sin(a) * r;
      } else {
        const n = near[Math.floor(Math.random() * near.length)];
        x = n.x + rand(-7, 7); z = n.z + rand(-7, 7);
      }
      if (!this.world.clear(x, z, 0.5)) continue;
      const y = this.world.roofAt(x, z, 1.0);
      if (y > 1) continue;
      let visible = false;
      if (camera) {
        _sphere.center.set(x, y + 1, z);
        visible = _frustum.intersectsSphere(_sphere) && Math.hypot(x - camera.position.x, z - camera.position.z) < 120;
      }
      const zb = this.newZombie(x, y, z, { ...opts, state: visible || opts.rise ? ST.RISE : ST.WALK });
      if (zb.state === ST.RISE) zb.t = 1.15; // emerge from the ground (prone, then up)
      this.local.push(zb);
      return zb;
    }
    return null;
  }

  // A bitten civilian becomes one of them, keeping their looks
  infectCivilian(p) {
    p.placed = false;
    this.infected++;
    const alive = this.local.reduce((n, z) => n + (z.state !== ST.DEAD), 0);
    if (this.local.length >= MAX_LOCAL || alive >= this.desired + 25) {
      // too many already: the victim is simply gone
      this.fx.burst(_v.set(p.x, 1.1, p.z), 0x4a0806, 12, 5, { size: 0.08, life: 0.9, gravity: 16 });
      return;
    }
    const r = p.rig;
    const zb = this.newZombie(p.x, 0.22, p.z, {
      runner: true, state: ST.RISE,
      look: { seed: r.seed, female: !!r.female, scale: r.s, girth: r.girth, hair: r.pose[r.pose.length - 1], stride: r.stride }
    });
    zb.t = 0; // the full fall-and-rise
    zb.heading = Math.random() * Math.PI * 2;
    this.local.push(zb);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // damage from this device. Returns 'kill' | 'shatter' | 'hit' | null
  hit(zb, dmg, kx = 0, kz = 0, ky = 0, freeze = 0, sender = null) {
    if (!zb || zb.state === ST.DEAD) return null;
    if (zb.remote) {
      sender?.(zb, dmg, kx, kz, ky, freeze);
      if (zb.state === ST.FROZEN && dmg > 0) {
        this.shatter(zb);
        zb.predDead = true;
        return 'shatter';
      }
      if (freeze > 0) zb.chill += freeze;
      zb.predHp = (zb.predHp ?? 60) - dmg;
      if (dmg > 0 && zb.predHp <= 0) {
        this.kill(zb, kx, kz);
        zb.predDead = true;
        return 'kill';
      }
      return dmg > 0 ? 'hit' : null;
    }
    return this.applyHit(zb, dmg, kx, kz, ky, freeze, true);
  }

  // authoritative damage on a local zombie (from this device, or a partner's hit)
  applyHit(zb, dmg, kx, kz, ky, freeze, mine) {
    if (zb.state === ST.DEAD) return null;
    if (zb.state === ST.FROZEN && dmg > 0) {
      this.shatter(zb);
      this.onKill(zb, mine, true);
      return 'shatter';
    }
    if (freeze > 0) {
      zb.chill += freeze;
      if (zb.chill >= 1) {
        zb.state = ST.FROZEN;
        zb.frozen = 9;
        zb.chill = 0;
        zb.grabKey = null;
        zb.vx = zb.vz = 0;
        this.fx.burst(_v.set(zb.x, zb.y + 1, zb.z), 0xd8f4ff, 6, 3, { size: 0.06, life: 0.5 });
      }
    }
    if (mine) zb.hitT = 4;
    if (dmg <= 0) return null;
    zb.hp -= dmg;
    zb.lastHurt = 0;
    if (dmg >= 6 || Math.random() < dmg * 0.08) this.fx.burst(_v.set(zb.x, zb.y + 1.2, zb.z), 0x4a0806, Math.min(8, 2 + dmg / 18), 4, { size: 0.035, life: 0.6, gravity: 14 });
    if (zb.hp <= 0) {
      this.kill(zb, kx, kz);
      this.onKill(zb, mine, false);
      return 'kill';
    }
    if (Math.hypot(kx, kz) > 3 || ky > 3) {
      zb.vx += kx; zb.vz += kz; zb.vy += ky;
      zb.state = ST.KNOCK;
      zb.knockT = 0.9;
      zb.grabKey = null;
    }
    return 'hit';
  }

  kill(zb, kx = 0, kz = 0) {
    zb.state = ST.DEAD;
    zb.t = 0;
    zb.grabKey = null;
    zb.vx = kx * 0.4; zb.vz = kz * 0.4;
    if (Math.hypot(kx, kz) > 0.1) zb.heading = Math.atan2(kx, kz);
    this.fx.burst(_v.set(zb.x, zb.y + 1.1, zb.z), 0x3d0605, 10, 5, { size: 0.045, life: 0.8, gravity: 16 });
  }

  shatter(zb) {
    zb.state = ST.DEAD;
    zb.shattered = true;
    zb.t = 0;
    this.fx.burst(_v.set(zb.x, zb.y + 1, zb.z), 0xd6f2ff, 26, 7, { size: 0.12, life: 1.3, gravity: 18, up: 0.8 });
    this.fx.burst(_v, 0x9fe0ff, 14, 5, { size: 0.05, life: 0.4, glowing: true });
    this.onSound('shatter', zb.x, zb.y, zb.z);
  }

  // ---------------------------------------------------------------------------------------------------------------
  /**
   * heroes: [{ key, x, y, z, vx, vz, speed, down, grounded, local }]
   */
  update(dt, { heroes, camera, me, threat }) {
    _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm, camera.coordinateSystem, camera.reversedDepth);
    const meHero = heroes.find((h) => h.local);
    this.spawnTimer -= dt;

    // keep the horde topped up around this player
    if (meHero && !meHero.dead && this.spawnTimer <= 0) {
      this.spawnTimer = 0.18;
      const alive = this.local.reduce((n, z) => n + (z.state !== ST.DEAD && z.state !== ST.PILE), 0);
      if (alive < this.desired) this.spawnNear(meHero.x, meHero.z, 45, 170, camera);
    }

    this.buildGrid();
    const grabCount = new Map();
    for (const zb of this.local) if (zb.state === ST.GRAB && zb.grabKey) grabCount.set(zb.grabKey, (grabCount.get(zb.grabKey) || 0) + 1);

    let w = 0;
    for (let i = 0; i < this.local.length; i++) {
      const zb = this.local[i];
      this.think(zb, dt, heroes, grabCount);
      this.move(zb, dt, heroes);
      if (zb.state === ST.DEAD && zb.t > (zb.shattered ? 0.6 : 7)) {
        this.rigPool.push(zb.rig);
        continue;
      }
      // recycle the far-away
      if (meHero && zb.state !== ST.DEAD && zb.state !== ST.GRAB) {
        let dmin = Infinity;
        for (const h of heroes) dmin = Math.min(dmin, Math.hypot(h.x - zb.x, h.z - zb.z));
        if (dmin > 320) continue;
      }
      this.local[w++] = zb;
    }
    this.local.length = w;
    this.updatePiles(dt, heroes);
    this.separate();

    // remote copies: ease toward their owner's positions
    for (const [key, zb] of this.remote) {
      zb.t += dt;
      if (zb.state === ST.DEAD) {
        if (zb.t > 6 || (zb.shattered && zb.t > 0.6)) this.remote.delete(key);
        continue;
      }
      if (zb.age > 1.5) { this.remote.delete(key); continue; }
      zb.age += dt;
      const k = 1 - Math.exp(-dt * 10);
      zb.x += (zb.tx - zb.x) * k;
      zb.y += (zb.ty - zb.y) * k;
      zb.z += (zb.tz - zb.z) * k;
      zb.heading += wrap(zb.th - zb.heading) * k;
      zb.gy = zb.y;
      if (zb.state === ST.FROZEN) zb.frozen = 1;
    }

    this.render(dt, camera);
  }

  buildGrid() {
    const g = this.grid;
    g.clear();
    for (const zb of this.local) {
      if (zb.state !== ST.WALK && zb.state !== ST.FROZEN) continue;
      const k = (Math.floor(zb.x / 1.5) + 4096) * 8192 + Math.floor(zb.z / 1.5) + 4096;
      let list = g.get(k);
      if (!list) g.set(k, (list = []));
      list.push(zb);
    }
  }

  separate() {
    const g = this.grid;
    for (const zb of this.local) {
      if (zb.state !== ST.WALK) continue;
      const cx = Math.floor(zb.x / 1.5), cz = Math.floor(zb.z / 1.5);
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        for (let iz = cz - 1; iz <= cz + 1; iz++) {
          const list = g.get((ix + 4096) * 8192 + iz + 4096);
          if (!list) continue;
          for (const o of list) {
            if (o === zb || Math.abs(o.y - zb.y) > 1) continue;
            const dx = zb.x - o.x, dz = zb.z - o.z;
            const d2 = dx * dx + dz * dz;
            if (d2 > RADIUS * RADIUS * 4 || d2 < 1e-6) continue;
            const d = Math.sqrt(d2);
            const push = (RADIUS * 2 - d) * (o.state === ST.FROZEN ? 1 : 0.5);
            zb.x += (dx / d) * push;
            zb.z += (dz / d) * push;
          }
        }
      }
    }
  }

  think(zb, dt, heroes, grabCount) {
    zb.t += dt;
    if (zb.hitT > 0) zb.hitT -= dt;
    zb.leapCd -= dt;
    zb.think -= dt;
    if (zb.state === ST.DEAD || zb.state === ST.FROZEN || zb.state === ST.RISE) return;
    if (zb.think > 0 && zb.target) return;
    zb.think = 0.35 + Math.random() * 0.25;
    // nearest standing hero within reach of the senses
    let best = null, bd = 170;
    for (const h of heroes) {
      if (h.down || h.dead) continue;
      const d = Math.hypot(h.x - zb.x, h.z - zb.z) + Math.max(0, h.y - zb.y - 30) * 0.5;
      if (d < bd) { bd = d; best = h; }
    }
    // a living civilian close by beats a hero further off
    if (zb.targetKind === 2 && zb.target?.placed && Math.hypot(zb.target.x - zb.x, zb.target.z - zb.z) < Math.min(40, bd * 0.6)) return;
    const civRange = best ? Math.min(30, (bd - 20) * 0.6) : 30;
    if (best) {
      zb.target = best;
      zb.targetKind = 1;
      if (zb.state === ST.WALK && !zb.pileGoal && best.y > zb.y + 2.5) {
        let pile = null, pd = 50;
        for (const p of this.piles) {
          if (!p.wall || p.heroKey !== best.key || p.members.length < 2) continue;
          const d = Math.hypot(p.x - zb.x, p.z - zb.z) - p.members.length * 0.5;
          if (d < pd) { pd = d; pile = p; }
        }
        if (pile) zb.pileGoal = pile;
      }
    } else {
      zb.target = null;
      zb.targetKind = 0;
    }
    if (civRange < 4) return;
    let cd = civRange;
    for (let i = 0; i < this.peds.length; i += 3) {
      const p = this.peds[(i + (zb.id % 3)) % this.peds.length];
      if (!p.placed || p.conversation) continue;
      const d = Math.abs(p.x - zb.x) + Math.abs(p.z - zb.z);
      if (d < cd) { cd = d; zb.target = p; zb.targetKind = 2; }
    }
  }

  move(zb, dt, heroes) {
    const world = this.world;
    switch (zb.state) {
      case ST.DEAD:
      case ST.FROZEN: {
        if (zb.state === ST.FROZEN) {
          zb.frozen -= dt;
          if (zb.frozen <= 0) { zb.state = ST.WALK; zb.t = 0; }
        }
        // fall if knocked off a ledge
        this.gravity(zb, dt, true);
        zb.x += zb.vx * dt; zb.z += zb.vz * dt;
        const k = Math.exp(-dt * 4);
        zb.vx *= k; zb.vz *= k;
        return;
      }
      case ST.RISE:
        if (zb.t > 2.5) { zb.state = ST.WALK; zb.t = 0; }
        this.gravity(zb, dt);
        return;
      case ST.KNOCK: {
        zb.knockT -= dt;
        zb.x += zb.vx * dt; zb.z += zb.vz * dt;
        const k = Math.exp(-dt * (zb.y > zb.gy + 0.1 ? 0.3 : 5));
        zb.vx *= k; zb.vz *= k;
        world.push(zb, RADIUS, 1.7, null);
        this.gravity(zb, dt);
        if (zb.knockT <= 0 && zb.y <= zb.gy + 0.05) { zb.state = ST.RISE; zb.t = 1.5; }
        return;
      }
      case ST.GRAB: {
        const h = heroes.find((q) => q.key === zb.grabKey);
        if (!h || h.down || h.dead) { this.release(zb); return; }
        // shaken loose by fast flight
        if (h.speed > 24 && Math.random() < dt * 0.9) { this.release(zb, h); return; }
        const a = zb.slot / GRAB_SLOTS * Math.PI * 2 + h.heading;
        const dist = 0.62;
        zb.x = h.x + Math.sin(a) * dist;
        zb.z = h.z + Math.cos(a) * dist;
        zb.y = h.grounded ? h.y : h.y - 0.55;
        zb.gy = zb.y;
        zb.heading = Math.atan2(h.x - zb.x, h.z - zb.z);
        return;
      }
      case ST.LEAP: {
        zb.x += zb.vx * dt; zb.z += zb.vz * dt;
        zb.vy -= GRAVITY * dt;
        zb.y += zb.vy * dt;
        const h = zb.target && zb.targetKind === 1 ? zb.target : null;
        if (h && !h.down && Math.hypot(h.x - zb.x, h.z - zb.z) < 1.3 && Math.abs(h.y + 1 - (zb.y + 1)) < 1.6) {
          this.grab(zb, h);
          return;
        }
        world.push(zb, RADIUS, 1.7, null);
        zb.gy = world.roofAt(zb.x, zb.z, zb.y);
        if (zb.y <= zb.gy && zb.vy <= 0) { zb.y = zb.gy; zb.vy = 0; zb.state = ST.WALK; }
        return;
      }
      case ST.PILE:
        return;
      case ST.CLIMB: {
        const c = zb.climb;
        const h = zb.target && zb.targetKind === 1 ? zb.target : null;
        if (!h || h.y < zb.y - 1 || Math.hypot(h.x - zb.x, h.z - zb.z) > 80) {
          zb.state = ST.WALK; zb.climb = null; zb.vy = 0;
          zb.x += c.nx * 0.4; zb.z += c.nz * 0.4;
          return;
        }
        zb.y += (zb.runner ? 3.4 : 1.5) * dt;
        zb.heading = Math.atan2(-c.nx, -c.nz);
        if (zb.y >= c.top) {
          zb.y = c.top;
          zb.x -= c.nx * 0.9;
          zb.z -= c.nz * 0.9;
          zb.state = ST.WALK;
          zb.climb = null;
        }
        zb.gy = zb.y;
        return;
      }
      default: break;
    }

    // WALK: chase, wander, leap, climb
    const tgt = zb.target;
    let dx = 0, dz = 0, speed = zb.runner ? zb.speed : zb.speed;
    if (tgt && zb.targetKind === 1) {
      dx = tgt.x - zb.x; dz = tgt.z - zb.z;
      const d = Math.hypot(dx, dz);
      const dy = tgt.y - zb.y;
      if (d < 1.15 && dy > -1.2 && dy < 1.6 && !tgt.down) {
        this.grab(zb, tgt);
        return;
      }
      // leap at low-flying heroes
      if (zb.runner && zb.leapCd <= 0 && d < 7.5 && d > 1 && dy > 1.2 && dy < 6.5) {
        this.leap(zb, tgt, d, dy);
        return;
      }
      // under a hovering hero: pile up on each other to reach them
      if (dy > 2.2 && dy < 45 && d < 4.5 && !tgt.grounded && this.freePileFor(zb, tgt)) return;
      if (d < 1.2) speed = 0;
      else if (!zb.runner && d < 12) speed *= 1.35;
    } else if (tgt && zb.targetKind === 2) {
      dx = tgt.x - zb.x; dz = tgt.z - zb.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.9 && tgt.placed) {
        this.infectCivilian(tgt);
        zb.target = null;
        zb.think = 1.5;
        speed = 0;
      }
      speed = zb.runner ? speed * 0.85 : speed;
    } else {
      zb.wander += (Math.random() - 0.5) * dt * 1.5;
      dx = Math.sin(zb.wander); dz = Math.cos(zb.wander);
      speed = Math.min(zb.speed, 1.0);
    }
    // heading for a pile already climbing this wall
    const goal = zb.pileGoal;
    if (goal) {
      if (!this.piles.includes(goal) || !tgt || tgt.key !== goal.heroKey) zb.pileGoal = null;
      else {
        const gx = goal.x + goal.nx * 1.2 - zb.x, gz = goal.z + goal.nz * 1.2 - zb.z;
        if (Math.hypot(gx, gz) < 2.3 && this.joinPile(zb, goal)) return;
        dx = gx; dz = gz;
        speed = zb.speed;
      }
    }
    const d = Math.hypot(dx, dz);
    if (d > 1e-3 && speed > 0) {
      const want = Math.atan2(dx, dz);
      zb.heading += wrap(want - zb.heading) * Math.min(1, dt * (zb.runner ? 7 : 3));
      const ax = Math.sin(zb.heading) * speed, az = Math.cos(zb.heading) * speed;
      const k = 1 - Math.exp(-dt * 5);
      zb.vx += (ax - zb.vx) * k;
      zb.vz += (az - zb.vz) * k;
    } else {
      const k = Math.exp(-dt * 6);
      zb.vx *= k; zb.vz *= k;
    }
    zb.x += zb.vx * dt;
    zb.z += zb.vz * dt;
    const contact = this._contact ??= { nx: 0, nz: 0, c: null };
    contact.c = null;
    const wall = world.push(zb, RADIUS, 1.7, contact);
    // a hero up on this building: pile up against the wall and climb over each other
    if (wall && tgt && zb.targetKind === 1 && tgt.y > zb.y + 2.5 && wall.maxY > zb.y + 1 && wall.maxY <= tgt.y + 4 && wall.maxY < 260) {
      if (this.wallPileFor(zb, contact, wall, tgt)) return;
    }
    this.gravity(zb, dt);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Piles: zombies climbing over each other. Each pile is a heap whose height grows with how many are in it; the
  // newest arrivals scramble to the top, burying the earlier ones, and whoever reaches the top goes over the roof
  // edge (wall piles) or leaps at the hero hovering above (free piles).
  pileHeight(n) {
    return n < 2 ? 0.3 : 1.2 * Math.pow(n - 1, 0.8);
  }

  joinPile(zb, pile) {
    if (pile.members.length >= PILE_MAX) return false;
    pile.members.push(zb);
    zb.state = ST.PILE;
    zb.pile = pile;
    zb.pileU = 0;
    zb.pileLat = rand(-1, 1);
    zb.pileAng = Math.random() * Math.PI * 2;
    zb.pileGoal = null;
    zb.vx = zb.vy = zb.vz = 0;
    return true;
  }

  wallPileFor(zb, contact, wall, tgt) {
    let best = null, bd = 22;
    for (const p of this.piles) {
      if (!p.wall || p.heroKey !== tgt.key || (p.c !== wall && p.members.length < 3)) continue;
      const d = Math.hypot(p.x - zb.x, p.z - zb.z);
      if (d < bd) { bd = d; best = p; }
    }
    if (best && bd < 2.3) return this.joinPile(zb, best);
    if (best) {
      zb.pileGoal = best;
      return false;
    }
    const p = {
      wall: true, c: wall, x: zb.x + contact.nx * 0.2, z: zb.z + contact.nz * 0.2, nx: contact.nx, nz: contact.nz,
      top: wall.maxY, g: zb.gy, heroKey: tgt.key, members: [], idle: 0, H: 0
    };
    this.piles.push(p);
    return this.joinPile(zb, p);
  }

  freePileFor(zb, tgt) {
    let p = this.piles.find((q) => !q.wall && q.heroKey === tgt.key);
    if (!p) {
      p = { wall: false, x: tgt.x, z: tgt.z, nx: 0, nz: 0, g: zb.gy, heroKey: tgt.key, members: [], idle: 0, H: 0 };
      this.piles.push(p);
    }
    return this.joinPile(zb, p);
  }

  // knocked off a collapsing pile
  tumble(zb, p) {
    zb.state = ST.KNOCK;
    zb.knockT = 1;
    zb.pile = null;
    const a = Math.random() * Math.PI * 2;
    zb.vx = Math.cos(a) * 3 + p.nx * 3;
    zb.vz = Math.sin(a) * 3 + p.nz * 3;
    zb.vy = 1.5;
  }

  updatePiles(dt, heroes) {
    let w = 0;
    for (const p of this.piles) {
      p.members = p.members.filter((z) => z.state === ST.PILE && z.pile === p);
      const h = heroes.find((q) => q.key === p.heroKey);
      let valid = !!h && !h.down && !h.dead;
      if (valid) {
        const d = Math.hypot(h.x - p.x, h.z - p.z);
        valid = p.wall ? h.y > p.top - 4 && d < 90 : h.y - p.g > 1.6 && d < 14 && !h.grounded;
      }
      p.idle = valid ? 0 : p.idle + dt;
      if (!p.members.length) continue;
      if (p.idle > 2.5) {
        for (const zb of p.members) this.tumble(zb, p);
        continue;
      }
      if (!p.wall && h) {
        const k = Math.min(1, dt * 1.1);
        p.x += (h.x - p.x) * k;
        p.z += (h.z - p.z) * k;
      }
      const n = p.members.length;
      // never taller than it needs to be: the ones on top are already grabbing
      const need = p.wall ? p.top - p.g + 0.5 : (h ? h.y - p.g - 0.4 : 1);
      const H = Math.max(0.3, Math.min(this.pileHeight(n), need));
      p.H = H;
      const R = p.wall ? H * 0.7 + 0.7 : H * 0.55 + 0.9;
      const tx = -p.nz, tz = p.nx;
      for (let i = 0; i < n; i++) {
        const zb = p.members[i];
        // arrival order sets the layer: the newest climb over everyone to the top
        const goal = n === 1 ? 0 : Math.sqrt((i + 0.5) / n);
        const rate = (zb.runner ? 2.6 : 1.1) * this.speedMul / Math.max(1.5, H);
        const du = goal - zb.pileU;
        zb.pileU += Math.sign(du) * Math.min(Math.abs(du), rate * dt);
        const u = zb.pileU;
        const r = R * (1 - u) + 0.25;
        if (p.wall) {
          const lat = zb.pileLat * R * 0.85 * (1 - u * 0.8);
          zb.x = p.x + p.nx * r + tx * lat;
          zb.z = p.z + p.nz * r + tz * lat;
          zb.heading = Math.atan2(-p.nx, -p.nz);
        } else {
          zb.x = p.x + Math.cos(zb.pileAng) * r;
          zb.z = p.z + Math.sin(zb.pileAng) * r;
          zb.heading = Math.atan2(p.x - zb.x, p.z - zb.z);
        }
        zb.y = p.g + u * H + Math.sin(zb.t * 9 + zb.id) * 0.04;
        zb.gy = zb.y;
      }
      // whoever reaches the top goes over: onto the roof, or at the hero hovering above
      p.exitT = (p.exitT || 0) - dt;
      if (p.exitT <= 0) {
        let top = null;
        for (const zb of p.members) if (zb.pileU > 0.94 && (!top || zb.pileU > top.pileU)) top = zb;
        if (top && p.wall && p.g + H + 2.8 >= p.top) {
          top.state = ST.WALK;
          top.pile = null;
          top.x = p.x - p.nx * 1.0;
          top.z = p.z - p.nz * 1.0;
          top.y = top.gy = p.top;
          top.think = 0;
          p.exitT = 0.22;
        } else if (top && !p.wall && h && h.y - top.y < 2.6 && Math.hypot(h.x - top.x, h.z - top.z) < 2.5) {
          // close enough to reach up and take hold
          top.pile = null;
          top.state = ST.WALK;
          this.grab(top, h);
          if (top.state !== ST.GRAB) { top.state = ST.PILE; top.pile = p; }
          p.exitT = 0.35;
        } else if (top && !p.wall && h && top.leapCd <= 0 && h.y - top.y < 5.5) {
          const dy = h.y - top.y;
          top.state = ST.WALK;
          top.pile = null;
          top.target = h;
          top.targetKind = 1;
          this.leap(top, h, Math.max(0.6, Math.hypot(h.x - top.x, h.z - top.z)), Math.max(1, dy));
          p.exitT = 0.3;
        }
      }
      this.piles[w++] = p;
    }
    this.piles.length = w;
  }

  // pile members climbing toward the hero with this key (for VEGA)
  climbersOn(key) {
    let n = 0;
    for (const p of this.piles) if (p.heroKey === key) n += p.members.length;
    return n;
  }

  gravity(zb, dt, splat = false) {
    zb.gy = this.world.roofAt(zb.x, zb.z, zb.y);
    if (zb.y > zb.gy + 0.02 || zb.vy > 0) {
      zb.vy -= GRAVITY * dt;
      zb.y += zb.vy * dt;
      if (zb.y <= zb.gy) {
        const impact = -zb.vy;
        zb.y = zb.gy;
        zb.vy = 0;
        const mine = (zb.hitT || 0) > 0;
        if (zb.state === ST.FROZEN && impact > 9) {
          this.shatter(zb);
          this.onKill(zb, mine, true);
        } else if (impact > 22 && zb.state !== ST.DEAD) {
          this.kill(zb, 0, 0);
          this.onKill(zb, mine, false);
        }
      }
    } else {
      zb.y = zb.gy;
      zb.vy = 0;
    }
  }

  grab(zb, h) {
    // take a free slot around the hero
    const used = new Set();
    for (const o of this.local) if (o.state === ST.GRAB && o.grabKey === h.key) used.add(o.slot);
    if (used.size >= GRAB_SLOTS) return;
    let slot = Math.floor(Math.random() * GRAB_SLOTS);
    while (used.has(slot)) slot = (slot + 1) % GRAB_SLOTS;
    zb.state = ST.GRAB;
    zb.grabKey = h.key;
    zb.slot = slot;
    zb.vx = zb.vy = zb.vz = 0;
    if (h.local) this.onSound('grab', zb.x, zb.y, zb.z);
  }

  release(zb, h = null) {
    zb.state = ST.KNOCK;
    zb.knockT = 0.6;
    zb.grabKey = null;
    if (h) {
      const dx = zb.x - h.x, dz = zb.z - h.z, d = Math.hypot(dx, dz) || 1;
      zb.vx = dx / d * 6; zb.vz = dz / d * 6; zb.vy = 2;
    }
  }

  leap(zb, h, d, dy) {
    const rise = Math.max(1, dy + 0.4);
    const vy = Math.sqrt(2 * GRAVITY * rise);
    const tApex = vy / GRAVITY;
    const sp = Math.min(11, d / Math.max(0.25, tApex));
    zb.vx = (h.x - zb.x) / d * sp + (h.vx || 0) * 0.5;
    zb.vz = (h.z - zb.z) / d * sp + (h.vz || 0) * 0.5;
    zb.vy = vy;
    zb.state = ST.LEAP;
    zb.leapCd = rand(2.2, 3.5);
    zb.t = 0;
    if (h.local) this.onSound('leap', zb.x, zb.y, zb.z);
  }

  // shove every local zombie within radius (shock pulse, nova, slam...). fn(zb, d) decides what happens
  each(cx, cy, cz, radius, fn, includeRemote = true) {
    const r2 = radius * radius;
    const visit = (zb) => {
      if (zb.state === ST.DEAD || zb.predDead) return;
      const dx = zb.x - cx, dy = (zb.y + 1) - cy, dz = zb.z - cz;
      const d2 = dx * dx + dy * dy * 0.5 + dz * dz;
      if (d2 <= r2) fn(zb, Math.sqrt(d2), dx, dz);
    };
    for (const zb of this.local.slice()) visit(zb);
    if (includeRemote) for (const zb of [...this.remote.values()]) visit(zb);
  }

  // all live zombies (for targeting)
  forEachLive(fn) {
    for (const zb of this.local) if (zb.state !== ST.DEAD) fn(zb);
    for (const zb of this.remote.values()) if (zb.state !== ST.DEAD && !zb.predDead) fn(zb);
  }

  countGrabbing(key, x, y, z) {
    let n = 0;
    for (const zb of this.local) if (zb.state === ST.GRAB && zb.grabKey === key) n++;
    for (const zb of this.remote.values()) {
      if (zb.state === ST.GRAB && !zb.predDead && Math.hypot(zb.x - x, zb.z - z) < 1.6 && Math.abs(zb.y - y) < 2.2) n++;
    }
    return n;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // networking: compact snapshot of local zombies near the given heroes
  snapshot(heroes, limit) {
    const scored = [];
    for (const zb of this.local) {
      let dmin = Infinity;
      for (const h of heroes) dmin = Math.min(dmin, Math.hypot(h.x - zb.x, h.z - zb.z));
      if (dmin < 200) scored.push([dmin, zb]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    const out = [];
    for (let i = 0; i < Math.min(limit, scored.length); i++) {
      const zb = scored[i][1];
      out.push(zb.id, Math.round(zb.x * 4), Math.round(zb.y * 4), Math.round(zb.z * 4), Math.round(wrap(zb.heading) * 40), zb.shattered ? 9 : zb.state, zb.runner ? 1 : 0);
    }
    return out;
  }

  applySnapshot(owner, arr) {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i + 6 < arr.length; i += 7) {
      const id = arr[i];
      const key = `${owner}:${id}`;
      let zb = this.remote.get(key);
      const x = arr[i + 1] / 4, y = arr[i + 2] / 4, z = arr[i + 3] / 4;
      if (![x, y, z].every(Number.isFinite)) continue;
      if (!zb) {
        if (this.remote.size >= MAX_REMOTE) continue;
        zb = {
          id, key, remote: true, owner, x, y, z, tx: x, ty: y, tz: z, th: 0, heading: arr[i + 4] / 40,
          state: ST.WALK, t: 0, age: 0, gy: y, runner: !!arr[i + 6], frozen: 0, chill: 0, predHp: 60,
          raise: rand(1.1, 1.45), rig: this.rigPool.pop() || this.makeRig()
        };
        zb.rig.placed = false;
        this.remote.set(key, zb);
      }
      zb.age = 0;
      if (zb.predDead || zb.state === ST.DEAD) continue;
      zb.tx = x; zb.ty = y; zb.tz = z;
      zb.th = arr[i + 4] / 40;
      const st = arr[i + 5];
      if (st === 9) { this.shatter(zb); continue; }
      if (st === ST.DEAD) { this.kill(zb); continue; }
      if (st !== zb.state) zb.t = st === ST.RISE ? 1.15 : 0;
      zb.state = st;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  render(dt, camera) {
    const cam = camera.position;
    this.crowd.begin();
    this.iceCrowd.begin();
    const draw = (zb) => {
      const dist = Math.hypot(zb.x - cam.x, zb.z - cam.z);
      _sphere.center.set(zb.x, zb.y + 1, zb.z);
      const visible = dist < 280 && _frustum.intersectsSphere(_sphere);
      const frozen = zb.state === ST.FROZEN;
      if (frozen && zb.rig.placed) {
        if (visible) this.iceCrowd.add(zb.rig, dist);
        return;
      }
      let dive = -1;
      if (zb.state === ST.DEAD) dive = Math.min(1.0, zb.t);
      else if (zb.state === ST.RISE) dive = Math.min(2.45, zb.t);
      else if (zb.state === ST.KNOCK || zb.state === ST.LEAP) dive = 0.3;
      else if (zb.state === ST.CLIMB) dive = 0.32;
      else if (zb.state === ST.PILE && (zb.pileU ?? 0) > 0.8) dive = 0.32;
      const heading = zb.state === ST.DEAD || zb.state === ST.RISE ? zb.heading : zb.heading;
      zb.rig.update(dt, zb.x, zb.z, heading, zGround, zb, 0, visible, dive);
      if (!visible) return;
      if (dive < 0 && zb.state !== ST.DEAD && !DEBUG.has('noreach')) reachArms(zb.rig, zb.state === ST.GRAB ? 1.55 : zb.state === ST.PILE ? 2.6 : zb.raise * (zb.runner ? 0.85 : 1));
      if (zb.shattered) return;
      if (frozen) this.iceCrowd.add(zb.rig, dist);
      else this.crowd.add(zb.rig, dist);
    };
    for (const zb of this.local) draw(zb);
    for (const zb of this.remote.values()) if (!zb.shattered) draw(zb);
    this.crowd.end();
    this.iceCrowd.end();
  }

  clear() {
    this.local.length = 0;
    this.piles.length = 0;
    this.remote.clear();
  }
}

export { ZombieSystem, ST as ZOMBIE_STATE };
