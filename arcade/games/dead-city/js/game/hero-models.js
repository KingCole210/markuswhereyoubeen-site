import * as THREE from 'three/webgpu';

// Procedural, articulated hero figures for the player and co-op partners. Every hero shares one skeleton
// (hips -> chest -> head / arms, hips -> legs) so the same pose code drives walking, hovering, flying, surfing,
// firing and lying down. Origin at the feet, facing +Z.

const HERO_KINDS = ['survivor', 'suit', 'paragon', 'coldfront'];

const HERO_INFO = {
  survivor: {
    name: 'Survivor',
    role: 'Regular guy with a gun',
    blurb: 'No suit, no powers. An M4, a pistol and his legs. Keep moving and never let them box you in.',
    maxHp: 100,
    abilities: ['Fire', 'Reload', 'Switch gun'],
    beam: 0xffd27a
  },
  suit: {
    name: 'Silver Suit',
    role: 'Armored flyer',
    blurb: 'Repulsors and missiles, but every shot and every second in the air burns thruster power.',
    maxHp: 100,
    abilities: ['Repulsor', 'Missiles', 'Shock Pulse'],
    beam: 0x9ff4ff
  },
  paragon: {
    name: 'Paragon',
    role: 'Super-strong flyer',
    blurb: 'Unlimited flight and the toughest body here. Heat vision overheats; the real damage is up close.',
    maxHp: 170,
    abilities: ['Heat Vision', 'Sky Slam', 'Haymaker'],
    beam: 0xff3b2a
  },
  coldfront: {
    name: 'Coldfront',
    role: 'Ice surfer',
    blurb: 'Surfs on his own ice. Freezes hordes solid; frozen zombies shatter from any hit.',
    maxHp: 110,
    abilities: ['Freeze Ray', 'Frost Nova', 'Shatter Kick'],
    beam: 0xbfe9ff
  }
};

const DOWN = new THREE.Vector3(0, -1, 0);
const FWD = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _e = new THREE.Euler();

const std = (color, metalness, roughness, extra = {}) => new THREE.MeshStandardNodeMaterial({ color, metalness, roughness, ...extra });
const glow = (color, intensity = 4) => new THREE.MeshStandardNodeMaterial({ color: 0x000000, emissive: color, emissiveIntensity: intensity, metalness: 0, roughness: 1 });
const flameMat = (color) => new THREE.MeshBasicNodeMaterial({ color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });

function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// A capsule hanging down from its pivot
function hanging(radius, length, mat, rx = radius, rz = radius) {
  const g = new THREE.CapsuleGeometry(radius, length, 4, 12);
  g.scale(rx / radius, 1, rz / radius);
  g.translate(0, -length / 2, 0);
  return mesh(g, mat);
}

const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

class HeroModel {
  constructor(kind) {
    this.kind = kind;
    this.root = new THREE.Group();
    this.root.name = `Hero-${kind}`;
    this.body = new THREE.Group();
    this.body.position.y = 0.98;
    this.root.add(this.body);
    this.chest = new THREE.Group();
    this.chest.position.y = 0.3;
    this.body.add(this.chest);
    this.head = new THREE.Group();
    this.head.position.y = 0.5;
    this.chest.add(this.head);

    this.shoulder = [];
    this.elbow = [];
    this.hip = [];
    this.knee = [];
    this.hands = [];
    this.feet = [];
    for (const side of [1, -1]) {
      const s = new THREE.Group();
      s.position.set(side * 0.215, 0.38, -0.01);
      this.chest.add(s);
      const e = new THREE.Group();
      e.position.y = -0.28;
      s.add(e);
      const hand = new THREE.Group();
      hand.position.y = -0.26;
      e.add(hand);
      this.shoulder.push(s);
      this.elbow.push(e);
      this.hands.push(hand);
      const h = new THREE.Group();
      h.position.set(side * 0.1, -0.03, 0);
      this.body.add(h);
      const k = new THREE.Group();
      k.position.y = -0.43;
      h.add(k);
      const f = new THREE.Group();
      f.position.y = -0.43;
      k.add(f);
      this.hip.push(h);
      this.knee.push(k);
      this.feet.push(f);
    }
    this.eyes = new THREE.Group();
    this.eyes.position.set(0, 0.11, 0.1);
    this.head.add(this.eyes);
    this.flames = [];
    this.cape = null;
    this.board = null;

    this.guns = null;
    this.weapon = 'm4';
    if (kind === 'survivor') this.buildSurvivor();
    else if (kind === 'suit') this.buildSuit();
    else if (kind === 'paragon') this.buildParagon();
    else this.buildColdfront();

    // pose state
    this.pitch = 0;
    this.roll = 0;
    this.phase = 0;
    this.gait = 0;
    this.time = Math.random() * 10;
    this.thigh = [0, 0];
    this.kneeBend = [0, 0];
    this.arm = [[0, 0, 0], [0, 0, 0]];
    this.elbowBend = [0, 0];
    this.downT = 0;
  }

  // ---------------------------------------------------------------------------------------------------------------
  buildSuit() {
    const plate = std(0xe3e7ed, 0.78, 0.26);
    const plateDark = std(0xa4abb6, 0.75, 0.34);
    const joint = std(0x23272e, 0.7, 0.55);
    const light = glow(0x7fe8ff, 5.5);
    this.lightMat = light;

    // pelvis & abdomen
    this.body.add(mesh(new THREE.CapsuleGeometry(0.15, 0.08, 4, 14).scale(1.15, 1, 0.8), joint, 0, 0.05, 0));
    this.body.add(mesh(new THREE.BoxGeometry(0.3, 0.12, 0.2), plateDark, 0, 0.02, 0.0));
    // torso: tapered chest plate, abdomen bands
    const torso = new THREE.CylinderGeometry(0.2, 0.15, 0.42, 14, 1);
    torso.scale(1.18, 1, 0.78);
    this.chest.add(mesh(torso, plate, 0, 0.2, 0));
    this.chest.add(mesh(new THREE.CapsuleGeometry(0.13, 0.1, 4, 12).scale(1.2, 1, 0.8), joint, 0, -0.06, 0));
    for (let i = 0; i < 3; i++) this.chest.add(mesh(new THREE.TorusGeometry(0.135 - i * 0.004, 0.012, 6, 18).rotateX(Math.PI / 2).scale(1.15, 1, 0.78), plateDark, 0, -0.1 + i * 0.06, 0));
    // chest light: a vertical bar with two side ribs (not a round reactor)
    this.chest.add(mesh(new THREE.BoxGeometry(0.035, 0.2, 0.02), light, 0, 0.24, 0.165));
    for (const s of [1, -1]) this.chest.add(mesh(new THREE.BoxGeometry(0.08, 0.016, 0.02).rotateZ(s * 0.35), light, s * 0.06, 0.29, 0.158));
    // collar & shoulder caps
    this.chest.add(mesh(new THREE.CylinderGeometry(0.075, 0.1, 0.08, 12), joint, 0, 0.44, 0));
    // back thruster pack
    const pack = mesh(new THREE.BoxGeometry(0.26, 0.26, 0.09), plateDark, 0, 0.25, -0.17);
    this.chest.add(pack);
    for (const s of [1, -1]) {
      this.chest.add(mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.12, 10), joint, s * 0.08, 0.1, -0.19));
      this.addFlame(this.chest, s * 0.08, 0.03, -0.19, 0.05, 0.5, 0x9fe9ff);
    }
    // helmet: smooth egg with a single horizontal visor slit
    const helm = new THREE.SphereGeometry(0.13, 20, 16);
    helm.scale(0.92, 1.12, 1.02);
    this.head.add(mesh(helm, plate, 0, 0.1, 0));
    this.head.add(mesh(new THREE.BoxGeometry(0.2, 0.026, 0.06), light, 0, 0.12, 0.1));
    this.head.add(mesh(new THREE.BoxGeometry(0.24, 0.03, 0.2), plateDark, 0, 0.03, -0.01));

    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const pad = new THREE.SphereGeometry(0.105, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
      pad.scale(1.1, 0.9, 1.0);
      this.shoulder[i].add(mesh(pad, plate, side * 0.02, 0.02, 0));
      this.shoulder[i].add(hanging(0.06, 0.16, joint));
      this.shoulder[i].add(hanging(0.07, 0.12, plate, 0.075, 0.07));
      this.elbow[i].add(mesh(new THREE.SphereGeometry(0.055, 10, 8), joint));
      this.elbow[i].add(hanging(0.072, 0.15, plate, 0.078, 0.072));
      const hand = mesh(new THREE.BoxGeometry(0.085, 0.1, 0.05), plateDark, 0, -0.04, 0);
      this.hands[i].add(hand);
      const palm = mesh(new THREE.CircleGeometry(0.026, 12).rotateX(Math.PI / 2), light, 0, -0.092, 0);
      this.hands[i].add(palm);
      this.addFlame(this.hands[i], 0, -0.1, 0, 0.035, 0.35, 0xbff6ff);

      this.hip[i].add(hanging(0.09, 0.2, joint));
      this.hip[i].add(hanging(0.1, 0.16, plate, 0.105, 0.11));
      this.knee[i].add(mesh(new THREE.SphereGeometry(0.07, 10, 8), plateDark));
      this.knee[i].add(hanging(0.08, 0.2, plate, 0.085, 0.09));
      const boot = mesh(new THREE.BoxGeometry(0.12, 0.1, 0.24), plateDark, 0, -0.03, 0.04);
      this.feet[i].add(boot);
      this.feet[i].add(mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.04, 10), joint, 0, -0.085, -0.02));
      this.addFlame(this.feet[i], 0, -0.1, -0.02, 0.055, 0.7, 0x9fe9ff);
    }
  }

  buildSurvivor() {
    const hoodie = std(0x4b5142, 0, 0.88);
    const vest = std(0x6e604a, 0.05, 0.8);
    const strap = std(0x2e2b26, 0.1, 0.7);
    const jeans = std(0x34445c, 0, 0.82);
    const skin = std(0xb68667, 0, 0.6);
    const hair = std(0x1c1611, 0, 0.85);
    const shoe = std(0x26272b, 0.1, 0.7);
    const sole = std(0xd9d5cc, 0, 0.8);

    this.body.add(mesh(new THREE.CapsuleGeometry(0.15, 0.08, 4, 14).scale(1.12, 1, 0.8), jeans, 0, 0.05, 0));
    this.body.add(mesh(new THREE.TorusGeometry(0.155, 0.018, 6, 20).rotateX(Math.PI / 2).scale(1.1, 1, 0.8), strap, 0, 0.11, 0));
    const torso = new THREE.CylinderGeometry(0.19, 0.165, 0.44, 14, 1);
    torso.scale(1.12, 1, 0.76);
    this.chest.add(mesh(torso, hoodie, 0, 0.2, 0));
    this.chest.add(mesh(new THREE.CapsuleGeometry(0.13, 0.1, 4, 12).scale(1.15, 1, 0.8), hoodie, 0, -0.06, 0));
    // plate carrier with two magazine pouches
    this.chest.add(mesh(new THREE.BoxGeometry(0.36, 0.3, 0.27), vest, 0, 0.22, 0));
    for (const x of [-0.07, 0.07]) this.chest.add(mesh(new THREE.BoxGeometry(0.06, 0.1, 0.04), strap, x, 0.12, 0.15));
    // hood bunched at the neck
    this.chest.add(mesh(new THREE.TorusGeometry(0.085, 0.035, 8, 16).rotateX(Math.PI / 2), hoodie, 0, 0.44, -0.02));
    this.chest.add(mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.08, 12), skin, 0, 0.46, 0));
    const headGeo = new THREE.SphereGeometry(0.112, 20, 16);
    headGeo.scale(0.9, 1.12, 1.0);
    this.head.add(mesh(headGeo, skin, 0, 0.1, 0));
    const hairGeo = new THREE.SphereGeometry(0.117, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.6);
    hairGeo.scale(0.95, 1.06, 1.05);
    const hairMesh = mesh(hairGeo, hair, 0, 0.115, -0.014);
    hairMesh.rotation.x = -0.35; // sits back over the crown and the back of the head
    this.head.add(hairMesh);
    // short beard
    this.head.add(mesh(new THREE.SphereGeometry(0.075, 12, 8, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5).scale(1.05, 0.9, 1.05), hair, 0, 0.06, 0.03));
    for (const sx of [1, -1]) this.head.add(mesh(new THREE.SphereGeometry(0.022, 8, 6), skin, sx * 0.1, 0.1, 0));

    for (let i = 0; i < 2; i++) {
      this.shoulder[i].add(mesh(new THREE.SphereGeometry(0.075, 12, 10), hoodie, 0, -0.01, 0));
      this.shoulder[i].add(hanging(0.065, 0.18, hoodie));
      this.elbow[i].add(hanging(0.058, 0.16, hoodie));
      this.hands[i].add(mesh(new THREE.SphereGeometry(0.05, 12, 10).scale(0.9, 1.15, 0.85), skin, 0, -0.035, 0));
      this.hip[i].add(hanging(0.085, 0.25, jeans));
      this.knee[i].add(hanging(0.07, 0.25, jeans));
      this.feet[i].add(mesh(new THREE.BoxGeometry(0.105, 0.08, 0.25), shoe, 0, -0.03, 0.045));
      this.feet[i].add(mesh(new THREE.BoxGeometry(0.11, 0.025, 0.26), sole, 0, -0.075, 0.045));
    }

    // guns, held in the right hand; built with the barrel along +Z, then turned to point down the forearm
    const metal = std(0x1d1f22, 0.65, 0.42);
    const poly = std(0x2a2b2e, 0.1, 0.7);
    const m4 = new THREE.Group();
    const part = (geo, mat, x, y, z, rx = 0) => { const m = mesh(geo, mat, x, y, z); m.rotation.x = rx; m4.add(m); return m; };
    part(new THREE.BoxGeometry(0.05, 0.07, 0.28), metal, 0, 0.045, 0.05);
    part(new THREE.BoxGeometry(0.056, 0.056, 0.22), poly, 0, 0.055, 0.29);
    part(new THREE.CylinderGeometry(0.011, 0.011, 0.2, 8).rotateX(Math.PI / 2), metal, 0, 0.058, 0.47);
    part(new THREE.CylinderGeometry(0.017, 0.017, 0.05, 8).rotateX(Math.PI / 2), metal, 0, 0.058, 0.58);
    part(new THREE.BoxGeometry(0.03, 0.13, 0.06), metal, 0, -0.04, 0.1, -0.22);
    part(new THREE.BoxGeometry(0.03, 0.085, 0.035), poly, 0, -0.025, -0.03, 0.3);
    part(new THREE.BoxGeometry(0.045, 0.06, 0.17), poly, 0, 0.03, -0.2);
    part(new THREE.BoxGeometry(0.036, 0.042, 0.07), metal, 0, 0.1, 0.07);
    m4.userData.muzzle = new THREE.Vector3(0, 0.058, 0.61);
    m4.userData.support = new THREE.Vector3(0, 0.03, 0.3);
    const pistol = new THREE.Group();
    const pp = (geo, mat, x, y, z, rx = 0) => { const m = mesh(geo, mat, x, y, z); m.rotation.x = rx; pistol.add(m); return m; };
    pp(new THREE.BoxGeometry(0.03, 0.036, 0.18), metal, 0, 0.045, 0.07);
    pp(new THREE.BoxGeometry(0.028, 0.1, 0.045), poly, 0, -0.01, -0.005, 0.25);
    pistol.userData.muzzle = new THREE.Vector3(0, 0.045, 0.17);
    pistol.userData.support = new THREE.Vector3(0, -0.02, 0.0);
    for (const g of [m4, pistol]) {
      g.rotation.x = Math.PI / 2; // +Z (barrel) -> -Y (down the forearm)
      g.position.set(0, -0.06, 0.01);
      this.hands[1].add(g);
    }
    this.guns = { m4, pistol };
    this.setWeapon('m4');
  }

  setWeapon(name) {
    if (!this.guns) return;
    this.weapon = name;
    this.guns.m4.visible = name === 'm4';
    this.guns.pistol.visible = name === 'pistol';
  }

  buildParagon() {
    const suit = std(0x2a2d33, 0.25, 0.4);
    const suitDark = std(0x16181c, 0.2, 0.55);
    const cape = std(0xe9e2d1, 0.0, 0.7, { side: THREE.DoubleSide });
    const boots = std(0xb8862e, 0.8, 0.32);
    const gold = std(0xd9a536, 0.85, 0.3, { emissive: 0xffb52a, emissiveIntensity: 0.25 });
    const skin = std(0xc69476, 0, 0.6);
    const hair = std(0x15100c, 0, 0.75);
    this.eyeMat = std(0x2a1a14, 0, 0.4, { emissive: 0xff2a14, emissiveIntensity: 0 });

    this.body.add(mesh(new THREE.CapsuleGeometry(0.16, 0.08, 4, 14).scale(1.2, 1, 0.82), suitDark, 0, 0.05, 0));
    this.body.add(mesh(new THREE.TorusGeometry(0.17, 0.024, 6, 20).rotateX(Math.PI / 2).scale(1.12, 1, 0.8), gold, 0, 0.11, 0));
    // heroic V torso
    const torso = new THREE.CylinderGeometry(0.235, 0.16, 0.46, 16, 1);
    torso.scale(1.22, 1, 0.78);
    this.chest.add(mesh(torso, suit, 0, 0.2, 0));
    this.chest.add(mesh(new THREE.CapsuleGeometry(0.14, 0.1, 4, 12).scale(1.2, 1, 0.82), suit, 0, -0.06, 0));
    // emblem: a forward chevron inside a shallow diamond (original mark)
    const emblem = new THREE.Shape();
    emblem.moveTo(0, 0.085); emblem.lineTo(0.1, 0); emblem.lineTo(0, -0.085); emblem.lineTo(-0.1, 0); emblem.closePath();
    const hole = new THREE.Path();
    hole.moveTo(0, 0.045); hole.lineTo(0.05, -0.015); hole.lineTo(0.03, -0.035); hole.lineTo(0, -0.0); hole.lineTo(-0.03, -0.035); hole.lineTo(-0.05, -0.015); hole.closePath();
    emblem.holes.push(hole);
    const emblemGeo = new THREE.ExtrudeGeometry(emblem, { depth: 0.012, bevelEnabled: false });
    this.chest.add(mesh(emblemGeo, gold, 0, 0.27, 0.17));
    this.chest.add(mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.09, 12), skin, 0, 0.45, 0));
    // head: face, hair swept back, eyes
    const headGeo = new THREE.SphereGeometry(0.115, 20, 16);
    headGeo.scale(0.9, 1.15, 1.0);
    this.head.add(mesh(headGeo, skin, 0, 0.1, 0));
    const hairGeo = new THREE.SphereGeometry(0.122, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55);
    hairGeo.scale(0.95, 1.05, 1.08);
    this.head.add(mesh(hairGeo, hair, 0, 0.125, -0.012));
    this.head.add(mesh(new THREE.BoxGeometry(0.09, 0.05, 0.08), skin, 0, 0.02, 0.04));
    for (const s of [1, -1]) this.eyes.add(mesh(new THREE.SphereGeometry(0.013, 8, 6), this.eyeMat, s * 0.035, 0, 0.002));

    for (let i = 0; i < 2; i++) {
      const pad = new THREE.SphereGeometry(0.105, 14, 10);
      pad.scale(1.05, 0.95, 0.95);
      this.shoulder[i].add(mesh(pad, suit, 0, -0.01, 0));
      this.shoulder[i].add(hanging(0.075, 0.17, suit, 0.08, 0.075));
      this.elbow[i].add(hanging(0.068, 0.15, suit));
      this.elbow[i].add(mesh(new THREE.CylinderGeometry(0.072, 0.064, 0.08, 12), suitDark, 0, -0.2, 0));
      this.hands[i].add(mesh(new THREE.SphereGeometry(0.055, 12, 10).scale(0.95, 1.15, 0.9), skin, 0, -0.035, 0));
      this.hip[i].add(hanging(0.095, 0.24, suit, 0.1, 0.1));
      this.knee[i].add(hanging(0.078, 0.14, suit));
      this.knee[i].add(mesh(new THREE.CylinderGeometry(0.075, 0.07, 0.24, 12), boots, 0, -0.33, 0));
      this.feet[i].add(mesh(new THREE.BoxGeometry(0.11, 0.09, 0.24), boots, 0, -0.03, 0.04));
    }

    // cape: a cloth strip animated on the CPU
    const capeGeo = new THREE.PlaneGeometry(0.6, 1.15, 5, 12);
    capeGeo.translate(0, -0.575, 0);
    this.capeRest = capeGeo.attributes.position.array.slice();
    const capeMesh = mesh(capeGeo, cape, 0, 0.4, -0.15);
    capeMesh.frustumCulled = false;
    this.chest.add(capeMesh);
    this.cape = capeMesh;
  }

  buildColdfront() {
    const suit = std(0xe4edf4, 0.18, 0.34);
    const panel = std(0x2f6f9c, 0.3, 0.38, { emissive: 0x3aa8ff, emissiveIntensity: 0.35 });
    const mask = std(0x1a2230, 0.2, 0.5);
    const skin = std(0x7a5440, 0, 0.6);
    const ice = std(0xc8ecff, 0.0, 0.06, { emissive: 0x58c8ff, emissiveIntensity: 0.55, transparent: true, opacity: 0.86 });
    const goggles = glow(0xa8ecff, 4.5);
    this.lightMat = goggles;

    this.body.add(mesh(new THREE.CapsuleGeometry(0.145, 0.08, 4, 14).scale(1.15, 1, 0.8), panel, 0, 0.05, 0));
    const torso = new THREE.CylinderGeometry(0.205, 0.15, 0.44, 14, 1);
    torso.scale(1.15, 1, 0.78);
    this.chest.add(mesh(torso, suit, 0, 0.2, 0));
    this.chest.add(mesh(new THREE.CapsuleGeometry(0.13, 0.1, 4, 12).scale(1.18, 1, 0.8), panel, 0, -0.06, 0));
    // diagonal ice-blue sash panel
    this.chest.add(mesh(new THREE.BoxGeometry(0.08, 0.5, 0.02).rotateZ(0.6), panel, 0, 0.2, 0.158));
    // crystal shoulder shards
    for (const s of [1, -1]) {
      for (let k = 0; k < 3; k++) {
        const shard = mesh(new THREE.OctahedronGeometry(0.06 - k * 0.012, 0).scale(0.6, 1.6, 0.6), ice, s * (0.2 + k * 0.035), 0.47 - k * 0.02, -0.03 + k * 0.03);
        shard.rotation.z = -s * (0.5 + k * 0.25);
        this.chest.add(shard);
      }
    }
    this.chest.add(mesh(new THREE.CylinderGeometry(0.068, 0.09, 0.09, 12), mask, 0, 0.45, 0));
    const headGeo = new THREE.SphereGeometry(0.115, 20, 16);
    headGeo.scale(0.9, 1.14, 1.0);
    this.head.add(mesh(headGeo, skin, 0, 0.1, 0));
    const hood = new THREE.SphereGeometry(0.124, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.62);
    hood.scale(0.96, 1.08, 1.06);
    this.head.add(mesh(hood, mask, 0, 0.115, -0.01));
    this.head.add(mesh(new THREE.BoxGeometry(0.19, 0.045, 0.05), goggles, 0, 0.115, 0.095));

    for (let i = 0; i < 2; i++) {
      this.shoulder[i].add(mesh(new THREE.SphereGeometry(0.09, 12, 10), suit, 0, -0.01, 0));
      this.shoulder[i].add(hanging(0.066, 0.17, suit));
      this.elbow[i].add(hanging(0.06, 0.12, suit));
      this.elbow[i].add(mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.12, 12), panel, 0, -0.18, 0));
      this.hands[i].add(mesh(new THREE.SphereGeometry(0.052, 12, 10).scale(0.95, 1.15, 0.9), panel, 0, -0.035, 0));
      this.addFlame(this.hands[i], 0, -0.09, 0, 0.03, 0.25, 0xc8f0ff);
      this.hip[i].add(hanging(0.088, 0.24, suit));
      this.knee[i].add(hanging(0.074, 0.18, suit));
      this.knee[i].add(mesh(new THREE.CylinderGeometry(0.078, 0.072, 0.16, 12), panel, 0, -0.34, 0));
      this.feet[i].add(mesh(new THREE.BoxGeometry(0.11, 0.09, 0.24), mask, 0, -0.03, 0.04));
    }

    // the ice board he surfs on: a faceted slab with a glowing core
    const board = new THREE.Group();
    const slab = new THREE.CylinderGeometry(0.42, 0.36, 0.09, 7, 1);
    slab.scale(0.75, 1, 1.9);
    board.add(mesh(slab, ice, 0, 0, 0));
    for (let k = 0; k < 4; k++) {
      const spike = mesh(new THREE.ConeGeometry(0.05, 0.3, 5), ice, (k % 2 ? 1 : -1) * 0.18, -0.08, -0.4 + k * 0.25);
      spike.rotation.x = Math.PI;
      board.add(spike);
    }
    board.position.y = 0.05;
    this.root.add(board);
    this.board = board;
  }

  addFlame(parent, x, y, z, radius, length, color) {
    // cone tip downwards: base at the nozzle (y = 0), tip at -length
    const geo = new THREE.ConeGeometry(radius, length, 10, 1, true);
    geo.translate(0, length / 2, 0);
    geo.rotateZ(Math.PI);
    const m = new THREE.Mesh(geo, flameMat(color));
    m.position.set(x, y, z);
    m.castShadow = false;
    m.renderOrder = 5;
    parent.add(m);
    this.flames.push(m);
    const core = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.5, length * 0.6, 8, 1, true).translate(0, length * 0.3, 0).rotateZ(Math.PI), flameMat(0xffffff));
    core.position.set(x, y, z);
    core.renderOrder = 6;
    parent.add(core);
    this.flames.push(core);
  }

  setFlames(throttle, flicker) {
    for (let i = 0; i < this.flames.length; i++) {
      const f = this.flames[i];
      const on = throttle > 0.02;
      f.visible = on;
      if (!on) continue;
      const s = throttle * (0.75 + flicker * 0.35 + ((i * 7.3) % 1) * 0.1);
      f.scale.set(0.8 + throttle * 0.3, s, 0.8 + throttle * 0.3);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  /**
   * s: { mode: 'ground'|'fly'|'fall'|'surf'|'down', speed, fwd (signed forward speed), vy, turn, boost, thrust,
   *      aim (world dir or null), firing, punchT, kickT, slam, pinned, beam }
   */
  pose(dt, s) {
    this.time += dt;
    const t = this.time;
    const kind = this.kind;
    const mode = s.mode;
    const speedN = Math.min(1, s.speed / 40);

    let pitch = 0, roll = 0, bodyY = 0.98;
    let thighT = [0, 0], kneeT = [0.04, 0.04];
    let armT = [[0.05, 0, 0.12], [0.05, 0, 0.12]]; // x (swing fwd -), y, z (out) per side, mirrored on z
    let elbowT = [0.15, 0.15];
    let gaitTarget = 0;

    if (mode === 'ground') {
      gaitTarget = Math.min(1, s.speed / 2.5);
      const run = Math.min(1, s.speed / 7);
      this.phase += dt * (1.6 + s.speed * 0.95);
      const sw = Math.sin(this.phase);
      const g = this.gait;
      pitch = 0.08 * run + (s.pinned ? 0.35 : 0);
      thighT = [sw * (0.55 + run * 0.35) * g, -sw * (0.55 + run * 0.35) * g];
      kneeT = [0.08 + Math.max(0, -sw) * (0.7 + run * 0.6) * g, 0.08 + Math.max(0, sw) * (0.7 + run * 0.6) * g];
      armT = [[-sw * 0.5 * g, 0, 0.12], [sw * 0.5 * g, 0, 0.12]];
      elbowT = [0.25 + run * 1.0, 0.25 + run * 1.0];
      bodyY = 0.98 - run * 0.05 - Math.abs(Math.cos(this.phase)) * 0.04 * g - (s.pinned ? 0.18 : 0);
      if (s.pinned) {
        kneeT = [0.9, 0.7];
        thighT = [-0.6, -0.3];
        armT = [[-1.2 + Math.sin(t * 13) * 0.3, 0, 0.6], [-1.0 + Math.cos(t * 11) * 0.3, 0, 0.6]];
      }
    } else if (mode === 'fly' || mode === 'surf') {
      const fwdN = Math.max(0, Math.min(1, s.fwd / 34));
      if (mode === 'surf') {
        pitch = 0.12 + fwdN * 0.25;
        roll = -s.turn * 0.35;
        thighT = [-0.45, 0.35];
        kneeT = [0.75, 0.55];
        armT = [[-0.2, 0, 1.15 + Math.sin(t * 2) * 0.05], [0.3, 0, 1.0]];
        elbowT = [0.3, 0.4];
        bodyY = 0.9;
      } else {
        // hover upright, lean into the flight with speed: horizontal at full speed
        pitch = fwdN * 1.3 + (s.boost ? 0.15 : 0) - Math.max(0, -s.fwd / 20) * 0.3;
        roll = -s.turn * (0.25 + fwdN * 0.4);
        const hover = 1 - fwdN;
        thighT = [0.1 * hover + Math.sin(t * 1.7) * 0.05 * hover, 0.18 * hover + Math.cos(t * 1.5) * 0.05 * hover];
        kneeT = [0.3 * hover + 0.04, 0.42 * hover + 0.04];
        if (kind === 'paragon') {
          // classic: one fist leading, the other arm along the body
          armT = [[-0.2 * hover - 2.9 * fwdN, 0, 0.25 * hover + 0.08], [0.15 * hover + 0.3 * fwdN, 0, 0.3 * hover + 0.1]];
          elbowT = [0.25 * hover + 0.05, 0.3 * hover + 0.1];
        } else {
          armT = [[-0.25 * hover + 0.35 * fwdN, 0, 0.42 * hover + 0.14], [-0.25 * hover + 0.35 * fwdN, 0, 0.42 * hover + 0.14]];
          elbowT = [0.25 * hover + 0.05, 0.25 * hover + 0.05];
        }
        if (s.vy > 4 && fwdN < 0.4) pitch -= 0.1;
      }
    } else if (mode === 'fall') {
      pitch = -0.2;
      thighT = [0.4 + Math.sin(t * 9) * 0.3, -0.1 + Math.cos(t * 8) * 0.3];
      kneeT = [0.6, 0.5];
      armT = [[-2.5 + Math.sin(t * 10) * 0.4, 0, 0.6], [-2.3 + Math.cos(t * 9) * 0.4, 0, 0.6]];
      elbowT = [0.4, 0.4];
    } else if (mode === 'down') {
      pitch = -1.48;
      bodyY = 0.2;
      thighT = [-0.05, 0.1];
      kneeT = [0.2, 0.05];
      armT = [[-0.3, 0, 0.9], [0.1, 0, 0.7]];
      elbowT = [0.5, 0.2];
    }

    // survivor: rifle held at low ready when not aiming
    if (kind === 'survivor' && mode !== 'down' && !s.aim) {
      armT[1] = [-0.75, 0, 0.18];
      elbowT[1] = 1.25;
      armT[0] = [-0.95, 0, -0.1];
      elbowT[0] = 1.1;
    }

    // melee overlays
    if (s.punchT > 0) {
      const k = Math.sin(Math.min(1, s.punchT / 0.25) * Math.PI);
      armT[1] = [-1.55 * k + armT[1][0] * (1 - k), 0, 0.05];
      elbowT[1] = 0.1;
      roll += 0.25 * k;
    }
    if (s.kickT > 0) {
      const k = Math.sin(Math.min(1, s.kickT / 0.3) * Math.PI);
      thighT[1] = -1.5 * k + thighT[1] * (1 - k);
      kneeT[1] = 0.1;
      pitch -= 0.25 * k;
    }
    if (s.slam) {
      pitch = 0.3;
      armT = [[-2.9, 0, 0.2], [-2.9, 0, 0.2]];
      elbowT = [0.1, 0.1];
      thighT = [-0.2, -0.2];
      kneeT = [0.6, 0.6];
    }

    const r = 10;
    this.gait = damp(this.gait, gaitTarget, 6, dt);
    this.pitch = damp(this.pitch, pitch, mode === 'down' ? 6 : 5, dt);
    this.roll = damp(this.roll, roll, 5, dt);
    this.body.position.y = damp(this.body.position.y, bodyY, 8, dt);
    this.body.rotation.set(this.pitch, 0, this.roll);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      this.thigh[i] = damp(this.thigh[i], thighT[i], r, dt);
      this.kneeBend[i] = damp(this.kneeBend[i], kneeT[i], r, dt);
      this.hip[i].rotation.set(-this.thigh[i], 0, 0);
      this.knee[i].rotation.set(this.kneeBend[i], 0, 0);
      this.feet[i].rotation.set(mode === 'fly' ? 0.5 * Math.min(1, s.speed / 30) : -this.kneeBend[i] * 0.3 + this.thigh[i] * 0.2, 0, 0);
      for (let a = 0; a < 3; a++) this.arm[i][a] = damp(this.arm[i][a], armT[i][a], r, dt);
      this.elbowBend[i] = damp(this.elbowBend[i], elbowT[i], r, dt);
      this.shoulder[i].rotation.set(this.arm[i][0], 0, side * this.arm[i][2]);
      this.shoulder[i].quaternion.setFromEuler(_e.set(this.arm[i][0], 0, side * this.arm[i][2], 'XYZ'));
      this.elbow[i].rotation.set(-this.elbowBend[i], 0, 0);
    }
    this.head.rotation.set(mode === 'fly' ? -this.pitch * 0.55 : mode === 'down' ? 0.3 : 0, 0, 0);

    // aiming: point the right arm (suit / coldfront) or the head (paragon heat vision) along the aim
    if (s.aim && mode !== 'down') {
      this.root.updateMatrixWorld(true);
      if (kind === 'paragon') {
        this.head.parent.getWorldQuaternion(_q);
        _v.copy(s.aim).applyQuaternion(_q.invert()).normalize();
        _q2.setFromUnitVectors(FWD, _v);
        this.head.quaternion.slerp(_q2, 0.8);
      } else if (!(s.kickT > 0) && !(s.punchT > 0)) {
        this.chest.getWorldQuaternion(_q);
        _v.copy(s.aim).applyQuaternion(_q.invert()).normalize();
        _q2.setFromUnitVectors(DOWN, _v);
        this.shoulder[1].quaternion.copy(_q2);
        this.elbow[1].rotation.set(0, 0, 0);
        this.hands[1].rotation.set(0, 0, 0);
        // the support hand reaches for the handguard
        if (this.guns) {
          this.root.updateMatrixWorld(true);
          const gun = this.guns[this.weapon];
          const target = gun.localToWorld(_v.copy(gun.userData.support));
          const sh = this.shoulder[0].getWorldPosition(new THREE.Vector3());
          this.chest.getWorldQuaternion(_q);
          target.sub(sh).applyQuaternion(_q.invert()).normalize();
          this.shoulder[0].quaternion.setFromUnitVectors(DOWN, target);
          this.elbow[0].rotation.set(0, 0, 0);
        }
      }
    }

    // flames / board / eyes
    const flicker = Math.sin(t * 61) * 0.5 + Math.sin(t * 37) * 0.5;
    if (kind === 'suit') this.setFlames(mode === 'fly' ? Math.max(0.35, s.thrust) : mode === 'fall' ? s.thrust * 0.5 : 0, flicker);
    else if (kind === 'coldfront') this.setFlames(s.firing ? 0.9 : 0, flicker);
    if (this.board) {
      const surf = mode === 'surf';
      this.board.visible = surf;
      this.board.rotation.set(this.pitch * 0.5, 0, this.roll * 0.6);
      this.board.position.y = 0.04;
    }
    if (this.eyeMat) this.eyeMat.emissiveIntensity = s.beam ? 9 : 0.0;
    if (this.cape) this.animateCape(dt, s, t);
  }

  animateCape(dt, s, t) {
    const pos = this.cape.geometry.attributes.position;
    const a = pos.array;
    const rest = this.capeRest;
    const flow = Math.min(1, s.speed / 30);
    const lift = 0.12 + flow * 0.35 + (s.mode === 'fall' ? 0.5 : 0);
    for (let i = 0; i < a.length; i += 3) {
      const v = -rest[i + 1] / 1.15; // 0 top .. 1 bottom
      const x = rest[i];
      const ang = lift * v + 0.05;
      const ripple = Math.sin(t * (5 + flow * 9) + v * 7 + x * 4) * (0.03 + flow * 0.07) * v;
      a[i] = x * (1 + v * 0.25);
      a[i + 1] = -Math.cos(ang) * v * 1.15;
      a[i + 2] = -Math.sin(ang) * v * 1.15 + ripple;
    }
    pos.needsUpdate = true;
    this.cape.geometry.computeVertexNormals();
  }

  // World position of the beam origin: right palm (suit / coldfront) or between the eyes (paragon)
  muzzle(out) {
    this.root.updateMatrixWorld(true);
    if (this.kind === 'paragon') return this.eyes.getWorldPosition(out);
    if (this.guns) {
      const gun = this.guns[this.weapon];
      return gun.localToWorld(out.copy(gun.userData.muzzle));
    }
    return this.hands[1].getWorldPosition(out).addScaledVector(_v.set(0, -0.1, 0).applyQuaternion(this.hands[1].getWorldQuaternion(_q)), 1);
  }
}

export { HeroModel, HERO_KINDS, HERO_INFO };
