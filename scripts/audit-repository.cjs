// Auditoria local; nunca imprime conteúdo de arquivos nem valores encontrados.
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const git = args => execFileSync('git', args, {cwd:root,maxBuffer:64*1024*1024,encoding:'utf8'});
function inspect(text) {
  const findings = [];
  const rules = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
    ['supabase-secret', /\bsb_secret_[A-Za-z0-9_-]{16,}\b/g],
    ['credential-url', /\b(?:postgres(?:ql)?|https?):\/\/[^\s:'"/]+:[^\s@'"/]+@[^\s'"<>]+/g],
    ['credential-assignment', /(?:^\s*|[;{,]\s*|\b(?:const|let|var)\s+)(?:\$env:)?['"]?(?:password|passwd|senha|secret|token|api_token|access_token|secret_key|api_secret|client_secret|service_role_key|cloudflare_api_token|github_token)['"]?\s*[=:]\s*['"][^'"\r\n]{8,}['"]/gim],
    ['jwt', /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{10,}\b/g],
    ['email-review', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  ];
  for (const [type, pattern] of rules) for (const match of text.matchAll(pattern)) {
    const value = match[0];
    // Exemplos explícitos e fixtures artificiais não são credenciais.
    if (type === 'email-review' && /@(?:test\.invalid|example\.(?:com|org)|exemplo\.(?:com|com\.br))$/i.test(value)) continue;
    if (type === 'credential-assignment' && /(?:placeholder|sua[_ -]|seu[_ -]|your[_ -]|example|exemplo|test-only|test\.invalid|CAMINHO_)/i.test(value)) continue;
    let kind = type;
    if (type === 'jwt') {
      try {kind = JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString()).role === 'anon' ? 'public-anon-jwt-review' : 'jwt';} catch {}
    }
    findings.push({type:kind,line:text.slice(0,match.index).split('\n').length});
  }
  return findings;
}
function audit() {
  const results = [];
  const sensitiveName = file => /(^|\/)(?:config\.js|\.env(?:\..+)?|[^/]+\.(?:dump|backup|p12|pfx|pem|key))$/i.test(file) && !/(?:\.example$|config\.example\.js$)/i.test(file);
  const current = git(['ls-files','-z']).split('\0').filter(Boolean);
  for (const file of current) {
    for (const hit of inspect(fs.readFileSync(path.join(root,file)).toString('utf8'))) results.push({scope:'working-tree',file,...hit});
    if (sensitiveName(file)) results.push({scope:'working-tree',file,type:'sensitive-filename',line:1});
  }
  const seen = new Set();
  const commits = git(['rev-list','--all','--max-count=100']).trim().split('\n').filter(Boolean);
  for (const commit of commits) {
    for (const hit of inspect(git(['show','-s','--format=%B',commit]))) results.push({scope:`message:${commit.slice(0,12)}`,file:'[commit message]',...hit});
    for (const entry of git(['ls-tree','-r','-z',commit]).split('\0').filter(Boolean)) {
    const [,sha,file] = entry.match(/^\d+ blob ([a-f0-9]+)\t([\s\S]+)$/) || [];
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    if (sensitiveName(file)) results.push({scope:`history:${commit.slice(0,12)}`,file,type:'sensitive-filename',line:1});
    for (const hit of inspect(git(['cat-file','blob',sha]))) results.push({scope:`history:${commit.slice(0,12)}`,file,...hit});
    }
  }
  const protectedConfig = git(['check-ignore','--no-index','config.js']).trim()==='config.js' && !current.includes('config.js');
  console.log(JSON.stringify({trackedFiles:current.length,commitsScanned:commits.length,uniqueHistoricalBlobs:seen.size,configIgnoredAndUntracked:protectedConfig,findings:results},null,2));
  if (results.length || !protectedConfig) process.exitCode=1;
}
module.exports = {inspect};
if (require.main === module) audit();
