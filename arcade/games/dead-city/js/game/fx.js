import * as THREE from 'three/webgpu';

// Pooled visual effects: beams, flashes, shock rings, particle bursts, ice trails and missile bodies.
// Everything lives under one group that the frame loop updates once per frame.

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

const additive = (color = 0xffffff) => new THREE.MeshBasicNodeMaterial({
  color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false
});

class Pool {
  constructor(count, make) {
    this.items = Array.from({ length: count }, (_, i) => make(i));
    this.next = 0;
  }
  take() {
    // reuse the first free item, else the oldest
    for (let n = 0; n < this.items.length; n++) {
      const it = this.items[(this.next + n) % this.items.length];
      if (it.life <= 0) {
        this.next = (this.next + n + 1) % this.items.length;
        return it;
      }
    }
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    return it;
  }
}

class Particles {
  constructor(group, max, material, geometry) {
    this.max = max;
    this.mesh = new THREE.InstancedMesh(geometry, material, max);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    for (let i = 0; i < max; i++) this.mesh.setColorAt(i, _c.set(0xffffff));
    group.add(this.mesh);
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.col = new Float32Array(max * 3);
    this.n = 0;
  }
  spawn(x, y, z, vx, vy, vz, life, size, gravity, color) {
    let i = this.n;
    if (i >= this.max) {
      i = Math.floor(Math.random() * this.max);
    } else this.n++;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.life[i] = this.maxLife[i] = life;
    this.size[i] = size;
    this.grav[i] = gravity;
    _c.set(color);
    this.col[i * 3] = _c.r; this.col[i * 3 + 1] = _c.g; this.col[i * 3 + 2] = _c.b;
  }
  update(dt) {
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const life = this.life[i] - dt;
      if (life <= 0) continue;
      // compact in place
      if (w !== i) {
        for (let k = 0; k < 3; k++) {
          this.p[w * 3 + k] = this.p[i * 3 + k];
          this.v[w * 3 + k] = this.v[i * 3 + k];
          this.col[w * 3 + k] = this.col[i * 3 + k];
        }
        this.maxLife[w] = this.maxLife[i];
        this.size[w] = this.size[i];
        this.grav[w] = this.grav[i];
      }
      this.life[w] = life;
      const o = w * 3;
      this.v[o + 1] -= this.grav[w] * dt;
      const drag = Math.exp(-dt * 1.5);
      this.v[o] *= drag; this.v[o + 2] *= drag;
      this.p[o] += this.v[o] * dt;
      this.p[o + 1] += this.v[o + 1] * dt;
      this.p[o + 2] += this.v[o + 2] * dt;
      if (this.p[o + 1] < 0.05 && this.grav[w] > 0) {
        this.p[o + 1] = 0.05;
        this.v[o + 1] *= -0.25;
        this.v[o] *= 0.5; this.v[o + 2] *= 0.5;
      }
      w++;
    }
    this.n = w;
    for (let i = 0; i < w; i++) {
      const k = this.life[i] / this.maxLife[i];
      const s = this.size[i] * (0.35 + 0.65 * k);
      _m.makeScale(s, s, s);
      _m.setPosition(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]);
      this.mesh.setMatrixAt(i, _m);
      _c.setRGB(this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2]);
      this.mesh.setColorAt(i, _c);
    }
    this.mesh.count = w;
    if (w) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }
}

class FX {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'GameFX';
    scene.add(this.group);

    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).translate(0, 0.5, 0);
    this.beams = new Pool(40, () => {
      const m = new THREE.Mesh(beamGeo, additive());
      m.visible = false;
      m.renderOrder = 10;
      m.frustumCulled = false;
      this.group.add(m);
      return { mesh: m, life: 0, max: 1, width: 0.05 };
    });

    const sphere = new THREE.SphereGeometry(1, 14, 10);
    this.flashes = new Pool(32, () => {
      const m = new THREE.Mesh(sphere, additive());
      m.visible = false;
      m.renderOrder = 9;
      this.group.add(m);
      return { mesh: m, life: 0, max: 1, size: 1, grow: 1 };
    });

    const ringGeo = new THREE.RingGeometry(0.86, 1, 56).rotateX(-Math.PI / 2);
    this.rings = new Pool(16, () => {
      const m = new THREE.Mesh(ringGeo, additive());
      m.material.side = THREE.DoubleSide;
      m.visible = false;
      m.renderOrder = 9;
      this.group.add(m);
      return { mesh: m, life: 0, max: 1, radius: 1 };
    });

    // missiles: dark body + bright exhaust
    const bodyGeo = new THREE.CylinderGeometry(0.05, 0.07, 0.55, 8).rotateX(Math.PI / 2);
    const bodyMat = new THREE.MeshStandardNodeMaterial({ color: 0x9aa2ad, metalness: 0.9, roughness: 0.35 });
    const exhaustMat = additive(0xffc27a);
    exhaustMat.color.multiplyScalar(4);
    this.missiles = new Pool(16, () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(bodyGeo, bodyMat));
      const ex = new THREE.Mesh(sphere, exhaustMat);
      ex.scale.setScalar(0.11);
      ex.position.z = -0.32;
      g.add(ex);
      g.visible = false;
      this.group.add(g);
      return { mesh: g, life: 0 };
    });

    this.glow = new Particles(this.group, 900, new THREE.MeshBasicNodeMaterial({
      color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
    }), new THREE.IcosahedronGeometry(1, 0));
    this.chunks = new Particles(this.group, 900, new THREE.MeshStandardNodeMaterial({
      color: 0xffffff, metalness: 0, roughness: 0.6
    }), new THREE.IcosahedronGeometry(1, 0));
    this.chunks.mesh.castShadow = false;

    // ice trail slabs (Coldfront's path through the air)
    const iceMat = new THREE.MeshStandardNodeMaterial({
      color: 0xcdeeff, metalness: 0, roughness: 0.08, emissive: 0x3db6ff, emissiveIntensity: 0.45, transparent: true, opacity: 0.8
    });
    this.iceMax = 360;
    this.ice = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), iceMat, this.iceMax);
    this.ice.frustumCulled = false;
    this.ice.count = 0;
    this.group.add(this.ice);
    this.iceSegs = [];
  }

  beam(from, to, color, width = 0.05, life = 0.1, intensity = 6) {
    const b = this.beams.take();
    _v.subVectors(to, from);
    const len = _v.length();
    if (len < 0.01) return;
    b.mesh.position.copy(from);
    b.mesh.quaternion.setFromUnitVectors(UP, _v.multiplyScalar(1 / len));
    b.mesh.scale.set(width, len, width);
    b.mesh.material.color.set(color).multiplyScalar(intensity);
    b.mesh.material.opacity = 1;
    b.mesh.visible = true;
    b.life = b.max = life;
    b.width = width;
  }

  flash(pos, color, size = 0.6, life = 0.15, intensity = 5, grow = 1.6) {
    const f = this.flashes.take();
    f.mesh.position.copy(pos);
    f.mesh.material.color.set(color).multiplyScalar(intensity);
    f.mesh.material.opacity = 1;
    f.mesh.visible = true;
    f.mesh.scale.setScalar(size);
    f.life = f.max = life;
    f.size = size;
    f.grow = grow;
  }

  ring(pos, color, radius, life = 0.45, intensity = 4) {
    const r = this.rings.take();
    r.mesh.position.copy(pos);
    r.mesh.position.y += 0.15;
    r.mesh.material.color.set(color).multiplyScalar(intensity);
    r.mesh.material.opacity = 1;
    r.mesh.visible = true;
    r.mesh.scale.setScalar(0.3);
    r.life = r.max = life;
    r.radius = radius;
  }

  // spray of particles; `glowing` uses the additive system
  burst(pos, color, count, speed, { life = 0.6, size = 0.08, gravity = 12, up = 0.5, glowing = false, dir = null } = {}) {
    const sys = glowing ? this.glow : this.chunks;
    for (let i = 0; i < count; i++) {
      let vx = (Math.random() * 2 - 1), vy = (Math.random() * 2 - 1) + up, vz = (Math.random() * 2 - 1);
      if (dir) { vx += dir.x * 1.5; vy += dir.y * 1.5; vz += dir.z * 1.5; }
      const l = Math.hypot(vx, vy, vz) || 1;
      const sp = speed * (0.4 + Math.random() * 0.6);
      sys.spawn(pos.x, pos.y, pos.z, vx / l * sp, vy / l * sp, vz / l * sp,
        life * (0.6 + Math.random() * 0.6), size * (0.6 + Math.random() * 0.8), gravity, color);
    }
  }

  takeMissile() {
    const m = this.missiles.take();
    m.life = 1;
    m.mesh.visible = true;
    return m;
  }

  releaseMissile(m) {
    m.life = 0;
    m.mesh.visible = false;
  }

  iceSegment(x, y, z, heading, life = 5) {
    if (this.iceSegs.length >= this.iceMax) this.iceSegs.shift();
    this.iceSegs.push({ x, y, z, heading, life, max: life, w: 0.9 + Math.random() * 0.3 });
  }

  update(dt) {
    for (const b of this.beams.items) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) { b.mesh.visible = false; continue; }
      const k = b.life / b.max;
      b.mesh.material.opacity = k;
      b.mesh.scale.x = b.mesh.scale.z = b.width * (0.4 + 0.6 * k);
    }
    for (const f of this.flashes.items) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) { f.mesh.visible = false; continue; }
      const k = f.life / f.max;
      f.mesh.material.opacity = k * k;
      f.mesh.scale.setScalar(f.size * (1 + (1 - k) * f.grow));
    }
    for (const r of this.rings.items) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) { r.mesh.visible = false; continue; }
      const k = r.life / r.max;
      r.mesh.material.opacity = k;
      r.mesh.scale.setScalar(Math.max(0.3, r.radius * (1 - k * k)));
    }
    this.glow.update(dt);
    this.chunks.update(dt);

    let w = 0;
    for (let i = 0; i < this.iceSegs.length; i++) {
      const s = this.iceSegs[i];
      s.life -= dt;
      if (s.life <= 0) continue;
      this.iceSegs[w++] = s;
    }
    this.iceSegs.length = w;
    for (let i = 0; i < w; i++) {
      const s = this.iceSegs[i];
      const k = Math.min(1, s.life / 1.2);
      _q.setFromAxisAngle(UP, s.heading);
      _s.set(s.w * k, 0.12 * k, 1.5);
      _m.compose(_v.set(s.x, s.y, s.z), _q, _s);
      this.ice.setMatrixAt(i, _m);
    }
    this.ice.count = w;
    if (w) this.ice.instanceMatrix.needsUpdate = true;
  }
}

export { FX };
