// Geometry queries over the city's building colliders: rooftops to stand on, walls to push out of and climb,
// and line of sight for shots. Colliders are axis-aligned boxes or oriented boxes (obb) with minY / maxY.

function createWorld(controllers) {
  const near = (x, z, r) => controllers.nearColliders(x, z, r).slice();

  // local coordinates of (x, z) in the collider's frame: [lx, lz, hx, hz, cs, sn]
  function local(c, x, z, out) {
    const o = c.obb;
    const cs = o ? o.cs : 1, sn = o ? o.sn : 0;
    const hx = o ? o.hx : (c.maxX - c.minX) * 0.5;
    const hz = o ? o.hz : (c.maxZ - c.minZ) * 0.5;
    const dx = x - (o ? o.cx : (c.minX + c.maxX) * 0.5);
    const dz = z - (o ? o.cz : (c.minZ + c.maxZ) * 0.5);
    out[0] = dx * cs - dz * sn;
    out[1] = dx * sn + dz * cs;
    out[2] = hx; out[3] = hz; out[4] = cs; out[5] = sn;
    return out;
  }
  const L = new Float64Array(6);

  function inside(c, x, z, pad = 0) {
    if (x < c.minX - pad || x > c.maxX + pad || z < c.minZ - pad || z > c.maxZ + pad) return false;
    local(c, x, z, L);
    return Math.abs(L[0]) <= L[2] + pad && Math.abs(L[1]) <= L[3] + pad;
  }

  // Highest surface under (x, z) at or below y + step: a roof, a setback, or the street / sidewalk
  function roofAt(x, z, y, step = 0.7) {
    let g = controllers.getGroundHeight(x, z, 'person');
    const list = controllers.nearColliders(x, z, 0.5);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.maxY <= g || c.maxY > y + step || c.maxY > 600) continue;
      if (inside(c, x, z)) g = c.maxY;
    }
    return g;
  }

  // Push a circle (feet at y, `height` tall) out of walls. Returns the collider it touched last (to climb), with
  // the outward normal in out.nx / out.nz.
  function push(p, radius, height, out) {
    let hit = null;
    const list = near(p.x, p.z, radius + 1);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (p.y >= c.maxY - 0.05 || p.y + height <= (c.minY ?? 0)) continue;
      if (p.x + radius <= c.minX || p.x - radius >= c.maxX || p.z + radius <= c.minZ || p.z - radius >= c.maxZ) continue;
      local(c, p.x, p.z, L);
      const [lx, lz, hx, hz, cs, sn] = L;
      const qx = lx - Math.max(-hx, Math.min(hx, lx));
      const qz = lz - Math.max(-hz, Math.min(hz, lz));
      const d = Math.hypot(qx, qz);
      let nx = 0, nz = 0, depth = 0;
      if (d >= radius) continue;
      if (d > 0) {
        nx = qx / d; nz = qz / d; depth = radius - d;
      } else if (hx - Math.abs(lx) <= hz - Math.abs(lz)) {
        nx = lx <= 0 ? -1 : 1; depth = hx - Math.abs(lx) + radius;
      } else {
        nz = lz <= 0 ? -1 : 1; depth = hz - Math.abs(lz) + radius;
      }
      const wx = nx * cs + nz * sn, wz = -nx * sn + nz * cs;
      p.x += wx * depth;
      p.z += wz * depth;
      hit = c;
      if (out) { out.nx = wx; out.nz = wz; out.c = c; }
    }
    return hit;
  }

  // Is the straight line between two points clear of buildings? Samples every 2.5 m.
  function lineOfSight(ax, ay, az, bx, by, bz) {
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    const n = Math.max(1, Math.ceil(len / 2.5));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
      const list = controllers.nearColliders(x, z, 0);
      for (let k = 0; k < list.length; k++) {
        const c = list[k];
        if (y > c.maxY || y < (c.minY ?? 0)) continue;
        if (inside(c, x, z)) return false;
      }
    }
    return true;
  }

  // First point along a ray (max `range`) that enters a building, or null
  function rayHit(ax, ay, az, dx, dy, dz, range, out) {
    const n = Math.ceil(range / 2);
    for (let i = 1; i <= n; i++) {
      const t = (i / n) * range;
      const x = ax + dx * t, y = ay + dy * t, z = az + dz * t;
      if (y <= controllers.getGroundHeight(x, z, 'person')) {
        out.set(x, Math.max(0, y), z);
        return t;
      }
      const list = controllers.nearColliders(x, z, 0);
      for (let k = 0; k < list.length; k++) {
        const c = list[k];
        if (y > c.maxY || y < (c.minY ?? 0)) continue;
        if (inside(c, x, z)) {
          out.set(x, y, z);
          return t;
        }
      }
    }
    return null;
  }

  // Is this spot free of buildings (for spawning)?
  function clear(x, z, radius = 0.6) {
    const list = controllers.nearColliders(x, z, radius);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if ((c.minY ?? 0) > 2.5) continue;
      if (inside(c, x, z, radius)) return false;
    }
    return true;
  }

  return { inside, roofAt, push, lineOfSight, rayHit, clear };
}

export { createWorld };
