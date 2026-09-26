import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const $ = (id) => document.getElementById(id);

const msg = (text) => ($("message").textContent = text);

const cfg = window.GUIGS_SUPABASE_CONFIG || {};

let client = null;

// ============================================================
// HELPERS
// ============================================================

function isNetworkFailure(error) {
  const message = String(error?.message || error || "");

  return (
    !navigator.onLine ||
    /failed to fetch|networkerror|network request failed/i.test(message)
  );
}

function setOfflineMessage() {
  msg(
    "Você está sem conexão com a internet. " +
      "O Guig's Stock continua disponível neste dispositivo, " +
      "mas o login e os dados em nuvem precisam de conexão.",
  );
}

function updateConnectionState() {
  if (!navigator.onLine) {
    $("enter").disabled = true;

    setOfflineMessage();

    return;
  }

  $("enter").disabled = false;
}

// ============================================================
// CONFIGURAÇÃO / CLIENTE SUPABASE
// ============================================================

if (
  !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(cfg.url || "") ||
  !/^sb_publishable_[A-Za-z0-9_-]+$/.test(cfg.publishableKey || "")
) {
  msg(
    "Ainda não configurado. " +
      "Preencha URL e chave publicável em config.js " +
      "depois de criar o projeto no Supabase. " +
      "Nunca insira uma chave secreta.",
  );

  $("enter").disabled = true;
} else {
  client = createClient(cfg.url, cfg.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  if (!navigator.onLine) {
    setOfflineMessage();
  } else {
    msg("Use sua conta autorizada para acessar o estoque.");
  }

  client.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => {
      void showSession(session);
    }, 0);
  });

  void client.auth
    .getSession()
    .then(({ data }) => showSession(data.session))
    .catch((error) => {
      if (isNetworkFailure(error)) {
        setOfflineMessage();

        return;
      }

      msg("Não foi possível verificar a sessão.");
    });
}

// ============================================================
// SESSÃO
// ============================================================

async function showSession(session) {
  if (!client) {
    return;
  }

  if (!session) {
    $("login").style.display = "block";

    if (!navigator.onLine) {
      setOfflineMessage();
    }

    return;
  }

  $("login").style.display = "none";

  msg("Acesso confirmado. Entrando no Guig's Stock…");

  let membershipResult;

  try {
    membershipResult = await client
      .from("guigs_memberships")
      .select("shop_id,role,active")
      .eq("user_id", session.user.id);
  } catch (error) {
    if (isNetworkFailure(error)) {
      

      setOfflineMessage();

      return;
    }

    msg("Não foi possível consultar seu perfil.");

    return;
  }

  const { data, error } = membershipResult;

  if (error) {
    

    if (isNetworkFailure(error)) {
      setOfflineMessage();

      return;
    }

    msg(
      "Sessão válida, mas não foi possível consultar seu perfil: " +
        error.message,
    );

    return;
  }

  if (!data?.length) {
    

    msg(
      "Acesso ao estoque não autorizado: " +
        "usuário sem vínculo ativo. " +
        "Solicite ao administrador.",
    );

    return;
  }

  const activeMemberships =
  data.filter(
    membership =>
      membership.active !== false
  );


if (!activeMemberships.length) {

  $('login').style.display =
    'block';


  msg(
    'Seu acesso ao estoque não está ativo. '
    + 'Solicite ao administrador.'
  );


  return;
}


if (activeMemberships.length > 1) {

  $('login').style.display =
    'block';


  msg(
    'Esta conta possui acesso a mais de uma loja. '
    + 'A seleção de loja ainda não está disponível.'
  );


  return;
}


msg(
  'Acesso confirmado. Entrando no Guig\'s Stock…'
);


window.location.replace(
  'index.html'
);
}

// ============================================================
// LOGIN
// ============================================================

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!client) {
    return;
  }

  if (!navigator.onLine) {
    setOfflineMessage();

    return;
  }

  $("enter").disabled = true;

  msg("Autenticando…");

  try {
    const { error } = await client.auth.signInWithPassword({
      email: $("email").value.trim(),

      password: $("password").value,
    });

    if (error) {
      throw error;
    }

    $("password").value = "";
  } catch (error) {
    if (isNetworkFailure(error)) {
      setOfflineMessage();
    } else {
      msg("Falha no login: " + (error.message || "verifique seus dados"));
    }
  } finally {
    $("enter").disabled = !navigator.onLine;
  }
});

// ============================================================
// LOGOUT
// ============================================================



// ============================================================
// RECUPERAÇÃO DE SENHA
// ============================================================

$("request-reset").addEventListener("click", async () => {
  if (!client) {
    msg("Configure URL e chave publicável no config.js.");

    return;
  }

  if (!navigator.onLine) {
    setOfflineMessage();

    return;
  }

  const email = $("email").value.trim();

  if (!$("email").checkValidity() || !email) {
    $("email").reportValidity();

    return;
  }

  const button = $("request-reset");

  button.disabled = true;

  msg("Solicitando link de recuperação…");

  try {
    const redirectTo = new URL("reset-password.html", window.location.href)
      .href;

    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo,
    });

    if (error) {
      throw error;
    }

    msg(
      "Se a conta estiver cadastrada e a cota de e-mails permitir, " +
        "você receberá um link. " +
        "Abra-o neste computador com o servidor ativo.",
    );
  } catch (error) {
    if (isNetworkFailure(error)) {
      setOfflineMessage();
    } else {
      const raw = String(error.message || "");

      msg(
        /rate limit/i.test(raw)
          ? "Limite de e-mails do Supabase atingido. " +
              "Aguarde a liberação antes de tentar novamente."
          : "Não foi possível solicitar a recuperação: " + raw,
      );
    }
  } finally {
    button.disabled = false;
  }
});

// ============================================================
// CONECTIVIDADE
// ============================================================

window.addEventListener("offline", () => {
  updateConnectionState();

  
});

window.addEventListener("online", async () => {
  $("enter").disabled = false;

  msg("Conexão restaurada. Verificando sua sessão…");

  if (!client) {
    return;
  }

  try {
    const { data } = await client.auth.getSession();

    await showSession(data.session);
  } catch (error) {
    if (isNetworkFailure(error)) {
      setOfflineMessage();
    } else {
      msg("Conexão restaurada. " + "Você já pode tentar entrar novamente.");
    }
  }
});

// ============================================================
// ESTADO INICIAL
// ============================================================

updateConnectionState();
