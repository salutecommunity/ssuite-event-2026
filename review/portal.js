(() => {
  const API='https://iddzcbknnddkonrcwgpt.supabase.co/functions/v1/ssuite-review-api';
  const storageKey='ssuite-review-session-v1';
  let session=null;
  const $=id=>document.getElementById(id);
  async function request(path, options={}){
    const headers={'Content-Type':'application/json',...(options.headers||{})};
    if(session?.token) headers.Authorization=`Bearer ${session.token}`;
    const response=await fetch(`${API}${path}`,{...options,headers});
    const payload=await response.json().catch(()=>({error:'The portal returned an unreadable response.'}));
    if(!response.ok){
      if(response.status===401 && path!=='/login') clearSession();
      throw new Error(payload.error||'The portal could not complete that request.');
    }
    return payload;
  }
  function saveSession(value){session=value;localStorage.setItem(storageKey,JSON.stringify(value));}
  function clearSession(){session=null;localStorage.removeItem(storageKey);}
  function setAuthBusy(busy){$('loginButton').disabled=busy;$('loginButton').textContent=busy?'Signing in…':'Enter private review';}
  function showLogin(message=''){
    $('authGate').hidden=false;$('appShell').hidden=true;
    $('loginError').textContent=message;$('loginError').hidden=!message;
  }
  async function launch(){
    const bootstrap=await request('/bootstrap');
    window.SSUITE_DATA=bootstrap.data;
    window.SSUITE_BOOTSTRAP=bootstrap;
    window.SSUITE_API={request,get session(){return session;},logout};
    $('authGate').hidden=true;$('appShell').hidden=false;
    $('signedInIdentity').textContent=`${bootstrap.reviewer.fullName} · ${bootstrap.reviewer.email}`;
    $('adminResultsButton').hidden=!bootstrap.reviewer.isAdmin;
    const script=document.createElement('script');script.src='script.js';script.defer=true;document.body.appendChild(script);
  }
  async function login(event){
    event.preventDefault();setAuthBusy(true);$('loginError').hidden=true;
    try{
      const result=await request('/login',{method:'POST',body:JSON.stringify({
        fullName:$('loginName').value,email:$('loginEmail').value,code:$('loginCode').value,
      })});
      saveSession({token:result.token,expiresAt:result.expiresAt,reviewer:result.reviewer});
      await launch();
    }catch(error){showLogin(error.message);}finally{setAuthBusy(false);}
  }
  async function logout(){
    try{await request('/logout',{method:'POST'});}catch(_){}
    clearSession();location.reload();
  }
  $('loginForm').addEventListener('submit',login);
  $('signOutButton').addEventListener('click',logout);
  try{
    const stored=JSON.parse(localStorage.getItem(storageKey)||'null');
    if(stored?.token && new Date(stored.expiresAt)>new Date()) session=stored;
  }catch(_){clearSession();}
  if(session){
    launch().catch(error=>showLogin(error.message));
  }else showLogin();
})();
