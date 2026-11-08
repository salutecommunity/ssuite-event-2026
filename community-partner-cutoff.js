/* Paid Community Partner invitation closure. Ascend and Anu Sehgal are intentionally exempt. Knead closed November 7 at 11:59 p.m. Eastern. */
(() => { 'use strict';
 const deadline = Date.parse('2026-11-07T04:59:00Z');
 const message = 'The event is now at capacity. Thank you so much for your interest.';
 const normalize = value => String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
 const codes = new Set(["DESAIPARTNER234Y","CULTURETREEPARTNER523F43","SAYAPARTNERB0DB82","SAKHIPARTNER2231B5","NEYTHRIPARTNERUJ5V","MALAIPARTNER7K3Q","CHARPARTNER4W9M","SAYAPARTNERA2KC","BOOMIEPARTNER7R8T","SSUITEMUBARAK2026","SSUITEKULTUREKHAZANA2026","SSUITEBROWNGIRLANGELS2026","SSUITEPRATHAM2026","SSUITESOUTHASIANSOAR2026","SSUITEKNEADSOMELOVENY2026"]);
 const guide = /^\/community-partners\//.test(location.pathname) && !/^\/community-partners\/(?:ascend|anu-sehgal)(?:\/|$)/.test(location.pathname);
 const closedNow = new Set(["SAYAPARTNERA2KC","SAYAPARTNERB0DB82"]);
 function closedEarly() { const query=new URLSearchParams(location.search); if(query.has('checkout'))return false; return /^\/community-partners\/saya(?:\/|$)/.test(location.pathname) || closedNow.has(normalize(document.body.dataset.invitationCode)) || closedNow.has(normalize(query.get('code'))); }
 function eligible() { const query=new URLSearchParams(location.search); if(query.has('checkout'))return false; return guide || codes.has(normalize(document.body.dataset.invitationCode)) || codes.has(normalize(query.get('code'))); }
 function close() {
  if (!closedEarly() && (Date.now() < deadline || !eligible())) return false;
  if (!document.getElementById('partner-capacity-notice')) {
   const style = document.createElement('style');style.textContent = 'html.partner-paid-closed body > *:not(header):not(footer):not(#partner-capacity-notice):not(script):not(style):not(link){display:none!important} #partner-capacity-notice{display:block!important;box-sizing:border-box;max-width:760px;margin:64px auto;padding:48px 24px;text-align:center;background:#fcfbf9;color:#191919} #partner-capacity-notice h1{font:clamp(28px,5vw,44px)/1.3 Georgia,serif} #partner-capacity-notice p{font:16px/1.7 Arial,sans-serif}';document.head.append(style);
   const name = document.body.dataset.hostName || document.getElementById('partner-name')?.textContent || 'Community Partner';
   const notice = document.createElement('section');notice.id='partner-capacity-notice';notice.setAttribute('role','status');
   const brand=document.createElement('p');brand.textContent=name+' · S.SUITE';const title=document.createElement('h1');title.textContent=message;notice.append(brand,title);document.body.insertBefore(notice,document.querySelector('main') || document.body.firstChild);
  }
  document.documentElement.classList.add('partner-paid-closed');
  document.querySelectorAll('form button,form input,form select,.choose').forEach(el=>{el.disabled=true;});
  return true;
 }
 document.addEventListener('submit',event=>{if(close()){event.preventDefault();event.stopImmediatePropagation();}},true);
 document.addEventListener('click',event=>{if(close() && event.target.closest('button,.choose,form')){event.preventDefault();event.stopImmediatePropagation();}},true);
 close();setInterval(close,1000);document.addEventListener('visibilitychange',close);window.addEventListener('pageshow',close);
})();
