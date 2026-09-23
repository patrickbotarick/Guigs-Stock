import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';
const $=id=>document.getElementById(id);
const msg=text=>$('message').textContent=text;
const cfg=window.GUIGS_SUPABASE_CONFIG||{};
const params=new URLSearchParams(location.search), hash=new URLSearchParams(location.hash.slice(1));
const authError=params.get('error_description')||hash.get('error_description')||params.get('error')||hash.get('error');
let client, recoveryReady=false;
function enableRecovery(){recoveryReady=true;$('reset-form').style.display='block';msg('Link validado. Defina sua nova senha.');}
if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(cfg.url||'')||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(cfg.publishableKey||'')){
 msg('Configuração ausente: informe URL e chave publicável em config.js.');
}else if(authError){
 msg('Link inválido ou expirado: '+authError+'. Solicite um novo link pela tela de login.');
}else{
 const recoveryLink=hash.get('type')==='recovery'||params.get('type')==='recovery'||params.has('code')||hash.has('access_token');
 client=createClient(cfg.url,cfg.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
 client.auth.onAuthStateChange((event,session)=>{
   if(event==='PASSWORD_RECOVERY'&&session)enableRecovery();
 });
 // A biblioteca processa URLs de recuperação no arranque. Também contempla recarga na mesma aba.
 void client.auth.initialize().then(async({error})=>{
   if(error){msg('Não foi possível validar o link: '+error.message);return;}
   const {data:{session},error:sessionError}=await client.auth.getSession();
   if(sessionError){msg('Erro ao verificar recuperação: '+sessionError.message);return;}
   if(!recoveryReady && recoveryLink && session)enableRecovery();
   if(!recoveryReady)msg('Nenhum link de recuperação válido nesta página. Solicite um novo pela tela de login.');
 }).catch(e=>msg('Falha ao validar recuperação: '+(e.message||'erro desconhecido')));
}
$('reset-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!client||!recoveryReady)return;
 const password=$('new-password').value,confirm=$('confirm-password').value;
 if(password.length<12){msg('A senha deve conter pelo menos 12 caracteres.');return;}
 if(password!==confirm){msg('As senhas não coincidem.');return;}
 const button=$('save-password');button.disabled=true;msg('Atualizando senha…');
 try{
  const {error}=await client.auth.updateUser({password});if(error)throw error;
  $('reset-form').reset();$('reset-form').style.display='none';recoveryReady=false;
  await client.auth.signOut();
  msg('Senha alterada. Volte ao login e entre com a nova senha.');
 }catch(e){msg('Não foi possível alterar a senha: '+(e.message||'erro desconhecido'));}
 finally{button.disabled=false;}
});
