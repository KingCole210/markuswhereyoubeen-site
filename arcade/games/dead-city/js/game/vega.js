// VEGA: the squad's AI on comms. Speaks through the browser's speech synthesis and always shows a subtitle.

const LINES = {
  deploy: ['VEGA online. Manhattan fell overnight. Stay off the streets if you can.', 'VEGA online. They are fast and there are a lot of them. Do not let them pin you.'],
  awakenSuit: ['Something is growing over your skin. Armor. Thrusters. Get up and fly.'],
  awakenParagon: ['Your heart started again, and you are floating. Nothing in this city can hurt you like it used to.'],
  awakenCold: ['Your skin is ice cold and the air is freezing around you. Use it.'],
  survivorDown: ['You are down. Hang on.', 'Man down. Your vitals are flat.'],
  deploySurvivor: ['You are on foot. No suit, no powers. Keep moving and do not let them box you in.', 'Comms check. You are on the street with a rifle and a pistol. Stay mobile.'],
  lowAmmo: ['Rifle is running dry. Switch to the pistol or find ammo.', 'Last magazine on the rifle.'],
  noAmmo: ['Rifle is empty. Pistol.'],
  ammo: ['Ammo.', 'Picked up a magazine.'],
  deploySquad: ['VEGA online. Linking you with {name}. Stay close; I can only patch one of you up at a time.'],
  contacts: ['{n} hostiles closing.', 'Contacts converging on you. {n} and counting.', 'Movement on every street. {n} of them.'],
  runners: ['Runners. Get some height.', 'Fast movers on your position.'],
  grabbed: ['One has you. Shake it.', 'Contact! Get it off you.'],
  pinnedSuit: ['You are pinned. Pulse them off, now.', 'They are piling on. Shock pulse!'],
  pinnedParagon: ['They have you down. Swing.', 'Pinned. Throw them off.'],
  pinnedCold: ['Pinned. Freeze them, then shatter.', 'Nova, now, before they bury you.'],
  pinnedAny: ['Mash to break free.'],
  hp35: ['Armor at thirty percent.', 'Taking heavy damage.'],
  hp15: ['Integrity critical. Get out of there.', 'You will not survive another pile-up.'],
  energyLowSuit: ['Thruster reserve low. Find a rooftop to recharge.', 'Thrusters at twenty percent. Land on something tall.'],
  energyLowCold: ['Cryo reserve low. Touch down and let it build.', 'Running out of ice. Find a roof.'],
  energyOut: ['Thrusters are dry. Brace!', 'Power gone. You are falling.'],
  coldOut: ['Out of ice. Brace!'],
  climbing: ['They are climbing over each other to reach you.', 'They are stacking up against the wall below you.', 'A pile is forming under you. Break it up.'],
  threat: ['Threat level {n}. They are getting faster.', 'Threat level {n}. More of them every minute.'],
  surge: ['Horde surge from the {dir}.', 'Big wave coming in from the {dir}.'],
  overheat: ['Eyes need a second to cool.', 'Heat vision overheated.'],
  streak: ['Nice grouping.', 'That cleared a street.', 'Keep that up.'],
  shatterChain: ['Shatter chain. Beautiful.', 'Ice and glass.'],
  down: ['Vitals critical. I have you, hold on.', 'You are down. Hold on.'],
  downSquad: ['You are down. {name}, get to them.'],
  reboot: ['Back on your feet. {n} chances left.', 'Rebooted. {n} left. Let us not do that again.'],
  lastLife: ['That was your last reserve. One more and it is over.'],
  partnerDown: ['{name} is down. Get to them.', '{name} is down and bleeding out.'],
  partnerUp: ['{name} is back up.', 'Good save.'],
  partnerJoin: ['{name} just dropped into the city.'],
  partnerLeft: ['Lost the link to {name}.'],
  revived: ['You are back. Thank {name}.'],
  gameOver: ['Signal lost.', 'It is over. They took the city.']
};

class Vega {
  constructor(subtitleEl) {
    this.el = subtitleEl;
    this.enabled = true;
    this.cooldowns = new Map();
    this.lastSpoke = -Infinity;
    this.clock = 0;
    this.voice = null;
    this.hideTimer = null;
    this.synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
    const pick = () => {
      if (!this.synth) return;
      const voices = this.synth.getVoices();
      const prefer = ['Samantha', 'Google UK English Female', 'Microsoft Aria', 'Microsoft Jenny', 'Karen', 'Serena', 'Zira', 'Moira', 'Tessa'];
      this.voice = prefer.map((n) => voices.find((v) => v.name.includes(n))).find(Boolean)
        || voices.find((v) => v.lang?.startsWith('en-GB')) || voices.find((v) => v.lang?.startsWith('en')) || null;
    };
    try {
      pick();
      this.synth?.addEventListener?.('voiceschanged', pick);
    } catch { /* no speech here */ }
  }

  tick(dt) {
    this.clock += dt;
  }

  // key: line group; cooldown: seconds before the same group may speak again; priority: interrupts lower ones
  say(key, vars = {}, { cooldown = 20, priority = 1 } = {}) {
    const now = this.clock;
    if ((this.cooldowns.get(key) ?? -Infinity) > now) return false;
    if (priority < 2 && now - this.lastSpoke < 3.2) return false;
    const group = LINES[key];
    if (!group) return false;
    let text = group[Math.floor(Math.random() * group.length)];
    text = text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
    this.cooldowns.set(key, now + cooldown);
    this.lastSpoke = now;
    this.show(text);
    this.speak(text, priority);
    return true;
  }

  show(text) {
    if (!this.el) return;
    this.el.querySelector('.vega-text').textContent = text;
    this.el.hidden = false;
    this.el.classList.remove('is-new');
    void this.el.offsetWidth;
    this.el.classList.add('is-new');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => { this.el.hidden = true; }, 2600 + text.length * 55);
  }

  speak(text, priority) {
    if (!this.enabled || !this.synth) return;
    try {
      if (priority >= 2) this.synth.cancel();
      else if (this.synth.speaking) return;
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.rate = 1.07;
      u.pitch = 0.92;
      u.volume = 0.95;
      this.synth.speak(u);
    } catch { /* speech refused */ }
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) try { this.synth?.cancel(); } catch { /* ignore */ }
  }
}

export { Vega };
