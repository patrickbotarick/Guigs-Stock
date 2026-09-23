import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const $=id=>document.getElementById(id), msg=text=>$('message').textContent=text;
const cfg=window.GUIGS_SUPABASE_CONFIG || {};
let client;
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(cfg.url||'') || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(cfg.publishableKey||'')) {
 msg('Ainda não configurado. Preencha URL e chave publicável em config.js depois de criar o projeto de testes no Supabase. Nunca insira uma chave secreta.');
 $('enter').disabled=true;
} else {
 client=createClient(cfg.url,cfg.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
 msg('Pronto para autenticar. Conta precisa existir no Supabase Auth e ter associação ativa a uma loja.');
 client.auth.onAuthStateChange((_event,session)=>{setTimeout(()=>{ void showSession(session); },0)});
 void client.auth.getSession().then(({data})=>showSession(data.session)).catch(()=>msg('Não foi possível verificar a sessão.'));
}
async function showSession(session){
 if(!client)return;
 if(!session){$('login').style.display='block';$('session').style.display='none';$('openCloud').style.display='none';return;}
 $('login').style.display='none';$('session').style.display='block';$('identity').textContent='Conectado: '+(session.user.email||'usuário');
 const {data,error}=await client.from('guigs_memberships').select('shop_id,role,active').eq('user_id',session.user.id);
 if(error){msg('Sessão válida, mas consulta de perfil falhou: '+error.message);return;}
 if(!data?.length){$('openCloud').style.display='none';msg('Acesso ao estoque não autorizado: usuário sem vínculo ativo. Solicite ao administrador.');return;}
 const roles=data.map(m=>(m.role==='owner'?'Proprietária':'Atendente')+' · loja '+m.shop_id).join('\n');
 $('openCloud').style.display=data.length===1?'block':'none';msg('Autenticação validada. Perfil(is):\n'+roles+'\n\nO painel da nuvem é SOMENTE LEITURA. Lançamentos continuam indisponíveis.');
}
$('form').addEventListener('submit',async event=>{
 event.preventDefault();if(!client)return;
 $('enter').disabled=true;msg('Autenticando…');
 try{const {error}=await client.auth.signInWithPassword({email:$('email').value.trim(),password:$('password').value});if(error)throw error;$('password').value='';}
 catch(e){msg('Falha no login: '+(e.message||'verifique seus dados'));}
 finally{$('enter').disabled=false;}
});
$('logout').addEventListener('click',async()=>{if(client){const {error}=await client.auth.signOut();msg(error?'Erro ao sair: '+error.message:'Sessão encerrada.');}});

// Solicitar recuperação dentro do app: o redirectTo aponta à tela que efetivamente altera a senha.
$('request-reset').addEventListener('click',async()=>{
 if(!client){msg('Configure URL e chave publicável no config.js.');return;}
 const email=$('email').value.trim();
 if(!$('email').checkValidity() || !email){$('email').reportValidity();return;}
 const button=$('request-reset');button.disabled=true;msg('Solicitando link de recuperação…');
 try{
   const redirectTo=new URL('reset-password.html',window.location.href).href;
   const {error}=await client.auth.resetPasswordForEmail(email,{redirectTo});
   if(error)throw error;
   msg('Se a conta estiver cadastrada e a cota de e-mails permitir, você receberá um link. Abra-o NESTE computador com o servidor ativo.');
 }catch(e){
   const raw=String(e.message||'');
   msg(/rate limit/i.test(raw)?'Limite de e-mails do Supabase atingido. Aguarde a liberação antes de tentar novamente.':'Não foi possível solicitar a recuperação: '+raw);
 }finally{button.disabled=false;}
});
