(() => {
  const data = window.SSUITE_DATA;
  const api = window.SSUITE_API;
  const bootstrap = window.SSUITE_BOOTSTRAP;
  const state = {
    category: 'CEO', scope: 'all', query: '', nomination: 'all', verification: 'all',
    votes: bootstrap.votes || [], notes: {}, selected: null, voteCandidateId: null,
    reviewerName: bootstrap.reviewer.fullName,
    reviewerEmail: bootstrap.reviewer.email,
    isAdmin: bootstrap.reviewer.isAdmin
  };
  const selectedHonorees = { Capital: 'Anu Aiyengar' };
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value='') => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const reviewerKey = (name='') => name.trim().toLowerCase();
  const connectionLabels = {
    'personal-direct':'Can reach out personally',
    'professional-direct':'Can reach out professionally',
    'warm-intro':'Can arrange warm introduction',
    'know-no-outreach':'Knows candidate; not outreach lead',
    none:'Does not know candidate'
  };
  const linkedInSearchHref = (r) => `https://www.google.com/search?q=${encodeURIComponent(`site:linkedin.com/in/ "${r.name}" "${r.organization||''}"`)}`;
  const linkedInHref = (r) => r.linkedinVerified && r.linkedinUrl ? r.linkedinUrl : linkedInSearchHref(r);
  const linkedInLabel = (r) => r.linkedinVerified && r.linkedinUrl ? 'Open verified LinkedIn profile' : 'Search for LinkedIn profile';
  const linkedInAction = (r) => `<a class="linkedin-link" href="${escapeHtml(linkedInHref(r))}" target="_blank" rel="noopener noreferrer" aria-label="${linkedInLabel(r)} for ${escapeHtml(r.name)}" title="${linkedInLabel(r)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.3 7.8H2.1V22h3.2V7.8ZM3.7 2A1.9 1.9 0 1 0 3.7 5.8 1.9 1.9 0 0 0 3.7 2ZM22 13.9c0-4.3-2.3-6.4-5.4-6.4-2.5 0-3.6 1.4-4.2 2.3v-2H9.2V22h3.2v-7c0-1.8.3-3.6 2.6-3.6 2.2 0 2.3 2.1 2.3 3.7V22H22v-8.1Z"/></svg><span class="sr-only">${linkedInLabel(r)}</span></a>`;
  const bindLinkedInLinks = (root=document) => root.querySelectorAll('.linkedin-link').forEach(link => {
    link.addEventListener('click', event => event.stopPropagation());
  });

  function currentVote(category=state.category){
    return state.votes.find(v=>v.category===category) || null;
  }

  function renderTabs(){
    const scopeButton=document.querySelector('[data-scope="top5"]');
    if(scopeButton) scopeButton.textContent=`Top ${shortlistSize()} shortlist`;
    $('categoryTabs').innerHTML = data.categories.map(cat => `<button class="category-tab ${cat===state.category?'active':''}" data-category="${escapeHtml(cat)}"><b>${escapeHtml(cat)}</b><span>${selectedHonorees[cat]?'Awarded':data.counts[cat]}</span></button>`).join('');
    $('categorySelect').innerHTML=data.categories.map(cat=>`<option value="${escapeHtml(cat)}" ${cat===state.category?'selected':''}>${escapeHtml(cat)} · ${selectedHonorees[cat]?'Awarded':data.counts[cat]}</option>`).join('');
    $('categorySelect').onchange=event=>{
      state.category=event.target.value;
      if(state.category==='Capital') state.scope='all';
      render();
    };
    document.querySelectorAll('[data-category]').forEach(b => b.onclick = () => {
      state.category=b.dataset.category;
      if(state.category==='Capital') state.scope='all';
      render();
    });
  }

  function isShortlisted(r){ return r.tier==='Top 5' || r.tier==='Top 10'; }
  function shortlistSize(category=state.category){ return ['CEO','Culture'].includes(category) ? 10 : 5; }
  function matchesScope(r){
    if(state.scope==='top5') return isShortlisted(r);
    return true;
  }
  function filtered(){
    const q=state.query.trim().toLowerCase();
    return data.records.filter(r => {
      if(r.category!==state.category || !matchesScope(r)) return false;
      if(q && ![r.name,r.title,r.organization,r.whyConsider,r.communityImpact,r.recognitionEvidence].join(' ').toLowerCase().includes(q)) return false;
      if(state.nomination==='submitted' && !r.submitted) return false;
      if(state.nomination==='research' && r.submitted) return false;
      if(state.verification==='eligibility'){ if(!needsEligibilityCheck(r)) return false; }
      else if(state.verification==='heritage'){ if(!heritageToConfirm(r)) return false; }
      else if(state.verification==='location'){ if(!locationMissing(r)) return false; }
      else if(state.verification!=='all' && verificationKey(r)!==state.verification) return false;
      return true;
    }).sort((a,b) => {
      const selected = selectedHonorees[state.category];
      if(a.name===selected) return -1;
      if(b.name===selected) return 1;
      return 0;
    });
  }
  function displayRank(r){ return r.rank ? String(r.rank).padStart(2,'0') : '—'; }
  function verificationKey(r){
    const status=r.verificationStatus||'';
    if(status.startsWith('Source verified')) return 'verified';
    if(status.startsWith('Partially')) return 'partial';
    return 'lead';
  }
  const verificationLabels={verified:'Source verified',partial:'Partially verified',lead:'Research lead'};
  function verificationBadge(r){
    const key=verificationKey(r);
    return `<span class="badge ${key==='verified'?'verified':key==='partial'?'partial':'lead'}">${verificationLabels[key]}</span>`;
  }
  function needsEligibilityCheck(r){ return /^(Needs eligibility check|Eligibility unresolved)/.test(r.eligibility||''); }
  function heritageToConfirm(r){ return /heritage not yet documented/i.test(r.eligibility||''); }
  function locationMissing(r){ return /not yet verified/i.test(r.location||''); }
  function eligibilityBadge(r){
    if(needsEligibilityCheck(r)) return '<span class="badge eligibility">Eligibility to confirm</span>';
    if(heritageToConfirm(r)) return '<span class="badge eligibility">Heritage to confirm</span>';
    return '';
  }
  function evidenceClass(s){ return /^not yet (verified|summarized)/i.test(s||'') ? 'unverified' : ''; }

  function openVote(record){
    if(selectedHonorees[record.category]) return;
    state.voteCandidateId=record.id;
    const existing=currentVote(record.category);
    $('voteCandidateName').textContent=record.name;
    $('voteCandidateRole').textContent=[record.title,record.organization].filter(Boolean).join(' · ');
    $('voteReviewerIdentity').textContent=`${state.reviewerName} (${state.reviewerEmail})`;
    const connection=existing?.connection || '';
    document.querySelectorAll('input[name="connection"]').forEach(input=>{input.checked=input.value===connection;});
    $('removeVoteButton').hidden=!existing;
    $('voteError').hidden=true;
    $('voteModal').hidden=false;
  }
  function closeVote(){ $('voteModal').hidden=true; state.voteCandidateId=null; }

  async function saveVote(){
    const record=data.records.find(r=>r.id===state.voteCandidateId); if(!record) return;
    const selectedConnection=document.querySelector('input[name="connection"]:checked');
    const connection=selectedConnection?.value || '';
    const error=$('voteError');
    if(!connection){error.textContent='Please indicate whether you know or can reach this candidate.';error.hidden=false;return;}
    $('saveVoteButton').disabled=true;$('saveVoteButton').textContent='Saving…';
    try{
      const result=await api.request('/votes',{method:'PUT',body:JSON.stringify({category:record.category,candidateId:record.id,connection})});
      const previousIndex=state.votes.findIndex(v=>v.category===record.category);
      if(previousIndex>=0) state.votes[previousIndex]=result.vote; else state.votes.push(result.vote);
      closeVote(); renderRows(); renderReviewerStatus();
      if(state.selected===record.id) renderDetailVotes();
    }catch(err){error.textContent=err.message;error.hidden=false;}
    finally{$('saveVoteButton').disabled=false;$('saveVoteButton').textContent='Save honoree vote';}
  }

  async function removeVote(){
    const record=data.records.find(r=>r.id===state.voteCandidateId); if(!record) return;
    $('removeVoteButton').disabled=true;
    try{
      await api.request(`/votes/${encodeURIComponent(record.category)}`,{method:'DELETE'});
      state.votes=state.votes.filter(v=>v.category!==record.category);
      closeVote(); renderRows(); renderReviewerStatus();
      if(state.selected===record.id) renderDetailVotes();
    }catch(err){$('voteError').textContent=err.message;$('voteError').hidden=false;}
    finally{$('removeVoteButton').disabled=false;}
  }

  function renderReviewerStatus(){
    const count=state.votes.length;
    $('reviewerStatus').textContent=`${state.reviewerName} · ${count} vote${count===1?'':'s'} saved`;
  }

  function renderRows(){
    const rows=filtered();
    const selectedName=selectedHonorees[state.category];
    const vote=currentVote(state.category);
    $('candidateRows').innerHTML=rows.map(r => {
      const isSelected=r.name===selectedName;
      const hasVote=vote?.candidateId===r.id;
      const isCapital=r.category==='Capital';
      const tierLabel=isSelected?'2026 Honoree':isCapital?'':isShortlisted(r)?`${r.tier} shortlist`:'';
      const rankLabel=isSelected?'✓':isCapital?'':displayRank(r);
      const organization=r.category==='Director'?(r.publicBoards||r.organization||'Not yet verified'):r.organization||'Not yet verified';
      const privateBoards=r.privateBoards||'Not yet verified';
      const voteText=hasVote ? `Edit vote · ${connectionLabels[vote.connection]}` : 'Vote';
      return `<tr class="candidate-row ${(!isCapital&&isShortlisted(r))||isSelected?'top-ten':''} ${isSelected?'selected-honoree':''}" data-id="${escapeHtml(r.id)}">
        <td class="rank-cell" data-label="Rank"><span class="rank">${rankLabel}</span>${tierLabel?`<span class="tier">${escapeHtml(tierLabel)}</span>`:''}</td>
        <td class="candidate-cell" data-label="Candidate"><div class="candidate-heading"><div class="candidate-name">${escapeHtml(r.name)}</div>${r.submitted?'<span class="submitted-star" role="img" title="Submitted nomination" aria-label="Submitted nomination">★</span>':''}${linkedInAction(r)}</div><div class="badge-row">${r.saluteAffiliated?'<span class="badge salute">SALUTE connection</span>':''}</div></td>
        <td class="role-cell" data-label="Title / Role"><div class="main-field">${escapeHtml(r.title||'Not yet verified')}</div></td>
        <td class="org-cell" data-label="${r.category==='Director'?'Current public-company boards':'Organization'}"><div class="main-field">${escapeHtml(organization)}</div></td>
        ${r.category==='Director'?`<td class="private-board-col" data-label="Private company boards"><div class="main-field ${evidenceClass(privateBoards)}">${escapeHtml(privateBoards)}</div></td>`:''}
        <td class="location-cell" data-label="Location"><div class="main-field">${escapeHtml(r.location||'Not yet verified')}</div></td>
        <td class="impact-cell" data-label="Impact"><div class="cell-copy ${evidenceClass(r.communityImpact)}">${escapeHtml(r.communityImpact||'Not yet verified')}</div></td>
        <td class="vote-cell" data-label="Your vote">${isCapital?'<span class="closed-vote">Closed</span>':`<button class="vote-pill ${hasVote?'has-vote':''}" data-cast-vote="${escapeHtml(r.id)}">${escapeHtml(voteText)}</button>`}</td>
      </tr>`;
    }).join('');
    $('emptyState').hidden=rows.length>0;
    document.querySelectorAll('.candidate-row').forEach(row => row.onclick = () => openDetail(row.dataset.id));
    document.querySelectorAll('[data-cast-vote]').forEach(button => button.onclick = (event) => {
      event.stopPropagation();
      const record=data.records.find(r=>r.id===button.dataset.castVote);
      if(record) openVote(record);
    });
    bindLinkedInLinks($('candidateRows'));
    const size=shortlistSize();
    const scopeLabel=state.scope==='top5'?`Top ${size} shortlist`:'All candidates';
    $('viewTitle').textContent=selectedName?`${state.category} · Honoree selected`:`${state.category} · ${scopeLabel}`;
    $('viewDescription').textContent=selectedName?`${selectedName} is the 2026 honoree. Other candidates may remain under consideration in another fitting category.`:state.scope==='top5'?`${size} candidates currently under serious consideration`:`Top ${size} shortlist followed by every other candidate in alphabetical order`;
    $('showingCount').textContent=`${rows.length} shown`;
    $('reviewedCount').textContent=selectedName?`Selected: ${selectedName}`:vote?`Your vote: ${vote.candidateName}`:'Your vote: Not cast';
  }

  function openDetail(id){
    const r=data.records.find(x=>x.id===id); if(!r) return;
    state.selected=id;
    $('detailCategory').textContent=isShortlisted(r)?`${r.category} · ${r.tier} shortlist · Rank ${r.rank}`:r.tier==='Selected Honoree'?`${r.category} · 2026 honoree`:r.category;
    $('detailName').textContent=r.name;
    $('detailRole').textContent=[r.title,r.organization].filter(Boolean).join(' · ');
    $('detailWhy').textContent=r.whyConsider;
    $('detailProfessional').textContent=r.professionalImpact;
    $('detailCommunity').textContent=r.communityImpact;
    $('detailCommunity').className=evidenceClass(r.communityImpact);
    $('detailRecognition').textContent=r.recognitionEvidence;
    $('detailRecognition').className=evidenceClass(r.recognitionEvidence);
    $('detailNomination').textContent=r.nominationSource || 'Public research';
    $('detailLinkedIn').innerHTML=linkedInAction(r);
    $('detailLocation').textContent=r.location || 'Not yet verified';
    $('detailAlso').textContent=r.alsoQualifies || '—';
    const combined=[r.researchNotes,r.submittedNotes].filter(Boolean).join('\n\n');
    $('detailNotes').textContent=combined || 'No additional notes.';
    $('detailNotesSection').style.display=combined?'block':'none';
    const sources=[r.source1,r.source2].filter(Boolean);
    $('detailSources').innerHTML=sources.length?sources.map((s,i)=>/^https?:\/\//.test(s)?`<a href="${escapeHtml(s)}" target="_blank" rel="noopener">Source ${i+1}: ${escapeHtml(s)}</a>`:`<span>${escapeHtml(s)}</span>`).join(''):'<span>No direct source link recorded yet.</span>';
    renderDetailVotes();
    $('scrim').hidden=false; $('detailDrawer').classList.add('open'); $('detailDrawer').setAttribute('aria-hidden','false');
  }
  function renderDetailVotes(){
    const record=data.records.find(r=>r.id===state.selected); if(!record) return;
    const selectedName=selectedHonorees[record.category];
    const isSelected=record.name===selectedName;
    const vote=currentVote(record.category);
    const hasVote=vote?.candidateId===record.id;
    if(selectedName){
      $('detailVotes').innerHTML=isSelected?'<div class="honoree-confirmation">Selected 2026 honoree</div>':`<div class="closed-category">Capital has been awarded to ${escapeHtml(selectedName)}. This candidate may still be considered in another fitting category.</div>`;
      return;
    }
    const voteLabel=hasVote?'Edit your vote and disclosure':`Vote for ${escapeHtml(record.name)}`;
    $('detailVotes').innerHTML=`<button class="vote-button primary-vote ${hasVote?'active':''}" data-detail-vote>${voteLabel}</button>`;
    const button=document.querySelector('[data-detail-vote]'); if(button) button.onclick=()=>openVote(record);
  }
  function closeDetail(){
    $('detailDrawer').classList.remove('open'); $('detailDrawer').setAttribute('aria-hidden','true'); $('scrim').hidden=true;
  }

  async function renderAdmin(){
    $('adminVoteRows').innerHTML='';$('adminEmptyState').hidden=false;$('adminEmptyState').textContent='Loading saved responses…';
    const result=await api.request('/admin');
    const rows=[...result.votes].sort((a,b)=>a.category.localeCompare(b.category)||a.reviewerName.localeCompare(b.reviewerName));
    $('adminVoteRows').innerHTML=rows.map(v=>`<tr><td>${escapeHtml(v.category)}</td><td>${escapeHtml(v.candidateName)}</td><td>${escapeHtml(v.reviewerName)}<br><span class="admin-email">${escapeHtml(v.reviewerEmail)}</span></td><td>${escapeHtml(connectionLabels[v.connection]||v.connection)}</td><td>${escapeHtml(new Date(v.updatedAt).toLocaleString())}</td></tr>`).join('');
    $('adminEmptyState').hidden=rows.length>0;$('adminEmptyState').textContent='No votes have been submitted yet.';
    const activeReviewers=(result.reviewers||[]).filter(r=>r.active).length;
    const participants=new Set(rows.map(v=>v.reviewerEmail)).size;
    $('adminSummary').innerHTML=`<span><b>${participants}</b> reviewers responding</span><span><b>${rows.length}</b> category votes</span><span><b>${activeReviewers}</b> reviewer accounts</span>`;
  }
  function renderRubric(){ $('rubricList').innerHTML=data.rubric.map((r,i)=>`<div class="rubric-item"><b>${i+1}. ${escapeHtml(r.name)}</b><p>${escapeHtml(r.question)}</p></div>`).join(''); }
  function render(){
    renderTabs();
    const isDirector=state.category==='Director';
    $('rankHeader').textContent=state.category==='Capital'?'Status':'Rank';
    $('organizationHeader').textContent=isDirector?'Current public-company boards':'Organization';
    $('privateBoardsHeader').hidden=!isDirector;
    $('voteHeader').textContent=state.category==='Capital'?'Final honoree':'Your honoree vote';
    $('scopeControls').hidden=state.category==='Capital';
    document.querySelectorAll('[data-scope]').forEach(b=>{
      b.classList.toggle('active',b.dataset.scope===state.scope);
      if(b.dataset.scope==='top5') b.textContent=`Top ${shortlistSize()} shortlist`;
    });
    renderRows(); renderReviewerStatus();
  }

  $('searchInput').oninput=e=>{state.query=e.target.value;renderRows();};
  $('nominationFilter').onchange=e=>{state.nomination=e.target.value;renderRows();};
  document.querySelectorAll('[data-scope]').forEach(b=>b.onclick=()=>{state.scope=b.dataset.scope;render();});
  $('closeDrawer').onclick=closeDetail; $('scrim').onclick=closeDetail;
  $('rubricButton').onclick=()=>{$('rubricModal').hidden=false;};
  $('closeRubric').onclick=()=>{$('rubricModal').hidden=true;};
  $('rubricModal').onclick=e=>{if(e.target===$('rubricModal')) $('rubricModal').hidden=true;};
  $('closeVoteModal').onclick=closeVote; $('saveVoteButton').onclick=saveVote; $('removeVoteButton').onclick=removeVote;
  $('voteModal').onclick=e=>{if(e.target===$('voteModal')) closeVote();};
  $('adminResultsButton').onclick=async()=>{$('adminModal').hidden=false;try{await renderAdmin();}catch(err){$('adminEmptyState').hidden=false;$('adminEmptyState').textContent=err.message;}};
  $('closeAdminModal').onclick=()=>{$('adminModal').hidden=true;};
  $('adminModal').onclick=e=>{if(e.target===$('adminModal')) $('adminModal').hidden=true;};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!$('voteModal').hidden) closeVote(); else if(!$('adminModal').hidden) $('adminModal').hidden=true; else if(!$('rubricModal').hidden) $('rubricModal').hidden=true; else closeDetail();}});

  renderRubric(); render();
})();
