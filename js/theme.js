// Colour themes; follows the OS setting (prefers-color-scheme). Browser-only; falls back to light in Node.
const LIGHT = { bg: '#e8e6e1', floor: '#c9c4b8', floorFar: '#8a867c', grid: 'rgba(0,0,0,0.08)', povGrid: 'rgba(0,0,0,0.22)', skyTop: '#9fb4c8', skyBottom: '#d3dde6', tine: '#5a5f66', tineEdge: '#1a1a1a' };
const DARK = { bg: '#1b1f23', floor: '#4a4a48', floorFar: '#27272a', grid: 'rgba(255,255,255,0.08)', povGrid: 'rgba(255,255,255,0.2)', skyTop: '#14171b', skyBottom: '#2b3038', tine: '#b0b0b0', tineEdge: '#333' };
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

export function theme() { return mq && mq.matches ? DARK : LIGHT; }
