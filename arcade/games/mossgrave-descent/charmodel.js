/* charmodel.js: skinned Quaternius "Universal Base Characters" (CC0) for Mossgrave, Three.js r128.
   Classic script (no modules). Needs the global THREE and THREE.GLTFLoader (examples/js/loaders/GLTFLoader.js).

   How it works
   - makeSkinnedHuman()/buildHumanSkinned() return the same parts the procedural buildHuman() returns:
     {root, body, torso, lL, lR, aR:{p,el,hold,hand}, aL:{...}, head, hair}. Every part except root/body is an
     invisible Object3D "proxy" placed on the real joint. The game keeps writing rotations to the proxies.
   - Each frame, while three updates world matrices (the model's updateMatrixWorld is hooked, so no extra call
     is needed), the proxy rotations are copied onto the real bones: torso -> spine_01 (rigid upper body),
     arm p -> upperarm, arm el -> lowerarm (+hand), legs -> thigh/calf/foot with a two-bone knee solve that keeps
     feet on the floor (crouch, slide) and bends the knee a little on the back swing.
   - Weapons go on aR.hold / aL.hold exactly as before; the proxies sit on the real hand, so items land in the
     real palm. Things the game adds to torso (race bits, eye rings) are re-parented under torso's "head fit"
     child, which maps the old cartoon-head coordinates onto the real head.
   - Skin/shirt/pants/boots/belt are painted by a small shader from per-vertex region masks, and their colors
     are the game's own material colors (live), so applyRaceLook's skinMat.color.setHex() and ALIEN_CLOTH work. */
(function () {
  'use strict';
  var T = window.THREE;
  if (!T) { console.warn('charmodel: THREE missing'); return; }
  var CM = window.CharModel = window.CharModel || {};
  CM.version = 2;
  CM.ready = false;
  CM.enabled = true;
  CM.assets = {};
  CM.EYE_Y = 1.61;      // eye height of the procedural body (torso pivot .82 + .792)
  CM.TORSO_Y = 0.82;    // procedural torso / leg pivot height; race bits and eye rings use this origin
  CM.ARM_ABD = 0.13;    // radians the upper arm hangs out from the body at rest (keeps hands off the hips)
  CM.playerSex = 'm';
  CM.playerHair = null; // null = default per sex
  CM.HAIRS = ['buzzed', 'buzzedF', 'parted', 'long', 'buns', 'beard', 'none'];
  var _cb = [];
  CM.onReady = function (fn) { if (CM.ready) fn(); else _cb.push(fn); };

  // ---------------------------------------------------------------- loading
  function b64buf(s) { var bin = atob(s), n = bin.length, u = new Uint8Array(n); for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
  function loader() {
    if (!T.GLTFLoader) throw new Error('charmodel: THREE.GLTFLoader missing (load examples/js/loaders/GLTFLoader.js)');
    return new T.GLTFLoader();
  }
  function parseBuf(buf) { return new Promise(function (res, rej) { loader().parse(buf, '', res, rej); }); }
  function loadUrl(url) { return new Promise(function (res, rej) { loader().load(url, res, undefined, rej); }); }
  function getOne(key, opt) {
    var emb = window.CHAR_ASSETS && window.CHAR_ASSETS[key];
    var url = (opt.base || '') + key + '.glb';
    CM.sources = CM.sources || {};
    if (emb && opt.preferEmbedded !== false) { CM.sources[key] = 'embedded'; return parseBuf(b64buf(emb)); }
    CM.sources[key] = url;
    return loadUrl(url).catch(function (e) { if (emb) { CM.sources[key] = 'embedded (url failed)'; return parseBuf(b64buf(emb)); } throw e; });
  }
  /* CharModel.load({base:'./', preferEmbedded:true}) -> Promise<boolean>. Uses window.CHAR_ASSETS (charassets.js)
     when present, otherwise fetches body_m.glb, body_f.glb, hair.glb from `base`. Never throws: on failure
     CM.ready stays false and the game keeps its procedural bodies. */
  CM.load = function (opt) {
    opt = opt || {};
    if (CM._loading) return CM._loading;
    var t0 = performance.now();
    CM._loading = Promise.all([getOne('body_m', opt), getOne('body_f', opt), getOne('hair', opt)]).then(function (r) {
      CM.assets.m = prepBody(r[0], 'm'); CM.assets.f = prepBody(r[1], 'f'); CM.assets.hair = prepHair(r[2]);
      fitHair();
      CM.ready = true; CM.loadMs = Math.round(performance.now() - t0);
      _cb.splice(0).forEach(function (f) { try { f(); } catch (e) { console.error(e); } });
      return true;
    }).catch(function (e) { console.warn('charmodel: load failed, keeping procedural bodies', e); CM._loading = null; return false; });
    return CM._loading;
  };

  // ---------------------------------------------------------------- asset preparation
  var V = function (x, y, z) { return new T.Vector3(x || 0, y || 0, z || 0); };
  var FINGERS = ['index', 'middle', 'ring', 'pinky', 'thumb'];
  function cl3(v) { return Math.max(-3, Math.min(3, v)); }
  function comp(at, i, k) { return k === 0 ? at.getX(i) : k === 1 ? at.getY(i) : k === 2 ? at.getZ(i) : at.getW(i); } // r128 has no getComponent

  /* Expressive proportions ("heroic", default) vs the asset's own ("natural"). Set CharModel.PROPORTIONS before
     load(). Joint changes are applied after calibration; vertex sculpting happens in bind space, so skinning,
     garment shells and all measurements pick it up automatically. */
  CM.PROPORTIONS = CM.PROPORTIONS || 'heroic';
  function propsFor(sex) {
    if (CM.PROPORTIONS === 'natural') return { shoulder: 1, hand: 1, head: 1, fore: 0, back: 0, jaw: 0, brow: 0 };
    return sex === 'm' ? { shoulder: 1.13, hand: 1.17, head: 1.06, fore: 0.009, back: 0.011, jaw: 0.006, brow: 0.004 }
                       : { shoulder: 1.05, hand: 1.1, head: 1.06, fore: 0.005, back: 0.004, jaw: 0.003, brow: 0.003 };
  }
  function sculpt(body, brows, bones, PR, W) {
    if (!PR.fore && !PR.back && !PR.jaw && !PR.brow) return;
    var g = body.geometry, pa = g.attributes.position, na = g.attributes.normal, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    var bn = body.skeleton.bones.map(function (b) { return b.name; });
    var eyeY = (function () { brows.geometry.computeBoundingBox(); return brows.geometry.boundingBox.min.y - 0.01; })();
    var s3 = W('spine_03'), xs = W('upperarm_l').x;
    for (var i = 0; i < pa.count; i++) {
      var x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i), d = 0;
      var wFore = 0, wHead = 0, wBack = 0;
      for (var k = 0; k < 4; k++) {
        var nm = bn[comp(si, i, k)], w = comp(sw, i, k);
        if (/^lowerarm_/.test(nm)) wFore += w;
        else if (nm === 'Head') wHead += w;
        else if (/^clavicle_/.test(nm) || (nm === 'spine_03' && y > s3.y + 0.04) || (/^upperarm_/.test(nm) && Math.abs(x) < xs + 0.07)) wBack += w;
      }
      d += PR.fore * wFore;
      d += PR.back * wBack * Math.min(1, Math.max(0, (y - s3.y) / 0.08));
      if (wHead > 0.5 && z > 0.0) {
        d += PR.jaw * Math.max(0, 1 - Math.abs(y - (eyeY - 0.085)) / 0.04) * wHead;      // jaw and cheekbones
        d += PR.brow * Math.max(0, 1 - Math.abs(y - (eyeY + 0.03)) / 0.016) * wHead;      // brow ridge
      }
      if (d) pa.setXYZ(i, x + na.getX(i) * d, y + na.getY(i) * d, z + na.getZ(i) * d);
    }
    pa.needsUpdate = true;
    // eyebrows ride the brow ridge
    var bp = brows.geometry.attributes.position, bnn = brows.geometry.attributes.normal;
    for (i = 0; i < bp.count; i++) bp.setXYZ(i, bp.getX(i) + bnn.getX(i) * PR.brow, bp.getY(i) + bnn.getY(i) * PR.brow, bp.getZ(i) + bnn.getZ(i) * PR.brow);
    bp.needsUpdate = true;
  }
  function prepBody(gltf, sex) {
    var proto = gltf.scene;
    proto.updateMatrixWorld(true);
    var bones = {}, meshes = {};
    proto.traverse(function (o) { if (o.isBone) bones[o.name] = o; if (o.isSkinnedMesh) meshes[o.name] = o; });
    var body = meshes.Body, eyes = meshes.Eyes, brows = meshes.Eyebrows;
    var W = function (n) { return bones[n].getWorldPosition(V()); };
    var A = { sex: sex, proto: proto, bones: bones };
    var PR = A.prop = propsFor(sex);
    sculpt(body, brows, bones, PR, W);
    eyes.geometry.computeBoundingBox();
    var eyeC = eyes.geometry.boundingBox.getCenter(V());
    var JH = W('Head');
    A.eyeBindY = eyeC.y;
    var s = A.s = CM.EYE_Y / (JH.y + (eyeC.y - JH.y) * PR.head);   // the head is scaled about its joint
    A.zOff = -W('thigh_l').z * s;
    var BS = function (v) { return v.clone().multiplyScalar(s).add(V(0, 0, A.zOff)); };
    A.BS = BS;

    // --- region masks from the bind (T) pose
    var J = {}; Object.keys(bones).forEach(function (n) { J[n] = W(n); });
    var g = body.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, n = pos.count;
    var bn = body.skeleton.bones.map(function (b) { return b.name; });
    var legSide = bn.map(function (nm) { var m = /^(thigh|calf|foot|ball|ball_leaf)_(l|r)$/.exec(nm); return m ? m[2] : ''; });
    var headIdx = bn.indexOf('Head');
    var cm1 = new Float32Array(n * 4), cm2 = new Float32Array(n * 3), csc = new Float32Array(n);
    // scalp: Head-weighted vertices above a hairline that runs from the brow (front) down to the nape (back)
    var hz0 = 1e9, hz1 = -1e9, hx = 0, eyeYm = eyeC.y;
    for (var q0 = 0; q0 < n; q0++) { var d0 = -1, j0 = -1; for (var k0 = 0; k0 < 4; k0++) { var w0 = comp(sw, q0, k0); if (w0 > d0) { d0 = w0; j0 = comp(si, q0, k0); } }
      if (j0 === headIdx && pos.getY(q0) > eyeYm - 0.02) { hz0 = Math.min(hz0, pos.getZ(q0)); hz1 = Math.max(hz1, pos.getZ(q0)); hx = Math.max(hx, Math.abs(pos.getX(q0))); } }
    var xe = J.lowerarm_l.x, xw = J.hand_l.x, yW = J.pelvis.y + 0.075, yBoot = J.calf_l.y * 0.3, yNeck = J.neck_01.y - 0.045;
    var hb = new T.Box3(), back = 1e9, hbLocal = new T.Box3();
    var headInv = body.skeleton.boneInverses[headIdx], tmp = V();
    for (var i = 0; i < n; i++) {
      var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), ax = Math.abs(x);
      // signed distances in cm (positive = inside), clamped; the shader thresholds at 0, so seams are straight
      // lines across triangles instead of following mesh edges
      var dw = (y - yW) * 100, dn = (yNeck - (z > 0.02 ? 0.01 : 0) + Math.max(0, ax - 0.075) * 1.7 - y) * 100;
      var de = (xe - ax) * 100, dr = (xw - 0.01 - ax) * 100, db = (yBoot - y) * 100, BH = 2.2;
      var top = Math.min(dw - BH, dn, de), slv = Math.min(-de, dr), belt = BH - Math.abs(dw);
      var bot = Math.min(-dw - BH, -db, dr), boot = Math.min(db, dr);
      top = cl3(top); slv = cl3(slv); belt = cl3(belt); bot = cl3(bot); boot = cl3(boot);
      cm1[i * 4] = top; cm1[i * 4 + 1] = bot; cm1[i * 4 + 2] = boot; cm1[i * 4 + 3] = belt;
      var lL = 0, lR = 0, dom = -1, dwt = -1;
      for (var k = 0; k < 4; k++) {
        var j = comp(si, i, k), w = comp(sw, i, k);
        if (legSide[j] === 'l') lL += w; else if (legSide[j] === 'r') lR += w;
        if (w > dwt) { dwt = w; dom = j; }
      }
      cm2[i * 3] = slv; cm2[i * 3 + 1] = lL; cm2[i * 3 + 2] = lR;
      var tz = Math.max(0, Math.min(1, (z - hz0) / (hz1 - hz0))), tz2 = tz * tz * (3 - 2 * tz);
      var hl = eyeYm - 0.075 + 0.135 * Math.max(0, Math.min(1, (tz2 - 0.2) / 0.6)) + Math.max(0, ax - hx * 0.78) * 1.2;
      csc[i] = bn[dom] === 'Head' || (bn[dom] === 'neck_01' && z < hz0 + 0.04 && y > eyeYm - 0.11) ? cl3((y - hl) * 100) : -3;
      if (dom === headIdx) { tmp.set(x, y, z); hb.expandByPoint(tmp); hbLocal.expandByPoint(tmp.applyMatrix4(headInv)); }
      if ((bn[dom] === 'spine_02' || bn[dom] === 'spine_03') && ax < 0.08) back = Math.min(back, z);
    }
    g.setAttribute('cmask', new T.BufferAttribute(cm1, 4));
    g.setAttribute('cmask2', new T.BufferAttribute(cm2, 3));
    g.setAttribute('cscalp', new T.BufferAttribute(csc, 1));
    // skinned meshes are posed away from the bind pose: give culling some slack
    [body, eyes, brows].forEach(function (m) { m.geometry.computeBoundingSphere(); m.geometry.boundingSphere.radius *= 1.25; });
    A.headLocalBox = hbLocal;

    // --- calibrate: arms hang down (upper arm slightly abducted), forearm and hand straight down
    var down = V(0, -1, 0), q = new T.Quaternion(), qw = new T.Quaternion(), qp = new T.Quaternion();
    ['l', 'r'].forEach(function (sd) {
      var sg = sd === 'l' ? 1 : -1;
      var chain = [['upperarm_', 'lowerarm_', V(sg * Math.sin(CM.ARM_ABD), -Math.cos(CM.ARM_ABD), 0)], ['lowerarm_', 'hand_', down], ['hand_', 'middle_01_', down]];
      chain.forEach(function (c) {
        proto.updateMatrixWorld(true);
        var b = bones[c[0] + sd], dir = W(c[1] + sd).sub(W(c[0] + sd)).normalize();
        q.setFromUnitVectors(dir, c[2]); b.getWorldQuaternion(qw); qw.premultiply(q);
        b.parent.getWorldQuaternion(qp); b.quaternion.copy(qp.invert().multiply(qw));
      });
    });
    proto.updateMatrixWorld(true);
    // natural calibrated pose (garment measurements and rigid attachments are built against it)
    A.calW0 = {}; Object.keys(bones).forEach(function (nm) { A.calW0[nm] = bones[nm].matrixWorld.clone(); });
    // expressive proportions: wider shoulder joints, bigger hands and head (bone scale, so everything attached follows)
    ['l', 'r'].forEach(function (sd) { bones['upperarm_' + sd].position.multiplyScalar(PR.shoulder); bones['hand_' + sd].scale.setScalar(PR.hand); });
    bones.Head.scale.setScalar(PR.head);
    proto.updateMatrixWorld(true);
    var Q = A.Q = {}, iQ = A.iQ = {}, rest = A.rest = {};
    Object.keys(bones).forEach(function (nm) {
      Q[nm] = bones[nm].getWorldQuaternion(new T.Quaternion());
      iQ[nm] = Q[nm].clone().invert();
      rest[nm] = { p: bones[nm].position.clone(), q: bones[nm].quaternion.clone() };
    });
    // --- proxy geometry (body space = the procedural body's frame: +Z forward, feet at y 0)
    var sh = BS(W('upperarm_l'));
    A.T0 = V(0, CM.TORSO_Y, sh.z);
    A.Pv = BS(W('spine_01'));
    A.L1 = W('lowerarm_l').distanceTo(W('upperarm_l')) * s;
    A.L2f = W('hand_l').distanceTo(W('lowerarm_l')) * s;
    A.palm = W('middle_01_l').distanceTo(W('hand_l')) * s * 0.62;
    A.sh = { l: BS(W('upperarm_l')).sub(A.T0), r: BS(W('upperarm_r')).sub(A.T0) };
    A.hip = { l: BS(W('thigh_l')), r: BS(W('thigh_r')) };
    A.legA = W('calf_l').distanceTo(W('thigh_l')) * s;
    A.legB = W('foot_l').distanceTo(W('calf_l')) * s;
    A.dThigh = bones.calf_l.position.clone().normalize();
    A.dCalf = bones.foot_l.position.clone().normalize();
    A.ankle = BS(W('foot_l')).y;
    // head fit: old cartoon head center (0,.78,0) half-size (.112,.128,.118) in torso space -> real head
    var hcB = hb.getCenter(V()).sub(JH).multiplyScalar(PR.head).add(JH);
    var hc = BS(hcB).sub(A.T0), hs = hb.getSize(V()).multiplyScalar(s * 0.5 * PR.head);
    A.head = { c: hc, half: hs };
    var kx = Math.min(1.1, Math.max(0.7, hs.x / 0.112)), kz = Math.min(1.1, Math.max(0.8, hs.z / 0.118));
    A.headFit = { p: V(hc.x, hc.y - 0.78, hc.z), s: V(kx, 1, kz) };
    A.backZ = BS(V(0, 0, back)).z - A.T0.z;
    A.packY = (BS(W('spine_02')).y + BS(W('spine_03')).y) / 2 - CM.TORSO_Y + 0.03;
    // finger curl axes (bone-local), chosen so a positive angle closes the finger toward the palm
    A.curl = { l: [], r: [] };
    ['l', 'r'].forEach(function (sd) {
      var nrm = V(sd === 'l' ? -1 : 1, 0, 0);
      FINGERS.forEach(function (f) {
        for (var k = 1; k <= 3; k++) {
          var bnm = f + '_0' + k + '_' + sd, cnm = k < 3 ? f + '_0' + (k + 1) + '_' + sd : f + '_04_leaf_' + sd;
          if (!bones[bnm] || !bones[cnm]) continue;
          var dir = W(cnm).sub(W(bnm)), best = null, bs = -1e9;
          [V(1, 0, 0), V(-1, 0, 0), V(0, 0, 1), V(0, 0, -1)].forEach(function (ax) {
            var wax = ax.clone().applyQuaternion(Q[bnm]);
            var d2 = dir.clone().applyAxisAngle(wax, 0.5), sc = d2.sub(dir).dot(nrm);
            if (sc > bs) { bs = sc; best = ax; }
          });
          A.curl[sd].push({ name: bnm, ax: best, thumb: f === 'thumb', k: k });
        }
      });
    });
    A.across = W('index_01_l').sub(W('pinky_01_l')).normalize(); // expect ~ +Z (palms face the body)
    // materials and textures: textures carry raw values (the game renders without color management)
    [body, eyes, brows].forEach(function (m) {
      var mt = m.material; ['map', 'emissiveMap'].forEach(function (k) { if (mt[k]) { mt[k].encoding = T.LinearEncoding; mt[k].needsUpdate = true; } });
    });
    A.map = body.material.map; A.normalMap = body.material.normalMap; A.normalScale = body.material.normalScale ? body.material.normalScale.clone() : new T.Vector2(1, 1);
    A.eyeMat = eyes.material;
    A.meshNames = { body: 'Body', eyes: 'Eyes', brows: 'Eyebrows' };
    return A;
  }

  function prepHair(gltf) {
    var H = { geo: {}, mat: {} };
    gltf.scene.traverse(function (o) {
      if (!o.isMesh) return;
      H.geo[o.name] = o.geometry; H.mat[o.name] = o.material;
      if (o.material.map) { o.material.map.encoding = T.LinearEncoding; o.material.map.needsUpdate = true; }
    });
    return H;
  }
  // hair was rigged on the female head: map it onto each body's head (head-bone local space)
  function fitHair() {
    var ref = CM.assets.f.headLocalBox;
    ['m', 'f'].forEach(function (sx) {
      var A = CM.assets[sx], b = A.headLocalBox;
      var rs = ref.getSize(V()), bs = b.getSize(V());
      var k = V(bs.x / rs.x, bs.y / rs.y, bs.z / rs.z);
      var km = (k.x + k.z) / 2 * (sx === 'm' ? 1.025 : 1); k.set(km, (k.y + km) / 2, km);   // a little slack on the male crown
      var c = b.getCenter(V()).sub(ref.getCenter(V()).multiply(k));
      A.hairFit = { s: k, p: c };
    });
  }

  // ---------------------------------------------------------------- materials

  // ================================================================ PAINTERLY STYLE
  /* One global style switch for every character material (body, eyes, brows, hair, garments): a uniform, so
     CharModel.setStyle() changes existing and new characters live without recompiling anything.
     Lighting mirrors the game's ADU hook (index.html "const ADU=") and reads the game's own uniform objects
     through window.MG_ADU when the game exposes them; otherwise painterly defaults (or plain PBR in 'default'). */
  var U_STYLE = { value: 1 };
  var V3 = function (x, y, z) { return new T.Vector3(x, y, z); };
  var PAINT_ADU = { adSteps: { value: 3 }, adSoft: { value: 0.5 }, adMid: { value: 0.8 }, adRim: { value: 0.35 }, adSpec: { value: 0.2 }, adShadow: { value: V3(0.45, 0.48, 0.66) }, adRimCol: { value: V3(1, 0.85, 0.65) } };
  var PLAIN_ADU = { adSteps: { value: 0 }, adSoft: { value: 0 }, adMid: { value: 0.8 }, adRim: { value: 0 }, adSpec: { value: 1 }, adShadow: { value: V3(0.3, 0.3, 0.4) }, adRimCol: { value: V3(1, 0.9, 0.7) } };
  CM.PAINT_ADU = PAINT_ADU;
  function aduSrc() { var g = window.MG_ADU; return g && g.adSteps ? g : (U_STYLE.value > 0.5 ? PAINT_ADU : PLAIN_ADU); }
  var CM_ADU = {};
  ['adSteps', 'adSoft', 'adMid', 'adRim', 'adSpec', 'adShadow', 'adRimCol'].forEach(function (k) { CM_ADU[k] = { get value() { return aduSrc()[k].value; } }; });
  var BODY_NS = new T.Vector2(1, 1), BODY_NS_DEF = new T.Vector2(1, 1);
  CM.style = 'painterly';
  CM.setStyle = function (name) {
    var p = name !== 'default';
    CM.style = p ? 'painterly' : 'default'; U_STYLE.value = p ? 1 : 0;
    BODY_NS.copy(BODY_NS_DEF).multiplyScalar(p ? 0.22 : 1);
    return CM.style;
  };
  /* shared GLSL: style uniform, world normal varying, low-specular override, and the game's banded lighting */
  var AD_GLSL = ['#include <aomap_fragment>',
    'if(adSteps>.5){vec3 adB=max(diffuseColor.rgb,vec3(.003));vec3 adI=(reflectedLight.directDiffuse+reflectedLight.indirectDiffuse)/adB;float adL=dot(adI,vec3(.299,.587,.114));',
    '  vec3 adLc=mix(vec3(1.),adI/max(adL,.001),.5);float adX=clamp(adL/adMid,0.,1.5);float adQ=floor(adX*adSteps+.5)/adSteps;adQ=mix(adQ,adX,adSoft);',
    '  vec3 adS=mix(adShadow,vec3(1.),clamp(adQ,0.,1.))*(1.+max(adQ-1.,0.)*.5);',
    '  reflectedLight.directDiffuse=adB*adS*adLc;reflectedLight.indirectDiffuse=vec3(0.);reflectedLight.directSpecular*=adSpec;reflectedLight.indirectSpecular*=adSpec;}',
    'if(adRim>0.){float adR=pow(1.-clamp(dot(normal,normalize(vViewPosition)),0.,1.),3.);reflectedLight.directDiffuse+=adRimCol*adR*adRim*max(diffuseColor.rgb,vec3(.06));}'].join('\n');
  function paintHook(shader, o) {
    o = o || {};
    Object.keys(CM_ADU).forEach(function (k) { shader.uniforms[k] = CM_ADU[k]; });
    shader.uniforms.uCmStyle = U_STYLE;
    shader.uniforms.uCmRough = { value: o.rough == null ? 0.88 : o.rough };
    shader.uniforms.uCmMetK = { value: o.metK == null ? 0.25 : o.metK };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCmNW;')
      .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\nvCmNW = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = 'uniform float adSteps,adSoft,adMid,adRim,adSpec,uCmStyle,uCmRough,uCmMetK;uniform vec3 adShadow,adRimCol;\nvarying vec3 vCmNW;\n' + shader.fragmentShader
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, max(roughnessFactor, uCmRough), uCmStyle);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, metalnessFactor * uCmMetK, uCmStyle);')
      .replace('#include <aomap_fragment>', AD_GLSL);
    if (o.facet) shader.fragmentShader = 'uniform float uFacet;\n' + shader.fragmentShader.replace('#include <normal_fragment_begin>',
      '#include <normal_fragment_begin>\nif (uCmStyle * uFacet > 0.01) { vec3 cfx = dFdx(vViewPosition), cfy = dFdy(vViewPosition); vec3 cfn = normalize(cross(cfx, cfy)); normal = normalize(mix(normal, cfn, 0.7 * uFacet)); }');
  }
  // eyes / brows: lighting only
  function plainOBC(shader) { paintHook(shader, { rough: 0.6 }); }
  function plainKey() { return 'cmPlain1'; }
  function plainify(m) { if (m && !m.__cmPlain) { m.__cmPlain = 1; m.onBeforeCompile = plainOBC; m.customProgramCacheKey = plainKey; m.needsUpdate = true; } return m; }
  // hair: blurred (clumpy) texture, flatter value, broad warm highlight band
  function hairOBC(shader) {
    paintHook(shader, { rough: 0.85 });
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', [
      '#ifdef USE_MAP',
      '  vec4 texelColor = mapTexelToLinear(texture2D(map, vUv, 2.6 * uCmStyle));',
      '  vec3 hd = texelColor.rgb;',
      '  if (uCmStyle > 0.5) { float hl = dot(hd, vec3(.333)); hd = vec3(mix(0.82, hl, 0.55));',
      '    float band = smoothstep(0.42, 0.62, vCmNW.y) * (1.0 - smoothstep(0.78, 0.95, vCmNW.y));',
      '    hd = hd * (0.9 + 0.55 * band) + vec3(0.07, 0.04, 0.0) * band; }',
      '  diffuseColor.rgb *= hd;',
      '#endif'].join('\n'));
  }
  function hairKey() { return 'cmHair1'; }
  function colorOf(x, def) {
    if (x && x.isMaterial) return x.color;
    if (x && x.isColor) return x;
    return new T.Color(x == null ? def : x);
  }
  function bodyOBC(shader) {
    var U = this.__cmU;
    if (U) for (var k in U) shader.uniforms[k] = U[k];
    paintHook(shader, { rough: 0.9 });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 cmask;\nattribute vec3 cmask2;\nattribute float cscalp;\nvarying float vSc;\nvarying vec4 vCm;\nvarying vec2 vCm2;\nvarying float vCmY;\nuniform vec3 uHide;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCmY = position.y;\nvSc = cscalp;\nvCm = cmask;\nvCm2 = vec2(cmask2.x, dot(uHide, vec3(clamp(1.0 - cmask2.y - cmask2.z, 0.0, 1.0), cmask2.y, cmask2.z)));');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vCm;\nvarying vec2 vCm2;\nuniform vec3 uSkin, uTop, uBot, uBoot, uBelt, uHairC;\nuniform float uSleeve, uGain, uScalpOn;\nuniform vec4 uPaint;\nvarying float vSc;\nvarying float vCmY;\nvec3 cmVal(vec3 c){ float l = dot(c, vec3(0.299, 0.587, 0.114)); float l2 = 0.045 + min(l, 1.0) * 0.72; return mix(vec3(l2), c * (l2 / max(l, 0.001)), smoothstep(0.0, 0.04, l)); }')
      .replace('#include <map_fragment>', [
        'if (vCm2.y > 0.5) discard;',
        '#ifdef USE_MAP',
        '  vec4 texelColor = mapTexelToLinear(texture2D(map, vUv, uCmStyle * (vSc > -2.9 ? 0.9 : 2.2)));',
        '#else',
        '  vec4 texelColor = vec4(0.8);',
        '#endif',
        '  vec3 det = texelColor.rgb * uGain;',
        '  float sh = mix(1.0, dot(det, vec3(0.3333)), 0.55);',
        '  float gy = 1.0;',
        '  if (uCmStyle > 0.5) {',
        // painted planes: soft-posterized value, flattened toward mid, warm lights / cool darks, some hue kept for lips
        '    float l = dot(det, vec3(0.3333)), q = floor(l * 4.0 + 0.5) / 4.0, l2 = mix(1.0, mix(l, q, 0.3), 0.8);',
        '    vec3 chroma = det / max(l, 0.02);',
        '    det = vec3(l2) * mix(vec3(0.86, 0.9, 1.08), vec3(1.06, 0.99, 0.9), smoothstep(0.7, 1.0, l2));',
        '    det *= mix(vec3(1.0), chroma, 0.8);',
        '    sh = mix(sh, 1.0, 0.6);',
        '    gy = mix(0.84, 1.08, smoothstep(0.25, 1.45, vCmY));',
        '    det *= mix(vec3(0.84, 0.88, 1.06), vec3(1.05, 1.0, 0.94), smoothstep(-0.55, 0.45, vCmNW.y));',
        '  }',
        '  vec3 col = uSkin * det;',
        '  vec3 cTop = uTop, cBot = uBot, cBoot = uBoot, cBelt = uBelt;',
        '  if (uCmStyle > 0.5) { cTop = cmVal(cTop); cBot = cmVal(cBot); cBoot = cmVal(cBoot); cBelt = cmVal(cBelt); }',
        '  col = mix(col, cTop * sh * gy, uPaint.x * smoothstep(-0.25, 0.25, max(vCm.x, uSleeve > 0.5 ? vCm2.x : -3.0)));',
        '  col = mix(col, cBot * sh * gy, uPaint.y * smoothstep(-0.25, 0.25, vCm.y));',
        '  col = mix(col, cBoot * sh * 0.95, uPaint.z * smoothstep(-0.25, 0.25, vCm.z));',
        '  col = mix(col, cBelt * sh * gy, uPaint.w * smoothstep(-0.25, 0.25, vCm.w));',
        '  col = mix(col, uHairC * (0.55 + 0.25 * sh), uScalpOn * smoothstep(-1.2, 1.2, vSc));',
        '  diffuseColor.rgb *= col;'].join('\n'));
  }
  function bodyKey() { return 'cmBody2'; }
  function makeBodyMat(A, o) {
    var U = {
      uSkin: { value: colorOf(o.skinMat, 0xc89a78) }, uTop: { value: colorOf(o.top, 0x3c5a78) }, uBot: { value: colorOf(o.bot, 0x2a2620) },
      uBoot: { value: colorOf(o.boot, 0x2a1f18) }, uBelt: { value: colorOf(o.belt, 0x3a2818) },
      uSleeve: { value: o.sleeves === false ? 0 : 1 }, uGain: { value: 1.25 }, uHide: { value: new T.Vector3() },
      uPaint: { value: new T.Vector4(1, 1, 1, 1) }, uHairC: { value: new T.Color(0x2a1a10) }, uScalpOn: { value: 0 }
    };
    var m = new T.MeshStandardMaterial({ map: A.map, normalMap: A.normalMap, roughness: 0.72, metalness: 0, skinning: true });
    BODY_NS_DEF.copy(A.normalScale); BODY_NS.copy(A.normalScale).multiplyScalar(U_STYLE.value > 0.5 ? 0.22 : 1);
    m.normalScale = BODY_NS;   // shared: setStyle() rescales every body's normal map at once
    m.name = 'cmBody';
    m.__cmU = U; m.onBeforeCompile = bodyOBC; m.customProgramCacheKey = bodyKey; m.clone = cloneBodyMat;
    return m;
  }
  function cloneBodyMat() {
    var c = T.MeshStandardMaterial.prototype.clone.call(this);
    c.__cmU = this.__cmU; c.onBeforeCompile = bodyOBC; c.customProgramCacheKey = bodyKey; c.clone = cloneBodyMat; c.skinning = true; c.normalScale = BODY_NS;
    return c;
  }
  var HAIR_MATS = {};
  function hairMat(key, col) {
    var H = CM.assets.hair, src = H.mat[key];
    var id = src.uuid + ':' + col.getHexString();
    if (HAIR_MATS[id]) return HAIR_MATS[id];
    var m = new T.MeshStandardMaterial({ map: src.map, normalMap: src.normalMap, roughness: 0.75, metalness: 0, side: T.DoubleSide });
    if (src.normalScale) m.normalScale.copy(src.normalScale);
    m.color.copy(col).multiplyScalar(1.25);
    m.onBeforeCompile = hairOBC; m.customProgramCacheKey = hairKey;
    return (HAIR_MATS[id] = m);
  }
  // A SkinnedMesh must render with material.skinning = true, and r128 caches one program per material (a shared
  // non-skinning material that already drew a static mesh keeps drawing ours in the bind pose). The game sometimes
  // swaps in its own materials (afterimage ghosts, ally tints), so a foreign material assigned to one of our
  // meshes is replaced by a skinning copy whose color/opacity follow the original every frame (see sync).
  var SKIN_COPIES = new WeakMap();
  function skinCopy(v) {
    if (!v || v.skinning || !('skinning' in v)) return v;
    var c = SKIN_COPIES.get(v);
    if (!c) { c = v.clone(); c.skinning = true; c.__cmSrc = v; SKIN_COPIES.set(v, c); }
    return c;
  }
  function guardSkinning(mesh) {
    var cur = mesh.material;
    Object.defineProperty(mesh, 'material', {
      configurable: true, enumerable: true,
      get: function () { return cur; },
      set: function (v) { cur = Array.isArray(v) ? v.map(skinCopy) : skinCopy(v); }
    });
  }
  function mirrorMat(c) {
    var s = c.__cmSrc; if (!s) return;
    c.opacity = s.opacity; c.transparent = s.transparent; c.visible = s.visible; c.depthWrite = s.depthWrite;
    if (c.color && s.color) c.color.copy(s.color); if (c.emissive && s.emissive) c.emissive.copy(s.emissive);
  }

  // ---------------------------------------------------------------- instance (skinned model)
  function cloneSkinned(source) {
    var srcMap = new Map(), dstMap = new Map();
    var clone = source.clone();
    (function walk(a, b) { srcMap.set(b, a); dstMap.set(a, b); for (var i = 0; i < a.children.length; i++) walk(a.children[i], b.children[i]); })(source, clone);
    var shared = [];   // body, eyes and brows use the same glTF skin: give them one skeleton (one bone texture)
    clone.traverse(function (node) {
      if (!node.isSkinnedMesh) return;
      var src = srcMap.get(node), sb = src.skeleton.bones, sk = null;
      for (var i = 0; i < shared.length && !sk; i++) if (shared[i].src.length === sb.length && shared[i].src.every(function (b, k) { return b === sb[k]; })) sk = shared[i].sk;
      if (!sk) { sk = new T.Skeleton(sb.map(function (b) { return dstMap.get(b); }), src.skeleton.boneInverses); shared.push({ src: sb, sk: sk }); }
      node.bind(sk, src.bindMatrix);
    });
    return clone;
  }
  function pickHair(o, sex) {
    if (typeof o.hairStyle === 'string') return o.hairStyle;
    if (typeof o.hair === 'string') return o.hair;
    if (o.isPlayer && CM.playerHair) return CM.playerHair;
    var seed = o.seed != null ? o.seed : Math.floor(Math.random() * 1e6);
    var L = sex === 'f' ? ['long', 'buns', 'long', 'buzzedF'] : ['parted', 'buzzed', 'parted+beard', 'buzzed+beard'];
    return o.isPlayer ? L[0] : L[seed % L.length];
  }
  function buildModel(A, st) {
    var o = st.opts;
    var model = cloneSkinned(A.proto);
    model.name = 'cm_model';
    model.scale.setScalar(A.s);
    model.position.set(0, 0, A.zOff);
    var bones = {}, meshes = {};
    model.traverse(function (x) { if (x.isBone) bones[x.name] = x; if (x.isSkinnedMesh) meshes[x.name] = x; });
    st.bones = bones;
    var bm = meshes[A.meshNames.body], em = meshes[A.meshNames.eyes], wm = meshes[A.meshNames.brows];
    if (!st.mats) {
      st.mats = { body: makeBodyMat(A, o), brows: new T.MeshStandardMaterial({ color: st.hairCol.clone().multiplyScalar(0.85), roughness: 0.9, skinning: true }) };
      st.U = st.mats.body.__cmU;
      st.U.uHairC.value = st.hairCol;
      st.U.uScalpOn.value = st.hairStyle.split('+').some(function (k) { return k && k !== 'none' && k !== 'beard'; }) ? 1 : 0;
    }
    plainify(st.mats.brows); plainify(A.eyeMat);
    bm.material = st.mats.body; wm.material = st.mats.brows; em.material = A.eyeMat;
    [bm, em, wm].forEach(function (m) { m.castShadow = !!o.castShadow; guardSkinning(m); m.raycast = noRay; });  // raycasts hit cm_hitbox instead of the T-pose bind geometry
    st.meshes = { body: bm, eyes: em, brows: wm };
    // hair: plain meshes on the Head bone
    var hr = new T.Group(); hr.name = 'cm_hairRoot';
    hr.position.copy(A.hairFit.p); hr.scale.copy(A.hairFit.s);
    st.hairStyle.split('+').forEach(function (k) {
      if (!k || k === 'none' || !CM.assets.hair.geo[k]) return;
      var hm = new T.Mesh(CM.assets.hair.geo[k], hairMat(k, st.hairCol)); hm.__k = k; hm.castShadow = !!o.castShadow; hr.add(hm);
    });
    bones.Head.add(hr); st.hairRoot = hr;
    var wr = new T.Group(); wr.name = 'cm_ward'; model.add(wr); st.wardRoot = wr; st.ward = [];
    model.__cm = st;
    model.updateMatrixWorld = modelUpdateMatrixWorld;
    model.clone = modelClone;
    model.toJSON = modelToJSON;
    return model;
  }
  function noRay() { }
  function modelUpdateMatrixWorld(force) { try { sync(this); } catch (e) { if (!this.__cmErr) { this.__cmErr = 1; console.error('charmodel sync', e); } } T.Object3D.prototype.updateMatrixWorld.call(this, force); }
  // Object3D.clone() of the whole body (the game's playerEcho/ghostOf) lands here: rebuild a proper skinned
  // copy (own skeleton) with the same pose. The clone finds its proxies by name, so cloned proxies drive it.
  function modelClone() {
    var st = this.__cm;
    var nst = { A: st.A, opts: st.opts, hairCol: st.hairCol, hairStyle: st.hairStyle, mats: st.mats, U: st.U, curl: { l: -1, r: -1 }, hairMode: st.hairMode };
    var m = buildModel(st.A, nst);
    var sb = st.bones;
    Object.keys(nst.bones).forEach(function (k) { var a = sb[k], b = nst.bones[k]; b.position.copy(a.position); b.quaternion.copy(a.quaternion); b.scale.copy(a.scale); });
    m.position.copy(this.position); m.quaternion.copy(this.quaternion); m.scale.copy(this.scale); m.visible = this.visible;
    if (st.outfit && st.outfit.length) applyOutfit(m, st.outfit);
    return m;
  }
  // keep JSON.stringify(userData) (Object3D.clone copies userData through JSON) cheap: do not serialize meshes/textures
  function modelToJSON() { return { object: { type: 'Object3D', name: this.name, uuid: this.uuid, matrix: this.matrix.toArray() } }; }

  // ---------------------------------------------------------------- proxies
  function obj(name, parent, x, y, z, order) {
    var o = new T.Object3D(); o.name = name; o.position.set(x || 0, y || 0, z || 0); if (order) o.rotation.order = order;
    T.Object3D.prototype.add.call(parent, o); return o;
  }
  function makeArm(A, torso, sd) {
    var S = sd.toUpperCase(), sg = sd === 'l' ? 1 : -1, sh = A.sh[sd];
    var p = obj('cm_p' + S, torso, sh.x, sh.y, 0, 'YXZ');
    var el = obj('cm_el' + S, p, sg * A.L1 * Math.sin(CM.ARM_ABD), -A.L1 * Math.cos(CM.ARM_ABD), 0, 'YXZ');
    var reach = A.L2f + A.palm;
    var hand = obj('cm_hand' + S, el, -sg * 0.012, -reach, 0);
    var hold = new T.Group(); hold.name = 'cm_hold' + S; hold.position.set(-sg * 0.012, -reach, 0); T.Object3D.prototype.add.call(el, hold);
    return { p: p, el: el, hold: hold, hand: hand, cmL1: A.L1, cmL2: Math.hypot(reach, 0.012), cmAbd: sg * CM.ARM_ABD };
  }

  /* Build a skinned human with the procedural buildHuman() interface.
     o: {sex:'m'|'f', skin, top, bot, boot (hex | THREE.Color | Material), hair (hex color, or style string),
         hairColor, hairMat, hairStyle ('buzzed','buzzedF','parted','long','buns','none', '+beard' suffix ok),
         sleeves (false = bare forearms), pack (false = no backpack), castShadow, scale, seed, isPlayer} */
  CM.buildHumanSkinned = function (o) {
    o = o || {};
    if (!CM.ready) throw new Error('charmodel: assets not loaded');
    var sex = o.sex === 'f' || o.sex === 'm' ? o.sex : (o.isPlayer ? CM.playerSex : ((o.seed != null ? o.seed : Math.random() * 1e6 | 0) % 2 ? 'f' : 'm'));
    var A = CM.assets[sex];
    var skinMat = o.skin && o.skin.isMaterial ? o.skin : new T.MeshStandardMaterial({ color: o.skin == null ? 0xc89a78 : o.skin, roughness: 0.8 });
    var hc = o.hairColor != null ? o.hairColor : (o.hairMat ? o.hairMat.color.getHex() : (typeof o.hair === 'number' ? o.hair : 0x2a1a10));
    var st = { A: A, opts: Object.assign({}, o, { skinMat: skinMat }), hairCol: new T.Color(hc), hairStyle: pickHair(o, sex), curl: { l: -1, r: -1 } };
    var root = new T.Group(), body = new T.Group(); body.rotation.order = 'YXZ'; root.add(body);
    if (o.scale) root.scale.setScalar(o.scale);
    var model = buildModel(A, st);
    body.add(model);                                  // first child: synced before the proxies' children render
    var torso = obj('cm_torso', body, A.T0.x, A.T0.y, A.T0.z, 'YXZ');
    var head = obj('cm_head', torso, 0, 0, 0);
    var hair = obj('cm_hair', torso, 0, 0, 0);
    var fit = new T.Group(); fit.name = 'cm_headFit'; fit.position.copy(A.headFit.p); fit.scale.copy(A.headFit.s); T.Object3D.prototype.add.call(torso, fit);
    var aR = makeArm(A, torso, 'r'), aL = makeArm(A, torso, 'l');
    var lL = obj('cm_lL', body, A.hip.l.x, A.hip.l.y, 0), lR = obj('cm_lR', body, A.hip.r.x, A.hip.r.y, 0);
    // invisible hit volume for the game's aim raycasts (SkinnedMesh.raycast would test the unposed T-pose)
    var hit = new T.Mesh(HIT_GEO || (HIT_GEO = new T.BoxGeometry(0.46, 1.75, 0.34).translate(0, 0.875, 0)), HIT_MAT || (HIT_MAT = new T.MeshBasicMaterial({ color: 0xffffff })));
    hit.name = 'cm_hitbox'; hit.visible = false; T.Object3D.prototype.add.call(body, hit);
    // anything the game adds to the torso (race bits, eye rings) goes onto the head fit
    torso.add = function () { for (var i = 0; i < arguments.length; i++) fit.add(arguments[i]); return this; };
    torso.remove = function () { for (var i = 0; i < arguments.length; i++) { var c = arguments[i]; if (c && c.parent === fit) fit.remove(c); else T.Object3D.prototype.remove.call(this, c); } return this; };
    // backpack (the procedural body wore one unless pack:false)
    if (o.pack !== false) {
      var pk = std(0x6a4a2a), roll = std(0x4a5a3a), z = A.backZ - 0.03, y = A.packY;
      var G = PACK_GEO || (PACK_GEO = [new T.BoxGeometry(0.28, 0.34, 0.11), new T.SphereGeometry(1, 10, 6), new T.CylinderGeometry(0.06, 0.06, 0.34, 10)]);
      addMesh(torso, G[0], pk, 0, y, z).name = 'cm_pack';
      addMesh(torso, G[1], pk, 0, y + 0.17, z, [0.14, 0.05, 0.06]).name = 'cm_pack';
      var r = addMesh(torso, G[2], roll, 0, y + 0.22, z - 0.01); r.rotation.z = Math.PI / 2; r.name = 'cm_pack';
    }
    // invisible carriers so code that finds the cloth/skin materials by traversing meshes still finds them
    [o.top, o.bot, skinMat].forEach(function (m) { if (m && m.isMaterial) { var c = new T.Mesh(new T.BufferGeometry(), m); c.visible = false; c.name = 'cm_matCarrier'; T.Object3D.prototype.add.call(body, c); } });
    if (typeof window.addBlob === 'function') { try { window.addBlob(root, 0.34); } catch (e) { } }
    return { root: root, body: body, torso: torso, lL: lL, lR: lR, aR: aR, aL: aL, head: head, hair: hair, headFit: fit, model: model, skinMat: skinMat, sex: sex };
  };
  var PACK_GEO = null, HIT_GEO = null, HIT_MAT = null, STD = {};
  function std(c) { return STD[c] || (STD[c] = new T.MeshStandardMaterial({ color: c, roughness: 0.8 })); }
  function addMesh(parent, geo, mat, x, y, z, sc) { var m = new T.Mesh(geo, mat); m.position.set(x, y, z); if (sc) m.scale.set(sc[0], sc[1], sc[2]); T.Object3D.prototype.add.call(parent, m); return m; }

  /* Stand-alone API: returns root (THREE.Group) with root.userData = {body,torso,lL,lR,aR,aL,head,hair,skinMat,headFit,cm:true} */
  CM.makeSkinnedHuman = function (o) {
    o = Object.assign({}, o || {});
    if (typeof o.hair === 'string' && o.hairColor == null) o.hairColor = 0x2a1a10;
    var H = CM.buildHumanSkinned(o);
    H.root.userData = { body: H.body, torso: H.torso, lL: H.lL, lR: H.lR, aR: H.aR, aL: H.aL, head: H.head, hair: H.hair, skinMat: H.skinMat, headFit: H.headFit, cm: true, walk: 0, ck: 0, dk: 0 };
    return H.root;
  };
  CM.isSkinned = function (root) { var m = findModel(root); return !!m; };
  function findModel(root) { var r = null; if (root) root.traverse(function (o) { if (!r && o.__cm) r = o; }); return r; }
  CM.modelOf = findModel;
  CM.setSkin = function (root, hex) { var m = findModel(root); if (m) m.__cm.U.uSkin.value.setHex(hex); };
  CM.setCloth = function (root, part, hex) { var m = findModel(root); var k = { top: 'uTop', bot: 'uBot', boot: 'uBoot', belt: 'uBelt' }[part]; if (m && k) m.__cm.U[k].value.setHex(hex); };
  CM.setHairColor = function (root, hex) { var m = findModel(root); if (!m) return; var st = m.__cm; st.hairCol.setHex(hex); st.hairRoot.children.forEach(function (h) { h.material = hairMat(h.__k || 'parted', st.hairCol); }); st.mats.brows.color.setHex(hex).multiplyScalar(0.85); };

  // ---------------------------------------------------------------- per-frame sync (proxies -> bones)
  var _q = new T.Quaternion(), _q2 = new T.Quaternion(), _q3 = new T.Quaternion(), _v = V(), _v2 = V(), _v3 = V(), _m = new T.Matrix4(), _mi = new T.Matrix4();
  var _H = V(), _F = V(), _K = V(), _n = V(), _pl = V(), _d = V(), _w = V();
  var Y_DOWN = V(0, -1, 0), Z_FWD = V(0, 0, 1);
  function resolveRig(model) {
    var st = model.__cm, body = model.parent;
    if (!body) return null;
    if (st.rig && st.rig.body === body) return st.rig;
    var g = function (n) { return body.getObjectByName(n); };
    var rig = { body: body, torso: g('cm_torso'), lL: g('cm_lL'), lR: g('cm_lR'), hair: g('cm_hair'),
      p: { l: g('cm_pL'), r: g('cm_pR') }, el: { l: g('cm_elL'), r: g('cm_elR') }, hold: { l: g('cm_holdL'), r: g('cm_holdR') } };
    if (!rig.torso || !rig.lL || !rig.lR || !rig.p.l || !rig.p.r) return null;
    rig.pack = rig.torso.children.filter(function (o) { return o.name === 'cm_pack'; });
    st.rig = rig; return rig;
  }
  function sync(model) {
    var st = model.__cm, rig = resolveRig(model);
    if (!rig) return;
    var A = st.A, B = st.bones, R = A.rest;
    var tv = rig.torso.visible, lv = rig.lL.visible, rv = rig.lR.visible;
    var any = tv || lv || rv;
    st.meshes.body.visible = any; st.meshes.eyes.visible = st.meshes.brows.visible = tv;
    st.U.uHide.value.set(tv ? 0 : 1, lv ? 0 : 1, rv ? 0 : 1);
    st.hairRoot.visible = tv && (!rig.hair || rig.hair.visible);
    syncWardrobe(st, rig, tv, lv || rv, any && rig.body.visible);
    if (!any || !rig.body.visible) return;
    mirrorMat(st.meshes.body.material); mirrorMat(st.meshes.eyes.material); mirrorMat(st.meshes.brows.material);
    // torso: rigid upper body rotating about spine_01 (the proxy keeps its .82 origin for the game's coordinates)
    var Qt = rig.torso.quaternion;
    _v.copy(A.T0).sub(A.Pv).applyQuaternion(Qt).add(A.Pv); rig.torso.position.copy(_v);
    B.spine_01.quaternion.copy(A.iQ.pelvis).multiply(Qt).multiply(A.Q.spine_01);
    // arms
    for (var si = 0; si < 2; si++) {
      var sd = si ? 'r' : 'l', p = rig.p[sd], el = rig.el[sd];
      var ua = B['upperarm_' + sd], la = B['lowerarm_' + sd], hd = B['hand_' + sd];
      ua.quaternion.copy(A.iQ['clavicle_' + sd]).multiply(p.quaternion).multiply(A.Q['upperarm_' + sd]);
      _v.set(p.position.x - A.sh[sd].x, p.position.y - A.sh[sd].y, p.position.z - A.sh[sd].z);
      if (_v.lengthSq() > 1e-10) ua.position.copy(_v.applyQuaternion(A.iQ['clavicle_' + sd]).divideScalar(A.s)).add(R['upperarm_' + sd].p);
      else ua.position.copy(R['upperarm_' + sd].p);
      la.quaternion.copy(A.iQ['upperarm_' + sd]).multiply(el.quaternion).multiply(A.Q['lowerarm_' + sd]);
      hd.quaternion.copy(R['hand_' + sd].q);
      var grip = (rig.hold[sd] && rig.hold[sd].children.length > 0) || el.rotation.x < -1.5 ? 1 : 0;
      if (st.curl[sd] !== grip) { st.curl[sd] = grip; curlHand(st, sd, grip); }
    }
    // legs
    var bw = rig.body.matrixWorld, e = bw.elements;
    var ws = Math.hypot(e[4], e[5], e[6]) || 1, upright = e[5] / ws > 0.85;
    var gY = rig.body.parent ? rig.body.parent.matrixWorld.elements[13] : 0;
    var inv = null;
    for (var li = 0; li < 2; li++) {
      var s2 = li ? 'r' : 'l', leg = li ? rig.lR : rig.lL, Ql = leg.quaternion;
      var a = A.legA, b = A.legB, Lt = a + b;
      _H.copy(leg.position);
      var rx = leg.rotation.x;
      var flex = 0.02 + 0.13 * Math.min(1.2, Math.max(0, rx));
      _d.copy(Y_DOWN).applyQuaternion(Ql);
      _F.copy(_H).addScaledVector(_d, Lt * leg.scale.y * (1 - flex));
      var plant = 0;
      if (upright) {
        _w.copy(_F).applyMatrix4(bw);
        var floor = gY + A.ankle * ws;
        if (_w.y < floor) { _w.y = floor; if (!inv) inv = _mi.copy(bw).invert(); _F.copy(_w).applyMatrix4(inv); }
        plant = Math.min(1, Math.max(0, 1 - (_w.y - floor) / (0.1 * ws)));
      }
      // two-bone solve, knee toward the leg's front
      _n.subVectors(_F, _H); var dist = _n.length(); if (dist < 1e-6) { _n.copy(_d); dist = Lt; }
      _n.divideScalar(dist); dist = Math.min(Math.max(dist, 0.3 * Lt), 0.9995 * Lt);
      _pl.copy(Z_FWD).applyQuaternion(Ql); _pl.addScaledVector(_n, -_pl.dot(_n));
      if (_pl.lengthSq() < 1e-8) _pl.set(0, 0, 1); _pl.normalize();
      var ca = Math.min(1, Math.max(-1, (a * a + dist * dist - b * b) / (2 * a * dist))), sa = Math.sqrt(1 - ca * ca);
      _K.copy(_H).addScaledVector(_n, a * ca).addScaledVector(_pl, a * sa);
      _F.copy(_H).addScaledVector(_n, dist);
      var th = B['thigh_' + s2], cf = B['calf_' + s2], ft = B['foot_' + s2];
      _q.copy(Ql).multiply(A.Q['thigh_' + s2]);                         // thigh as the proxy says (straight leg)
      _v.copy(A.dThigh).applyQuaternion(_q); _v2.subVectors(_K, _H).normalize();
      _q2.setFromUnitVectors(_v, _v2); _q.premultiply(_q2);             // bend at the hip toward the knee
      th.quaternion.copy(A.iQ.pelvis).multiply(_q);
      _v.set(leg.position.x - A.hip[s2].x, leg.position.y - A.hip[s2].y, leg.position.z - A.hip[s2].z);
      if (_v.lengthSq() > 1e-10) th.position.copy(_v.applyQuaternion(A.iQ.pelvis).divideScalar(A.s)).add(R['thigh_' + s2].p);
      else th.position.copy(R['thigh_' + s2].p);
      _q2.copy(_q).multiply(R['calf_' + s2].q);                         // calf world (body space)
      _v.copy(A.dCalf).applyQuaternion(_q2); _v2.subVectors(_F, _K).normalize();
      _q3.setFromUnitVectors(_v, _v2); _q2.premultiply(_q3);
      cf.quaternion.copy(_q).invert().multiply(_q2);
      // foot: rigid with the calf in the air, flat on the floor when planted
      var qf = _q.copy(_q2).multiply(R['foot_' + s2].q);
      if (plant > 0) qf.slerp(A.Q['foot_' + s2], plant);
      ft.quaternion.copy(_q2.invert()).multiply(qf);
    }
  }
  var _ax = V();
  function curlHand(st, sd, grip) {
    var L = st.A.curl[sd], B = st.bones, R = st.A.rest;
    for (var i = 0; i < L.length; i++) {
      var c = L[i], ang = c.thumb ? (grip ? (c.k === 1 ? 0.15 : 0.55) : 0.12) : (grip ? (c.k === 1 ? 1.25 : 1.05) : (c.k === 1 ? 0.25 : 0.2));
      B[c.name].quaternion.copy(R[c.name].q).multiply(_q.setFromAxisAngle(_ax.copy(c.ax), ang));
    }
  }
  CM.sync = function (root) { var m = findModel(root); if (m) { sync(m); } };

  // ---------------------------------------------------------------- arm IK for skinned arms
  /* Same contract as the game's armIK(a,target,pole,blend) (world-space target/pole), but with the real arm
     lengths and the hanging-arm geometry (upper arm abducted by ARM_ABD, elbow hinge on the proxy X axis). */
  var _S = V(), _T = V(), _P = V(), _ax2 = V(), _E = V(), _uA = V(), _fA = V(), _e1 = V(), _e2 = V(), _e3 = V(), _g1 = V(), _g2 = V(), _g3 = V();
  var _M1 = new T.Matrix4(), _M2 = new T.Matrix4(), _qik = new T.Quaternion();
  CM.armIK = function (a, target, pole, blend) {
    var par = a.p.parent; par.updateWorldMatrix(true, false);
    _S.copy(a.p.position); _T.copy(par.worldToLocal(_T.copy(target))); _P.copy(par.worldToLocal(_P.copy(pole)));
    var L1 = a.cmL1, L2 = a.cmL2, al = a.cmAbd, cA = Math.cos(al);
    var maxR = Math.sqrt(L1 * L1 + L2 * L2 + 2 * L1 * L2 * cA) * 0.999;
    _ax2.subVectors(_T, _S); var d = _ax2.length(); d = Math.min(Math.max(d, 0.08), maxR); _ax2.normalize();
    var nP = _P.sub(_S); nP.addScaledVector(_ax2, -nP.dot(_ax2)); if (nP.lengthSq() < 1e-6) nP.set(0, -1, 0); nP.normalize();
    var ca = Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))), sa = Math.sqrt(1 - ca * ca);
    _E.copy(_S).addScaledVector(_ax2, L1 * ca).addScaledVector(nP, L1 * sa);
    _uA.subVectors(_E, _S).normalize();
    _fA.copy(_S).addScaledVector(_ax2, d).sub(_E).normalize();
    var cosT = Math.max(-1, Math.min(1, _uA.dot(_fA)));
    var bend = -Math.acos(Math.max(-1, Math.min(1, cosT / cA)));
    // proxy-local segment directions for that bend
    _e1.set(Math.sin(al), -Math.cos(al), 0);
    _e2.set(0, -Math.cos(bend), -Math.sin(bend));
    _e2.addScaledVector(_e1, -_e2.dot(_e1)).normalize(); _e3.crossVectors(_e1, _e2);
    _g1.copy(_uA); _g2.copy(_fA).addScaledVector(_g1, -_fA.dot(_g1));
    if (_g2.lengthSq() < 1e-8) _g2.copy(nP).multiplyScalar(-1); _g2.normalize(); _g3.crossVectors(_g1, _g2);
    _M1.makeBasis(_e1, _e2, _e3); _M2.makeBasis(_g1, _g2, _g3); _M2.multiply(_M1.transpose());
    _qik.setFromRotationMatrix(_M2);
    if (blend >= 1) a.p.quaternion.copy(_qik); else a.p.quaternion.slerp(_qik, blend);
    var x0 = a.el.rotation.x; a.el.rotation.set(x0 + (bend - x0) * Math.min(1, blend), 0, 0);
  };

  // ================================================================ WARDROBE (clothing)
  /* CharModel.dress(root, [{k, c, c2, p}]) puts procedural clothes on a skinned body.
     - "Shell" garments are copies of body triangles selected by region, pushed out along the (welded) normals,
       with the body's own skin weights, so they deform exactly like the skin. Each shell is sealed back onto the
       body by a thin lip at its edges, and the body triangles underneath are removed (index-only geometry
       variant), so nothing can poke through and there are no gaps.
     - Skirts, coat/robe hems and aprons are skinned tubes weighted between pelvis and thighs.
     - Hats, shoes, armour bits etc. are rigid meshes on bones, placed from the calibrated rest pose.
     - All garment materials share one shader (patterns/decorations are uniforms). */
  var P_HEAD = 1, P_NECK = 2, P_TORSO = 3, P_PELVIS = 4, P_ARM = 5, P_PALM = 6, P_LEG = 7, P_FOOT = 8, P_FING = 9;
  function partOf(nm) {
    if (nm === 'Head') return P_HEAD; if (nm === 'neck_01') return P_NECK;
    if (/^(spine_|clavicle_)/.test(nm)) return P_TORSO; if (nm === 'pelvis' || nm === 'root') return P_PELVIS;
    if (/^(upperarm|lowerarm)_/.test(nm)) return P_ARM; if (/^hand_/.test(nm)) return P_PALM;
    if (/^(index|middle|ring|pinky|thumb)_/.test(nm)) return P_FING;
    if (/^(thigh|calf)_/.test(nm)) return P_LEG; if (/^(foot|ball)/.test(nm)) return P_FOOT; return P_TORSO;
  }
  // ---- per-sex analysis of the body mesh (model units, bind/T pose), done once on first use
  function wprep(A) {
    if (A.wd) return A.wd;
    var mesh = null; A.proto.traverse(function (o) { if (o.isSkinnedMesh && o.name === A.meshNames.body) mesh = o; });
    var g = mesh.geometry, pa = g.attributes.position, na = g.attributes.normal, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    var n = pa.count, idx = g.index.array, nT = idx.length / 3, s = A.s;
    var bn = mesh.skeleton.bones.map(function (b) { return b.name; });
    var D = { A: A, mesh: mesh, n: n, nT: nT, idx: idx, bn: bn, bi: {}, s: s,
      X: new Float32Array(n), Y: new Float32Array(n), Z: new Float32Array(n), NX: new Float32Array(n), NY: new Float32Array(n), NZ: new Float32Array(n),
      part: new Uint8Array(n), armT: new Float32Array(n), legT: new Float32Array(n), side: new Int8Array(n), wid: new Int32Array(n),
      SI: new Uint16Array(n * 4), SW: new Float32Array(n * 4) };
    bn.forEach(function (b, i) { D.bi[b] = i; });
    var J = D.J = {}; bn.forEach(function (b, i) { J[b] = V().setFromMatrixPosition(mesh.skeleton.boneInverses[i].clone().invert()); });
    var Jc = D.Jc = {}, calW = D.calW = {};
    Object.keys(A.bones).forEach(function (b) { calW[b] = (A.calW0 ? A.calW0[b] : A.bones[b].matrixWorld).clone(); Jc[b] = A.BS(V().setFromMatrixPosition(calW[b])); });
    D.Mi = new T.Matrix4().compose(V(0, 0, A.zOff), new T.Quaternion(), V(s, s, s)).invert();
    var keyMap = new Map(), nw = 0;
    for (var i = 0; i < n; i++) {
      var x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
      D.X[i] = x; D.Y[i] = y; D.Z[i] = z; D.NX[i] = na.getX(i); D.NY[i] = na.getY(i); D.NZ[i] = na.getZ(i);
      var key = Math.round(x * 1e5) + ',' + Math.round(y * 1e5) + ',' + Math.round(z * 1e5);
      var w = keyMap.get(key); if (w === undefined) { w = nw++; keyMap.set(key, w); } D.wid[i] = w;
      var dom = 0, dw = -1;
      for (var k = 0; k < 4; k++) { var j = comp(si, i, k), wt = comp(sw, i, k); D.SI[i * 4 + k] = j; D.SW[i * 4 + k] = wt; if (wt > dw) { dw = wt; dom = j; } }
      var pt = D.part[i] = partOf(bn[dom]);
      D.side[i] = x > 0.0005 ? 1 : x < -0.0005 ? -1 : 0;
      D.armT[i] = (Math.abs(x) - J.upperarm_l.x) / (J.hand_l.x - J.upperarm_l.x);
      D.legT[i] = (J.thigh_l.y - y) / (J.thigh_l.y - J.foot_l.y);
    }
    D.nw = nw;
    // welded edge id for every triangle corner edge (corner q of triangle t = edge q -> q+1)
    var em = new Map(), eid = new Int32Array(nT * 3), ne = 0;
    for (var t0 = 0; t0 < nT; t0++) for (var q0 = 0; q0 < 3; q0++) {
      var a0 = D.wid[idx[t0 * 3 + q0]], b0 = D.wid[idx[t0 * 3 + (q0 + 1) % 3]], kk = a0 < b0 ? a0 * 65536 + b0 : b0 * 65536 + a0;
      var e0 = em.get(kk); if (e0 === undefined) { e0 = ne++; em.set(kk, e0); } eid[t0 * 3 + q0] = e0;
    }
    D.eid = eid; D.ne = ne;
    // welded edge use counts (the mesh is closed, so every edge is shared by two triangles)
    D.edgeKey = function (a, b) { var wa = D.wid[a], wb = D.wid[b]; return wa < wb ? wa * 65536 + wb : wb * 65536 + wa; };
    // ---- measurements (model units)
    var M = D.M = { yW: J.pelvis.y + 0.075, yHip: J.thigh_l.y, yKnee: J.calf_l.y, yAnk: J.foot_l.y, xs: J.upperarm_l.x, xe: J.lowerarm_l.x, xw: J.hand_l.x,
      yNeck: J.neck_01.y, yArm: J.upperarm_l.y };
    var BIN = 0.01, nb = Math.ceil(2.0 / BIN), zf = new Float32Array(nb).fill(-9), zb = new Float32Array(nb).fill(9), wx = new Float32Array(nb),
      lx = new Float32Array(nb), lzf = new Float32Array(nb).fill(-9), lzb = new Float32Array(nb).fill(9);
    var GX = 31, zg = new Float32Array(GX * nb).fill(-9);
    var hd = { top: -9, minY: 9 }, armR = new Float32Array(25), legR = new Float32Array(25), nk = { rx: 0, zf: -9, zb: 9 };
    for (i = 0; i < n; i++) {
      var X = D.X[i], Y = D.Y[i], Z = D.Z[i], p = D.part[i], b = Math.max(0, Math.min(nb - 1, Math.round(Y / BIN)));
      if ((p === P_TORSO || p === P_PELVIS || p === P_NECK) && Math.abs(X) < 0.04) { if (D.NZ[i] > 0.3) zf[b] = Math.max(zf[b], Z); if (D.NZ[i] < -0.3) zb[b] = Math.min(zb[b], Z); }
      if (p === P_TORSO || p === P_PELVIS) wx[b] = Math.max(wx[b], Math.abs(X));
      if ((p === P_TORSO || p === P_PELVIS || p === P_NECK) && D.NZ[i] > 0.2) { var gx = Math.round(X / 0.02) + 15; if (gx >= 0 && gx < GX) zg[gx * nb + b] = Math.max(zg[gx * nb + b], Z); }
      if (p === P_TORSO || p === P_PELVIS || p === P_LEG || p === P_FOOT) { lx[b] = Math.max(lx[b], Math.abs(X)); lzf[b] = Math.max(lzf[b], Z); lzb[b] = Math.min(lzb[b], Z); }
      if (p === P_HEAD) { hd.top = Math.max(hd.top, Y); }
      if (p === P_NECK && Math.abs(Y - (J.neck_01.y + 0.03)) < 0.015) { nk.rx = Math.max(nk.rx, Math.abs(X)); nk.zf = Math.max(nk.zf, Z); nk.zb = Math.min(nk.zb, Z); }
      if ((p === P_ARM || p === P_PALM) && X > 0) { var t = D.armT[i], ab = Math.max(0, Math.min(24, Math.round(t * 20))); armR[ab] = Math.max(armR[ab], Math.hypot(Y - J.upperarm_l.y, Z - J.upperarm_l.z)); }
      if ((p === P_LEG || p === P_FOOT) && X > 0 && Y > J.foot_l.y) { var lt = D.legT[i], lb = Math.max(0, Math.min(24, Math.round(lt * 20))); var az = J.thigh_l.z + (J.foot_l.z - J.thigh_l.z) * Math.max(0, Math.min(1, lt)); legR[lb] = Math.max(legR[lb], Math.hypot(X - J.thigh_l.x, Z - az)); }
    }
    // fill holes in the profiles
    function fill(a, bad) { var last = null; for (var q = 0; q < a.length; q++) { if (bad(a[q])) { if (last !== null) a[q] = last; } else last = a[q]; } }
    fill(zf, function (v) { return v < -8; }); fill(zb, function (v) { return v > 8; }); fill(lzf, function (v) { return v < -8; }); fill(lzb, function (v) { return v > 8; });
    for (var gx2 = 0; gx2 < GX; gx2++) { var lastz = null; for (var yb = 0; yb < nb; yb++) { var zz = zg[gx2 * nb + yb]; if (zz < -8) { if (lastz !== null) zg[gx2 * nb + yb] = lastz; } else lastz = zz; } }
    M.zfx = function (x, y) { var gx = Math.max(0, Math.min(GX - 1, Math.round(x / 0.02) + 15)), yb = Math.max(0, Math.min(nb - 1, Math.round(y / BIN))); var z = zg[gx * nb + yb]; return z < -8 ? at(zf, y) : z; };
    var at = function (a, y) { return a[Math.max(0, Math.min(nb - 1, Math.round(y / BIN)))]; };
    M.zf = function (y) { return at(zf, y); }; M.zb = function (y) { return at(zb, y); }; M.wx = function (y) { return at(wx, y); };
    M.legExt = function (y) { return { rx: at(lx, y), zf: at(lzf, y), zb: at(lzb, y) }; };
    M.armR = function (t) { return armR[Math.max(0, Math.min(24, Math.round(t * 20)))]; };
    M.legR = function (t) { return legR[Math.max(0, Math.min(24, Math.round(t * 20)))]; };
    M.neck = nk;
    // head: forehead ring a little above the eyes
    var ringY = hd.top - 0.075, rng = { rx: 0, zf: -9, zb: 9 }, eyeL = { rx: 0, zf: -9 }, eyeY = A.eyeBindY, faceZ = -9;
    for (i = 0; i < n; i++) {
      if (D.part[i] !== P_HEAD) continue;
      if (Math.abs(D.Y[i] - ringY) < 0.012) { rng.rx = Math.max(rng.rx, Math.abs(D.X[i])); rng.zf = Math.max(rng.zf, D.Z[i]); rng.zb = Math.min(rng.zb, D.Z[i]); }
      if (Math.abs(D.Y[i] - eyeY) < 0.012) { eyeL.rx = Math.max(eyeL.rx, Math.abs(D.X[i])); eyeL.zf = Math.max(eyeL.zf, D.Z[i]); }
      if (D.Y[i] > eyeY - 0.12 && D.Y[i] < eyeY + 0.03) faceZ = Math.max(faceZ, D.Z[i]);
    }
    M.head = { top: hd.top, ringY: ringY, rx: rng.rx, zf: rng.zf, zb: rng.zb, eyeY: eyeY, eyeRx: eyeL.rx, eyeZf: eyeL.zf, faceZ: faceZ };
    // ---- body-space (meters) versions for rigid pieces
    var B = D.B = {};
    var bsY = function (y) { return y * s; }, bsZ = function (z) { return z * s + A.zOff; };
    B.head = { y: bsY(ringY), cz: bsZ((rng.zf + rng.zb) / 2), rx: rng.rx * s, rz: (rng.zf - rng.zb) / 2 * s, top: bsY(hd.top),
      eyeY: bsY(eyeY), eyeZ: bsZ(eyeL.zf), earX: eyeL.rx * s, faceZ: bsZ(faceZ) };
    B.neck = { y: bsY(J.neck_01.y + 0.03), rx: nk.rx * s, rz: (nk.zf - nk.zb) / 2 * s, cz: bsZ((nk.zf + nk.zb) / 2), base: bsY(J.neck_01.y - 0.02) };
    B.zf = function (y) { return bsZ(M.zf(y / s)); }; B.zfx = function (x, y) { return bsZ(M.zfx(x / s, y / s)); }; B.zb = function (y) { return bsZ(M.zb(y / s)); }; B.wx = function (y) { return M.wx(y / s) * s; };
    B.yW = bsY(M.yW); B.shTop = bsY(J.upperarm_l.y + M.armR(0) * 0.9);
    return D;
  }
  function attachMatrix(D, bone, at) { return D.calW[bone].clone().invert().multiply(D.Mi).multiply(new T.Matrix4().makeTranslation(at.x, at.y, at.z)); }

  // ---- shell builder: body triangles where sel(i) holds for all three corners, offset by d(i) meters
  function buildShell(D, o) {
    var n = D.n, nT = D.nT, idx = D.idx, s = D.s;
    var ok = new Uint8Array(n); for (var i = 0; i < n; i++) ok[i] = o.sel(i) ? 1 : 0;
    var tri = new Uint8Array(nT), used = new Int32Array(n).fill(-1), cnt = 0, ec = new Uint8Array(D.ne), eid = D.eid;
    for (var t = 0; t < nT; t++) {
      var a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      if (!(ok[a] && ok[b] && ok[c])) continue; tri[t] = 1; cnt++;
      ec[eid[t * 3]]++; ec[eid[t * 3 + 1]]++; ec[eid[t * 3 + 2]]++;
    }
    if (!cnt) return null;
    var P = [], N = [], SI = [], SW = [], H = [], I = [];
    function addV(src, off, hem) {
      var d = off ? (typeof o.d === 'function' ? o.d(src) : o.d) / s : 0;
      P.push(D.X[src] + D.NX[src] * d, D.Y[src] + D.NY[src] * d, D.Z[src] + D.NZ[src] * d);
      N.push(D.NX[src], D.NY[src], D.NZ[src]);
      for (var k = 0; k < 4; k++) { SI.push(D.SI[src * 4 + k]); SW.push(D.SW[src * 4 + k]); }
      H.push(hem); return P.length / 3 - 1;
    }
    var base = new Int32Array(n).fill(-1);
    for (t = 0; t < nT; t++) {
      if (!tri[t]) continue;
      var v = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
      for (var q = 0; q < 3; q++) if (used[v[q]] < 0) used[v[q]] = addV(v[q], true, 0);
      I.push(used[v[0]], used[v[1]], used[v[2]]);
      if (o.lip === false) continue;
      for (q = 0; q < 3; q++) {   // edges shared with an unselected triangle get a lip back down to the skin
        var e0 = v[q], e1 = v[(q + 1) % 3];
        if (ec[eid[t * 3 + q]] !== 1) continue;
        if (o.lipSkip && o.lipSkip(e0) && o.lipSkip(e1)) continue;
        H[used[e0]] = 1; H[used[e1]] = 1;
        if (base[e0] < 0) base[e0] = addV(e0, false, 1); if (base[e1] < 0) base[e1] = addV(e1, false, 1);
        I.push(used[e0], base[e0], used[e1], used[e1], base[e0], base[e1]);
      }
    }
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new T.Float32BufferAttribute(N, 3));
    g.setAttribute('skinIndex', new T.Uint16BufferAttribute(SI, 4)); g.setAttribute('skinWeight', new T.Float32BufferAttribute(SW, 4));
    g.setAttribute('hem', new T.Float32BufferAttribute(H, 1)); g.setIndex(I);
    g.computeBoundingSphere(); g.boundingSphere.radius *= 1.3;
    return { geo: g, tri: tri };
  }
  // ---- skirt / hem tube from y0 to y1 (model units), weighted pelvis -> thighs
  function buildTube(D, o) {
    var M = D.M, s = D.s, segs = o.segs || 32, rings = o.rings || Math.max(7, Math.min(16, Math.round(Math.abs(o.y0 - o.y1) / 0.06) + 4)), a0 = o.a0 == null ? -Math.PI : o.a0, a1 = o.a1 == null ? Math.PI : o.a1;
    var full = a1 - a0 > 6.2, cols = full ? segs : segs + 1;
    var iP = D.bi.pelvis, iL = D.bi.thigh_l, iR = D.bi.thigh_r, iCL = D.bi.calf_l, iCR = D.bi.calf_r;
    var P = [], SI = [], SW = [], H = [], I = [];
    var e0 = M.legExt(o.y0), cz = (e0.zf + e0.zb) / 2, NS = 64, prevR = new Float32Array(NS), yPrev = o.y0;
    for (var r = 0; r < rings; r++) {
      var t = Math.pow(r / (rings - 1), 1.5), y = o.y0 + (o.y1 - o.y0) * t, tn = Math.pow((r + 1) / (rings - 1), 1.5), band = Math.max(0.025, Math.abs(o.y1 - o.y0) * (tn - t) * 0.6);
      // polar profile of the body around (0, cz) in this slice (legs, hips, torso), 64 sectors
      var pr = new Float32Array(NS), i;
      for (i = 0; i < D.n; i++) {
        var pt = D.part[i]; if (pt !== P_TORSO && pt !== P_PELVIS && pt !== P_LEG && pt !== P_FOOT) continue;
        if (D.Y[i] - y > (r ? yPrev - y : 0.025) || y - D.Y[i] > band) continue;
        var dx = D.X[i], dz = D.Z[i] - cz, sec = Math.round((Math.atan2(dx, dz) + Math.PI) / (2 * Math.PI) * NS) % NS, rr = Math.hypot(dx, dz);
        if (rr > pr[sec]) pr[sec] = rr;
      }
      var pr2 = new Float32Array(NS);
      for (i = 0; i < NS; i++) { var m = 0; for (var k = -3; k <= 3; k++) m = Math.max(m, pr[(i + k + NS) % NS] * (1 - Math.abs(k) * 0.015)); pr2[i] = Math.max(m, prevR[i]); }
      prevR = pr2; var yPrev = y;
      var off = (o.off + (o.flare || 0) * Math.pow((o.y0 - y) / (o.y0 - o.y1), o.flareExp || 1.5)) / s;
      var kL = Math.min(1, Math.max(0, (o.y0 - y) * s / 0.15)) * (o.legK == null ? 0.92 : o.legK);
      for (var c = 0; c < cols; c++) {
        var th = a0 + (a1 - a0) * c / segs, sx = Math.sin(th), si = Math.round(((th + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI) * NS) % NS;
        var R = pr2[si] + off;
        P.push(R * sx, y, cz + R * Math.cos(th));
        var wl = Math.min(1, Math.max(0, (sx + 0.4) / 0.8)), wr = 1 - wl;
        var kc = o.calf ? Math.max(0, (y < M.yKnee ? (M.yKnee - y) / (M.yKnee - M.yAnk) : 0)) * 0.5 : 0;
        SI.push(iP, iL, iR, wl > 0.5 ? iCL : iCR); SW.push(1 - kL, kL * wl * (1 - kc), kL * wr * (1 - kc), kL * kc);
        H.push(r === rings - 1 ? 1 : 0);
      }
      if (r) for (c = 0; c < segs; c++) {
        var A0 = (r - 1) * cols + c, B0 = (r - 1) * cols + (c + 1) % cols, C0 = r * cols + c, D0 = r * cols + (c + 1) % cols;
        I.push(A0, C0, B0, B0, C0, D0);
      }
    }
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(P, 3));
    g.setAttribute('skinIndex', new T.Uint16BufferAttribute(SI, 4)); g.setAttribute('skinWeight', new T.Float32BufferAttribute(SW, 4));
    g.setAttribute('hem', new T.Float32BufferAttribute(H, 1)); g.setIndex(I); g.computeVertexNormals();
    g.computeBoundingSphere(); g.boundingSphere.radius *= 1.4;
    return g;
  }
  // ---- rigid parts: primitives in body-space meters around an anchor, merged per material slot
  var PRIM = {};
  function prim(k) {
    if (PRIM[k]) return PRIM[k];
    var p = k.split(':'), g;
    switch (p[0]) {
      case 'sph': g = new T.SphereGeometry(1, 16, 12); break;
      case 'hemi': g = new T.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2); break;
      case 'cap': g = new T.SphereGeometry(1, 18, 8, 0, Math.PI * 2, 0, +p[1]); break;          // sphere cap down to polar angle p1
      case 'band': g = new T.CylinderGeometry(1, 1, 1, 24, 1, true); break;
      case 'cyl': g = new T.CylinderGeometry(1, 1, 1, 16); break;
      case 'tcyl': g = new T.CylinderGeometry(+p[1], 1, 1, 16, 1, p[2] === 'o'); break;          // tapered: top radius p1
      case 'cone': g = new T.ConeGeometry(1, 1, 12); break;
      case 'box': g = new T.BoxGeometry(1, 1, 1); break;
      case 'tor': g = new T.TorusGeometry(1, +p[1], 8, 28, p[2] ? +p[2] : Math.PI * 2); break;
      case 'part': g = new T.SphereGeometry(1, 20, 12, Math.PI / 2 + +p[1], +p[2], +p[3], +p[4]); break;   // partial sphere: azimuth start relative to the front (+Z), length, polar start, polar length
    }
    g = g.index ? g.toNonIndexed() : g;
    return (PRIM[k] = g);
  }
  var _pm = new T.Matrix4(), _pn = new T.Matrix3(), _pe = new T.Euler(), _pq = new T.Quaternion();
  function mergeParts(parts) {
    var out = {};
    parts.forEach(function (q) {
      var g = prim(q.g), pos = g.attributes.position, nor = g.attributes.normal;
      _pe.set(q.r ? q.r[0] : 0, q.r ? q.r[1] : 0, q.r ? q.r[2] : 0, q.o || 'XYZ');
      _pm.compose(V(q.p[0], q.p[1], q.p[2]), _pq.setFromEuler(_pe), V(q.s[0], q.s[1], q.s[2]));
      _pn.getNormalMatrix(_pm);
      var L = out[q.m] || (out[q.m] = { P: [], N: [] }), v = V(), w = V();
      for (var i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(_pm); w.fromBufferAttribute(nor, i).applyMatrix3(_pn).normalize();
        L.P.push(v.x, v.y, v.z); L.N.push(w.x, w.y, w.z);
      }
    });
    var res = {};
    Object.keys(out).forEach(function (m) {
      var g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(out[m].P, 3)); g.setAttribute('normal', new T.Float32BufferAttribute(out[m].N, 3));
      g.setAttribute('hem', new T.Float32BufferAttribute(new Float32Array(out[m].P.length / 3), 1));
      g.computeBoundingSphere(); res[m] = g;
    });
    return res;
  }
  // a strip that follows the body front (ties, plackets); pts = [[x,y,z,halfWidth],...] in body space
  function stripParts(pts, th, m) {
    var parts = [];
    for (var i = 0; i + 1 < pts.length; i++) {
      var a = pts[i], b = pts[i + 1], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dy, dz);
      parts.push({ g: 'box', p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], s: [a[3] + b[3], L * 1.04, th], r: [Math.atan2(dz, -dy) * -1, 0, 0], m: m });
    }
    return parts;
  }

  // ---- materials (one shader for every garment; pattern/deco are uniforms)
  var PATS = { solid: 0, stripes: 1, plaid: 2, camo: 3, chain: 4, check: 5, pinstripe: 6, fur: 7 };
  var DECOS = { none: 0, side: 1, placket: 2, ribs: 3, wrap: 4, reflect: 5, bands: 6, zip: 7, lapel: 8 };
  var GLSL_PAT = [
    'uniform vec3 uC2; uniform float uPat, uDeco, uSkGrad, uMetal; varying float vHem; varying vec3 vCp; varying vec3 vBn;',
    'vec3 cmVal(vec3 c){ float l = dot(c, vec3(0.299, 0.587, 0.114)); float l2 = 0.045 + min(l, 1.0) * 0.72; return mix(vec3(l2), c * (l2 / max(l, 0.001)), smoothstep(0.0, 0.04, l)); }',
    'float cmH(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }',
    'float cmN(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(mix(cmH(i), cmH(i + vec3(1,0,0)), f.x), mix(cmH(i + vec3(0,1,0)), cmH(i + vec3(1,1,0)), f.x), f.y),',
    '             mix(mix(cmH(i + vec3(0,0,1)), cmH(i + vec3(1,0,1)), f.x), mix(cmH(i + vec3(0,1,1)), cmH(i + vec3(1,1,1)), f.x), f.y), f.z); }',
    'vec3 cmPattern(vec3 c){',
    '  float fq = (uPat > 5.5 && uPat < 6.5) ? 1.0 : mix(1.0, 0.6, uCmStyle);',
    '  vec3 p = vCp * fq, c2 = uC2, col = c; float u = p.x + p.z * 0.7;',
    '  if (uPat > 0.5 && uPat < 1.5) col = mix(c, c2, step(0.5, fract(p.y * 12.0)));',
    '  else if (uPat < 2.5 && uPat > 1.5) { float a = step(0.62, fract(p.y * 8.0)), b = step(0.62, fract(u * 8.0));',
    '    col = mix(c, c2, 0.42 * (a + b)); float l = max(step(0.93, fract(p.y * 24.0 + 0.3)), step(0.93, fract(u * 24.0 + 0.3))); col = mix(col, c * 0.55, 0.5 * l); }',
    '  else if (uPat < 3.5 && uPat > 2.5) { float n1 = cmN(p * 9.0) + 0.5 * cmN(p * 19.0), n2 = cmN(p * 7.0 + 11.3);',
    '    col = n1 > 0.98 ? c2 : (n2 > 0.56 ? mix(c, c2, 0.45) * 0.7 : c); }',
    '  else if (uPat < 4.5 && uPat > 3.5) { vec2 q = vec2(u * 70.0, p.y * 80.0); q.x += 0.5 * mod(floor(q.y), 2.0); float d = length(fract(q) - 0.5);',
    '    col = mix(c * 0.3, c * 1.1, smoothstep(0.17, 0.03, abs(d - 0.32))); }',
    '  else if (uPat < 5.5 && uPat > 4.5) col = mix(c, c2, mod(floor(p.x * 24.0) + floor(p.y * 24.0) + floor(p.z * 24.0), 2.0));',
    '  else if (uPat < 6.5 && uPat > 5.5) { bool lg = p.y < 0.93 && abs(p.x) > 0.02; vec2 cc = lg ? vec2(sign(p.x) * 0.11, -0.03) : vec2(0.0); col = mix(c, c2, step(0.86, fract(atan(p.x - cc.x, p.z - cc.y) * (lg ? 3.2 : 5.5)))); }',
    '  else if (uPat > 6.5) col = c * (0.7 + 0.55 * cmN(p * 70.0) + 0.15 * cmN(p * 9.0));',
    '  p = vCp; u = p.x + p.z * 0.7;',
    '  float dd = uDeco;',
    '  if (dd > 0.5 && dd < 1.5 && vBn.x * sign(p.x) > 0.955) col = c2;',                                        // side stripe
    '  else if (dd > 1.5 && dd < 2.5 && vBn.z > 0.3) { if (abs(p.x) < 0.011) col = mix(col, c2, 0.85); if (abs(p.x) < 0.007 && fract(p.y * 12.5) < 0.22) col = c2 * 0.5; }',
    '  else if (dd > 2.5 && dd < 3.5 && vHem > 0.05) col *= 0.82 + 0.18 * step(0.5, fract(u * 90.0));',          // ribbing on hems
    '  else if (dd > 3.5 && dd < 4.5 && vBn.z > 0.15 && p.y > 1.07 && p.y < 1.48) { float lx = p.y > 1.27 ? abs(p.x) - (0.075 - (1.47 - p.y) * 0.38) : p.x + (1.27 - p.y) * 0.5; if (abs(lx) < 0.022) col *= 0.72; }',
    '  else if (dd > 4.5 && dd < 5.5) { float b = (abs(p.y - 1.08) < 0.022 || abs(p.y - 0.62) < 0.022 || abs(abs(p.x) - 0.58) < 0.022) ? 1.0 : 0.0; col = mix(col, c2, b); }',
    '  else if (dd > 5.5 && dd < 6.5) col = mix(col, c2, step(0.8, fract(abs(p.x) * 20.0 + 0.1)));',
    '  else if (dd > 6.5 && dd < 7.5 && vBn.z > 0.3 && abs(p.x) < 0.006) col = c2;',
    '  else if (dd > 7.5 && vBn.z > 0.2 && p.y > 1.0) { float lx = 0.03 + (p.y - 1.0) * 0.32; if (abs(abs(p.x) - lx) < 0.022) col = c2; }',
    '  col *= mix(1.0, 0.86, vHem);',
    '  if (uCmStyle > 0.5) {',
    '    col = cmVal(col);',
    '    if (uSkGrad > 0.5) col *= mix(0.84, 1.1, smoothstep(0.3, 1.5, vCp.y));',   // lighter shoulders, darker hems
    '    col *= 0.94 + 0.12 * smoothstep(-0.3, 0.7, vCmNW.y);',                    // broad top-lit planes
    '    if (uMetal > 0.5) { float band = smoothstep(0.1, 0.42, vCmNW.y) * (1.0 - smoothstep(0.6, 0.9, vCmNW.y));',
    '      col = col * (0.42 + 0.5 * band) + vec3(0.06, 0.05, 0.03) * band; }',
    '  }',
    '  return col;',
    '}'].join('\n');
  function garmOBC(shader) {
    var U = this.__gU; if (U) for (var k in U) shader.uniforms[k] = U[k];
    paintHook(shader, { rough: U && U.uMetal.value > 0.5 ? 0.5 : 0.82, metK: 0.25, facet: true });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float hem;\nvarying float vHem;\nvarying vec3 vCp;\nvarying vec3 vBn;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHem = hem; vCp = position; vBn = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_PAT)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = cmPattern(diffuseColor.rgb);');
  }
  function garmKey() { return 'cmGarm2'; }
  var MTYPE = {
    cloth: { roughness: 0.92, metalness: 0 }, denim: { roughness: 0.85, metalness: 0 }, leather: { roughness: 0.55, metalness: 0.05 },
    metal: { roughness: 0.32, metalness: 0.62 }, plastic: { roughness: 0.38, metalness: 0 }, rubber: { roughness: 0.75, metalness: 0 },
    fur: { roughness: 1, metalness: 0 }, gold: { roughness: 0.3, metalness: 0.7, emissive: 0x2a1c00 }, glass: { roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.38 },
    emis: { roughness: 0.5, metalness: 0, emissive: 0x222222 } };
  var FIXED = { metal: [0x9aa0aa, 'metal'], gold: [0xd9b04a, 'gold'], dark: [0x1e1c1a, 'rubber'], white: [0xf0eee8, 'cloth'], sole: [0xe6e2d8, 'rubber'],
    glass: [0x9ec4dc, 'glass'], visor: [0x2fa060, 'glass'], gem: [0xc02040, 'plastic'], wood: [0x6a4a2a, 'leather'], black: [0x161616, 'plastic'],
    shirt: [0xf2f0ea, 'cloth'], steel: [0x6a7078, 'metal'], skin: [0xc89a78, 'cloth'] };
  var GMATS = {};
  function gmat(type, c, c2, pat, deco, skinned) {
    var key = type + '|' + c + '|' + c2 + '|' + pat + '|' + deco + '|' + (skinned ? 1 : 0);
    if (GMATS[key]) return GMATS[key];
    var mt = MTYPE[type] || MTYPE.cloth;
    var m = new T.MeshStandardMaterial(Object.assign({ color: c, side: T.DoubleSide, skinning: !!skinned }, mt));
    if (type === 'fur') pat = 'fur';
    m.__gU = { uC2: { value: new T.Color(c2 == null ? c : c2) }, uPat: { value: PATS[pat] || 0 }, uDeco: { value: DECOS[deco] || 0 },
      uSkGrad: { value: skinned ? 1 : 0 }, uMetal: { value: type === 'metal' || type === 'gold' ? 1 : 0 },
      uFacet: { value: skinned ? 0.35 : (type === 'metal' || type === 'gold' || type === 'plastic' || type === 'leather' || type === 'rubber' ? 1 : 0.5) } };
    m.extensions = { derivatives: true };
    m.onBeforeCompile = garmOBC; m.customProgramCacheKey = garmKey;
    m.clone = function () { var x = T.MeshStandardMaterial.prototype.clone.call(this); x.__gU = this.__gU; x.onBeforeCompile = garmOBC; x.customProgramCacheKey = garmKey; return x; };
    m.name = 'cmGarm';
    return (GMATS[key] = m);
  }

  // ---- catalog
  var GDEF = {};
  CM.GARMENTS = {};
  function G(kind, slot, name, def) { def.slot = slot; def.name = name; GDEF[kind] = def; CM.GARMENTS[kind] = { slot: slot, name: name }; }
  // selection helpers (D = per-sex data, i = vertex)
  function top(D, o) {
    var M = D.M, bottom = Math.max(M.yHip + 0.03, o.bottom != null ? o.bottom : M.yW - 0.05), sl = o.sleeve == null ? 1 : o.sleeve, nd = o.nd == null ? 0.0 : o.nd, sc = o.scoop || 0;
    return function (i) {
      var p = D.part[i], y = D.Y[i];
      if (p === P_ARM || p === P_PALM) return sl > 0 && D.armT[i] <= sl && (!o.side || D.side[i] === o.side);
      if (p === P_NECK) return !!o.neck && y < M.yNeck + 0.05;
      if (p === P_LEG) return y >= bottom && D.legT[i] < 0.12 && (!o.open || D.Z[i] < 0.02 || Math.abs(D.X[i]) > o.open[0]);
      if (p !== P_TORSO && p !== P_PELVIS) return false;
      if (y < bottom) return false;
      if (o.open && D.Z[i] > 0.02 && y > o.open[1] && Math.abs(D.X[i]) < o.open[0] + Math.max(0, y - o.open[1]) * (o.open[2] || 0)) return false;
      if (o.front && !o.front(i)) return false;
      return o.neck || y < M.yNeck - nd + Math.max(0, Math.abs(D.X[i]) - 0.07) * (o.rise || 1.6) - (D.Z[i] > 0.02 ? sc : 0);
    };
  }
  function legs(D, o) {
    var M = D.M, tp = o.top == null ? M.yW + 0.025 : o.top, hem = o.hem == null ? 0.97 : o.hem;
    return function (i) {
      var p = D.part[i];
      if (p === P_TORSO || p === P_PELVIS) return D.Y[i] < tp;
      if (p === P_LEG) return D.legT[i] <= hem;
      if (p === P_FOOT) return hem >= 1.2;
      return false;
    };
  }
  function band(D, y0, y1, d) { return function (i) { var p = D.part[i]; return (p === P_TORSO || p === P_PELVIS) && D.Y[i] >= y0 && D.Y[i] <= y1; }; }
  function forearm(D, t0, t1, side, hand) {
    return function (i) { var p = D.part[i]; if (side && D.side[i] !== side) return false;
      if (p === P_ARM) return D.armT[i] >= t0 && D.armT[i] <= t1; if (p === P_PALM) return !!hand || t1 > 1.05; if (p === P_FING) return hand === 2; return false; };
  }
  function shin(D, t0, t1) { return function (i) { var p = D.part[i]; return (p === P_LEG || p === P_FOOT) && D.legT[i] >= t0 && D.legT[i] <= t1 && D.part[i] !== P_FOOT; }; }
  function feetSel(D) { return function (i) { return D.part[i] === P_FOOT || (D.part[i] === P_LEG && D.legT[i] > 0.93); }; }
  function handSel(D) { return function (i) { var p = D.part[i]; return p === P_PALM || p === P_FING || (p === P_ARM && D.armT[i] > 0.96); }; }
  function or(a, b) { return function (i) { return a(i) || b(i); }; }
  // anchors (body space, meters)
  function headAt(D) { return V(0, D.B.head.y, D.B.head.cz); }
  function spineAt(D, y, back) { return V(0, y, back ? D.B.zb(y) : D.B.zf(y)); }
  // rigid item helper
  function R(bone, at, parts, extra) { return Object.assign({ rigid: true, bone: bone, at: at, parts: parts }, extra || {}); }
  function both(f) { return [f('l', 1), f('r', -1)]; }

  // shells
  var D_TOP = 0.009;
  G('tshirt', 'top', 'T-shirt', { c: 0x8a3a3a, paint: ['top'], build: function (D) { return [{ shell: { sel: top(D, { sleeve: 0.36, scoop: 0.012 }), d: D_TOP } }]; } });
  G('longsleeve', 'top', 'Long-sleeve shirt', { c: 0x3a5a7a, paint: ['top'], build: function (D) { return [{ shell: { sel: top(D, { sleeve: 0.985, scoop: 0.01 }), d: D_TOP } }]; } });
  G('tank', 'top', 'Tank top', { c: 0xe8e4dc, paint: ['top'], build: function (D) { return [{ shell: { sel: top(D, { sleeve: -1, scoop: 0.045, rise: 2.4, nd: 0.025 }), d: 0.007 } }]; } });
  G('hoodie', 'top', 'Hoodie', { c: 0x4a4e58, c2: 0x2a2c30, paint: ['top', 'belt'], build: function (D) {
    var B = D.B, nb = B.neck.base, zb = B.zb(nb - 0.05), yp = B.yW + 0.09;
    return [{ shell: { sel: top(D, { sleeve: 0.99, nd: 0.012 }), d: 0.02 }, deco: 'ribs' }, hemTube(D, D.M.yHip - 0.06, 0.017, 0.012),
      hoodDown(D, 'c'),
      R('spine_01', V(0, yp, B.zf(yp) + 0.022), [{ g: 'box', p: [0, 0, 0], s: [0.21, 0.12, 0.022], r: [-0.12, 0, 0], m: 'c' }, { g: 'box', p: [0, 0.061, 0.004], s: [0.2, 0.008, 0.02], m: 'c2' }]),
      R('spine_03', V(0, nb - 0.02, B.zf(nb - 0.02) + 0.02), [{ g: 'cyl', p: [0.03, -0.07, 0], s: [0.004, 0.14, 0.004], m: 'c2' }, { g: 'cyl', p: [-0.03, -0.07, 0], s: [0.004, 0.14, 0.004], m: 'c2' }])];
  } });
  function collar(D, m, h, extra) {
    var N = D.B.neck; return R('spine_03', V(0, N.base + 0.005, N.cz - 0.004), [{ g: 'tcyl:1.05:o', p: [0, h / 2, 0], s: [N.rx + 0.02 + (extra || 0), h, N.rz + 0.022 + (extra || 0)], m: m }]);
  }
  G('buttonshirt', 'top', 'Button shirt', { c: 0xdfe6ee, c2: 0x8a96a6, paint: ['top'], build: function (D) {
    return [{ shell: { sel: top(D, { sleeve: 0.985, nd: 0.018 }), d: D_TOP }, deco: 'placket' }, collar(D, 'c', 0.035)];
  } });
  G('sweater', 'top', 'Sweater', { c: 0x7a5a3a, paint: ['top', 'belt'], build: function (D) { return [{ shell: { sel: top(D, { sleeve: 0.985, nd: 0.008 }), d: 0.017 }, deco: 'ribs' }, Object.assign(hemTube(D, D.M.yHip - 0.035, 0.014, 0.008), { deco: 'ribs' })]; } });
  function hemTube(D, y1, off, flare, o) { var M = D.M; return { tube: Object.assign({ y0: M.yW, y1: y1, off: off, flare: flare || 0.02, legK: 0.85 }, o || {}) }; }
  function belt(D, d, w, m, buckle) {
    var M = D.M, y = M.yW, by = y * D.s, it = [{ shell: { sel: band(D, y - w, y + w), d: d }, m: m || 'c2', t: 'leather' }];
    if (buckle !== false) it.push(R('pelvis', V(0, by, D.B.zf(by) + d + 0.006), [{ g: 'box', p: [0, 0, 0], s: [0.055, 0.045, 0.012], m: 'gold' }, { g: 'box', p: [0, 0, 0.006], s: [0.032, 0.024, 0.008], m: 'c2' }]));
    return it;
  }
  G('tunic', 'top', 'Tunic', { c: 0x6a5a3a, c2: 0x3a2818, paint: ['top', 'belt'], build: function (D) {
    var M = D.M; return [{ shell: { sel: top(D, { sleeve: 0.9, nd: 0.02, scoop: 0.025 }), d: 0.014 } },
      hemTube(D, M.yHip - (M.yHip - M.yKnee) * 0.5, 0.01, 0.05)].concat(belt(D, 0.026, 0.02, 'c2'));
  } });
  G('jumpsuit', 'top', 'Jumpsuit', { c: 0x4a6a8a, c2: 0x2a3a4a, paint: ['top', 'bot', 'belt'], build: function (D) {
    return [{ shell: { sel: top(D, { sleeve: 0.985, bottom: D.M.yW - 0.06, nd: 0.012 }), d: 0.013 }, deco: 'zip' },
      { shell: { sel: legs(D, { hem: 0.96 }), d: 0.011 }, grp: 'lo' }];
  } });
  G('chefcoat', 'top', 'Chef coat', { c: 0xf2f0ea, c2: 0x2a2a2a, paint: ['top', 'belt'], build: function (D) {
    var B = D.B, M = D.M, items = [{ shell: { sel: top(D, { sleeve: 0.97, nd: 0.008 }), d: 0.016 } }, hemTube(D, M.yHip - 0.12, 0.013, 0.02), collar(D, 'c', 0.04)];
    var parts = [];
    [0.0, 0.085, 0.17].forEach(function (k) { var y = B.yW + 0.08 + k; [-1, 1].forEach(function (sx) { parts.push({ g: 'sph', p: [sx * 0.05, y - B.yW, B.zfx(sx * 0.05, y) - B.zf(B.yW) + 0.019], s: [0.011, 0.011, 0.006], m: 'c2' }); }); });
    items.push(R('spine_02', V(0, B.yW, B.zf(B.yW)), parts));
    return items;
  } });
  G('suit', 'top', 'Suit', { c: 0x2a2e38, c2: 0x8a2020, paint: ['top', 'belt'], build: function (D) {
    var M = D.M; return [{ shell: { sel: top(D, { sleeve: 0.995, nd: 0.016 }), d: 0.008 }, m: 'shirt', deco: 'placket' },
      { shell: { sel: top(D, { sleeve: 0.95, nd: 0.0, open: [0.014, M.yW - 0.02, 0.3] }), d: 0.022 } }, hemTube(D, M.yHip - 0.1, 0.019, 0.02, { a0: 0.18, a1: Math.PI * 2 - 0.18, segs: 30 }),
      collar(D, 'shirt', 0.03, -0.004)].concat(tieItems(D, 'c2'));
  } });
  function tieItems(D, m) {
    var B = D.B, y0 = B.neck.base + 0.005, y1 = B.yW + 0.06, pts = [], k;
    for (k = 0; k <= 8; k++) { var y = y0 + (y1 - y0) * k / 8; pts.push([0, y - y0, B.zf(y) - B.zf(y0) + 0.003, 0.012 + 0.024 * k / 8]); }
    var parts = stripParts(pts, 0.008, m); parts.push({ g: 'box', p: [0, -0.012, 0.006], s: [0.034, 0.03, 0.02], m: m });
    parts.push({ g: 'box', p: [0, y1 - y0 - 0.012, B.zf(y1) - B.zf(y0) + 0.004], s: [0.036, 0.036, 0.008], r: [0, 0, Math.PI / 4], m: m });
    return [R('spine_03', V(0, y0, B.zf(y0) + 0.026), parts)];
  }
  G('gi', 'top', 'Gi', { c: 0xeeece4, c2: 0x161616, paint: ['top', 'belt'], build: function (D) {
    var M = D.M; return [{ shell: { sel: top(D, { sleeve: 0.78, nd: 0.0, scoop: 0.03 }), d: function (i) { return 0.016 + (D.part[i] === P_ARM ? 0.035 * Math.max(0, D.armT[i] - 0.4) : 0); } }, deco: 'wrap', m: 'c' }, hemTube(D, M.yHip - 0.1, 0.014, 0.025)].concat(belt(D, 0.028, 0.024, 'c2', false)).concat([
      R('pelvis', V(D.B.wx(M.yW * D.s) * 0.55, M.yW * D.s, D.B.zf(M.yW * D.s) + 0.02), [{ g: 'sph', p: [0, 0, 0], s: [0.025, 0.02, 0.018], m: 'c2' }, { g: 'box', p: [-0.012, -0.08, 0.004], s: [0.026, 0.14, 0.006], r: [0, 0, 0.12], m: 'c2' }, { g: 'box', p: [0.016, -0.075, 0.004], s: [0.026, 0.13, 0.006], r: [0, 0, -0.18], m: 'c2' }])]);
  } });
  // outer
  G('jacket', 'outer', 'Leather jacket', { c: 0x2a2220, t: 'leather', paint: [], build: function (D) {
    return [{ shell: { sel: top(D, { sleeve: 0.97, bottom: D.M.yW - 0.08, nd: 0.0, open: [0.04, D.M.yW - 0.2, 0.15] }), d: 0.025 }, deco: 'zip' }, collar(D, 'c', 0.045, 0.012)];
  } });
  function longCoat(D, o) {
    var M = D.M;
    return [{ shell: { sel: top(D, { sleeve: o.sleeve || 0.98, bottom: M.yHip - 0.03, nd: o.nd == null ? 0.0 : o.nd, open: o.open }), d: o.d || 0.03, lipSkip: o.lipSkip }, deco: o.deco },
      { tube: { y0: M.yW, y1: o.y1, off: (o.d || 0.03) - 0.008, flare: o.flare || 0.06, calf: o.calf }, deco: o.deco }];
  }
  G('coat', 'outer', 'Long coat', { c: 0x8a6a3a, c2: 0xd8d84a, paint: ['top', 'belt'], build: function (D) { return longCoat(D, { y1: D.M.yKnee - 0.03, deco: 'reflect' }).concat([collar(D, 'c', 0.06, 0.016)]); } });
  G('robe', 'outer', 'Robe', { c: 0x3a2a6a, c2: 0xd9b04a, paint: ['top', 'belt'], build: function (D) {
    var it = longCoat(D, { y1: 0.07, flare: 0.13, calf: true, sleeve: 1.0, d: 0.026, nd: 0.0 });
    it[0].shell.d = function (i) { return 0.026 + (D.part[i] === P_ARM ? 0.075 * Math.pow(Math.max(0, D.armT[i] - 0.35) / 0.65, 1.6) : 0); };
    it[0].shell.lipSkip = function (i) { return D.part[i] === P_ARM && D.armT[i] > 0.9; };
    return it;
  } });
  G('vest', 'outer', 'Vest', { c: 0x5a4a3a, paint: [], build: function (D) { return [{ shell: { sel: top(D, { sleeve: -1, bottom: D.M.yW - 0.06, nd: 0.0, rise: 2.4, open: [0.045, D.M.yW - 0.2, 0.2] }), d: 0.026 } }]; } });
  G('apron', 'outer', 'Apron', { c: 0xe8e2d4, paint: [], build: function (D) {
    var M = D.M, s = D.s;
    var bib = function (i) { var p = D.part[i]; return (p === P_TORSO || p === P_PELVIS) && D.Z[i] > 0.02 && Math.abs(D.X[i]) < 0.13 && D.Y[i] > M.yW - 0.03 && D.Y[i] < D.J.spine_03.y + 0.09; };
    var B = D.B, ny = B.neck.base;
    return [{ shell: { sel: bib, d: 0.032 } }, { shell: { sel: band(D, M.yW - 0.012, M.yW + 0.012), d: 0.034 } },
      { tube: { y0: M.yW, y1: M.yKnee - 0.05, off: 0.03, flare: 0.04, a0: -1.25, a1: 1.25, segs: 18 } },
      R('spine_03', V(0, ny, B.neck.cz), [{ g: 'tor:0.12:3.3', p: [0, -0.02, 0], s: [B.neck.rx + 0.03, B.neck.rx + 0.03, B.neck.rz + 0.035], r: [Math.PI / 2 + 0.5, 0, 0], m: 'c' }])];
  } });
  G('platecarrier', 'outer', 'Plate carrier', { c: 0x4a5236, c2: 0x3a4028, paint: [], build: function (D) {
    var M = D.M, B = D.B, items = [{ shell: { sel: top(D, { sleeve: -1, bottom: M.yW - 0.01, nd: 0.06, scoop: 0.05, rise: 3.5 }), d: 0.045 } }], parts = [];
    var y = B.yW + 0.07; [-0.085, 0, 0.085].forEach(function (x) { parts.push({ g: 'box', p: [x, 0, 0.035], s: [0.075, 0.1, 0.045], m: 'c2' }, { g: 'box', p: [x, 0.052, 0.04], s: [0.078, 0.02, 0.05], m: 'c' }); });
    items.push(R('spine_02', V(0, y, B.zf(y) + 0.04), parts));
    return items;
  } });
  G('cuirass', 'outer', 'Cuirass', { c: 0xb8bcc4, t: 'metal', paint: [], build: function (D) {
    return [{ shell: { sel: top(D, { sleeve: -1, bottom: D.M.yW - 0.035, nd: 0.05, scoop: 0.03, rise: 3.0 }), d: 0.036 } }];
  } });
  function capeItem(D, o) {
    var B = D.B, yTop = B.shTop + 0.005, zTop = B.zb(yTop) - 0.012, rows = 10, cols = 13, P = [], I = [];
    var len = o.len, w0 = o.w0, w1 = o.w1;
    for (var r = 0; r < rows; r++) {
      var t = r / (rows - 1), y = -len * t, by = yTop + y, back = Math.min(B.zb(Math.max(0.5, by)), B.zb(Math.max(0.5, by + 0.05))) - 0.025;
      var zb = Math.min(back - zTop, -0.0 - 0.02 * t), w = w0 + (w1 - w0) * Math.pow(t, 0.8), wrap = (o.wrap || 1.25) * (1 - t * 0.55);
      for (var c = 0; c < cols; c++) {
        var a = (c / (cols - 1) - 0.5) * 2 * wrap;
        P.push(Math.sin(a) * w, y + (r === 0 ? -Math.abs(Math.sin(a)) * 0.06 : 0), zb + (1 - Math.cos(a)) * w * 0.55 * (1 - t * 0.6));
      }
      if (r) for (c = 0; c + 1 < cols; c++) { var A0 = (r - 1) * cols + c; I.push(A0, A0 + 1, A0 + cols, A0 + 1, A0 + cols + 1, A0 + cols); }
    }
    var g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(P, 3)); g.setIndex(I); g.computeVertexNormals();
    var h = new Float32Array(P.length / 3); for (var k = (rows - 1) * cols; k < rows * cols; k++) h[k] = 1; g.setAttribute('hem', new T.BufferAttribute(h, 1));
    g = g.toNonIndexed(); g.computeBoundingSphere();
    return { rigid: true, bone: 'spine_03', at: V(0, yTop, zTop), geos: { c: g }, dyn: 'cape' };
  }
  function hoodDown(D, m) { var nb = D.B.neck.base, zb = D.B.zb(nb - 0.05); return R('spine_03', V(0, nb - 0.02, zb - 0.05), [{ g: 'sph', p: [0, 0, 0], s: [0.16, 0.09, 0.08], m: m }, { g: 'tor:0.35', p: [0, 0.035, 0.03], s: [0.11, 0.07, 0.08], r: [Math.PI / 2 - 0.3, 0, 0], m: m }]); }
  G('cloak', 'outer', 'Cloak', { c: 0x3a4a2a, paint: [], noPack: true, build: function (D) {
    var B = D.B, M = D.M, mantle = function (i) { var p = D.part[i]; if (p === P_ARM) return D.armT[i] < 0.3; return (p === P_TORSO) && D.Y[i] > M.yArm - 0.1 && D.Y[i] < M.yNeck + 0.01; };
    return [capeItem(D, { len: 1.12, w0: 0.21, w1: 0.36, wrap: 1.5 }), hoodDown(D, 'c'), { shell: { sel: mantle, d: 0.03 } },
      R('spine_03', V(0, B.neck.base - 0.01, B.zf(B.neck.base - 0.01) + 0.02), [{ g: 'cyl', p: [0, 0, 0], s: [0.018, 0.008, 0.018], r: [Math.PI / 2, 0, 0], m: 'gold' }])];
  } });
  G('labcoat', 'outer', 'Lab coat', { c: 0xf4f4f2, paint: [], build: function (D) { return longCoat(D, { y1: D.M.yKnee + 0.02, d: 0.028, open: [0.02, D.M.yW - 0.3, 0.12], flare: 0.04 }).concat([collar(D, 'c', 0.04, 0.012)]); } });
  // legs
  var D_LEG = 0.008;
  G('jeans', 'legs', 'Jeans', { c: 0x34507a, t: 'denim', paint: ['bot', 'belt'], build: function (D) { return [{ shell: { sel: legs(D, { hem: 0.965 }), d: D_LEG }, grp: 'lo' }]; } });
  G('pants', 'legs', 'Pants', { c: 0x3a3630, paint: ['bot', 'belt'], build: function (D) { return [{ shell: { sel: legs(D, { hem: 0.965 }), d: D_LEG }, grp: 'lo' }]; } });
  G('cargo', 'legs', 'Cargo pants', { c: 0x5a5a40, c2: 0x4a4a34, paint: ['bot', 'belt'], build: function (D) {
    var J = D.Jc, items = [{ shell: { sel: legs(D, { hem: 0.965 }), d: 0.011 }, grp: 'lo' }];
    both(function (sd, sg) {
      var th = J['thigh_' + sd], cf = J['calf_' + sd], y = th.y + (cf.y - th.y) * 0.45, r = D.M.legR(0.25) * D.s + 0.012;
      items.push(R('thigh_' + sd, V(th.x + sg * r * 0.9, y, th.z + 0.005), [{ g: 'box', p: [0, 0, 0], s: [0.035, 0.13, 0.11], m: 'c2' }, { g: 'box', p: [sg * 0.002, 0.062, 0], s: [0.04, 0.025, 0.115], m: 'c' }], { grp: 'lo' }));
    });
    return items;
  } });
  G('trackpants', 'legs', 'Track pants', { c: 0x1e2a4a, c2: 0xf0f0f0, paint: ['bot', 'belt'], build: function (D) { return [{ shell: { sel: legs(D, { hem: 0.965 }), d: 0.009 }, deco: 'side', grp: 'lo' }]; } });
  G('shorts', 'legs', 'Shorts', { c: 0x6a7a5a, paint: ['bot', 'belt'], build: function (D) { return [{ shell: { sel: legs(D, { hem: 0.42 }), d: 0.01 }, grp: 'lo' }]; } });
  G('chainpants', 'legs', 'Chainmail leggings', { c: 0x9aa0a8, t: 'metal', pat: 'chain', paint: ['bot', 'belt'], build: function (D) { return [{ shell: { sel: legs(D, { hem: 0.965 }), d: 0.012 }, grp: 'lo' }]; } });
  G('skirt', 'legs', 'Skirt', { c: 0x6a2a4a, paint: ['bot', 'belt'], build: function (D) {
    var M = D.M; return [{ shell: { sel: legs(D, { hem: 0.1 }), d: 0.009 }, grp: 'lo' }, { tube: { y0: M.yW - 0.01, y1: M.yHip - (M.yHip - M.yKnee) * 0.62, off: 0.008, flare: 0.09, flareExp: 1.2 }, grp: 'lo' }];
  } });
  G('kneepads', 'knees', 'Kneepads', { c: 0x2a2a2a, c2: 0x5a5a5a, t: 'plastic', paint: [], build: function (D) {
    return both(function (sd) { var k = D.Jc['calf_' + sd], r = D.M.legR(0.5) * D.s; return R('calf_' + sd, V(k.x, k.y - 0.01, k.z + r + 0.005), [{ g: 'sph', p: [0, 0, 0], s: [0.05, 0.065, 0.028], m: 'c' }, { g: 'band', p: [0, 0, -r * 0.9], s: [r + 0.012, 0.03, r + 0.012], m: 'c2' }], { grp: 'lo' }); });
  } });
  // feet: rigid shoes on the foot bones (the bare feet underneath are removed)
  function shoe(D, sd, o) {
    var f = D.Jc['foot_' + sd], toe = D.Jc['ball_leaf_' + sd], heel = f.z - 0.07, L = toe.z - heel + 0.03, cz = heel + L / 2 - f.z, w = o.w || 0.052;
    var parts = [{ g: 'cyl', p: [0, -f.y + o.sole / 2, cz], s: [w + 0.008, o.sole, L / 2 + 0.008], m: o.solem || 'sole' },
      { g: 'hemi', p: [0, -f.y + o.sole, cz + 0.005], s: [w, o.h, L / 2], m: 'c' }];
    if (o.toe) parts.push({ g: 'hemi', p: [0, -f.y + o.sole, cz + L * 0.3], s: [w * 0.95, o.h * 0.7, L * 0.22], m: o.toe });
    if (o.stripe) parts.push({ g: 'box', p: [0, -f.y + o.sole + 0.025, cz], s: [w * 2.08, 0.012, L * 0.5], r: [0.25, 0, 0], m: 'c2' });
    if (o.collar) parts.push({ g: 'tcyl:1.1:o', p: [0, 0.015, -0.01], s: [0.05, 0.06, 0.055], m: 'c' });
    return R('foot_' + sd, f.clone(), parts, { grp: 'lo' });
  }
  function feetGarment(o, extra) { return function (D) { var it = both(function (sd) { return shoe(D, sd, o); }); return extra ? it.concat(extra(D)) : it; }; }
  G('sneakers', 'feet', 'Sneakers', { c: 0xe8e8e8, c2: 0xc03030, paint: ['boot'], hideFeet: true, build: feetGarment({ sole: 0.028, h: 0.06, stripe: true, collar: true }) });
  G('runners', 'feet', 'Running shoes', { c: 0x2a6ad0, c2: 0xf0f0f0, paint: ['boot'], hideFeet: true, build: feetGarment({ sole: 0.03, h: 0.05, w: 0.047, stripe: true }) });
  G('boots', 'feet', 'Work boots', { c: 0x4a3420, t: 'leather', paint: ['boot'], hideFeet: true, build: feetGarment({ sole: 0.035, h: 0.09, w: 0.058, toe: 'steel', solem: 'dark', collar: true }, function (D) { return [{ shell: { sel: shin(D, 0.7, 1.2), d: 0.022 }, grp: 'lo' }]; }) });
  G('sandals', 'feet', 'Sandals', { c: 0x8a5a2a, t: 'leather', paint: ['boot'], build: function (D) {
    return both(function (sd) {
      var f = D.Jc['foot_' + sd], toe = D.Jc['ball_leaf_' + sd], heel = f.z - 0.07, L = toe.z - heel + 0.03, cz = heel + L / 2 - f.z;
      return R('foot_' + sd, f.clone(), [{ g: 'cyl', p: [0, -f.y + 0.008, cz], s: [0.055, 0.016, L / 2 + 0.008], m: 'c' },
        { g: 'tor:0.12:3.14', p: [0, -f.y + 0.012, cz + L * 0.22], s: [0.05, 0.05, 0.04], r: [0, 0, 0], m: 'c' },
        { g: 'tor:0.12:3.14', p: [0, -f.y + 0.012, cz - L * 0.1], s: [0.05, 0.065, 0.04], m: 'c' }], { grp: 'lo' });
    });
  } });
  G('greaves', 'feet', 'Greaves', { c: 0xa8acb4, t: 'metal', paint: ['boot'], hideFeet: true, build: feetGarment({ sole: 0.03, h: 0.09, w: 0.058, toe: 'c', solem: 'dark' }, function (D) {
    return [{ shell: { sel: shin(D, 0.5, 1.2), d: 0.028 }, grp: 'lo' }].concat(both(function (sd) { var k = D.Jc['calf_' + sd], r = D.M.legR(0.5) * D.s; return R('calf_' + sd, V(k.x, k.y, k.z + r + 0.012), [{ g: 'sph', p: [0, 0, 0], s: [0.04, 0.048, 0.02], m: 'c' }], { grp: 'lo' }); }));
  }) });
  // hands / arms
  G('gloves', 'hands', 'Gloves', { c: 0x2a2420, t: 'leather', paint: [], build: function (D) { return [{ shell: { sel: handSel(D), d: 0.005 } }]; } });
  G('wraps', 'hands', 'Hand wraps', { c: 0xe8e2d0, c2: 0xc8c0a8, pat: 'stripes', paint: [], build: function (D) { return [{ shell: { sel: forearm(D, 0.86, 1.4, 0, 1), d: 0.006 } }]; } });
  G('mitts', 'hands', 'Oven mitts', { c: 0xc83a3a, c2: 0xf0e8d8, pat: 'check', paint: [], hideHands: true, build: function (D) {
    return both(function (sd, sg) { var h = D.Jc['hand_' + sd]; return R('hand_' + sd, h.clone(), [{ g: 'sph', p: [sg * -0.01, -0.075, 0.0], s: [0.055, 0.11, 0.06], m: 'c' }, { g: 'sph', p: [sg * -0.03, -0.05, 0.05], s: [0.025, 0.05, 0.025], r: [-0.4, 0, 0], m: 'c' }, { g: 'tcyl:1.0:o', p: [sg * -0.004, 0.015, 0], s: [0.05, 0.06, 0.05], m: 'c2' }]); });
  } });
  G('knuckles', 'hands', 'Brass knuckles', { c: 0xd9b04a, t: 'gold', paint: [], build: function (D) {
    return both(function (sd, sg) { var m = D.Jc['middle_01_' + sd]; return R('middle_01_' + sd, m.clone(), [{ g: 'box', p: [sg * -0.012, -0.012, 0.0], s: [0.016, 0.022, 0.095], m: 'c' }, { g: 'tor:0.3', p: [sg * -0.012, -0.012, 0.03], s: [0.016, 0.016, 0.016], r: [0, Math.PI / 2, 0], m: 'c' }, { g: 'tor:0.3', p: [sg * -0.012, -0.012, 0.0], s: [0.016, 0.016, 0.016], r: [0, Math.PI / 2, 0], m: 'c' }, { g: 'tor:0.3', p: [sg * -0.012, -0.012, -0.03], s: [0.016, 0.016, 0.016], r: [0, Math.PI / 2, 0], m: 'c' }]); });
  } });
  G('gauntlets', 'hands', 'Gauntlets', { c: 0x9aa0a8, t: 'metal', paint: [], build: function (D) {
    var it = [{ shell: { sel: forearm(D, 0.74, 1.6, 0, 2), d: 0.011 } }];
    return it.concat(both(function (sd) { var e = D.Jc['lowerarm_' + sd], h = D.Jc['hand_' + sd], y = e.y + (h.y - e.y) * 0.72, r = D.M.armR(0.8) * D.s; return R('lowerarm_' + sd, V(e.x + (h.x - e.x) * 0.72, y, e.z), [{ g: 'tcyl:0.75:o', p: [0, 0, 0], s: [r + 0.03, 0.05, r + 0.03], m: 'c' }]); }));
  } });
  G('bracers', 'arms', 'Leather bracers', { c: 0x6a4428, c2: 0x3a2414, t: 'leather', deco: 'bands', paint: [], build: function (D) { return [{ shell: { sel: forearm(D, 0.6, 0.93), d: 0.015 } }]; } });
  G('vambraces', 'arms', 'Spiked vambraces', { c: 0x8a9098, t: 'metal', paint: [], build: function (D) {
    return [{ shell: { sel: forearm(D, 0.56, 0.93), d: 0.016 } }].concat(both(function (sd, sg) {
      var e = D.Jc['lowerarm_' + sd], h = D.Jc['hand_' + sd], r = D.M.armR(0.75) * D.s + 0.016, parts = [];
      [0.3, 0.55, 0.8].forEach(function (t) { parts.push({ g: 'cone', p: [sg * (r + 0.012), (h.y - e.y) * t, 0], s: [0.012, 0.035, 0.012], r: [0, 0, -sg * Math.PI / 2], m: 'metal' }); });
      return R('lowerarm_' + sd, e.clone(), parts);
    }));
  } });
  G('elbowpads', 'arms', 'Elbow pads', { c: 0x2a2a2a, t: 'plastic', paint: [], build: function (D) {
    return both(function (sd) { var e = D.Jc['lowerarm_' + sd], r = D.M.armR(0.5) * D.s; return R('lowerarm_' + sd, e.clone(), [{ g: 'sph', p: [0, 0.0, -r - 0.008], s: [0.045, 0.055, 0.025], m: 'c' }, { g: 'band', p: [0, 0, 0], s: [r + 0.01, 0.025, r + 0.01], m: 'c' }]); });
  } });
  G('armguard', 'arms', "Archer's armguard", { c: 0x7a5232, c2: 0x3a2414, t: 'leather', deco: 'bands', paint: [], build: function (D) { return [{ shell: { sel: forearm(D, 0.55, 0.93, 1), d: 0.016 } }]; } });
  // head (rigid on the Head bone, anchored on the forehead ring)
  function H(fn, extra) { return function (D) { var B = D.B.head; return [R('Head', headAt(D), fn(B, D), extra)]; }; }
  G('hardhat', 'head', 'Hard hat', { c: 0xe8c020, t: 'plastic', hair: 'hide', build: H(function (h) {
    return [{ g: 'hemi', p: [0, 0.0, 0], s: [h.rx + 0.03, h.top - h.y + 0.05, h.rz + 0.03], m: 'c' }, { g: 'cyl', p: [0, 0.0, 0.015], s: [h.rx + 0.06, 0.012, h.rz + 0.075], m: 'c' }, { g: 'hemi', p: [0, 0.0, 0], s: [0.022, h.top - h.y + 0.058, h.rz + 0.036], m: 'c' }];
  }) });
  G('skatehelmet', 'head', 'Skate helmet', { c: 0x2a2a2a, c2: 0xc03030, t: 'plastic', hair: 'hide', build: H(function (h) {
    return [{ g: 'cap:1.75', p: [0, 0.0, -0.005], s: [h.rx + 0.035, h.top - h.y + 0.055, h.rz + 0.035], m: 'c' }, { g: 'cap:1.2', p: [0, 0.0, -0.005], s: [0.03, h.top - h.y + 0.059, h.rz + 0.038], m: 'c2' }];
  }) });
  G('bucket', 'head', 'Mop bucket', { c: 0xe8d020, c2: 0x8a8a8a, t: 'plastic', hair: 'hide', build: H(function (h) {
    var H2 = h.top - h.y + 0.15;
    return [{ g: 'tcyl:0.8:o', p: [0, H2 / 2 - 0.05, 0], s: [h.rx + 0.07, H2, h.rz + 0.07], m: 'c' }, { g: 'cyl', p: [0, H2 - 0.05, 0], s: [(h.rx + 0.07) * 0.8, 0.008, (h.rz + 0.07) * 0.8], m: 'c' },
      { g: 'tor:0.1', p: [0, -0.05, 0], s: [h.rx + 0.075, h.rz + 0.075, 0.08], r: [Math.PI / 2, 0, 0], m: 'c' }, { g: 'tor:0.04:3.14', p: [0, -0.02, 0], s: [h.rx + 0.08, 0.12, 0.2], m: 'c2' }];
  }) });
  G('wig', 'head', 'Glam wig', { c: 0xe8c040, t: 'cloth', pat: 'fur', hair: 'hide', build: H(function (h) {
    var p = [], k; for (k = 0; k < 10; k++) { var a = k / 10 * Math.PI * 2; if (Math.cos(a) > 0.45) continue; p.push({ g: 'sph', p: [Math.sin(a) * (h.rx + 0.03), 0.02 + 0.03 * Math.cos(a * 2), Math.cos(a) * (h.rz + 0.03) - 0.02], s: [0.09, 0.1, 0.09], m: 'c' }); }
    p.push({ g: 'sph', p: [0, h.top - h.y + 0.01, -0.03], s: [h.rx + 0.06, 0.1, h.rz + 0.04], m: 'c' }, { g: 'sph', p: [0, 0.04, h.rz - 0.01], s: [h.rx + 0.02, 0.05, 0.05], r: [0.3, 0, 0], m: 'c' });
    [-1, 1].forEach(function (sx) { p.push({ g: 'sph', p: [sx * (h.rx + 0.07), -0.14, -0.06], s: [0.08, 0.17, 0.09], m: 'c' }, { g: 'sph', p: [sx * (h.rx + 0.05), -0.3, -0.06], s: [0.07, 0.12, 0.08], m: 'c' }); });
    p.push({ g: 'sph', p: [0, -0.12, -h.rz - 0.04], s: [0.14, 0.2, 0.08], m: 'c' });
    return p.filter(function (q) { return !(q.p[2] > h.rz * 0.4 && q.p[1] < 0.02); });
  }) });
  G('headset', 'head', 'Gaming headset', { c: 0x1a1a1e, c2: 0x40e060, t: 'plastic', hair: 'keep', build: H(function (h) {
    var ey = h.eyeY - h.y - 0.01, ez = 0.0;
    return [{ g: 'tor:0.07:3.14', p: [0, ey, ez], s: [h.earX + 0.03, h.top - h.y - ey + 0.03, 0.18], m: 'c' },
      { g: 'cyl', p: [h.earX + 0.02, ey, ez], s: [0.045, 0.03, 0.045], r: [0, 0, Math.PI / 2], m: 'c' }, { g: 'cyl', p: [-h.earX - 0.02, ey, ez], s: [0.045, 0.03, 0.045], r: [0, 0, Math.PI / 2], m: 'c' },
      { g: 'cyl', p: [h.earX + 0.037, ey, ez], s: [0.03, 0.004, 0.03], r: [0, 0, Math.PI / 2], m: 'c2' }, { g: 'cyl', p: [-h.earX - 0.037, ey, ez], s: [0.03, 0.004, 0.03], r: [0, 0, Math.PI / 2], m: 'c2' },
      { g: 'cyl', p: [h.earX + 0.008, ey - 0.045, 0.055], s: [0.005, 0.12, 0.005], r: [0.95, 0, 0.18], m: 'c' }, { g: 'sph', p: [h.earX - 0.01, ey - 0.08, 0.1], s: [0.012, 0.012, 0.014], m: 'c' }];
  }) });
  G('wizardhat', 'head', 'Wizard hat', { c: 0x2a2a7a, c2: 0xd9b04a, hair: 'under', build: H(function (h) {
    var b = h.top - h.y - 0.02;
    return [{ g: 'cyl', p: [0, 0.005, 0], s: [h.rx + 0.12, 0.012, h.rz + 0.12], m: 'c' }, { g: 'tcyl:0.45', p: [0, b / 2 + 0.03, 0], s: [h.rx + 0.045, b + 0.06, h.rz + 0.045], m: 'c' },
      { g: 'cone', p: [0, b + 0.22, -0.02], s: [(h.rx + 0.045) * 0.45, 0.32, (h.rz + 0.045) * 0.45], r: [-0.18, 0, 0], m: 'c' }, { g: 'cone', p: [0, b + 0.39, -0.09], s: [0.035, 0.14, 0.035], r: [-0.9, 0, 0], m: 'c' },
      { g: 'band', p: [0, 0.035, 0], s: [h.rx + 0.048, 0.035, h.rz + 0.048], m: 'c2' }];
  }) });
  G('hood', 'head', 'Hood', { c: 0x3a3a3a, hair: 'hide', build: function (D) {
    var h = D.B.head, nb = D.B.neck;
    return [R('Head', headAt(D), [{ g: 'part:0.95:4.38:0:2.25', p: [0, -0.02, -0.01], s: [h.rx + 0.045, h.top - h.y + 0.07, h.rz + 0.05], r: [0.15, 0, 0], m: 'c' },
      { g: 'sph', p: [0, h.top - h.y - 0.02, -h.rz * 0.5], s: [h.rx + 0.04, 0.07, h.rz * 0.8], m: 'c' }, { g: 'sph', p: [0, -0.07, -h.rz - 0.01], s: [h.rx * 0.95, 0.12, 0.06], m: 'c' }]),
      R('spine_03', V(0, nb.base, nb.cz), [{ g: 'tcyl:0.7:o', p: [0, 0.0, -0.015], s: [nb.rx + 0.075, 0.07, nb.rz + 0.075], m: 'c' }])];
  } });
  function capOn(h, o) { return [{ g: 'cap:' + (o.depth || 1.6), p: [0, o.y || 0, -0.005], s: [h.rx + (o.m || 0.022), h.top - h.y + (o.up || 0.035), h.rz + (o.m || 0.022)], m: 'c' }]; }
  G('cap', 'head', 'Baseball cap', { c: 0x2a4a8a, c2: 0xf0f0f0, hair: 'under', build: H(function (h) {
    return capOn(h, { depth: 1.45, y: 0.005, m: 0.038, up: 0.045 }).concat([{ g: 'cyl', p: [0, 0.012, h.rz + 0.065], s: [h.rx * 0.85, 0.008, 0.075], r: [0.12, 0, 0], m: 'c' }, { g: 'sph', p: [0, h.top - h.y + 0.05, 0], s: [0.012, 0.008, 0.012], m: 'c2' }]);
  }) });
  G('beanie', 'head', 'Beanie', { c: 0x8a2a2a, hair: 'hide', deco: 'ribs', build: H(function (h) {
    return capOn(h, { depth: 1.75, y: -0.005, m: 0.02, up: 0.05 }).concat([{ g: 'band', p: [0, 0.0, -0.005], s: [h.rx + 0.03, 0.05, h.rz + 0.03], m: 'c' }]);
  }) });
  G('bandana', 'head', 'Bandana', { c: 0xb02020, c2: 0xf0f0f0, pat: 'check', hair: 'hide', build: H(function (h) {
    return capOn(h, { depth: 1.62, y: 0.0, m: 0.018, up: 0.025 }).concat([{ g: 'sph', p: [0, -0.02, -h.rz - 0.02], s: [0.025, 0.02, 0.02], m: 'c' }, { g: 'box', p: [0.02, -0.08, -h.rz - 0.03], s: [0.03, 0.1, 0.004], r: [0.2, 0, 0.25], m: 'c' }, { g: 'box', p: [-0.02, -0.075, -h.rz - 0.03], s: [0.03, 0.09, 0.004], r: [0.2, 0, -0.3], m: 'c' }]);
  }) });
  G('headband', 'head', 'Headband', { c: 0xb02020, hair: 'keep', build: H(function (h) {
    return [{ g: 'band', p: [0, 0.0, -0.005], s: [h.rx + 0.022, 0.035, h.rz + 0.022], m: 'c' }, { g: 'sph', p: [0, 0, -h.rz - 0.025], s: [0.02, 0.02, 0.015], m: 'c' },
      { g: 'box', p: [0.025, -0.1, -h.rz - 0.04], s: [0.03, 0.18, 0.004], r: [0.35, 0, 0.18], m: 'c' }, { g: 'box', p: [-0.02, -0.09, -h.rz - 0.045], s: [0.03, 0.16, 0.004], r: [0.45, 0, -0.22], m: 'c' }];
  }) });
  G('beret', 'head', 'Beret', { c: 0x2a2a3a, hair: 'under', build: H(function (h) {
    return [{ g: 'sph', p: [0.025, h.top - h.y - 0.02, -0.01], s: [h.rx + 0.065, 0.05, h.rz + 0.055], r: [0, 0, -0.18], m: 'c' }, { g: 'tcyl:1.12:o', p: [0, 0.025, -0.005], s: [h.rx + 0.036, 0.05, h.rz + 0.036], m: 'c' }];
  }) });
  G('tophat', 'head', 'Top hat', { c: 0x161616, c2: 0x6a2020, hair: 'under', build: H(function (h) {
    var b = h.top - h.y; return [{ g: 'cyl', p: [0, 0.01, 0], s: [h.rx + 0.08, 0.01, h.rz + 0.08], m: 'c' }, { g: 'tcyl:1.08', p: [0, b / 2 + 0.11, 0], s: [h.rx + 0.04, b + 0.2, h.rz + 0.04], m: 'c' }, { g: 'band', p: [0, 0.045, 0], s: [h.rx + 0.043, 0.035, h.rz + 0.043], m: 'c2' }];
  }) });
  G('chefhat', 'head', "Chef's hat", { c: 0xf6f6f2, hair: 'under', build: H(function (h) {
    var b = h.top - h.y, p = [{ g: 'band', p: [0, 0.05, 0], s: [h.rx + 0.025, 0.1, h.rz + 0.025], m: 'c' }, { g: 'tcyl:1.25', p: [0, b + 0.06, 0], s: [h.rx + 0.02, 0.14, h.rz + 0.02], m: 'c' }];
    for (var k = 0; k < 6; k++) { var a = k / 6 * 6.28; p.push({ g: 'sph', p: [Math.sin(a) * 0.06, b + 0.15, Math.cos(a) * 0.055], s: [0.075, 0.06, 0.075], m: 'c' }); }
    p.push({ g: 'sph', p: [0, b + 0.17, 0], s: [0.08, 0.06, 0.08], m: 'c' }); return p;
  }) });
  G('visor', 'head', "Gambler's visor", { c: 0x2a6a3a, hair: 'keep', build: H(function (h) {
    return [{ g: 'band', p: [0, 0.0, -0.005], s: [h.rx + 0.022, 0.022, h.rz + 0.022], m: 'dark' }, { g: 'part:-1.2:2.4:1.4:0.5', p: [0, 0.035, 0.0], s: [h.rx + 0.06, 0.12, h.rz + 0.1], m: 'visor' }];
  }) });
  G('goggles', 'head', 'Goggles', { c: 0x5a3a20, c2: 0x8ab4c8, t: 'leather', hair: 'keep', build: H(function (h) {
    return [{ g: 'band', p: [0, 0.0, -0.005], s: [h.rx + 0.02, 0.022, h.rz + 0.02], m: 'c' }].concat([-1, 1].map(function (sx) { return { g: 'cyl', p: [sx * 0.035, 0.005, h.rz + 0.025], s: [0.026, 0.03, 0.026], r: [Math.PI / 2 - 0.3, 0, 0], m: 'metal' }; }))
      .concat([-1, 1].map(function (sx) { return { g: 'cyl', p: [sx * 0.035, 0.009, h.rz + 0.04], s: [0.02, 0.004, 0.02], r: [Math.PI / 2 - 0.3, 0, 0], m: 'c2' }; }));
  }) });
  G('helmet', 'head', 'Knight helmet', { c: 0xa8acb4, t: 'metal', hair: 'hide', build: H(function (h) {
    return [{ g: 'cap:1.62', p: [0, 0.0, -0.005], s: [h.rx + 0.03, h.top - h.y + 0.05, h.rz + 0.032], m: 'c' }, { g: 'band', p: [0, -0.005, -0.005], s: [h.rx + 0.035, 0.03, h.rz + 0.037], m: 'c' },
      { g: 'box', p: [0, -0.045, h.rz + 0.037], s: [0.018, 0.085, 0.01], m: 'c' }, { g: 'cap:1.4', p: [0, 0.0, -0.005], s: [0.02, h.top - h.y + 0.062, h.rz + 0.04], m: 'c' }]
      .concat([-1, 1].map(function (sx) { return { g: 'box', p: [sx * (h.rx + 0.025), -0.08, 0.02], s: [0.012, 0.12, 0.09], r: [0, sx * 0.25, 0], m: 'c' }; }))
      .concat([{ g: 'box', p: [0, -0.07, -h.rz - 0.02], s: [h.rx * 1.6, 0.12, 0.012], r: [0.12, 0, 0], m: 'c' }]);
  }) });
  G('crown', 'head', 'Crown', { c: 0xd9b04a, c2: 0xc02040, t: 'gold', hair: 'keep', build: H(function (h) {
    var p = [{ g: 'band', p: [0, 0.03, -0.005], s: [h.rx + 0.026, 0.045, h.rz + 0.026], m: 'c' }];
    for (var k = 0; k < 8; k++) { var a = k / 8 * 6.28; p.push({ g: 'cone', p: [Math.sin(a) * (h.rx + 0.026), 0.075, Math.cos(a) * (h.rz + 0.026) - 0.005], s: [0.016, 0.05, 0.008], r: [0, a, 0], m: 'c' }); }
    p.push({ g: 'sph', p: [0, 0.03, h.rz + 0.03], s: [0.012, 0.012, 0.008], m: 'c2' }); return p;
  }) });
  G('circlet', 'head', 'Circlet', { c: 0xd9b04a, c2: 0x40a0e0, t: 'gold', hair: 'keep', build: H(function (h) {
    return [{ g: 'tor:0.12', p: [0, 0.005, -0.008], s: [h.rx + 0.01, h.rz + 0.006, 0.05], r: [Math.PI / 2 + 0.12, 0, 0], m: 'c' }, { g: 'sph', p: [0, -0.003, h.rz + 0.008], s: [0.012, 0.014, 0.008], m: 'c2' }];
  }) });
  // face
  G('pbmask', 'face', 'Paintball mask', { c: 0x2a2a2a, c2: 0xc03030, t: 'plastic', build: H(function (h) {
    var ey = h.eyeY - h.y, fz = h.faceZ - h.cz;
    return [{ g: 'part:-1.15:2.3:1.62:0.85', p: [0, ey - 0.03, -0.01], s: [h.earX + 0.03, 0.13, fz + 0.035], m: 'c' }, { g: 'part:-0.95:1.9:1.2:0.75', p: [0, ey - 0.01, -0.008], s: [h.earX + 0.025, 0.1, fz + 0.04], m: 'glass' },
      { g: 'part:-1.0:2.0:0.9:0.32', p: [0, ey - 0.01, -0.008], s: [h.earX + 0.028, 0.1, fz + 0.042], m: 'c' },
      { g: 'box', p: [0, ey - 0.07, fz + 0.03], s: [0.05, 0.03, 0.02], m: 'c2' }, { g: 'band', p: [0, ey + 0.01, -0.005], s: [h.rx + 0.022, 0.03, h.rz + 0.022], m: 'dark' }];
  }) });
  G('glasses', 'face', 'Glasses', { c: 0x1a1a1a, t: 'plastic', build: H(function (h) {
    var ey = h.eyeY - h.y, ez = h.eyeZ - h.cz + 0.02, p = [];
    [-1, 1].forEach(function (sx) { p.push({ g: 'tor:0.12', p: [sx * 0.033, ey, ez], s: [0.022, 0.018, 0.02], m: 'c' }, { g: 'cyl', p: [sx * 0.033, ey, ez], s: [0.02, 0.002, 0.016], r: [Math.PI / 2, 0, 0], m: 'glass' }, { g: 'box', p: [sx * (h.earX + 0.004), ey + 0.005, ez / 2 - 0.02], s: [0.004, 0.004, ez + 0.07], m: 'c' }); });
    p.push({ g: 'box', p: [0, ey + 0.004, ez], s: [0.022, 0.004, 0.004], m: 'c' }); return p;
  }) });
  G('mask', 'face', 'Face mask', { c: 0x4a6a8a, build: H(function (h) {
    var ey = h.eyeY - h.y, fz = h.faceZ - h.cz;
    return [{ g: 'part:-1.3:2.6:1.45:0.85', p: [0, ey - 0.03, -0.014], s: [h.earX + 0.006, 0.11, fz + 0.01], m: 'c' }, { g: 'box', p: [h.earX + 0.006, ey - 0.03, -0.01], s: [0.004, 0.004, 0.07], m: 'white' }, { g: 'box', p: [-h.earX - 0.006, ey - 0.03, -0.01], s: [0.004, 0.004, 0.07], m: 'white' }];
  }) });
  G('monocle', 'face', 'Monocle', { c: 0xd9b04a, t: 'gold', build: H(function (h) {
    var ey = h.eyeY - h.y, ez = h.eyeZ - h.cz + 0.018;
    return [{ g: 'tor:0.12', p: [-0.033, ey, ez], s: [0.022, 0.022, 0.02], m: 'c' }, { g: 'cyl', p: [-0.033, ey, ez], s: [0.02, 0.002, 0.02], r: [Math.PI / 2, 0, 0], m: 'glass' }, { g: 'cyl', p: [-0.05, ey - 0.07, ez - 0.01], s: [0.0025, 0.12, 0.0025], r: [0.1, 0, 0.25], m: 'c' }];
  }) });
  // shoulders / back / neck / waist
  G('pauldrons', 'shoulders', 'Pauldrons', { c: 0xa8acb4, t: 'metal', build: function (D) {
    return both(function (sd, sg) { var u = D.Jc['upperarm_' + sd], r = D.M.armR(0.1) * D.s; return R('upperarm_' + sd, u.clone(), [
      { g: 'cap:1.35', p: [sg * 0.012, 0.0, 0], s: [r + 0.05, r + 0.035, r + 0.05], r: [0, 0, -sg * 0.35], m: 'c' }, { g: 'cap:1.2', p: [sg * 0.03, -0.045, 0], s: [r + 0.045, r + 0.02, r + 0.045], r: [0, 0, -sg * 0.5], m: 'c' },
      { g: 'cap:1.1', p: [sg * 0.045, -0.085, 0], s: [r + 0.035, r + 0.01, r + 0.04], r: [0, 0, -sg * 0.65], m: 'c' }]); });
  } });
  G('furmantle', 'shoulders', 'Fur mantle', { c: 0x6a5238, t: 'fur', build: function (D) {
    var B = D.B, y = B.shTop - 0.02, p = [], k; for (k = 0; k < 14; k++) { var a = k / 14 * 6.28; p.push({ g: 'sph', p: [Math.sin(a) * (B.wx(y) + 0.02), 0.01 + 0.015 * Math.cos(a * 3), Math.cos(a) * 0.11 - 0.01], s: [0.075, 0.06, 0.07], m: 'c' }); }
    return [R('spine_03', V(0, y, (B.zf(y) + B.zb(y)) / 2), p)];
  } });
  G('shoulderpad', 'shoulders', 'Shoulder pad', { c: 0x8a2a2a, c2: 0x2a2a2a, t: 'plastic', build: function (D) {
    var u = D.Jc.upperarm_l, r = D.M.armR(0.1) * D.s; return [R('upperarm_l', u.clone(), [{ g: 'cap:1.3', p: [0.01, 0.01, 0], s: [r + 0.075, r + 0.05, r + 0.07], r: [0, 0, -0.35], m: 'c' }, { g: 'cap:1.2', p: [0.035, -0.045, 0], s: [r + 0.06, r + 0.03, r + 0.06], r: [0, 0, -0.55], m: 'c2' }])];
  } });
  G('cape', 'back', 'Cape', { c: 0x8a1a1a, noPack: true, build: function (D) { return [capeItem(D, { len: 1.05, w0: 0.19, w1: 0.32, wrap: 1.2 })]; } });
  G('quiver', 'back', 'Quiver', { c: 0x6a4428, c2: 0xd8d0c0, t: 'leather', noPack: true, build: function (D) {
    var B = D.B, y = B.yW + 0.3, p = [{ g: 'tcyl:1.1', p: [0, 0, 0], s: [0.045, 0.5, 0.04], m: 'c' }, { g: 'tor:0.2', p: [0, 0.25, 0], s: [0.047, 0.047, 0.06], r: [Math.PI / 2, 0, 0], m: 'c' }];
    [[0.015, 0.01], [-0.015, -0.005], [0.0, -0.02], [0.02, -0.018]].forEach(function (q, k) { p.push({ g: 'cyl', p: [q[0], 0.3 + k * 0.01, q[1]], s: [0.004, 0.12, 0.004], m: 'wood' }, { g: 'box', p: [q[0], 0.36 + k * 0.01, q[1]], s: [0.003, 0.05, 0.02], m: 'c2' }); });
    var dir = [0.42, 0.32], L = Math.hypot(dir[0], dir[1]);
    var strap = function (i) { var pt = D.part[i]; if (pt !== P_TORSO && pt !== P_PELVIS) return false; var v = (D.X[i] * dir[0] + (D.Y[i] - D.J.spine_02.y - 0.06) * dir[1]) / L; return Math.abs(v) < 0.022; };
    return [R('spine_03', V(-0.03, y, B.zb(y) - 0.05), p.map(function (q) { q.r = [(q.r ? q.r[0] : 0) - 0.12, 0, -0.42]; q.o = 'ZXY'; var c = Math.cos(-0.42), s = Math.sin(-0.42), x = q.p[0], yy = q.p[1]; q.p = [x * c - yy * s, x * s + yy * c, q.p[2] - yy * 0.12]; return q; })),
      { shell: { sel: strap, d: 0.02 }, m: 'c' }];
  } });
  G('scarf', 'neck', 'Scarf', { c: 0xb03a2a, c2: 0xe8d8b0, pat: 'stripes', build: function (D) {
    var N = D.B.neck, B = D.B, y0 = N.base + 0.015, p = [{ g: 'tor:0.5', p: [0, 0, 0], s: [N.rx + 0.022, N.rz + 0.026, 0.09], r: [Math.PI / 2, 0, 0], m: 'c' }];
    // two tails hanging down the chest from the front-left of the wrap, following the chest surface
    [[0.045, 0.27, 0.06], [0.085, 0.21, 0.055]].forEach(function (q) {
      var pts = [], k; for (k = 0; k <= 5; k++) { var y = y0 - 0.02 - q[1] * k / 5; pts.push([q[0], y - y0, B.zfx(q[0], y) - N.cz + 0.026 + 0.004 * k, q[2] / 2]); }
      p = p.concat(stripParts(pts, 0.014, 'c'));
    });
    return [R('spine_03', V(0, y0, N.cz), p)];
  } });
  G('tie', 'neck', 'Necktie', { c: 0x8a2020, build: function (D) { return tieItems(D, 'c'); } });
  G('collar', 'neck', 'Spiked collar', { c: 0x1e1c1a, t: 'leather', build: function (D) {
    var J = D.Jc.neck_01, N = D.B.neck, y = N.y - 0.035, p = [{ g: 'band', p: [0, 0, 0], s: [N.rx + 0.012, 0.03, N.rz + 0.014], m: 'c' }];
    for (var k = 0; k < 10; k++) { var a = k / 10 * 6.28; p.push({ g: 'cone', p: [Math.sin(a) * (N.rx + 0.022), 0, Math.cos(a) * (N.rz + 0.024)], s: [0.007, 0.03, 0.007], r: [Math.PI / 2, a, 0], o: 'YXZ', m: 'metal' }); }
    return [R('neck_01', V(0, y, N.cz), p)];
  } });
  G('belt', 'waist', 'Belt', { c: 0x3a2818, t: 'leather', paint: ['belt'], build: function (D) { return belt(D, 0.024, 0.017, 'c'); } });
  G('sash', 'waist', 'Sash', { c: 0xa02020, paint: ['belt'], build: function (D) {
    var M = D.M, y = M.yW * D.s; return belt(D, 0.027, 0.032, 'c', false).concat([R('pelvis', V(D.B.wx(y) * 0.8, y, D.B.zf(y) - 0.03), [{ g: 'sph', p: [0, 0, 0], s: [0.035, 0.035, 0.03], m: 'c' }, { g: 'box', p: [0.01, -0.12, 0.0], s: [0.045, 0.2, 0.008], r: [0, 0.6, 0.1], m: 'c' }, { g: 'box', p: [0.02, -0.1, -0.02], s: [0.04, 0.17, 0.008], r: [0, 0.9, -0.12], m: 'c' }])]);
  } });
  G('toolbelt', 'waist', 'Tool belt', { c: 0x6a4a28, c2: 0x8a8a8a, t: 'leather', paint: ['belt'], build: function (D) {
    var M = D.M, B = D.B, y = M.yW * D.s, w = B.wx(y) + 0.03;
    return belt(D, 0.026, 0.02, 'c').concat([R('pelvis', V(0, y - 0.03, (B.zf(y) + B.zb(y)) / 2), [
      { g: 'box', p: [w * 0.85, -0.02, 0.05], s: [0.04, 0.11, 0.09], r: [0, 0.5, 0], m: 'c' }, { g: 'box', p: [-w * 0.85, -0.02, 0.05], s: [0.04, 0.11, 0.09], r: [0, -0.5, 0], m: 'c' },
      { g: 'cyl', p: [w + 0.015, -0.06, -0.02], s: [0.01, 0.2, 0.01], m: 'wood' }, { g: 'box', p: [w + 0.015, 0.05, -0.02], s: [0.02, 0.025, 0.08], m: 'c2' },
      { g: 'cyl', p: [-w * 0.85, 0.06, 0.07], s: [0.006, 0.05, 0.006], m: 'c2' }])]);
  } });

  // ---- build (cached per sex+kind)
  function buildGarment(A, kind) {
    var cache = A.gcache || (A.gcache = {});
    if (cache[kind]) return cache[kind];
    var D = wprep(A), def = GDEF[kind], items = def.build(D), out = { items: [], tri: null, def: def };
    var tri = null; function addTri(t) { if (!tri) tri = new Uint8Array(D.nT); for (var i = 0; i < t.length; i++) if (t[i]) tri[i] = 1; }
    items.forEach(function (it) {
      var grp = it.grp || (def.slot === 'legs' || def.slot === 'feet' || def.slot === 'knees' ? 'lo' : 'up');
      if (it.shell) { var r = buildShell(D, it.shell); if (!r) return; if (it.shell.cover !== false) addTri(r.tri); out.items.push({ kind: 'skin', geo: r.geo, m: it.m || 'c', deco: it.deco, t: it.t, grp: grp }); }
      else if (it.tube) out.items.push({ kind: 'skin', geo: buildTube(D, it.tube), m: it.m || 'c', deco: it.deco, t: it.t, grp: grp });
      else if (it.rigid) {
        var geos = it.geos || mergeParts(it.parts), mat = attachMatrix(D, it.bone, it.at);
        Object.keys(geos).forEach(function (m) { out.items.push({ kind: 'rigid', bone: it.bone, matrix: mat, geo: geos[m], m: m, deco: it.deco, t: it.t, grp: grp, dyn: it.dyn }); });
      }
    });
    if (def.hideFeet) { var fs = buildShell(D, { sel: feetSel(D), d: 0 }); if (fs) addTri(fs.tri); }
    if (def.hideHands) { var hs = buildShell(D, { sel: handSel(D), d: 0 }); if (hs) addTri(hs.tri); }
    out.tri = tri;
    return (cache[kind] = out);
  }
  // body geometry with the triangles under opaque garments removed (shares all vertex buffers)
  function bodyVariant(A, kinds) {
    var D = wprep(A), key = kinds.join(','), vc = A.vcache || (A.vcache = {});
    if (!key) return D.mesh.geometry;
    if (vc[key]) return vc[key];
    var cover = new Uint8Array(D.nT);
    kinds.forEach(function (k) { var t = buildGarment(A, k).tri; if (t) for (var i = 0; i < t.length; i++) if (t[i]) cover[i] = 1; });
    var src = D.mesh.geometry, I = [];
    for (var t = 0; t < D.nT; t++) if (!cover[t]) I.push(D.idx[t * 3], D.idx[t * 3 + 1], D.idx[t * 3 + 2]);
    var g = new T.BufferGeometry();
    Object.keys(src.attributes).forEach(function (k) { g.setAttribute(k, src.attributes[k]); });
    g.setIndex(I); g.boundingSphere = src.boundingSphere.clone(); g.boundingBox = src.boundingBox ? src.boundingBox.clone() : null;
    return (vc[key] = g);
  }

  var SLOT_ORDER = ['top', 'outer', 'legs', 'knees', 'feet', 'hands', 'arms', 'head', 'face', 'shoulders', 'back', 'neck', 'waist'];
  var _warned = {};
  function normOutfit(pieces) {
    var bySlot = {};
    (pieces || []).forEach(function (pc) {
      if (!pc) return; var d = GDEF[pc.k];
      if (!d) { if (!_warned[pc.k]) { _warned[pc.k] = 1; console.warn('charmodel: unknown garment kind', pc.k); } return; }
      bySlot[d.slot] = { k: pc.k, c: pc.c == null ? d.c : pc.c, c2: pc.c2 == null ? (d.c2 == null ? null : d.c2) : pc.c2, p: pc.p || d.pat || 'solid' };
    });
    return SLOT_ORDER.filter(function (s) { return bySlot[s]; }).map(function (s) { return bySlot[s]; });
  }
  function matFor(item, pc, def) {
    var m = item.m, skinned = item.kind === 'skin';
    if (m === 'c') return gmat(item.t || def.t || 'cloth', pc.c, pc.c2 == null ? new T.Color(pc.c).multiplyScalar(0.6).getHex() : pc.c2, pc.p, item.deco || def.deco, skinned);
    if (m === 'c2') return gmat(item.t || def.t2 || 'cloth', pc.c2 == null ? new T.Color(pc.c).multiplyScalar(0.6).getHex() : pc.c2, null, 'solid', null, skinned);
    var f = FIXED[m] || FIXED.dark;
    if (m === 'shirt') return gmat(f[1], f[0], pc.c2 == null ? 0x8a96a6 : 0x8a96a6, 'solid', item.deco, skinned);
    return gmat(item.t && m === 'c' ? item.t : f[1], f[0], null, 'solid', null, skinned);
  }
  function applyOutfit(model, outfit) {
    var st = model.__cm, A = st.A, bones = st.bones;
    (st.ward || []).forEach(function (w) { if (w.obj.parent) w.obj.parent.remove(w.obj); });
    st.ward = []; st.cape = null;
    var kinds = [], paint = { top: 1, bot: 1, boot: 1, belt: 1 }, hair = 'keep', noPack = false;
    var skel = st.meshes.body.skeleton, bind = st.meshes.body.bindMatrix;
    outfit.forEach(function (pc) {
      var gb = buildGarment(A, pc.k), def = gb.def;
      if (gb.tri) kinds.push(pc.k);
      (def.paint || []).forEach(function (p) { paint[p] = 0; });
      if (def.slot === 'head') hair = def.hair || 'keep';
      if (def.noPack) noPack = true;
      gb.items.forEach(function (it) {
        var obj, mat = matFor(it, pc, def);
        if (it.kind === 'skin') {
          obj = new T.SkinnedMesh(it.geo, mat); obj.bind(skel, bind); obj.frustumCulled = true; guardSkinning(obj); obj.raycast = noRay;
          st.wardRoot.add(obj);
        } else {
          var m = new T.Mesh(it.geo, mat); m.raycast = noRay;
          var holder = new T.Group(); holder.matrixAutoUpdate = false; holder.matrix.copy(it.matrix); holder.name = 'cm_w';
          if (it.dyn === 'cape') { var piv = new T.Group(); piv.add(m); holder.add(piv); st.cape = { piv: piv, holder: holder, a: 0.1, sp: 0 }; } else holder.add(m);
          bones[it.bone].add(holder); obj = holder;
        }
        obj.name = 'cm_w'; st.ward.push({ obj: obj, grp: it.grp, mesh: it.kind === 'skin' ? obj : null });
      });
    });
    var bm = st.meshes.body;
    bm.geometry = bodyVariant(A, kinds.slice().sort());
    st.U.uPaint.value.set(paint.top, paint.bot, paint.boot, paint.belt);
    st.hairMode = outfit.length ? hair : 'keep'; st.noPack = noPack;
    st.outfit = outfit; st.outfitKey = JSON.stringify(outfit);
  }
  /* CharModel.dress(root, pieces): pieces = [{k:'tshirt', c:0xaa3333, c2:0xffffff, p:'stripes'}, ...]. Replaces the
     previous clothing; one piece per slot (later wins); unknown kinds are skipped. Returns true when dressed. */
  CM.dress = function (root, pieces) {
    var m = findModel(root); if (!m) return false;
    var st = m.__cm, outfit = normOutfit(pieces), key = JSON.stringify(outfit);
    if (st.outfitKey === key || (!st.outfitKey && !outfit.length)) return true;
    applyOutfit(m, outfit); return true;
  };
  CM._wprep = function (sex) { return wprep(CM.assets[sex]); }; CM._garment = function (sex, k) { return buildGarment(CM.assets[sex], k); };
  CM.undress = function (root) { return CM.dress(root, []); };
  /* CharModel.prewarm({kinds, sexes, budgetMs}) -> Promise: builds garment geometry ahead of time in small slices
     (default: every kind, both bodies, 6 ms per slice) so the first dress() of a kind doesn't hitch. */
  CM.prewarm = function (o) {
    o = o || {}; var kinds = o.kinds || Object.keys(GDEF), sexes = o.sexes || ['m', 'f'], budget = o.budgetMs || 6, jobs = [];
    sexes.forEach(function (sx) { kinds.forEach(function (k) { if (GDEF[k]) jobs.push([sx, k]); }); });
    return new Promise(function (res) {
      (function step() {
        if (!CM.ready) return setTimeout(step, 100);
        var t0 = performance.now();
        while (jobs.length && performance.now() - t0 < budget) { var j = jobs.shift(); try { buildGarment(CM.assets[j[0]], j[1]); } catch (e) { console.warn('charmodel prewarm', j, e); } }
        if (jobs.length) setTimeout(step, 16); else res(true);
      })();
    });
  };
  CM.outfitOf = function (root) { var m = findModel(root); return m && m.__cm.outfit ? m.__cm.outfit.slice() : []; };
  CM.PATTERNS = Object.keys(PATS).filter(function (k) { return k !== 'fur'; });
  CM.SLOTS = SLOT_ORDER.slice();
  // per-frame part of sync(): visibility by group, hair under hats, cape sway
  var _cq = new T.Quaternion(), _cv = V(), _cp = V();
  function syncWardrobe(st, rig, tv, lo, live) {
    if (rig.pack && rig.pack.length && rig.pack[0].visible === !!st.noPack) for (var pi = 0; pi < rig.pack.length; pi++) rig.pack[pi].visible = !st.noPack;
    var W = st.ward; if (!W || !W.length) { setHair(st, false); return; }
    for (var i = 0; i < W.length; i++) { var w = W[i]; w.obj.visible = w.grp === 'lo' ? lo : tv; if (w.mesh) mirrorMat(w.mesh.material); }
    setHair(st, st.hairMode === 'hide' || (st.hairMode === 'under' && /buns/.test(st.hairStyle)));
    var c = st.cape;
    if (c && tv && live) {
      var now = performance.now(), dt = Math.min(0.1, Math.max(0.001, ((now - (c.t || now)) / 1000) || 0.016)); c.t = now;
      rig.body.getWorldPosition(_cp); var sp = c.last ? _cp.distanceTo(c.last) / dt : 0; if (!c.last) c.last = V(); c.last.copy(_cp);
      c.sp += (Math.min(8, sp) - c.sp) * Math.min(1, dt * 4);
      // gravity in the cape's frame (last frame's matrices are fine)
      c.holder.getWorldQuaternion(_cq); _cv.set(0, -1, 0).applyQuaternion(_cq.invert());
      var grav = Math.atan2(-_cv.z, -_cv.y), upr = rig.body.matrixWorld.elements[5] / (Math.hypot(rig.body.matrixWorld.elements[4], rig.body.matrixWorld.elements[5], rig.body.matrixWorld.elements[6]) || 1);
      if (upr < 0.6) grav = 0.05;
      var legs = Math.max(0, rig.lL.rotation.x, rig.lR.rotation.x) * 0.55, want = Math.max(0.04 + legs, grav) + c.sp * 0.07 + Math.sin(now / 260) * 0.02 * Math.min(1, c.sp);
      want = Math.min(1.3, want);
      c.a += (want - c.a) * Math.min(1, dt * 6); c.piv.rotation.x = c.a;
    }
  }
  function setHair(st, hide) {
    var ch = st.hairRoot.children;
    for (var i = 0; i < ch.length; i++) ch[i].visible = !hide || ch[i].__k === 'beard';
  }

  // ---------------------------------------------------------------- game hooks
  /* CharModel.install(): call once after the game script has defined its functions.
     - buildHuman -> skinned body when assets are ready (old one otherwise), same return shape
     - armIK -> real-length IK for skinned arms
     - buildRaceBits: unchanged (its group is re-parented to the head fit automatically by torso.add) */
  CM.install = function () {
    if (typeof window.buildHuman === 'function' && !window.buildHuman.__cm) {
      var oB = window.buildHuman;
      var nb = function (o) {
        if (CM.ready && CM.enabled) {
          try {
            var oo = Object.assign({}, o || {});
            if (oo.eyeMat && typeof PLAYER_IRIS !== 'undefined' && oo.eyeMat === PLAYER_IRIS) oo.isPlayer = true; // only buildPlayerBody passes the player iris
            if (oo.seed == null) oo.seed = hashColor(oo);
            return CM.buildHumanSkinned(oo);
          } catch (e) { console.warn('charmodel: falling back to procedural body', e); }
        }
        return oB.apply(this, arguments);
      };
      nb.__cm = true; nb.orig = oB; window.buildHuman = nb;
    }
    if (typeof window.armIK === 'function' && !window.armIK.__cm) {
      var oI = window.armIK;
      var ni = function (a, target, pole, blend) { if (a && a.cmL1) return CM.armIK(a, target, pole, blend); return oI.apply(this, arguments); };
      ni.__cm = true; ni.orig = oI; window.armIK = ni;
    }
    return CM;
  };
  function hashColor(o) { var h = 0; ['top', 'bot', 'skin'].forEach(function (k) { var c = o[k] && o[k].color ? o[k].color.getHex() : (o[k] | 0); h = (h * 31 + c) >>> 0; }); h = (h * 31 + ((o.hair | 0) >>> 0)) >>> 0; return h + (Math.random() * 1e6 | 0); }
})();
