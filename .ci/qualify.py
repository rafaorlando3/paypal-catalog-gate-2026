#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

ALLOWED_OVERLAY_PATHS = {
    ".github/workflows/qualify-paypal-offline.yml",
    ".ci/qualify.py",
    ".ci/inside.mjs",
    ".ci/pins.json",
    ".ci/README.md",
}

FORBIDDEN_ENV_KEYS = (
    "GEMINI_API_KEY",
    "PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "PAYPAL_WEBHOOK_ID",
    "OPERATOR_TOKEN_SHA256",
    "GITHUB_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "NODE_OPTIONS",
)


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def git_blob_sha1(data: bytes) -> str:
    header = f"blob {len(data)}\0".encode("ascii")
    return hashlib.sha1(header + data).hexdigest()


def validate_rel_path(rel: str) -> None:
    if not rel or rel.startswith("/") or "\\" in rel or "\x00" in rel:
        raise ValueError(f"Invalid path: {rel!r}")
    parts = rel.split("/")
    for p in parts:
        if p in ("", ".", ".."):
            raise ValueError(f"Disallowed path segment in {rel!r}")


def run_cmd(args, *, cwd=None, timeout=30.0, check=True):
    res = subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )
    if check and res.returncode != 0:
        raise RuntimeError(
            f"Command {args[0]} failed (rc={res.returncode}): {res.stderr.strip()[:400]}"
        )
    return res


def verify_directory_against_pins(root: Path, expected_files: list, expected_total_bytes: int) -> dict:
    expected_map = {item["path"]: item for item in expected_files}
    if len(expected_map) != len(expected_files):
        raise RuntimeError("Duplicate path entries in pins.json")

    discovered = []
    total_bytes = 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dir_p = Path(dirpath)
        for d in dirnames:
            dp = dir_p / d
            st = os.lstat(dp)
            if stat.S_ISLNK(st.st_mode):
                raise RuntimeError(f"Symlink directory found: {dp}")
        for fn in filenames:
            fp = dir_p / fn
            st = os.lstat(fp)
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
                raise RuntimeError(f"Non-regular file found: {fp}")
            rel = fp.relative_to(root).as_posix()
            validate_rel_path(rel)
            if rel not in expected_map:
                raise RuntimeError(f"Unexpected file in product tree: {rel}")
            exp = expected_map[rel]
            data = fp.read_bytes()
            size = len(data)
            b_sha1 = git_blob_sha1(data)
            f_sha256 = sha256_bytes(data)
            if size != exp["bytes"]:
                raise RuntimeError(f"Size mismatch for {rel}: {size} != {exp['bytes']}")
            if b_sha1 != exp["blob"]:
                raise RuntimeError(f"Blob SHA1 mismatch for {rel}: {b_sha1} != {exp['blob']}")
            if f_sha256 != exp["sha256"]:
                raise RuntimeError(f"SHA256 mismatch for {rel}: {f_sha256} != {exp['sha256']}")
            total_bytes += size
            discovered.append(rel)

    if len(discovered) != len(expected_files):
        missing = sorted(set(expected_map.keys()) - set(discovered))
        raise RuntimeError(f"Count mismatch ({len(discovered)} != {len(expected_files)}), missing: {missing[:5]}")
    if total_bytes != expected_total_bytes:
        raise RuntimeError(f"Total bytes mismatch: {total_bytes} != {expected_total_bytes}")
    return {
        "verified_files": len(discovered),
        "verified_bytes": total_bytes,
        "ok": True,
    }


def download_and_extract_npm_pkg(pkg_spec: dict, dest_node_modules: Path, deadline: float) -> dict:
    name = pkg_spec["name"]
    url = pkg_spec["url"]
    integrity = pkg_spec["integrity"]
    max_dl = int(pkg_spec["max_download_bytes"])
    max_unpacked = int(pkg_spec["max_unpacked_bytes"])
    max_members = int(pkg_spec["max_members"])

    if not integrity.startswith("sha512-"):
        raise RuntimeError(f"Unsupported SRI format for {name}: {integrity}")
    expected_b64 = integrity[len("sha512-"):]

    rem = max(5.0, deadline - time.monotonic())
    req = urllib.request.Request(url, headers={"User-Agent": "catalog-gate-ci-offline/1.0"})
    buf = bytearray()
    with urllib.request.urlopen(req, timeout=min(30.0, rem)) as resp:
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status} for {url}")
        while True:
            if time.monotonic() > deadline:
                raise RuntimeError(f"Deadline exceeded downloading {name}")
            chunk = resp.read(65536)
            if not chunk:
                break
            buf.extend(chunk)
            if len(buf) > max_dl:
                raise RuntimeError(f"Download exceeded max_download_bytes ({max_dl}) for {name}")

    raw_tgz = bytes(buf)
    actual_b64 = base64.b64encode(hashlib.sha512(raw_tgz).digest()).decode("ascii")
    if actual_b64 != expected_b64:
        raise RuntimeError(f"SRI sha512 mismatch for {name}: {actual_b64} != {expected_b64}")

    pkg_out = dest_node_modules / name
    if pkg_out.exists():
        raise RuntimeError(f"Destination already exists: {pkg_out}")
    pkg_out.mkdir(parents=True, exist_ok=False)

    tgz_tmp = dest_node_modules / f".{name}.tgz"
    tgz_tmp.write_bytes(raw_tgz)

    members_count = 0
    unpacked_bytes = 0
    try:
        with tarfile.open(tgz_tmp, mode="r|gz") as tf:
            for member in tf:
                if time.monotonic() > deadline:
                    raise RuntimeError(f"Deadline exceeded extracting {name}")
                members_count += 1
                if members_count > max_members:
                    raise RuntimeError(f"Member count exceeded {max_members} for {name}")
                mname = member.name
                if not mname or mname.startswith("/") or "\\" in mname or "\x00" in mname:
                    raise RuntimeError(f"Unsafe tar member name in {name}: {mname!r}")
                norm_parts = mname.split("/")
                if any(p in ("..", "") for p in norm_parts if p != ""):
                    if ".." in norm_parts:
                        raise RuntimeError(f"Path traversal in tar member {mname!r}")
                if not (mname == "package" or mname.startswith("package/")):
                    raise RuntimeError(f"Tar member outside package/ prefix: {mname!r}")
                if member.issym() or member.islnk() or member.ischr() or member.isblk() or member.isfifo() or member.isdev():
                    raise RuntimeError(f"Disallowed special/link tar member in {name}: {mname!r}")
                rel_inside = mname[len("package"):].lstrip("/")
                if not rel_inside:
                    continue
                validate_rel_path(rel_inside)
                target_path = (pkg_out / rel_inside).resolve()
                if not str(target_path).startswith(str(pkg_out.resolve()) + os.sep):
                    raise RuntimeError(f"Resolved path escaped package root: {target_path}")
                if member.isdir():
                    target_path.mkdir(parents=True, exist_ok=True)
                elif member.isreg():
                    if member.size < 0:
                        raise RuntimeError(f"Negative member size in {name}: {mname!r}")
                    unpacked_bytes += member.size
                    if unpacked_bytes > max_unpacked:
                        raise RuntimeError(f"Unpacked bytes exceeded {max_unpacked} for {name}")
                    target_path.parent.mkdir(parents=True, exist_ok=True)
                    fobj = tf.extractfile(member)
                    if fobj is None:
                        raise RuntimeError(f"Unable to read regular member {mname!r}")
                    written = 0
                    with target_path.open("wb") as out_f:
                        while True:
                            chunk = fobj.read(65536)
                            if not chunk:
                                break
                            written += len(chunk)
                            if written > member.size:
                                raise RuntimeError(f"Member wrote more than declared size: {mname!r}")
                            out_f.write(chunk)
                    if written != member.size:
                        raise RuntimeError(f"Short read on tar member {mname!r}: {written} != {member.size}")
                    os.chmod(target_path, 0o644)
                else:
                    raise RuntimeError(f"Unsupported tar member type for {mname!r}")
    finally:
        if tgz_tmp.exists():
            tgz_tmp.unlink()

    return {
        "name": name,
        "version": pkg_spec["version"],
        "download_bytes": len(raw_tgz),
        "sri_sha512": integrity,
        "tgz_sha256": sha256_bytes(raw_tgz),
        "members_count": members_count,
        "unpacked_bytes": unpacked_bytes,
    }


def emit_framed_report(report: dict) -> None:
    raw = json.dumps(report, indent=2, sort_keys=True, ensure_ascii=True).encode("utf-8")
    digest = sha256_bytes(raw)
    sys.stdout.write(f"===BEGIN_PAYPAL230_QUALIFICATION_REPORT_SHA256:{digest}===\n")
    sys.stdout.write(raw.decode("utf-8") + "\n")
    sys.stdout.write(f"===END_PAYPAL230_QUALIFICATION_REPORT_SHA256:{digest}===\n")
    sys.stdout.flush()


def main() -> int:
    t0 = time.monotonic()
    started_utc = utc_now()
    repo_root = Path(__file__).resolve().parent.parent
    pins_path = repo_root / ".ci" / "pins.json"

    report = {
        "schema": "catalog-gate-ci-offline-report-v1",
        "started_at_utc": started_utc,
        "ok": False,
        "failure_reason": None,
        "stages": {},
        "cleanup": {},
    }

    if sys.platform != "linux":
        report["failure_reason"] = f"Forbidden platform: {sys.platform} (Linux required)"
        emit_framed_report(report)
        return 1
    if os.environ.get("GITHUB_ACTIONS") != "true":
        report["failure_reason"] = "GITHUB_ACTIONS must be exact string 'true'"
        emit_framed_report(report)
        return 1

    run_id = os.environ.get("GITHUB_RUN_ID", "")
    run_attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    if not re.fullmatch(r"[0-9]+", run_id) or not re.fullmatch(r"[0-9]+", run_attempt):
        report["failure_reason"] = "GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be digits only"
        emit_framed_report(report)
        return 1

    container_name = f"cg-{run_id}-{run_attempt}"
    report["run_identity"] = {
        "container_name": container_name,
        "github_run_id": run_id,
        "github_run_attempt": run_attempt,
        "ci_head_sha": os.environ.get("GITHUB_SHA", ""),
    }

    pins = json.loads(pins_path.read_text(encoding="utf-8"))
    pins_sha256 = sha256_file(pins_path)
    budgets = pins["budgets"]
    total_deadline = t0 + float(budgets["total_seconds"])
    reserve_seconds = float(budgets["closure_reserve_seconds"])
    execution_deadline = total_deadline - reserve_seconds

    workspace_dir = None
    container_created = False

    try:
        # Stage 1: Preflight & exact 55-blob materialization (45s)
        s1_start = time.monotonic()
        s1_deadline = min(execution_deadline, s1_start + float(budgets["preflight_seconds"]))

        prod_cfg = pins["product"]
        exp_commit = prod_cfg["commit"]
        exp_tree = prod_cfg["tree"]
        exp_blobs_count = int(prod_cfg["blobs"])
        exp_total_bytes = int(prod_cfg["total_bytes"])
        exp_files = prod_cfg["files"]

        if len(exp_files) != exp_blobs_count:
            raise RuntimeError(f"pins.json files length ({len(exp_files)}) != blobs ({exp_blobs_count})")

        head_sha = run_cmd(["git", "rev-parse", "HEAD"], cwd=repo_root, timeout=10).stdout.strip()
        tree_of_commit = run_cmd(["git", "rev-parse", f"{exp_commit}^{{tree}}"], cwd=repo_root, timeout=10).stdout.strip()
        if tree_of_commit != exp_tree:
            raise RuntimeError(f"Commit {exp_commit} tree mismatch: {tree_of_commit} != {exp_tree}")

        ls_res = run_cmd(["git", "ls-tree", "-r", "--long", exp_commit], cwd=repo_root, timeout=15)
        ls_entries = {}
        for line in ls_res.stdout.splitlines():
            if not line.strip():
                continue
            meta, path_str = line.split("\t", 1)
            validate_rel_path(path_str)
            parts = meta.split()
            mode_str, obj_type, blob_sha, size_str = parts[0], parts[1], parts[2], parts[3]
            if obj_type != "blob":
                raise RuntimeError(f"Non-blob git object in product tree: {path_str} ({obj_type})")
            ls_entries[path_str] = {
                "mode": mode_str,
                "blob": blob_sha,
                "bytes": int(size_str),
            }

        if len(ls_entries) != exp_blobs_count:
            raise RuntimeError(f"git ls-tree count {len(ls_entries)} != {exp_blobs_count}")

        # Verify HEAD overlay allowlist against product commit
        head_ls = run_cmd(["git", "ls-tree", "-r", "--name-only", head_sha], cwd=repo_root, timeout=15).stdout.splitlines()
        extra_in_head = sorted(set(head_ls) - set(ls_entries.keys()))
        disallowed_overlay = [p for p in extra_in_head if p not in ALLOWED_OVERLAY_PATHS]
        if disallowed_overlay:
            raise RuntimeError(f"Disallowed overlay paths in HEAD: {disallowed_overlay}")

        workspace_dir = Path(tempfile.mkdtemp(prefix=f"{container_name}-"))
        os.chmod(workspace_dir, 0o755)
        product_dir = workspace_dir / "product"
        ci_dir = workspace_dir / "ci"
        vendor_dir = workspace_dir / "vendor"
        evidence_dir = workspace_dir / "evidence"
        product_dir.mkdir()
        ci_dir.mkdir()
        vendor_dir.mkdir()
        evidence_dir.mkdir(mode=0o777)
        os.chmod(evidence_dir, 0o777)

        for item in exp_files:
            if time.monotonic() > s1_deadline:
                raise RuntimeError("Stage 1 preflight deadline exceeded")
            rel = item["path"]
            validate_rel_path(rel)
            if rel not in ls_entries:
                raise RuntimeError(f"Pinned file missing from git tree: {rel}")
            git_meta = ls_entries[rel]
            if item["mode"] != "100644" or git_meta["mode"] != "100644":
                raise RuntimeError(f"Mode must be 100644 for {rel}: pin={item['mode']} git={git_meta['mode']}")
            if item["blob"] != git_meta["blob"]:
                raise RuntimeError(f"Blob SHA mismatch for {rel}: pin={item['blob']} git={git_meta['blob']}")
            if int(item["bytes"]) != git_meta["bytes"]:
                raise RuntimeError(f"Byte size mismatch for {rel}")

            cat_p = subprocess.run(
                ["git", "cat-file", "blob", item["blob"]],
                cwd=str(repo_root),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=10,
                check=True,
            )
            raw = cat_p.stdout
            if len(raw) != int(item["bytes"]):
                raise RuntimeError(f"cat-file byte length mismatch for {rel}")
            if git_blob_sha1(raw) != item["blob"]:
                raise RuntimeError(f"Computed blob SHA1 mismatch for {rel}")
            if sha256_bytes(raw) != item["sha256"]:
                raise RuntimeError(f"Computed SHA256 mismatch for {rel}")

            dest = product_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(raw)
            os.chmod(dest, 0o444)

        pre_audit = verify_directory_against_pins(product_dir, exp_files, exp_total_bytes)

        # Copy CI runtime files into read-only ci mount directory
        shutil.copy2(repo_root / ".ci" / "inside.mjs", ci_dir / "inside.mjs")
        shutil.copy2(pins_path, ci_dir / "pins.json")
        os.chmod(ci_dir / "inside.mjs", 0o444)
        os.chmod(ci_dir / "pins.json", 0o444)

        report["stages"]["preflight"] = {
            "ok": True,
            "duration_seconds": round(time.monotonic() - s1_start, 3),
            "product_commit": exp_commit,
            "product_tree": exp_tree,
            "ci_overlay_commit": head_sha,
            "overlay_files": extra_in_head,
            "pins_json_sha256": pins_sha256,
            "inside_mjs_sha256": sha256_file(ci_dir / "inside.mjs"),
            "qualify_py_sha256": sha256_file(Path(__file__).resolve()),
            "workflow_yml_sha256": sha256_file(repo_root / ".github" / "workflows" / "qualify-paypal-offline.yml"),
            "pre_audit": pre_audit,
        }

        # Stage 2: Toolchain pull + 2 NPM tarballs verified extraction (120s)
        s2_start = time.monotonic()
        s2_deadline = min(execution_deadline, s2_start + float(budgets["toolchain_seconds"]))
        tc = pins["toolchain"]
        nm_dir = vendor_dir / "node_modules"
        nm_dir.mkdir(parents=True, exist_ok=True)

        npm_reports = []
        for pkg_spec in tc["npm"]:
            npm_reports.append(download_and_extract_npm_pkg(pkg_spec, nm_dir, s2_deadline))

        for sib in ("playwright", "playwright-core"):
            if not (nm_dir / sib / "package.json").is_file():
                raise RuntimeError(f"Missing extracted sibling package: {sib}")

        rem_pull = max(5.0, s2_deadline - time.monotonic())
        run_cmd(
            ["docker", "pull", "--platform", tc["platform"], tc["image"]],
            timeout=rem_pull,
        )
        img_inspect_raw = run_cmd(["docker", "image", "inspect", tc["image"]], timeout=15).stdout
        img_inspect = json.loads(img_inspect_raw)[0]
        repo_digests = img_inspect.get("RepoDigests") or []
        if tc["image"] not in repo_digests:
            raise RuntimeError(f"Pulled image RepoDigests {repo_digests} does not contain pinned {tc['image']}")

        report["stages"]["toolchain"] = {
            "ok": True,
            "duration_seconds": round(time.monotonic() - s2_start, 3),
            "image": tc["image"],
            "image_id": img_inspect.get("Id"),
            "repo_digests": repo_digests,
            "architecture": img_inspect.get("Architecture"),
            "os": img_inspect.get("Os"),
            "npm_packages": npm_reports,
        }

        # Create single container (never recreate on timeout)
        existing = run_cmd(
            ["docker", "ps", "-aq", "--filter", f"name=^/{container_name}$", "--filter", f"label=cg.run={container_name}"],
            timeout=10,
        ).stdout.strip()
        if existing:
            raise RuntimeError(f"Container {container_name} already exists before create")

        rt = pins["runtime"]
        inside_allowlist_env = [
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME=/tmp/cg-home",
            "TMPDIR=/tmp/cg-tmp",
            "LANG=C.UTF-8",
            f"MODE={rt['mode']}",
            f"PORT={rt['port']}",
            f"BASE=http://localhost:{rt['port']}",
            f"BASE_URL=http://localhost:{rt['port']}",
            "DATA_DIR=/tmp/cg-data-init",
            "NODE_PATH=/vendor/node_modules",
            f"PLAYWRIGHT_BROWSERS_PATH={tc['browser_path']}",
        ]

        create_args = [
            "docker", "create",
            "--name", container_name,
            "--label", f"cg.run={container_name}",
            "--platform", tc["platform"],
            "--network", "none",
            "--init",
            "--read-only",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--ipc", "private",
            "--shm-size", str(rt["shm_bytes"]),
            "--cpus", str(rt["cpus"]),
            "--memory", str(rt["memory_bytes"]),
            "--pids-limit", str(rt["pids_limit"]),
            "--tmpfs", f"/tmp:rw,nosuid,size={rt['tmpfs_bytes']},mode=1777",
            "--mount", f"type=bind,src={product_dir},dst=/product,readonly",
            "--mount", f"type=bind,src={ci_dir},dst=/ci,readonly",
            "--mount", f"type=bind,src={vendor_dir},dst=/vendor,readonly",
            "--mount", f"type=bind,src={evidence_dir},dst=/evidence",
            "--workdir", "/product",
            tc["image"],
            "/usr/bin/env", "-i",
            *inside_allowlist_env,
            "node", "/ci/inside.mjs",
        ]
        container_id = run_cmd(create_args, timeout=20).stdout.strip()
        container_created = True

        pre_inspect = json.loads(run_cmd(["docker", "inspect", container_name], timeout=10).stdout)[0]
        hc = pre_inspect.get("HostConfig", {})
        mounts = pre_inspect.get("Mounts", [])
        mount_summary = [
            {"Destination": m.get("Destination"), "RW": m.get("RW"), "Type": m.get("Type")}
            for m in mounts
        ]
        if hc.get("NetworkMode") != "none":
            raise RuntimeError(f"Container NetworkMode is {hc.get('NetworkMode')}, expected 'none'")
        if not hc.get("ReadonlyRootfs"):
            raise RuntimeError("Container ReadonlyRootfs is not True")
        for m in mount_summary:
            if m["Destination"] in ("/product", "/ci", "/vendor") and m["RW"] is not False:
                raise RuntimeError(f"Mount {m['Destination']} must be read-only")
            if m["Destination"] == "/evidence" and m["RW"] is not True:
                raise RuntimeError("Mount /evidence must be read-write")

        report["stages"]["container_profile_before_start"] = {
            "container_id": container_id,
            "network_mode": hc.get("NetworkMode"),
            "readonly_rootfs": hc.get("ReadonlyRootfs"),
            "cap_drop": hc.get("CapDrop"),
            "security_opt": hc.get("SecurityOpt"),
            "ipc_mode": hc.get("IpcMode"),
            "shm_size": hc.get("ShmSize"),
            "nano_cpus": hc.get("NanoCpus"),
            "memory": hc.get("Memory"),
            "pids_limit": hc.get("PidsLimit"),
            "mounts": mount_summary,
        }

        # Start and wait for inside execution (isolation 15s + unit 90s + C3a 90s + U1 90s = 285s max)
        s_exec_start = time.monotonic()
        stage_exec_budget = (
            float(budgets["isolation_seconds"])
            + float(budgets["unit_seconds"])
            + float(budgets["e2e_C3a_seconds"])
            + float(budgets["e2e_U1_seconds"])
        )
        exec_wait_deadline = min(execution_deadline, s_exec_start + stage_exec_budget)

        run_cmd(["docker", "start", container_name], timeout=15)
        wait_timeout = max(5.0, exec_wait_deadline - time.monotonic())
        timed_out_waiting = False
        try:
            wait_res = run_cmd(["docker", "wait", container_name], timeout=wait_timeout, check=False)
            wait_rc_str = wait_res.stdout.strip()
        except subprocess.TimeoutExpired:
            timed_out_waiting = True
            wait_rc_str = "TIMEOUT"
            run_cmd(["docker", "kill", container_name], timeout=15, check=False)
            run_cmd(["docker", "wait", container_name], timeout=15, check=False)

        post_inspect = json.loads(run_cmd(["docker", "inspect", container_name], timeout=10).stdout)[0]
        state_obj = post_inspect.get("State", {})
        terminal_closure_utc = utc_now()

        # Remove owned container before audit
        run_cmd(["docker", "rm", "-f", container_name], timeout=20, check=False)
        container_created = False
        remaining_containers = run_cmd(
            ["docker", "ps", "-aq", "--filter", f"name=^/{container_name}$", "--filter", f"label=cg.run={container_name}"],
            timeout=10,
        ).stdout.strip()

        report["stages"]["container_terminal_state"] = {
            "timed_out_waiting": timed_out_waiting,
            "wait_output": wait_rc_str,
            "status": state_obj.get("Status"),
            "running": state_obj.get("Running"),
            "oom_killed": state_obj.get("OOMKilled"),
            "dead": state_obj.get("Dead"),
            "exit_code": state_obj.get("ExitCode"),
            "error": state_obj.get("Error"),
            "started_at": state_obj.get("StartedAt"),
            "finished_at": state_obj.get("FinishedAt"),
            "observed_closed_at_utc": terminal_closure_utc,
        }
        report["cleanup"]["container_removed_before_audit"] = (remaining_containers == "")

        # Stage 7: Post-execution audit of 55 product blobs & evidence collection (30s)
        s7_start = time.monotonic()
        post_audit = verify_directory_against_pins(product_dir, exp_files, exp_total_bytes)
        inside_summary_path = evidence_dir / "inside-summary.json"
        inside_summary = None
        if inside_summary_path.is_file():
            raw_inside = inside_summary_path.read_bytes()
            if len(raw_inside) > int(pins["evidence"]["max_total_bytes"]):
                raise RuntimeError("inside-summary.json exceeded max_total_bytes")
            inside_summary = json.loads(raw_inside.decode("utf-8"))

        report["stages"]["inside"] = inside_summary
        report["stages"]["post_audit"] = {
            "ok": True,
            "duration_seconds": round(time.monotonic() - s7_start, 3),
            "audit_started_after_closure_utc": utc_now(),
            "post_audit": post_audit,
            "container_removed_confirmed": (remaining_containers == ""),
        }

        # Final strict fail-closed verification
        if timed_out_waiting:
            raise RuntimeError("Container execution timed out")
        if state_obj.get("Running") is not False:
            raise RuntimeError("Container still running at inspect")
        if state_obj.get("OOMKilled") is not False:
            raise RuntimeError("Container was OOMKilled")
        if state_obj.get("ExitCode") != 0:
            raise RuntimeError(f"Container exited with non-zero code: {state_obj.get('ExitCode')}")
        if not state_obj.get("FinishedAt") or state_obj.get("FinishedAt").startswith("0001-"):
            raise RuntimeError("Container FinishedAt timestamp invalid")
        if remaining_containers != "":
            raise RuntimeError("Owned container still present after rm")
        if not inside_summary or inside_summary.get("ok") is not True:
            raise RuntimeError(f"inside.mjs reported failure: {inside_summary.get('failure_reason') if inside_summary else 'missing summary'}")

        report["ok"] = True
        report["finished_at_utc"] = utc_now()
        report["total_duration_seconds"] = round(time.monotonic() - t0, 3)
        emit_framed_report(report)
        return 0

    except Exception as exc:
        report["ok"] = False
        report["failure_reason"] = str(exc)
        report["finished_at_utc"] = utc_now()
        report["total_duration_seconds"] = round(time.monotonic() - t0, 3)
        if workspace_dir and (workspace_dir / "evidence" / "inside-summary.json").is_file() and not report["stages"].get("inside"):
            try:
                report["stages"]["inside"] = json.loads(
                    (workspace_dir / "evidence" / "inside-summary.json").read_text(encoding="utf-8")
                )
            except Exception:
                pass
        emit_framed_report(report)
        return 1
    finally:
        if container_created:
            try:
                subprocess.run(["docker", "rm", "-f", container_name], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=False)
            except Exception:
                pass
        if workspace_dir and workspace_dir.exists():
            shutil.rmtree(workspace_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
