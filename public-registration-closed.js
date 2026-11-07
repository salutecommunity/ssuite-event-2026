/* Public entrypoints only. Server independently requires a valid private invitation. */
(() => {
  const params = new URLSearchParams(location.search);
  const code = (params.get('code') || '').replace(/[^A-Za-z0-9]/g, '');
  let tableInvitation = false;
  try {
    const handoff = JSON.parse(sessionStorage.getItem('ssuite.table.invitation') || 'null');
    tableInvitation = !!(handoff && handoff.code && handoff.host && Number.isFinite(Number(handoff.at)) && Date.now() - Number(handoff.at) <= 3600000);
  } catch (_) {}
  // Query/storage is routing convenience only, never eligibility. The original
  // code verification, partner cutoff, caps and server checks remain authoritative.
  if (code || tableInvitation) {
    document.body.classList.remove('public-registration-closed');
    return;
  }
  const closureStyle = document.createElement('style');
  closureStyle.textContent = '.public-registration-closed .ticket-grid,.public-registration-closed [data-request-invitation],.public-registration-closed #invitation-dialog{display:none!important}';
  document.head.appendChild(closureStyle);
  document.addEventListener('click', event => {
    if (event.target.closest('.choose')) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('submit', event => {
    if (event.target.id === 'registration-form') { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('a[href="#tickets"],a[href="#seat"]').forEach(a => {
      a.href = 'mailto:ssuite@salute.community'; a.textContent = 'Email us about S.Suite';
    });
  }, {once:true});
})();
