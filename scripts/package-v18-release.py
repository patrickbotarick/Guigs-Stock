"""Empacota a v1.8 a partir de um SHA revisado. Não lê config.js nem publica."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile
from zipfile import ZIP_STORED, ZipFile, ZipInfo


REPO = Path(__file__).resolve().parents[1]
APPROVED = "229a7a7d4d2a136deb254b037fcccf8b4d6a079c"
BUILDER = "scripts/build.cjs"
BASELINE = "20261111130126_nullable_stock_thresholds.sql"
DOCS = ("docs/V1.8_HOMOLOGACAO_INTEGRADA.md", "docs/V1.8_RELEASE_READINESS.md")
MIGRATIONS = {
    "20261111164204_integrated_fridge_transfers.sql": "9f8a4d4a33173a276411bc716a839b393cf825ffadd9c7394c786e3498d9fc05",
    "20261111173911_blind_grouped_inventory.sql": "6579b74672474528979895875ccfa471078f5463dee3846e54186638cab3fcc4",
    "20261111181130_smart_shopping_list.sql": "50558ecd22781e907f1581242b863128193236824af291de5113cff566720c1a",
    "20261111183754_fridge_slot_moves_history.sql": "30e61b237e2270aa62f631821431f2d452a42372f2a859e918042864f53ab6f4",
}
SECRET = re.compile(
    rb"(?:sb_secret_|ghp_|github_pat_|sk_live_)[A-Za-z0-9_-]{16,}"
    rb"|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
    rb"|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}"
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def git(*args):
    return subprocess.check_output(["git", *args], cwd=REPO)


def blob(commit, name):
    return git("cat-file", "blob", f"{commit}:{name}")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def public_path(name):
    parts = PurePosixPath(name).parts
    return bool(re.fullmatch(r"[A-Za-z0-9_./-]+", name)) and all(
        not part.startswith(".") and part != "config.js" for part in parts
    ) and (len(parts) == 1 or (len(parts) == 2 and parts[0] == "icons"))


def package(commit, output):
    require(re.fullmatch(r"[0-9a-f]{40}", commit), "Informe o SHA completo em minúsculas.")
    require(git("rev-parse", "--verify", commit + "^{commit}").decode().strip() == commit, "SHA inválido.")
    git("merge-base", "--is-ancestor", APPROVED, commit)
    require(output.is_absolute(), "Use um diretório de saída absoluto, fora de Git.")
    output = output.resolve(strict=True)
    require(output.is_dir() and not any((p / ".git").exists() for p in (output, *output.parents)),
            "O destino deve ser um diretório existente, externo a Git.")
    name = f"Guigs-Stock-v1.8-PWA-v20-R2-{commit[:7]}-candidata.zip"
    archive, checksum = output / name, output / (name + ".sha256")
    require(not archive.exists() and not checksum.exists(), "Artefatos já existem; use outro diretório.")

    builder = blob(commit, BUILDER)
    require(builder == blob(APPROVED, BUILDER), "O builder difere do aprovado para a v1.8.")
    with tempfile.TemporaryDirectory(prefix="build-check-", dir=output) as temp:
        scratch = Path(temp)
        tool = scratch / BUILDER
        tool.parent.mkdir()
        tool.write_bytes(builder)
        public = json.loads(subprocess.check_output([
            "node", "-e", "console.log(JSON.stringify(require(process.argv[1]).files))", str(tool),
        ]))
        require(len(public) == len(set(public)) and all(map(public_path, public)), "Allowlist pública inválida.")
        included = {}
        for rel in [*public, BUILDER, "config.example.js"]:
            included[rel] = blob(commit, rel)
            require(included[rel] == blob(APPROVED, rel), f"Fonte pública mudou desde a aprovação: {rel}")
        for doc in DOCS:
            included[doc] = blob(commit, doc)

        entries = []
        for filename, approved_hash in MIGRATIONS.items():
            rel = "supabase/migrations/" + filename
            raw = blob(commit, rel)
            require(raw == blob(APPROVED, rel), f"Migration mudou: {filename}")
            # Reproduz os bytes CRLF conferidos no ensaio Windows, a partir do blob Git.
            contents = raw.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            require(digest(contents) == approved_hash, f"SHA-256 da migration divergiu: {filename}")
            included[rel] = contents
            entries.append({"file": filename, "sha256": approved_hash, "gitBlobSha256": digest(raw)})

        manifest = json.loads(included["manifest.webmanifest"])
        require(manifest["display"] == "standalone" and len(manifest["icons"]) == 3
                and all(icon["src"] in public for icon in manifest["icons"]), "Manifest incompatível.")
        require(b'const CACHE_NAME = "guigs-stock-shell-v20";' in included["service-worker.js"], "Cache não é v20.")
        included["RELEASE.json"] = (json.dumps({
            "release": "Guig’s Stock v1.8 / PWA v20", "round": "2", "commit": commit,
            "frontendReference": APPROVED, "branch": "feature/v1.8d-fridge-map-polish",
            "requiredDatabaseBaseline": BASELINE, "cache": "guigs-stock-shell-v20",
            "classification": "CANDIDATE_FOR_HOMOLOGATION", "deploymentAuthorized": False,
            "migrations": entries,
        }, ensure_ascii=False, indent=2) + "\n").encode()
        for rel, contents in included.items():
            require(rel.endswith(".png") or not SECRET.search(contents), f"Possível segredo no pacote: {rel}")
        included["SHA256SUMS.txt"] = "".join(f"{digest(included[rel])}  {rel}\n" for rel in sorted(included)).encode()

        # Sem timestamps locais, compressão variável ou dependência da ordem do filesystem.
        with ZipFile(archive, "x", compression=ZIP_STORED) as zip_file:
            for rel in sorted(included):
                info = ZipInfo(rel, (1980, 1, 1, 0, 0, 0))
                info.create_system, info.external_attr = 3, 0o100644 << 16
                zip_file.writestr(info, included[rel])
        with ZipFile(archive) as zip_file:
            require(zip_file.namelist() == sorted(included), "Arquivos inesperados no ZIP.")
            for rel, contents in included.items():
                require(digest(zip_file.read(rel)) == digest(contents), f"Integridade do ZIP: {rel}")
            zip_file.extractall(scratch)

        subprocess.check_output(["node", str(tool)], cwd=scratch, env={**os.environ,
            "GUIGS_SUPABASE_URL": "https://build-check.supabase.co",
            "GUIGS_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_BUILD_CHECK_ONLY",
        })
        dist = scratch / "dist"
        built = {p.relative_to(dist).as_posix(): digest(p.read_bytes()) for p in dist.rglob("*") if p.is_file()}
        require(set(built) == set(public) | {"config.js"}, "Build extraído não corresponde à allowlist.")
        require(all(built[rel] == digest(included[rel]) for rel in public), "Build alterou uma fonte pública.")

    sha256 = digest(archive.read_bytes())
    with checksum.open("x", encoding="utf-8", newline="\n") as out:
        out.write(f"{sha256}  {name}\n")
    return {"archive": str(archive), "sha256": sha256, "commit": commit, "entries": len(included), "build": built}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("commit")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(json.dumps(package(args.commit, args.output), ensure_ascii=False, indent=2))
