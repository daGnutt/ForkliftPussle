import { hash } from './common.js';

// Botspeak: what a bot says (shown as a speech bubble for SAY_SECS) and why. The texts are meant to be funny; every reason has several.
export const SAY_SECS = 2.2;
export const BOTSPEAK = {
  yell: ['BZZT! %#@& MOVE, METAL-FOR-BRAINS!', 'KRRK!! YOU ARE STANDING ON MY JOB!', '*#!@ SCRAP-HEAP! I HAVE A SCHEDULE!', 'BEEP-BEEP-BEEP-MOVE-IT, TOASTER!', 'ERROR 404: YOUR MANNERS NOT FOUND'],
  'flee-truck': ['EEEP! FORKLIFT! BLEEP!', 'RUN.EXE HAS STARTED!', 'NOT THE FORKS! NOT THE FORKS!', 'MY WARRANTY DOES NOT COVER THIS!'],
  'flee-bot': ['OKAY OKAY, GOING! BEEP!', 'SORRY BOSS, MOVING MY CHASSIS!', 'YIELD.EXE EXECUTED. GRUMBLE.', 'RANK PULLED ON ME. BLEEP.'],
  'right-of-way': ['PARDON. BOT COMING THROUGH. BEEP.', 'OUT OF THE WAY, PLEASE. BLUE LIGHT!', 'HONK HONK (IN BINARY)', 'I HAVE RIGHT OF WAY AND A DEADLINE'],
  spawn: ['SPAWNING! BLORP!', 'ONE FRESH OBJECT, STRAIGHT FROM MY BELLY.', 'PLOP. DELIVERED.'],
  despawn: ['BACKING UP... BEEP BEEP BEEP', 'GULP! COLLECTED.', 'TIDYING UP. YOU ARE WELCOME.'],
};

export function speak(g, bot, reason) {
  const pool = BOTSPEAK[reason];
  if (!pool || !bot) return;
  g.speechN = (g.speechN || 0) + 1;
  const text = pool[Math.floor(hash(g.speechN + (bot.x + bot.y) * 7) * pool.length) % pool.length];
  bot.say = { text, reason, until: g.clock + SAY_SECS };
}

export const speaking = (g, bot) => bot?.show > 0 && !!bot.say && bot.say.until > g.clock;
