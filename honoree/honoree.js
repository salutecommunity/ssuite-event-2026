/* S.SUITE honoree invitation + private portal (live).
 * Everything honoree-specific arrives from the private API, opened by the
 * token in this page's URL fragment. The token is never sent as a query
 * string, is removed from the address bar on arrival, and is kept only for
 * this browser tab. */
(function(){
'use strict';
document.documentElement.classList.add('js');
var API='https://iddzcbknnddkonrcwgpt.supabase.co/functions/v1/honoree-portal';
var $=function(s,r){return (r||document).querySelector(s)};
var $$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};
var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
var EMAIL=/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/;
var KEY='ssuite.honoree.k';

/* ── Token ───────────────────────────────────────── */
var token=null;
(function(){
  var m=location.hash.match(/(?:^#|&)k=([0-9a-f]{64})(?:&|$)/i);
  if(m){token=m[1].toLowerCase();try{sessionStorage.setItem(KEY,token)}catch(e){}
    try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}}
  else{try{token=sessionStorage.getItem(KEY)}catch(e){}}
})();
function api(body){
  body.token=token;
  return fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'omit',referrerPolicy:'no-referrer',keepalive:body.action==='save'})
    .then(function(r){return r.json().catch(function(){return {}}).then(function(j){if(!r.ok){var e=new Error(j.error||'Something went wrong. Please try again.');e.status=r.status;e.errors=j.errors;throw e}return j})});
}
function gate(msg){$('#gate-msg').textContent=msg;$('#gate-pulse').hidden=true;$('#gate').hidden=false}

/* ── Honoree data ────────────────────────────────── */
var H=null, STATE=null, SUBMITTED_AT=null, GUEST_URL=null, GUEST_CODE=null;
function first(){return (H&&H.first_name)||''}
function fmtDate(iso){if(!iso)return '';var d=new Date(iso+(iso.length===10?'T12:00:00':''));return d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}
function fmtWhen(iso){var d=new Date(iso);return d.toLocaleDateString('en-US',{month:'long',day:'numeric'})+' at '+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}
function bind(){
  var map={full_name:H.full_name,headline_title:H.headline_title||'',honor_label:H.honor+' Honoree',honor:H.honor};
  $$('[data-b]').forEach(function(el){var v=map[el.dataset.b];if(v!=null)el.textContent=v});
  document.title='S.SUITE · A private invitation for '+H.full_name;
  var p=$('#portrait');
  if(H.portrait_url){p.src=H.portrait_url;p.alt='Portrait of '+H.full_name;p.style.objectPosition=H.portrait_position||'50% 18%'}else{p.closest('figure').hidden=true}
  var b=$('#honor-blurb');b.textContent='';
  b.appendChild(document.createTextNode('It is our honor and privilege to share that you have been nominated as the inaugural S.Suite '));
  var st=document.createElement('strong');st.textContent=H.honor+' Honoree';b.appendChild(st);
  b.appendChild(document.createTextNode('. '+(H.honor_blurb||'')));
  if(H.response_deadline) $('#deadline-line').textContent=' Please respond by '+fmtDate(H.response_deadline)+'.';
  if(!$('#view-invite').hidden) return;
}

/* ── Views ───────────────────────────────────────── */
var views={invite:$('#view-invite'),portal:$('#view-portal')};
var currentView='invite', inviteY=0;
function setView(name,opts){
  opts=opts||{};
  if(currentView==='invite') inviteY=window.scrollY;
  currentView=name;
  Object.keys(views).forEach(function(k){views[k].hidden=(k!==name)});
  document.body.setAttribute('data-view',name);
  if(name==='portal') measureHead();
  window.scrollTo(0,opts.keepScroll?inviteY:0);
  onScroll();
}
function smoothTo(sel){
  var el=$(sel);if(!el)return;
  el.scrollIntoView({behavior:reduce?'auto':'smooth',block:'start'});
  var h=$('[tabindex="-1"]',el);
  if(h) setTimeout(function(){h.focus({preventScroll:true})},reduce?0:700);
}
$$('[data-scroll]').forEach(function(b){b.addEventListener('click',function(){smoothTo(b.dataset.scroll)})});
$$('[data-enter]').forEach(function(b){b.addEventListener('click',enterPortal)});
var mini=$('#minibar'),miniBtn=$('#mini-enter'),ticking=false;
function onScroll(){
  ticking=false;
  var on=currentView==='invite'&&window.scrollY>($('#top').offsetHeight*.9);
  mini.classList.toggle('on',on);miniBtn.tabIndex=on?0:-1;
}
window.addEventListener('scroll',function(){if(!ticking){ticking=true;requestAnimationFrame(onScroll)}},{passive:true});
function startReveal(){
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{rootMargin:'0px 0px -8% 0px',threshold:.06});
    $$('.rv').forEach(function(el){io.observe(el)});
  }else{$$('.rv').forEach(function(el){el.classList.add('in')})}
}

/* ── Portal core ─────────────────────────────────── */
var pf=$('#pf'),F=pf.elements;
var stepEls=$$('.step',pf),navBtns=$$('.p-step');
var NAMES=['Response','Profile','Evening','Guests','Support','Review'];
var LAST=NAMES.length-1;
var cur=0,done={},submitted=false;
function val(n){var e=F.namedItem(n);return e&&typeof e.value==='string'?e.value.trim():''}
function chk(n){var e=F.namedItem(n);return !!(e&&e.checked)}
function declined(){return val('response')==='decline'}
function measureHead(){var h=$('#p-top').offsetHeight;document.documentElement.style.setProperty('--hh',h+'px')}
window.addEventListener('resize',measureHead);

function updateNav(){
  var dec=declined();
  navBtns.forEach(function(b,i){
    var off=dec&&i>0&&i<4;
    b.disabled=off;
    b.classList.toggle('is-current',i===cur);
    b.classList.toggle('is-done',!!done[i]&&!off&&i!==cur);
    if(i===cur) b.setAttribute('aria-current','step'); else b.removeAttribute('aria-current');
    var n=$('.n',b),base=('0'+(i+1)).slice(-2);
    n.innerHTML='';
    if(done[i]&&!off&&i!==cur){var t=document.createElement('span');t.className='tick';t.setAttribute('aria-hidden','true');n.appendChild(t)}
    n.appendChild(document.createTextNode(base));
    var st=$('.sr',b);if(st)st.remove();
    var s=document.createElement('span');s.className='sr';
    s.textContent=i===cur?' (current step)':(off?' (not needed)':(done[i]?' (completed)':''));
    b.appendChild(s);
  });
  var pct=submitted?100:Math.round(((cur+1)/NAMES.length)*100);
  $('#p-fill').style.width=pct+'%';
  var sc=$('#p-steps'),b=navBtns[cur];
  if(!views.portal.hidden) sc.scrollTo?sc.scrollTo({left:Math.max(0,b.parentNode.offsetLeft-(sc.clientWidth-b.offsetWidth)/2),behavior:reduce?'auto':'smooth'}):(sc.scrollLeft=b.parentNode.offsetLeft);
  $$('[data-count]').forEach(function(c){c.textContent='Step '+(cur+1)+' of '+NAMES.length+' · '+NAMES[cur]});
}
function goto(i,opts){
  opts=opts||{};
  if(!opts.keepConfirm){submitted=false;$('#confirm').hidden=true;$('#review-body').hidden=false}
  cur=i;
  stepEls.forEach(function(s,k){s.hidden=(k!==i)});
  if(i===LAST){renderReview();
    var al=$('.alert',stepEls[LAST]);
    if(al&&!al.hidden){var bad=firstInvalidStep();if(bad==null)clearErrors(stepEls[LAST]);else{showSubmitErrors(validate(bad).map(function(e){return e.msg}),bad)}}
  }
  updateNav();
  window.scrollTo({top:0,behavior:reduce?'auto':'smooth'});
  var h=$('.ps-title',stepEls[i]);if(h)h.focus({preventScroll:true});
  if(!opts.noSave) saveSoon(0);
}
navBtns.forEach(function(b){b.addEventListener('click',function(){if(!b.disabled)goto(+b.dataset.i)})});
function enterPortal(){inviteY=window.scrollY;setView('portal');goto(cur,{noSave:true});}
function toInvite(){setView('invite',{keepScroll:true})}
$('#p-back').addEventListener('click',toInvite);
$$('[data-back-invite]').forEach(function(b){b.addEventListener('click',toInvite)});
$$('[data-prev]').forEach(function(b){b.addEventListener('click',function(){goto(declined()&&cur===LAST?4:(declined()&&cur===4?0:cur-1))})});
$$('[data-next]').forEach(function(b){b.addEventListener('click',next)});
function next(){
  var errs=validate(cur);
  if(errs.length){showErrors(stepEls[cur],errs);return}
  clearErrors(stepEls[cur]);done[cur]=true;
  goto(cur===0&&declined()?4:cur+1);
}

/* validation + errors */
function clearErrors(root){
  $$('.err',root).forEach(function(e){e.remove()});
  $$('[aria-invalid]',root).forEach(function(e){e.removeAttribute('aria-invalid')});
  var a=$('.alert',root);if(a){a.hidden=true;a.textContent=''}
}
function showErrors(root,errs){
  clearErrors(root);
  var a=$('.alert',root),s=document.createElement('strong');s.textContent='Please review';
  var ul=document.createElement('ul');
  errs.forEach(function(e){
    var li=document.createElement('li');li.textContent=e.msg;ul.appendChild(li);
    if(e.el){
      e.el.setAttribute('aria-invalid','true');
      var host=e.el.closest('.fld')||e.el.closest('fieldset')||e.el.parentNode;
      var sp=document.createElement('span');sp.className='err';sp.textContent=e.msg;host.appendChild(sp);
    }
  });
  a.appendChild(s);a.appendChild(ul);a.hidden=false;
  var firstErr=errs.filter(function(e){return e.el})[0];
  if(firstErr){firstErr.el.focus({preventScroll:true});firstErr.el.scrollIntoView({behavior:reduce?'auto':'smooth',block:'center'})}
  else{a.focus();a.scrollIntoView({block:'center'})}
}
pf.addEventListener('input',clearOne);pf.addEventListener('change',clearOne);
function clearOne(e){
  var t=e.target;if(!t||!t.removeAttribute)return;
  if(t.getAttribute('aria-invalid')){
    t.removeAttribute('aria-invalid');
    var host=t.closest('.fld')||t.closest('fieldset');
    if(host){var er=$('.err',host);if(er)er.remove()}
  }else if(t.type==='radio'||t.type==='checkbox'){
    var fs=t.closest('fieldset');if(fs){var er2=$('.err',fs);if(er2)er2.remove();$$('[aria-invalid]',fs).forEach(function(x){x.removeAttribute('aria-invalid')})}
  }
  var step=t.closest('.step');
  if(step&&!$('.err',step)){var a=$('.alert',step);if(a){a.hidden=true;a.textContent=''}}
}
function words(t){t=t.trim();return t?t.split(/\s+/).length:0}
function plural(n,w){return n+' '+w+(n===1?'':'s')}
function validate(i){
  var e=[];
  function push(n,m){var x=F.namedItem(n);e.push({el:x&&x.length&&!x.tagName?x[0]:x,msg:m})}
  if(i===0){
    if(!val('response')) push('response','Choose whether to accept or respectfully decline.');
  }
  if(i===1){
    if(!val('pubName')) push('pubName','Add the name you’d like to appear publicly.');
    if(words(val('bio'))>250) push('bio','Please keep your bio to 250 words or fewer.');
    if(!HS) push('headshot','Please upload a headshot.');
    if(val('teamEmail')&&!EMAIL.test(val('teamEmail'))) push('teamEmail','Enter a valid email for your team contact.');
  }
  if(i===2){
    if(chk('guest')){
      if(!val('gFirst')) push('gFirst','Add your guest’s first name.');
      if(!val('gLast')) push('gLast','Add your guest’s last name.');
      if(!val('gEmail')) push('gEmail','Add your guest’s email.');
      else if(!EMAIL.test(val('gEmail'))) push('gEmail','Enter a valid email for your guest.');
      if(!val('gTitle')) push('gTitle','Add your guest’s title.');
      if(!val('gOrg')) push('gOrg','Add your guest’s organization.');
      if(!val('gMeal')) push('gMeal','Choose your guest’s meal.');
      if(!val('gMode')) push('gMode','Choose who should send your guest the details.');
    }
    if(!val('diet')) push('diet','Choose a vegetarian or non-vegetarian meal.');
  }
  if(i===3){
    var iv=parseList(val('inviteList'));
    if(iv.bad.length) push('inviteList','Add a valid email for: '+iv.bad.slice(0,3).join('; ')+(iv.bad.length>3?' …':''));
    if(iv.items.length&&!val('inviteMode')) push('inviteMode','Choose how the invitations should go out.');
  }
  if(i===4){
    var sv=parseList(val('supportList'));
    if(sv.bad.length) push('supportList','Add a valid email for: '+sv.bad.slice(0,3).join('; ')+(sv.bad.length>3?' …':''));
    if(sv.items.length&&!val('supportMode')) push('supportMode','Choose how SALUTE should reach out.');
  }
  return e;
}

/* name + email lists */
function parseList(text){
  var items=[],bad=[],seen={};
  String(text||'').split(/\r?\n/).forEach(function(line){
    line=line.trim();if(!line)return;
    var m=line.match(/[^\s<>,;"'()]+@[^\s<>,;"'()]+\.[^\s<>,;"'()]{2,}/);
    if(!m||!EMAIL.test(m[0])){bad.push(line.slice(0,40));return}
    var email=m[0],key=email.toLowerCase();if(seen[key])return;seen[key]=1;
    var name=line.replace(m[0],'').replace(/[<>()"]/g,' ').replace(/[,;\t]+/g,' ').replace(/\s+/g,' ').trim();
    items.push({name:name,email:email});
  });
  return {items:items,bad:bad};
}
function listSummary(id,text,noun){
  var r=parseList(text),el=$(id),out='';
  if(r.items.length) out=plural(r.items.length,noun)+' added.';
  if(r.bad.length) out+=(out?' ':'')+plural(r.bad.length,'line')+' still need'+(r.bad.length===1?'s':'')+' an email.';
  el.textContent=out;
  return r;
}
/* conditional reveals */
function syncReveals(){
  $('#decline-box').hidden=!declined();
  $('#guest-box').hidden=!chk('guest');
  listSummary('#invite-sum',val('inviteList'),'guest');
  $('#support-lead').firstChild.textContent=declined()?'We’re grateful you considered it. If you’d still like to support SALUTE’s work, here’s how. ':'Your recognition never depends on a contribution. ';
  listSummary('#support-sum',val('supportList'),'person');
  updateNav();
}
pf.addEventListener('input',function(e){if(e.target.name==='inviteList'||e.target.name==='supportList')syncReveals()});
pf.addEventListener('change',syncReveals);
pf.addEventListener('submit',function(e){e.preventDefault()});

/* bio counter */
var bio=F.namedItem('bio');
function bioCount(){var n=words(bio.value);$('#bio-count').textContent=n+(n===1?' word':' words')}
bio.addEventListener('input',bioCount);

/* ── Headshot upload (private bucket) ────────────── */
var hsIn=$('#hs-input'),HS=null,hsBusy=false;
var TYPES={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif'};
function fmtSize(b){return b>1048576?(b/1048576).toFixed(1)+' MB':Math.max(1,Math.round(b/1024))+' KB'}
function hsRender(){
  var t=$('#hs-thumb');
  if(HS){
    if(HS.url){t.src=HS.url;t.hidden=false}else{t.hidden=true;t.removeAttribute('src')}
    $('#hs-name').textContent=HS.filename||'Headshot';
    $('#hs-meta').textContent=(HS.size_bytes?fmtSize(HS.size_bytes)+' · ':'')+'Uploaded securely. Only the SALUTE team can see it.';
    $('#hs-remove').hidden=false;$('#hs-btn').textContent='Replace image';
    var hf=$('#hs').closest('fieldset');if(hf){var he=$('.err',hf);if(he)he.remove()}hsIn.removeAttribute('aria-invalid');
  }else{
    t.hidden=true;t.removeAttribute('src');
    $('#hs-name').textContent='No file selected';
    $('#hs-meta').textContent='High resolution, kept private.';
    $('#hs-remove').hidden=true;$('#hs-btn').textContent='Choose image';
  }
}
hsIn.addEventListener('change',function(){
  var f=hsIn.files&&hsIn.files[0];hsIn.value='';
  if(!f||hsBusy) return;
  var ext=(f.name.split('.').pop()||'').toLowerCase();
  var type=(f.type&&TYPES[ext]!==undefined)?f.type:(TYPES[ext]||f.type||'');
  if(!/^image\/(jpeg|png|webp|heic|heif)$/.test(type)){$('#hs-meta').textContent='Please choose a JPG, PNG, WebP or HEIC image.';return}
  if(f.size>25*1024*1024){$('#hs-meta').textContent='Please choose an image under 25 MB.';return}
  hsBusy=true;$('#hs-name').textContent=f.name;$('#hs-meta').textContent='Uploading '+fmtSize(f.size)+'…';
  var local=URL.createObjectURL(f);
  api({action:'headshot_upload_url',content_type:type,size_bytes:f.size}).then(function(p){
    return fetch(p.upload_url,{method:'PUT',headers:{'Content-Type':type},body:f}).then(function(r){
      if(!r.ok) throw new Error('The image did not finish uploading. Please try again.');
      return api({action:'headshot_recorded',object_path:p.object_path,filename:f.name,content_type:type,size_bytes:f.size});
    });
  }).then(function(r){HS=r.headshot;if(HS&&!HS.url)HS.url=local;hsRender()})
  .catch(function(e){hsRender();$('#hs-meta').textContent=e.message||'The image could not be uploaded. Please try again.'})
  .then(function(){hsBusy=false});
});
$('#hs-remove').addEventListener('click',function(){
  if(hsBusy)return;hsBusy=true;
  api({action:'headshot_remove'}).then(function(){HS=null;hsRender();hsIn.focus()})
  .catch(function(e){$('#hs-meta').textContent=e.message}).then(function(){hsBusy=false});
});


/* ── Guest link ──────────────────────────────────── */
function copyText(txt,msgEl,ok){
  function fb(){msgEl.textContent='Please select and copy it manually.'}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(function(){msgEl.textContent=ok||'Link copied.'},fb)}else fb();
}
function guestNote(){
  return 'I’m honored to be recognized as an inaugural S.SUITE '+H.honor+' Honoree by SALUTE, and I would love for you to join me on Friday, November 20, 2026, at 6:30 p.m. at the Prince George Ballroom in New York City.\n\nSALUTE has extended a special honoree guest rate of $300 per person (regular price $400). Seats are confirmed once registration and payment are complete. You can register here:\n\n'+GUEST_URL+'\n\nI hope you can join me.\n\n'+H.full_name;
}
function showGuestLink(){
  if(!GUEST_URL) return;
  $('#gl-field').value=GUEST_URL;$('#gl-box').hidden=false;
  $('#gl-desc').textContent='Share it with additional guests. It applies the $300 honoree rate at checkout.';
}
$('#gl-copy').addEventListener('click',function(){copyText(GUEST_URL,$('#gl-msg'))});
$('#c-gl-copy').addEventListener('click',function(){copyText(GUEST_URL,$('#c-small'))});
$('#c-note-copy').addEventListener('click',function(){copyText(guestNote(),$('#c-small'),'Note copied, with your link included.')});
$('#gl-note').addEventListener('click',function(){copyText(guestNote(),$('#gl-msg'),'Note copied, with your link included.')});
/* Host a table: the event site's own secure table checkout. Not credited through the guest code,
   which would spend ten of the honoree's guest seats. */
var TABLE_CUTOVER=Date.parse('2026-10-08T04:00:00Z');
if(Date.now()>=TABLE_CUTOVER) $('#table-price').textContent='$7,500 for a table of ten.';
$('#table-buy').addEventListener('click',function(){
  var w=window.open('/?table=1','_blank');
  if(w){try{w.opener=null}catch(e){}}else location.href='/?table=1';
  if(dirty&&ready) saveNow();
});

/* ── Upload a list (CSV, TXT or Excel), parsed in the browser ── */
var XLSX_URL='https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
function loadXlsx(){return window.XLSX?Promise.resolve(window.XLSX):new Promise(function(ok,no){var sc=document.createElement('script');sc.src=XLSX_URL;sc.onload=function(){ok(window.XLSX)};sc.onerror=function(){no(new Error('Excel files could not be read. Please save as CSV and try again.'))};document.head.appendChild(sc)})}
function csvRows(text){
  var rows=[],row=[],cell='',q=false;
  for(var i=0;i<text.length;i++){var c=text[i];
    if(q){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++}else q=false}else cell+=c}
    else if(c==='"')q=true;else if(c===','||c==='\t'||c===';'){row.push(cell);cell=''}
    else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell=''}
    else cell+=c}
  row.push(cell);rows.push(row);return rows;
}
function rowsToLines(rows){
  var out=[],EM=/[^\s<>,;"'()]+@[^\s<>,;"'()]+\.[^\s<>,;"'()]{2,}/;
  rows.forEach(function(r){
    var cells=r.map(function(x){return String(x==null?'':x).trim()}).filter(Boolean);
    var em=null,rest=[];
    cells.forEach(function(c){var m=c.match(EM);if(m&&!em)em=m[0];else if(!/^(e-?mail|name|first|last|first name|last name|full name)$/i.test(c))rest.push(c)});
    if(em) out.push((rest.slice(0,2).join(' ')+(rest.length?', ':'')+em).trim());
  });
  return out;
}
function wireListUpload(inputId,field,msgId,noun){
  var inp=$('#'+inputId),msg=$('#'+msgId),ta=F.namedItem(field);
  inp.addEventListener('change',function(){
    var f=inp.files&&inp.files[0];inp.value='';if(!f)return;
    if(f.size>5*1024*1024){msg.textContent='Please choose a file under 5 MB.';return}
    msg.textContent='Reading '+f.name+'…';
    var isX=/\.xlsx?$/i.test(f.name);
    var p=isX?Promise.all([loadXlsx(),f.arrayBuffer()]).then(function(a){var wb=a[0].read(a[1],{type:'array'});var rows=[];wb.SheetNames.forEach(function(n){rows=rows.concat(a[0].utils.sheet_to_json(wb.Sheets[n],{header:1,raw:false}))});return rows})
            :f.text().then(csvRows);
    p.then(function(rows){
      var lines=rowsToLines(rows);
      if(!lines.length){msg.textContent='We couldn’t find any email addresses in that file.';return}
      var have={};parseList(ta.value).items.forEach(function(x){have[x.email.toLowerCase()]=1});
      var add=lines.filter(function(l){var m=parseList(l).items[0];return m&&!have[m.email.toLowerCase()]});
      ta.value=(ta.value.trim()?ta.value.trim()+'\n':'')+add.join('\n');
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      msg.textContent=add.length?plural(add.length,noun)+' added from '+f.name+'. Review the list above.':'Everyone in that file is already on your list.';
    }).catch(function(e){msg.textContent=e.message||'That file could not be read. Please try a CSV.'});
  });
}
wireListUpload('inv-file','inviteList','inv-file-msg','guest');
wireListUpload('sup-file','supportList','sup-file-msg','person');

/* ── Save / restore ──────────────────────────────── */
var FIELDS=['response','declineNote','pubName','pubTitle','pubOrg','bio','teamName','teamEmail','gFirst','gLast','gEmail','gTitle','gOrg','gMeal','gMode','diet','access','inviteList','inviteMode','supportList','supportMode'];
var BOOLS=['guest'];
function collect(){
  var r={};
  FIELDS.forEach(function(k){r[k]=val(k)});
  BOOLS.forEach(function(k){r[k]=chk(k)});
  r.invitees=parseList(r.inviteList).items;r.supporters=parseList(r.supportList).items;
  r.step=cur;r.done=Object.keys(done).filter(function(k){return done[k]}).map(Number);
  return r;
}
function setField(k,v){
  var e=F.namedItem(k);if(!e||v==null)return;
  if(e.length&&!e.tagName){Array.prototype.forEach.call(e,function(x){x.checked=(x.value===v)})}
  else e.value=v;
}
function restore(r,prefill){
  prefill=prefill||{};
  ['pubName','pubTitle','pubOrg'].forEach(function(k){setField(k,(r&&r[k])||prefill[k]||'')});
  if(r){
    FIELDS.forEach(function(k){if(['pubName','pubTitle','pubOrg'].indexOf(k)<0&&r[k]!=null)setField(k,r[k])});
    BOOLS.forEach(function(k){var e=F.namedItem(k);if(e)e.checked=r[k]===true});
    (r.done||[]).forEach(function(i){if(i<=LAST)done[i]=true});
    if(typeof r.step==='number') cur=Math.max(0,Math.min(LAST,r.step));
  }
  bioCount();syncReveals();
}
var saveTimer=null,saving=false,dirty=false,ready=false;
function saveState(t){$('#savestate').textContent=t}
function saveSoon(ms){
  if(!ready||submitting) return;
  dirty=true;clearTimeout(saveTimer);
  saveTimer=setTimeout(saveNow,ms==null?1500:ms);
}
function saveNow(){
  if(!dirty||saving||submitting) return;
  saving=true;dirty=false;saveState('Saving…');
  api({action:'save',response:collect()}).then(function(){saveState('Saved')})
  .catch(function(){dirty=true;saveState('Not saved yet. Check your connection')})
  .then(function(){saving=false;if(dirty)saveSoon(4000)});
}
pf.addEventListener('input',function(){saveSoon()});
pf.addEventListener('change',function(e){if(e.target.type==='file')return;saveSoon()});
window.addEventListener('pagehide',function(){if(dirty&&ready&&!submitting)saveNow()});

/* ── Review ──────────────────────────────────────── */
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function noneSpan(t){return el('span','none',t||'Not yet provided')}
function renderReview(){
  var secs=$('#review-secs');secs.replaceChildren();
  var dec=declined(),resp=val('response');
  function sec(title,step,rows){
    var s=el('section','rsec'),h=el('div','rsec-h');
    h.appendChild(el('h3',null,title));
    var b=el('button','textbtn','Edit');b.type='button';b.setAttribute('aria-label','Edit '+title);
    b.addEventListener('click',function(){goto(step)});h.appendChild(b);s.appendChild(h);
    var dl=el('dl');
    rows=rows.filter(function(r){return r});
    if(!rows.length) rows=[['',noneSpan('Nothing added')]];
    rows.forEach(function(r){
      var row=el('div','rrow');if(r[0])row.appendChild(el('dt',null,r[0]));
      var dd=el('dd');
      if(r[1]&&r[1].nodeType) dd.appendChild(r[1]); else if(r[1]) dd.textContent=r[1]; else dd.appendChild(noneSpan());
      row.appendChild(dd);dl.appendChild(row);
    });
    s.appendChild(dl);secs.appendChild(s);
  }
  var rr=[['Nomination',resp==='accept'?'Accepted · I will attend in person on November 20':(resp==='decline'?'Respectfully declined':noneSpan('No response yet'))]];
  if(dec&&val('declineNote')) rr.push(['Note to the team',val('declineNote')]);
  sec('Response',0,rr);
  var sv0=parseList(val('supportList')).items;
  if(dec){
    sec('Support SALUTE',4,[
      sv0.length?['People to reach out to',plural(sv0.length,'person')]:null,
      sv0.length?['Outreach',val('supportMode')==='mention'?'SALUTE can reach out directly':(val('supportMode')==='cc'?'Copy me when reaching out':'')]:null
    ]);
    return;
  }
  var bw=words(val('bio'));
  sec('Profile',1,[
    ['Listed as',[val('pubName'),val('pubTitle'),val('pubOrg')].filter(Boolean).join(' · ')],
    bw?['Bio','Provided · '+plural(bw,'word')]:null,
    HS?['Headshot',(HS.filename||'Headshot')+' · uploaded']:null,
    val('teamName')||val('teamEmail')?['Team contact',[val('teamName'),val('teamEmail')].filter(Boolean).join(' · ')]:null
  ]);
  sec('Evening',2,[
    ['Complimentary guest',chk('guest')?[[val('gFirst'),val('gLast')].join(' ').trim(),val('gEmail'),[val('gTitle'),val('gOrg')].filter(Boolean).join(', '),val('gMeal')].filter(Boolean).join(' · '):'No guest'],
    chk('guest')&&val('gMode')?['Guest details',val('gMode')==='salute'?'SALUTE emails my guest, copying me':'I’ll share them myself']:null,
    ['Your meal',val('diet')],
    val('access')?['Allergies or accessibility',val('access')]:null
  ]);
  var iv=parseList(val('inviteList')).items,sv=parseList(val('supportList')).items;
  sec('Guests',3,[
    iv.length?['Additional guests',plural(iv.length,'guest')+' at $300 each']:null,
    iv.length?['Invitations',val('inviteMode')==='salute'?'SALUTE emails them on my behalf, copying me':(val('inviteMode')==='self'?'I’ll email them myself':'')]:null
  ]);
  sec('Support SALUTE',4,[
    sv.length?['People to reach out to',plural(sv.length,'person')]:null,
    sv.length?['Outreach',val('supportMode')==='mention'?'SALUTE can reach out directly':(val('supportMode')==='cc'?'Copy me when reaching out':'')]:null
  ]);
}

/* ── Submit ──────────────────────────────────────── */
var submitting=false;
function showSubmitErrors(list,stepFix){
  var root=stepEls[LAST];clearErrors(root);
  var a=$('.alert',root),s=el('strong',null,'Before you finish'),ul=el('ul');
  list.forEach(function(m){ul.appendChild(el('li',null,m))});
  a.appendChild(s);a.appendChild(ul);
  if(stepFix!=null){var fix=el('button','textbtn','Go to the step to fix');fix.type='button';fix.style.marginTop='8px';fix.addEventListener('click',function(){goto(stepFix)});a.appendChild(fix)}
  a.hidden=false;a.focus();a.scrollIntoView({block:'center',behavior:reduce?'auto':'smooth'});
}
function firstInvalidStep(){
  if(!val('response')) return 0;
  if(declined()) return validate(0).length?0:(validate(4).length?4:null);
  for(var i=0;i<LAST;i++){if(validate(i).length)return i}
  return null;
}
$('#submit').addEventListener('click',function(){
  if(submitting) return;
  var bad=firstInvalidStep();
  if(bad!=null){showSubmitErrors(validate(bad).map(function(e){return e.msg}),bad);return}
  clearErrors(stepEls[LAST]);
  submitting=true;clearTimeout(saveTimer);
  var btn=$('#submit');btn.disabled=true;btn.firstChild.textContent='Submitting… ';
  api({action:'submit',response:collect()}).then(function(r){
    STATE=r.status;SUBMITTED_AT=r.submitted_at;GUEST_URL=r.guest_page_url||null;GUEST_CODE=r.guest_code||null;dirty=false;
    for(var i=0;i<=LAST;i++) if(!(declined()&&i>0&&i<4)) done[i]=true;
    submitted=true;showConfirm();statusBar();showGuestLink();saveState('Submitted');
  }).catch(function(e){
    showSubmitErrors(e.errors&&e.errors.length?e.errors:[e.message||'Your response could not be submitted. Please try again.'],null);
  }).then(function(){submitting=false;btn.disabled=false;btn.firstChild.textContent='Submit my response '});
});
function showConfirm(){
  var dec=STATE==='declined';
  $('#c-eyebrow').textContent=dec?'Response received':'Nomination accepted';
  $('#c-h').textContent='Thank you, '+first()+'.';
  $('#c-lede').textContent=dec
    ?'Thank you for considering the nomination. We are grateful for the time you took, and the SALUTE team will be in touch personally.'
    :'We are honored to celebrate you as an inaugural S.SUITE '+H.honor+' Honoree on November 20. The SALUTE team will be in touch personally to confirm your seats and announcement timing.';
  $('#c-stamp').textContent=SUBMITTED_AT?'Received '+fmtWhen(SUBMITTED_AT):'';
  var showGl=!dec&&!!GUEST_URL;$('#c-gl').hidden=!showGl;if(showGl)$('#c-gl-field').value=GUEST_URL;
  $('#review-body').hidden=true;$('#confirm').hidden=false;
  cur=LAST;stepEls.forEach(function(s,k){s.hidden=(k!==LAST)});
  updateNav();
  window.scrollTo({top:0,behavior:reduce?'auto':'smooth'});
  $('#confirm').focus({preventScroll:true});
}
function statusBar(){
  var sb=$('#statusbar');
  if(!SUBMITTED_AT){sb.hidden=true;return}
  sb.textContent=(STATE==='accepted'?'You accepted your nomination on ':'You responded on ')+fmtWhen(SUBMITTED_AT)+'. You can update any answer and submit again; the SALUTE team will see your changes.';
  sb.hidden=false;
}
$('#c-review').addEventListener('click',function(){goto(LAST)});
$('#c-invite').addEventListener('click',toInvite);

/* ── Boot ────────────────────────────────────────── */
if(!token){gate('This private invitation link is incomplete. Please open it again from your email, or write to ssuite@salute.community.');return}
api({action:'get'}).then(function(d){
  H=d.honoree;STATE=d.status;SUBMITTED_AT=d.submitted_at;GUEST_URL=d.guest_page_url||null;GUEST_CODE=d.guest_code||null;HS=d.headshot||null;
  bind();
  var saved=d.response&&Object.keys(d.response).length?d.response:null;
  restore(saved,H.prefill);
  hsRender();showGuestLink();statusBar();
  $('#gate').hidden=true;views.invite.hidden=false;document.body.setAttribute('data-view','invite');
  startReveal();updateNav();onScroll();
  ready=true;
}).catch(function(e){
  gate(e.status===400?'This private invitation link is not valid or is no longer active. Please write to ssuite@salute.community and we will help right away.':'We could not open your invitation just now. Please refresh the page in a moment.');
});
})();
