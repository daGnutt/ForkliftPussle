// Anything not served from the production host counts as testing; ?testing forces it for local checks.
const PROD_HOST = 'forklift.gnutt.se';
export const isTesting = () =>
  location.hostname !== PROD_HOST || new URLSearchParams(location.search).has('testing');

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#1b1f23"/><path d="M8 40h30l6-14H30z" fill="#f9a825"/><circle cx="18" cy="44" r="6" fill="#111"/><circle cx="36" cy="44" r="6" fill="#111"/><rect y="0" width="64" height="22" fill="#d32f2f"/><text x="32" y="16" font-family="sans-serif" font-size="15" font-weight="bold" text-anchor="middle" fill="#fff">TEST</text></svg>`;

// Shows the TESTING banner and favicon.
export function initTestingBanner() {
  if (!isTesting()) return;
  const banner = document.getElementById('testingBanner');
  banner.classList.remove('hide');
  document.querySelectorAll('link[rel="icon"]').forEach((l) => { l.href = 'data:image/svg+xml,' + encodeURIComponent(FAVICON); });
  document.title = 'TESTING - ' + document.title;
}
