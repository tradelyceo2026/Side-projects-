// The single shared game state. Modules read and write fields; nothing else is global.
export const state = {
  time: 0, dt: 0,
  phase: 'title',
  activeIndex: 0,
  roster: ['wolverine', 'quicksilver', 'jean', 'cyclops', 'emma'],
  player: null,
  camera: null, scene: null, renderer: null,
  city: null,
  enemies: [],
  props: [],
  missions: null,
  settings: { quality: 'high', mute: false, invertY: false },
  input: { keys: new Set(), mouse: { dx: 0, dy: 0, buttons: 0, locked: false }, gamepad: null },
  timeScale: 1,
  debug: false,
};
