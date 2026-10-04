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
var H=null, STATE=null, SUBMITTED_AT=null, GUEST_URL=null;
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
var NAMES=['Response','Profile','Evening','Announcement','Invite Guests','Support SALUTE','Review'];
var cur=0,done={},submitted=false;
function val(n){var e=F.namedItem(n);return e&&typeof e.value==='string'?e.value.trim():''}
function chk(n){var e=F.namedItem(n);return !!(e&&e.checked)}
function choiceText(name){var el=$('input[name="'+name+'"]:checked',pf);if(!el)return '';var b=$('b',el.closest('label'));return b?b.textContent:el.value}
function declined(){return val('response')==='decline'}
function measureHead(){var h=$('#p-top').offsetHeight;document.documentElement.style.setProperty('--hh',h+'px')}
window.addEventListener('resize',measureHead);

function updateNav(){
  var dec=declined();
  navBtns.forEach(function(b,i){
    var off=dec&&i>0&&i<6;
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
  var pct=submitted?100:Math.round(((cur+1)/7)*100);
  $('#p-fill').style.width=pct+'%';
  var sc=$('#p-steps'),b=navBtns[cur];
  if(!views.portal.hidden) sc.scrollTo?sc.scrollTo({left:Math.max(0,b.parentNode.offsetLeft-(sc.clientWidth-b.offsetWidth)/2),behavior:reduce?'auto':'smooth'}):(sc.scrollLeft=b.parentNode.offsetLeft);
  $$('[data-count]').forEach(function(c){c.textContent='Step '+(cur+1)+' of 7 · '+NAMES[cur]});
}
function goto(i,opts){
  opts=opts||{};
  if(!opts.keepConfirm){submitted=false;$('#confirm').hidden=true;$('#review-body').hidden=false}
  cur=i;
  stepEls.forEach(function(s,k){s.hidden=(k!==i)});
  if(i===6){renderReview();
    // A notice from an earlier attempt must reflect what is still missing now.
    var al=$('.alert',stepEls[6]);
    if(al&&!al.hidden){var bad=firstInvalidStep();if(bad==null)clearErrors(stepEls[6]);else{showSubmitErrors(validate(bad).map(function(e){return e.msg}),bad)}}
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
$$('[data-prev]').forEach(function(b){b.addEventListener('click',function(){goto(cur===6&&declined()?0:cur-1)})});
$$('[data-next]').forEach(function(b){b.addEventListener('click',next)});
$$('[data-skip]').forEach(function(b){b.addEventListener('click',function(){clearErrors(stepEls[cur]);done[cur]=true;goto(cur+1)})});
function next(){
  var errs=validate(cur);
  if(errs.length){showErrors(stepEls[cur],errs);return}
  clearErrors(stepEls[cur]);done[cur]=true;
  goto(cur===0&&declined()?6:cur+1);
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
function looksUrl(u){return /^(https?:\/\/)?[^\s\/.]+(\.[^\s\/.]+)+([\/?#]\S*)?$/i.test(u)}
function words(t){t=t.trim();return t?t.split(/\s+/).length:0}
function validate(i){
  var e=[];
  function push(n,m){var x=F.namedItem(n);e.push({el:x&&x.length&&!x.tagName?x[0]:x,msg:m})}
  if(i===0){
    if(!val('response')) push('response','Choose whether to accept or respectfully decline.');
    if(chk('handoff')){
      if(!val('hoName')) push('hoName','Add your team member’s name.');
      if(!val('hoEmail')) push('hoEmail','Add your team member’s email.');
      else if(!EMAIL.test(val('hoEmail'))) push('hoEmail','Enter a valid email address for your team member.');
    }
  }
  if(i===1){
    if(!val('pubName')) push('pubName','Add the name you’d like to appear publicly.');
    if(words(val('bio'))>120) push('bio','Please keep your bio to 120 words or fewer.');
    if(val('teamEmail')&&!EMAIL.test(val('teamEmail'))) push('teamEmail','Enter a valid email for your team contact.');
    if(val('social')&&!looksUrl(val('social'))) push('social','Enter a valid link, such as linkedin.com/in/yourname.');
  }
  if(i===2){
    if(!chk('attend')) push('attend','Confirm that you will attend S.SUITE in person on November 20.');
    if(!val('diet')) push('diet','Choose a vegetarian or non-vegetarian meal.');
    if(chk('guest')){
      if(!val('gName')) push('gName','Add your guest’s name.');
      if(!val('gEmail')) push('gEmail','Add your guest’s email.');
      else if(!EMAIL.test(val('gEmail'))) push('gEmail','Enter a valid email for your guest.');
    }
  }
  if(i===3){
    if(!val('shareAnnouncement')) push('shareAnnouncement','Let us know whether you would like to share the announcement.');
    if(!val('draftPost')) push('draftPost','Let us know whether you would like SALUTE to draft a post.');
    if(!val('annContact')) push('annContact','Choose who SALUTE should coordinate with about the announcement.');
  }
  if(i===4){ if(mgrs.invite.items.length&&!val('inviteMode')) push('inviteMode','Choose how outreach should happen for the people you’ve added.') }
  if(i===5){ if(mgrs.support.items.length&&!val('supportMode')) push('supportMode','Choose how introductions should happen for the people you’ve added.') }
  return e;
}

/* conditional reveals */
function syncReveals(){
  $('#decline-box').hidden=!declined();
  $('#handoff-box').hidden=!chk('handoff');
  $('#guest-grp').hidden=false;
  $('#guest-box').hidden=!chk('guest');
  updateNav();
}
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
  }else{
    t.hidden=true;t.removeAttribute('src');
    $('#hs-name').textContent='No file selected';
    $('#hs-meta').textContent='Choose an image to attach it to your profile.';
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

/* ── Contact managers ────────────────────────────── */
function parseCells(cells){
  var cs=cells.map(function(c){return c.trim()}).filter(Boolean);
  if(!cs.length) return null;
  var ei=-1;for(var i=0;i<cs.length;i++){if(EMAIL.test(cs[i])){ei=i;break}}
  if(ei<0){
    var m=cs.join(' ').match(/^(.*?)\s*<\s*([^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,})\s*>\s*$/);
    if(m) return {name:m[1].replace(/^["']+|["']+$/g,'').trim(),email:m[2]};
    if(cs.some(function(c){return /^e-?mail(\s*address)?$/i.test(c)})) return {header:true};
    return {bad:true};
  }
  return {email:cs[ei],name:cs.filter(function(_,k){return k!==ei}).join(' ').replace(/^["']+|["']+$/g,'').trim()};
}
function parseText(text){
  return text.split(/\r?\n/).map(function(line){
    line=line.trim();if(!line)return null;
    var ang=line.match(/^(.*?)\s*<\s*([^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,})\s*>\s*$/);
    if(ang) return {name:ang[1].replace(/^["']+|["']+$/g,'').trim(),email:ang[2]};
    return parseCells(/[,;\t]/.test(line)?line.split(/[,;\t]/):line.split(/\s+/));
  }).filter(Boolean);
}
function parseCSV(text){
  var rows=[],row=[],cell='',q=false;
  text=text.replace(/^\uFEFF/,'');
  for(var i=0;i<text.length;i++){
    var c=text[i];
    if(q){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++}else q=false}else cell+=c}
    else if(c==='"') q=true;
    else if(c===','||c==='\t'||c===';'){row.push(cell);cell=''}
    else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell=''}
    else cell+=c;
  }
  if(cell!==''||row.length){row.push(cell);rows.push(row)}
  return rows.map(parseCells).filter(Boolean);
}
function plural(n,w){return n+' '+w+(n===1?'':'s')}
function makeManager(mount){
  mount.appendChild($('#tpl-contacts').content.cloneNode(true));
  var q=function(r){return $('[data-role="'+r+'"]',mount)};
  var items=[],msg=q('msg'),ul=q('list');
  function render(){
    ul.replaceChildren();
    items.forEach(function(c,i){
      var li=document.createElement('li'),d=document.createElement('div');
      var n=document.createElement('span');n.className='c-n';
      if(c.name) n.textContent=c.name; else{var em=document.createElement('em');em.textContent='Name not provided';n.appendChild(em)}
      var m=document.createElement('span');m.className='c-m';m.textContent=c.email;
      d.appendChild(n);d.appendChild(m);
      var b=document.createElement('button');b.type='button';b.className='rm';b.textContent='Remove';
      b.setAttribute('aria-label','Remove '+(c.name||c.email));
      b.addEventListener('click',function(){
        items.splice(i,1);render();msg.textContent='Removed '+(c.name||c.email)+'.';saveSoon();
        var nb=ul.querySelectorAll('.rm')[Math.min(i,items.length-1)];(nb||q('paste')).focus();
      });
      li.appendChild(d);li.appendChild(b);ul.appendChild(li);
    });
    q('count').textContent=plural(items.length,'contact');
    q('empty').hidden=items.length>0;q('clear').hidden=!items.length;
  }
  function ingest(rows){
    var added=0,dup=0,bad=0;
    rows.forEach(function(r){
      if(r.header) return;
      if(r.bad){bad++;return}
      var key=r.email.toLowerCase();
      if(items.some(function(x){return x.email.toLowerCase()===key})){dup++;return}
      items.push({name:r.name,email:r.email});added++;
    });
    render();
    var parts=[];
    parts.push(added?('Added '+plural(added,'contact')+'.'):'No new contacts added.');
    if(bad) parts.push(plural(bad,'row')+' skipped for a missing or invalid email.');
    if(dup) parts.push(plural(dup,'duplicate')+' ignored.');
    msg.textContent=parts.join(' ');
    if(added) saveSoon();
    return added;
  }
  q('paste-btn').addEventListener('click',function(){
    var t=q('paste').value;
    if(!t.trim()){msg.textContent='Paste at least one Name, Email row first.';q('paste').focus();return}
    if(ingest(parseText(t))) q('paste').value='';
  });
  function addOne(){
    var n=q('name'),e=q('email');
    if(!EMAIL.test(e.value.trim())){msg.textContent='Enter a valid email address to add this person.';e.focus();return}
    if(ingest([{name:n.value.trim(),email:e.value.trim()}])){n.value='';e.value='';n.focus()}else e.focus();
  }
  q('add-btn').addEventListener('click',addOne);
  ['name','email'].forEach(function(r){q(r).addEventListener('keydown',function(ev){if(ev.key==='Enter'){ev.preventDefault();addOne()}})});
  q('clear').addEventListener('click',function(){items.length=0;render();msg.textContent='All contacts removed.';saveSoon();q('paste').focus()});
  var csv=q('csv');
  csv.addEventListener('change',function(){
    var f=csv.files&&csv.files[0];if(!f)return;
    var rd=new FileReader();
    rd.onload=function(){ingest(parseCSV(String(rd.result)));msg.textContent=f.name+': '+msg.textContent;csv.value=''};
    rd.onerror=function(){msg.textContent='That file couldn’t be read. Please try another CSV.';csv.value=''};
    rd.readAsText(f);
  });
  q('tpl-btn').addEventListener('click',function(){
    var blob=new Blob(['Name,Email\r\nJane Sample,jane.sample@example.com\r\nAlex Example,alex.example@example.com\r\n'],{type:'text/csv;charset=utf-8'});
    var u=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=u;a.download='ssuite-contacts-template.csv';document.body.appendChild(a);a.click();a.remove();
    setTimeout(function(){URL.revokeObjectURL(u)},1500);
    msg.textContent='Template downloaded. Add rows as Name, Email, then upload it here.';
  });
  render();
  return {items:items,set:function(list){items.length=0;(list||[]).forEach(function(c){if(c&&EMAIL.test(c.email||''))items.push({name:c.name||'',email:c.email})});render()}};
}
var mgrs={invite:makeManager($('[data-mount="invite"]')),support:makeManager($('[data-mount="support"]'))};

/* ── Editable letters ────────────────────────────── */
var LINK_TOKEN='[PERSONAL INVITATION LINK]';
function defaultLetters(){
  var honor=H.honor, name=H.full_name;
  return {
    invite:{subject:'I’d love for you to join me at S.SUITE',
      body:'Dear [First Name],\n\nI’m honored to be recognized as an inaugural S.SUITE '+honor+' Honoree by SALUTE, and I would be delighted if you joined me for the inaugural S.SUITE evening.\n\nS.SUITE recognizes South Asian women leaders and allies whose leadership is shaping business, capital, culture, impact, and community. The celebration will take place on Friday, November 20, 2026, at 6:30 p.m. at the Prince George Ballroom in New York City.\n\nSALUTE has extended a special honoree guest rate of $300 per person. Space is limited, and a seat is confirmed only after registration and payment. You can view the invitation and register through my personal link:\n\n'+(GUEST_URL||LINK_TOKEN)+'\n\nI hope you’ll be able to join me for this very special evening.\n\nWith warmth,\n'+name},
    support:{subject:'An introduction to SALUTE',
      body:'Dear [First Name],\n\nI’m honored to have been named an inaugural S.SUITE '+honor+' Honoree by SALUTE, and I wanted to introduce you to the organization behind this recognition.\n\nSALUTE is a 501(c)(3) private professional network for senior South Asian women and allies. Its work expands access, visibility, connection, and opportunity—and S.SUITE brings that mission to life by recognizing leadership with purpose.\n\nI thought of you because [personal note]. If SALUTE’s work resonates with you, I would be glad to connect you with the team so they can share more. There is no expectation or obligation; I simply wanted to introduce you to an organization doing meaningful work.\n\nWith gratitude,\n'+name}
  };
}
function autosize(t){t.style.height='auto';t.style.height=Math.max(t.scrollHeight+4,280)+'px'}
var letterBoxes={};
function setupLetters(saved){
  var D=defaultLetters();
  $$('[data-letter]').forEach(function(box){
    var k=box.dataset.letter,d=D[k],s=$('[data-role="subj"]',box),b=$('[data-role="body"]',box),m=$('[data-role="lmsg"]',box);
    letterBoxes[k]={s:s,b:b};
    function set(src){s.value=src.subject;b.value=src.body;autosize(b)}
    var sv=saved&&saved[k];
    set(sv&&sv.body?sv:d);
    if(GUEST_URL&&k==='invite'&&b.value.indexOf(LINK_TOKEN)>=0){b.value=b.value.split(LINK_TOKEN).join(GUEST_URL);autosize(b)}
    b.addEventListener('input',function(){autosize(b)});
    $('[data-reset]',box).addEventListener('click',function(){set(defaultLetters()[k]);m.textContent='Template restored.';saveSoon()});
    $('[data-copy]',box).addEventListener('click',function(){
      var txt='Subject: '+s.value+'\n\n'+b.value;
      function fb(){b.focus();b.select();try{document.execCommand('copy');m.textContent='Message text copied.'}catch(e){m.textContent='Select the text and copy it manually.'}}
      if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(function(){m.textContent='Subject and message copied.'},fb)}else fb();
    });
    new MutationObserver(function(){autosize(b)}).observe(box.closest('.step'),{attributes:true,attributeFilter:['hidden']});
  });
}

/* ── Guest link ──────────────────────────────────── */
function copyText(txt,msgEl){
  function fb(){msgEl.textContent='Select the link and copy it manually.'}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(function(){msgEl.textContent='Link copied.'},fb)}else fb();
}
function showGuestLink(){
  if(!GUEST_URL) return;
  $('#gl-field').value=GUEST_URL;$('#gl-copy').hidden=false;
  $('#gl-desc').textContent='Share this link with anyone you would like in the room. It applies the $300 honoree rate automatically; each seat is confirmed once registration and payment are complete.';
  var lb=letterBoxes.invite;
  if(lb&&lb.b.value.indexOf(LINK_TOKEN)>=0){lb.b.value=lb.b.value.split(LINK_TOKEN).join(GUEST_URL);autosize(lb.b)}
}
$('#gl-copy').addEventListener('click',function(){copyText(GUEST_URL,$('#gl-msg'))});
$('#c-gl-copy').addEventListener('click',function(){copyText(GUEST_URL,$('#c-small'))});

/* ── Save / restore ──────────────────────────────── */
var FIELDS=['response','declineNote','hoName','hoEmail','pubName','pubTitle','pubOrg','bio','pron','teamName','teamEmail','social','gName','gEmail','gTitle','gOrg','diet','dietNote','access','travel','shareAnnouncement','draftPost','annContact','annNote','inviteMode','supportMode'];
var BOOLS=['handoff','attend','guest','tableLink'];
function collect(){
  var r={};
  FIELDS.forEach(function(k){r[k]=val(k)});
  BOOLS.forEach(function(k){r[k]=chk(k)});
  r.invitees=mgrs.invite.items.slice();r.supporters=mgrs.support.items.slice();
  if(letterBoxes.invite) r.inviteLetter={subject:letterBoxes.invite.s.value,body:letterBoxes.invite.b.value};
  if(letterBoxes.support) r.supportLetter={subject:letterBoxes.support.s.value,body:letterBoxes.support.b.value};
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
    mgrs.invite.set(r.invitees);mgrs.support.set(r.supporters);
    (r.done||[]).forEach(function(i){done[i]=true});
    if(typeof r.step==='number') cur=Math.max(0,Math.min(6,r.step));
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
pf.addEventListener('input',function(e){if(e.target.closest('.cm'))return;saveSoon()});
pf.addEventListener('change',function(e){if(e.target.type==='file'||e.target.closest('.cm'))return;saveSoon()});
window.addEventListener('pagehide',function(){if(dirty&&ready&&!submitting)saveNow()});

/* ── Review ──────────────────────────────────────── */
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function noneSpan(t){return el('span','none',t||'Not yet provided')}
function renderReview(){
  var figs=$('#figs'),secs=$('#review-secs');figs.replaceChildren();secs.replaceChildren();
  var dec=declined(),resp=val('response');
  var guest=(!dec&&chk('guest'))?1:0;
  [[dec?'—':String(guest),'Guest'+(guest===1?'':'s')],[String(dec?0:mgrs.invite.items.length),'Invited'],[String(dec?0:mgrs.support.items.length),'Introductions']].forEach(function(f){
    var d=el('div','fig');d.appendChild(el('b',null,f[0]));d.appendChild(el('span',null,f[1]));figs.appendChild(d);
  });
  function sec(title,step,rows){
    var s=el('section','rsec'),h=el('div','rsec-h');
    h.appendChild(el('h3',null,title));
    var b=el('button','textbtn','Edit');b.type='button';b.setAttribute('aria-label','Edit '+title);
    b.addEventListener('click',function(){goto(step)});h.appendChild(b);s.appendChild(h);
    var dl=el('dl');
    rows.forEach(function(r){
      var row=el('div','rrow');row.appendChild(el('dt',null,r[0]));
      var dd=el('dd');
      if(r[1]&&r[1].nodeType) dd.appendChild(r[1]); else if(r[1]) dd.textContent=r[1]; else dd.appendChild(noneSpan());
      row.appendChild(dd);dl.appendChild(row);
    });
    s.appendChild(dl);secs.appendChild(s);
  }
  var rr=[['Nomination',resp==='accept'?'Accepted':(resp==='decline'?'Respectfully declined':noneSpan('No response yet'))]];
  if(dec&&val('declineNote')) rr.push(['Note to the team',val('declineNote')]);
  if(chk('handoff')) rr.push(['Completion handed to',val('hoName')?(val('hoName')+(val('hoEmail')?' · '+val('hoEmail'):'')):noneSpan('Name missing')]);
  rr.push(['Conditions','In-person attendance on November 20 is required. Acceptance is not contingent on tickets, sponsorship, donations, or fundraising.']);
  sec('Response',0,rr);
  if(dec) return;
  var bw=words(val('bio'));
  sec('Profile',1,[
    ['Public name',val('pubName')],['Title',val('pubTitle')],['Organization',val('pubOrg')],
    ['Bio',bw?('Provided · '+plural(bw,'word')):noneSpan('Not yet added')],
    ['Pronunciation',val('pron')||noneSpan('None')],
    ['Headshot',HS?((HS.filename||'Headshot')+' · uploaded'):noneSpan('Not yet uploaded')],
    ['Team contact',val('teamName')||val('teamEmail')?[val('teamName'),val('teamEmail')].filter(Boolean).join(' · '):noneSpan('None')],
    ['Social link',val('social')||noneSpan('None')]
  ]);
  sec('Evening',2,[
    ['Attendance',chk('attend')?'Confirmed in-person attendance on November 20':''],
    ['Complimentary guest',guest?[val('gName'),val('gEmail'),val('gTitle'),val('gOrg')].filter(Boolean).join(' · '):noneSpan('No guest')],
    ['Honoree table',chk('tableLink')?'Requested secure purchase link · $5,000 extended early-bird rate':noneSpan('Not requested')],
    ['Meal preference',val('diet')||noneSpan('Not yet selected')],
    ['Food allergies',val('dietNote')||noneSpan('None noted')],
    ['Accommodations',val('access')||noneSpan('None noted')],
    ['Arrival & travel',val('travel')||noneSpan('None noted')]
  ]);
  sec('Announcement',3,[
    ['Sharing preference',choiceText('shareAnnouncement')],
    ['SALUTE-crafted post',val('draftPost')?(val('draftPost')==='Yes'?'Requested':'Not requested'):''],
    ['Coordination',choiceText('annContact')],
    ['Notes',val('annNote')||noneSpan('None')]
  ]);
  var ic=mgrs.invite.items.length,sc=mgrs.support.items.length;
  sec('Invite others',4,[
    ['Additional guests',plural(ic,'contact')+(ic?'. $300 honoree rate; seats confirmed after registration and payment.':'')],
    ['Outreach direction',ic?(val('inviteMode')||noneSpan('Choose a direction: no one is contacted without one')):noneSpan('No contacts added')]
  ]);
  sec('Support SALUTE (optional)',5,[
    ['Potential supporters',plural(sc,'contact')],
    ['Introduction direction',sc?(val('supportMode')||noneSpan('Choose a direction: no one is contacted without one')):noneSpan('No contacts added')]
  ]);
}

/* ── Submit ──────────────────────────────────────── */
var submitting=false;
function showSubmitErrors(list,stepFix){
  var root=stepEls[6];clearErrors(root);
  var a=$('.alert',root),s=el('strong',null,'Before you finish'),ul=el('ul');
  list.forEach(function(m){ul.appendChild(el('li',null,m))});
  a.appendChild(s);a.appendChild(ul);
  if(stepFix!=null){var fix=el('button','textbtn','Go to the step to fix');fix.type='button';fix.style.marginTop='8px';fix.addEventListener('click',function(){goto(stepFix)});a.appendChild(fix)}
  a.hidden=false;a.focus();a.scrollIntoView({block:'center',behavior:reduce?'auto':'smooth'});
}
function firstInvalidStep(){
  if(!val('response')) return 0;
  if(declined()) return validate(0).length?0:null;
  for(var i=0;i<6;i++){if(validate(i).length)return i}
  return null;
}
$('#submit').addEventListener('click',function(){
  if(submitting) return;
  var bad=firstInvalidStep();
  if(bad!=null){showSubmitErrors(validate(bad).map(function(e){return e.msg}),bad);return}
  clearErrors(stepEls[6]);
  submitting=true;clearTimeout(saveTimer);
  var btn=$('#submit');btn.disabled=true;btn.firstChild.textContent='Submitting… ';
  api({action:'submit',response:collect()}).then(function(r){
    STATE=r.status;SUBMITTED_AT=r.submitted_at;GUEST_URL=r.guest_page_url||null;dirty=false;
    for(var i=0;i<7;i++) if(!(declined()&&i>0&&i<6)) done[i]=true;
    submitted=true;showConfirm();statusBar();showGuestLink();saveState('Submitted');
  }).catch(function(e){
    showSubmitErrors(e.errors&&e.errors.length?e.errors:[e.message||'Your response could not be submitted. Please try again.'],null);
  }).then(function(){submitting=false;btn.disabled=false;btn.firstChild.textContent='Submit my response '});
});
function showConfirm(){
  var dec=STATE==='declined';
  $('#c-eyebrow').textContent=dec?'Response received':'Nomination accepted';
  $('#c-h').textContent=dec?'Thank you, '+first()+'.':'Thank you, '+first()+'.';
  $('#c-lede').textContent=dec
    ?'Thank you for considering the nomination. We are grateful for the time you took, and the SALUTE team will be in touch personally.'
    :'We are honored to celebrate you as an inaugural S.SUITE '+H.honor+' Honoree on November 20. The SALUTE team will be in touch personally to confirm your seats, announcement timing and materials.';
  $('#c-stamp').textContent=SUBMITTED_AT?'Received '+fmtWhen(SUBMITTED_AT):'';
  var showGl=!dec&&!!GUEST_URL;$('#c-gl').hidden=!showGl;if(showGl)$('#c-gl-field').value=GUEST_URL;
  $('#review-body').hidden=true;$('#confirm').hidden=false;
  cur=6;stepEls.forEach(function(s,k){s.hidden=(k!==6)});
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
$('#c-review').addEventListener('click',function(){goto(6)});
$('#c-invite').addEventListener('click',toInvite);

/* ── Boot ────────────────────────────────────────── */
if(!token){gate('This private invitation link is incomplete. Please open it again from your email, or write to ssuite@salute.community.');return}
api({action:'get'}).then(function(d){
  H=d.honoree;STATE=d.status;SUBMITTED_AT=d.submitted_at;GUEST_URL=d.guest_page_url||null;HS=d.headshot||null;
  bind();
  var saved=d.response&&Object.keys(d.response).length?d.response:null;
  restore(saved,H.prefill);
  setupLetters(saved?{invite:saved.inviteLetter,support:saved.supportLetter}:null);
  hsRender();showGuestLink();statusBar();
  $('#gate').hidden=true;views.invite.hidden=false;document.body.setAttribute('data-view','invite');
  startReveal();updateNav();onScroll();
  ready=true;
}).catch(function(e){
  gate(e.status===400?'This private invitation link is not valid or is no longer active. Please write to ssuite@salute.community and we will help right away.':'We could not open your invitation just now. Please refresh the page in a moment.');
});
})();
