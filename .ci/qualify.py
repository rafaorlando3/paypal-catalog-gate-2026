#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import re
import shutil
import signal
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

ALLOWED_EVIDENCE_FILES = (
    "unit-tap.stdout.log",
    "unit-tap.stderr.log",
    "e2e-c3a-server.stdout.log",
    "e2e-c3a-server.stderr.log",
    "e2e-c3a.stdout.log",
    "e2e-c3a.stderr.log",
    "e2e-u1-server.stdout.log",
    "e2e-u1-server.stderr.log",
    "e2e-u1.stdout.log",
    "e2e-u1.stderr.log",
    "inside-summary.json",
)

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


class DeadlineExpiredError(RuntimeError):
    pass


_ACTIVE_DEADLINE = None


def set_active_deadline(deadline: float) -> None:
    global _ACTIVE_DEADLINE
    _ACTIVE_DEADLINE = deadline


def remaining(deadline: float = None, cap: float = None) -> float:
    target = _ACTIVE_DEADLINE if deadline is None else deadline
    if target is None:
        return float(cap) if cap is not None else 30.0
    rem = target - time.monotonic()
    if rem <= 0.0:
        raise DeadlineExpiredError("Stage or global monotonic deadline expired")
    if cap is not None:
        return min(float(cap), rem)
    return rem


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


def run_cmd(args, *, cwd=None, timeout=30.0, deadline=None, check=True):
    eff_timeout = remaining(deadline, timeout)
    res = subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=eff_timeout,
        check=False,
    )
    if check and res.returncode != 0:
        raise RuntimeError(
            f"Command {args[0]} failed (rc={res.returncode}): {res.stderr.strip()[:400]}"
        )
    return res


def verify_directory_against_pins(root: Path, expected_files: list, expected_total_bytes: int, deadline: float = None) -> dict:
    expected_map = {item["path"]: item for item in expected_files}
    if len(expected_map) != len(expected_files):
        raise RuntimeError("Duplicate path entries in pins.json")

    discovered = []
    total_bytes = 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        remaining(deadline)
        dir_p = Path(dirpath)
        for d in dirnames:
            dp = dir_p / d
            st = os.lstat(dp)
            if stat.S_ISLNK(st.st_mode):
                raise RuntimeError(f"Symlink directory found: {dp}")
        for fn in filenames:
            remaining(deadline)
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

    req = urllib.request.Request(url, headers={"User-Agent": "catalog-gate-ci-offline/1.0"})
    buf = bytearray()
    with urllib.request.urlopen(req, timeout=remaining(deadline, 30.0)) as resp:
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status} for {url}")
        while True:
            remaining(deadline)
            resp.fp.raw._sock.settimeout(remaining(deadline, 15.0)) if getattr(getattr(resp, "fp", None), "raw", None) and getattr(resp.fp.raw, "_sock", None) else None
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
                remaining(deadline)
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
                            remaining(deadline)
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


def read_regular_file_bounded(fpath: Path, expected_size: int, max_bytes: int, deadline: float = None) -> bytes:
    if expected_size < 0 or expected_size > max_bytes:
        raise RuntimeError(f"File size {expected_size} out of bounds (max {max_bytes}) for {fpath.name}")
    buf = bytearray()
    with fpath.open("rb") as f:
        while True:
            remaining(deadline)
            chunk = f.read(65536)
            if not chunk:
                break
            if len(buf) + len(chunk) > max_bytes:
                raise RuntimeError(f"File grew beyond max_bytes ({max_bytes}) while reading {fpath.name}")
            buf.extend(chunk)
    if len(buf) != expected_size:
        raise RuntimeError(f"File size changed during read ({len(buf)} != {expected_size}) for {fpath.name}")
    return bytes(buf)


def emit_evidence_files(evidence_dir: Path, max_file_bytes: int, max_total_bytes: int, require_all: bool, deadline: float = None) -> dict:
    emitted = []
    errors = []
    total_bytes = 0
    try:
        remaining(deadline)
        if not evidence_dir or not evidence_dir.is_dir():
            if require_all:
                errors.append("Evidence directory missing")
            return {"ok": len(errors) == 0, "total_bytes": 0, "emitted": emitted, "errors": errors}

        for entry in sorted(os.listdir(evidence_dir)):
            if entry not in ALLOWED_EVIDENCE_FILES:
                errors.append(f"Unexpected file in evidence_dir: {entry}")

        for fname in ALLOWED_EVIDENCE_FILES:
            remaining(deadline)
            fpath = evidence_dir / fname
            try:
                st = os.lstat(fpath)
            except FileNotFoundError:
                if require_all:
                    errors.append(f"Required evidence file missing: {fname}")
                continue
            except Exception as exc:
                errors.append(f"lstat error on {fname}: {exc}")
                continue

            if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
                errors.append(f"Non-regular evidence file: {fname}")
                continue
            st_size = int(st.st_size)
            if st_size < 0 or st_size > max_file_bytes:
                errors.append(f"Evidence file {fname} st_size exceeds max_file_bytes ({st_size} > {max_file_bytes})")
                continue
            if total_bytes + st_size > max_total_bytes:
                errors.append(f"Evidence total st_size exceeds max_total_bytes ({total_bytes + st_size} > {max_total_bytes})")
                continue
            try:
                raw = read_regular_file_bounded(fpath, st_size, max_file_bytes, deadline=deadline)
            except Exception as exc:
                errors.append(f"Read error on {fname}: {exc}")
                continue

            size = len(raw)

            total_bytes += size
            f_sha256 = sha256_bytes(raw)
            payload = {
                "file": fname,
                "bytes": size,
                "sha256": f_sha256,
                "encoding": "base64",
                "data": base64.b64encode(raw).decode("ascii"),
            }
            raw_json = json.dumps(payload, sort_keys=True, ensure_ascii=True).encode("utf-8")
            frame_sha = sha256_bytes(raw_json)
            sys.stdout.write(f"===BEGIN_PAYPAL230_EVIDENCE_FILE:{fname}:SHA256:{frame_sha}===\n")
            sys.stdout.write(raw_json.decode("utf-8") + "\n")
            sys.stdout.write(f"===END_PAYPAL230_EVIDENCE_FILE:{fname}:SHA256:{frame_sha}===\n")
            sys.stdout.flush()
            emitted.append({"file": fname, "bytes": size, "sha256": f_sha256, "frame_sha256": frame_sha})
    except Exception as exc:
        errors.append(f"Unhandled evidence emission error: {exc}")

    return {"ok": len(errors) == 0, "total_bytes": total_bytes, "emitted": emitted, "errors": errors}


def reconcile_and_close_container(
    container_name: str,
    pinned_image_id: str,
    create_intent: bool,
    create_outcome: str,
    created_id_from_cli: str,
    preexisting_before_intent: bool,
    wait_rc_str: str,
    timed_out_waiting: bool,
    closure_deadline: float,
) -> dict:
    rec = {
        "create_intent": create_intent,
        "create_outcome": create_outcome,
        "created_id_from_cli": created_id_from_cli,
        "preexisting_before_intent": preexisting_before_intent,
        "timed_out_waiting": timed_out_waiting,
        "wait_output": wait_rc_str,
        "reconciled_id": None,
        "ownership_verified": False,
        "kill_attempted": False,
        "kill_rc": None,
        "wait_after_kill_rc": None,
        "terminal_inspect": None,
        "rm_attempted": False,
        "rm_rc": None,
        "post_rm_name_scan": None,
        "closure_status": "UNKNOWN",
        "closure_confirmed": False,
        "errors": [],
    }

    if preexisting_before_intent:
        rec["errors"].append("Preexisting container with job name detected before create intent; refusing kill/rm")
        return rec

    if not create_intent:
        rec["closure_status"] = "NOT_CREATED_NO_INTENT"
        rec["closure_confirmed"] = True
        return rec

    try:
        ps_res = run_cmd(
            ["docker", "ps", "-aq", "--no-trunc", "--filter", f"name=^/{container_name}$"],
            timeout=10.0,
            deadline=closure_deadline,
            check=False,
        )
        if ps_res.returncode != 0:
            rec["errors"].append(f"docker ps by name failed (rc={ps_res.returncode}): {ps_res.stderr.strip()[:200]}")
            return rec
        found_ids = [line.strip() for line in ps_res.stdout.splitlines() if line.strip()]
    except Exception as exc:
        rec["errors"].append(f"docker ps exception: {exc}")
        return rec

    if len(found_ids) > 1:
        rec["errors"].append(f"Multiple containers matched name {container_name}: {found_ids}")
        return rec

    if len(found_ids) == 0:
        rec["errors"].append(
            f"create_intent=True (create_outcome={create_outcome}) but no container found by name; cannot prove absence of in-flight daemon creation"
        )
        return rec

    cid = found_ids[0]
    rec["reconciled_id"] = cid
    if created_id_from_cli and cid != created_id_from_cli:
        rec["errors"].append(f"Reconciled ID {cid} != CLI returned ID {created_id_from_cli}")
        return rec

    try:
        insp_res = run_cmd(["docker", "inspect", cid], timeout=10.0, deadline=closure_deadline, check=False)
        if insp_res.returncode != 0:
            rec["errors"].append(f"docker inspect {cid} failed (rc={insp_res.returncode}): {insp_res.stderr.strip()[:200]}")
            return rec
        insp = json.loads(insp_res.stdout)[0]
    except Exception as exc:
        rec["errors"].append(f"docker inspect parse error: {exc}")
        return rec

    obs_id = insp.get("Id")
    obs_name = insp.get("Name")
    obs_image = insp.get("Image")
    obs_labels = (insp.get("Config") or {}).get("Labels") or {}
    obs_label_val = obs_labels.get("cg.run")

    if obs_id != cid:
        rec["errors"].append(f"Inspect Id {obs_id} != {cid}")
    if obs_name != f"/{container_name}":
        rec["errors"].append(f"Inspect Name {obs_name!r} != '/{container_name}'")
    if obs_label_val != container_name:
        rec["errors"].append(f"Inspect label cg.run {obs_label_val!r} != {container_name!r}")
    if not pinned_image_id or obs_image != pinned_image_id:
        rec["errors"].append(f"Inspect Image {obs_image!r} != pinned {pinned_image_id!r}")

    if rec["errors"]:
        return rec

    rec["ownership_verified"] = True
    state_obj = insp.get("State") or {}

    if state_obj.get("Running") is True or state_obj.get("Status") in ("running", "paused", "restarting"):
        rec["kill_attempted"] = True
        try:
            k_res = run_cmd(["docker", "kill", cid], timeout=15.0, deadline=closure_deadline, check=False)
            rec["kill_rc"] = k_res.returncode
            w_res = run_cmd(["docker", "wait", cid], timeout=15.0, deadline=closure_deadline, check=False)
            rec["wait_after_kill_rc"] = w_res.returncode
        except Exception as exc:
            rec["errors"].append(f"kill/wait exception on {cid}: {exc}")
            return rec

        try:
            insp2_res = run_cmd(["docker", "inspect", cid], timeout=10.0, deadline=closure_deadline, check=False)
            if insp2_res.returncode != 0:
                rec["errors"].append(f"post-kill inspect failed (rc={insp2_res.returncode})")
                return rec
            insp = json.loads(insp2_res.stdout)[0]
            state_obj = insp.get("State") or {}
        except Exception as exc:
            rec["errors"].append(f"post-kill inspect exception: {exc}")
            return rec

    terminal_status = state_obj.get("Status")
    terminal_running = state_obj.get("Running")
    terminal_pid = state_obj.get("Pid")
    rec["terminal_inspect"] = {
        "status": terminal_status,
        "running": terminal_running,
        "pid": terminal_pid,
        "oom_killed": state_obj.get("OOMKilled"),
        "dead": state_obj.get("Dead"),
        "exit_code": state_obj.get("ExitCode"),
        "error": state_obj.get("Error"),
        "started_at": state_obj.get("StartedAt"),
        "finished_at": state_obj.get("FinishedAt"),
        "observed_closed_at_utc": utc_now(),
    }

    if terminal_running is not False or terminal_pid != 0 or terminal_status not in ("created", "exited", "dead"):
        rec["errors"].append(
            f"Container not in terminal state before rm: status={terminal_status}, running={terminal_running}, pid={terminal_pid}"
        )
        return rec

    rec["rm_attempted"] = True
    try:
        rm_res = run_cmd(["docker", "rm", "--volumes", cid], timeout=20.0, deadline=closure_deadline, check=False)
        rec["rm_rc"] = rm_res.returncode
        if rm_res.returncode != 0:
            rec["errors"].append(f"docker rm {cid} failed (rc={rm_res.returncode}): {rm_res.stderr.strip()[:200]}")
            return rec
    except Exception as exc:
        rec["errors"].append(f"docker rm exception: {exc}")
        return rec

    try:
        scan_res = run_cmd(
            ["docker", "ps", "-aq", "--no-trunc", "--filter", f"name=^/{container_name}$"],
            timeout=10.0,
            deadline=closure_deadline,
            check=False,
        )
        if scan_res.returncode != 0:
            rec["errors"].append(f"post-rm docker ps scan failed (rc={scan_res.returncode})")
            return rec
        rem = scan_res.stdout.strip()
        rec["post_rm_name_scan"] = rem
        if rem != "":
            rec["errors"].append(f"Container still visible by name after rm: {rem}")
            return rec
    except Exception as exc:
        rec["errors"].append(f"post-rm scan exception: {exc}")
        return rec

    rec["closure_status"] = "CLOSED_AND_REMOVED"
    rec["closure_confirmed"] = True
    return rec


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
    total_seconds = float(budgets["total_seconds"])
    reserve_seconds = float(budgets["closure_reserve_seconds"])
    audit_seconds = float(budgets["audit_seconds"])
    total_deadline = t0 + total_seconds
    execution_deadline = total_deadline - reserve_seconds
    closure_deadline = total_deadline - audit_seconds
    max_file_bytes = int(pins["evidence"]["max_file_bytes"])
    max_total_bytes = int(pins["evidence"]["max_total_bytes"])

    def _sigalrm_handler(signum, frame):
        raise DeadlineExpiredError("Global 600s ITIMER_REAL watchdog expired")

    signal.signal(signal.SIGALRM, _sigalrm_handler)
    signal.setitimer(signal.ITIMER_REAL, max(0.1, total_deadline - time.monotonic()))

    workspace_dir = None
    product_dir = None
    evidence_dir = None
    img_id = None
    preexisting_before_intent = False
    create_intent = False
    create_outcome = "NOT_ATTEMPTED"
    created_id_from_cli = None
    wait_rc_str = None
    timed_out_waiting = False

    try:
        # Stage 1: Preflight & exact 55-blob materialization (45s)
        s1_start = time.monotonic()
        s1_deadline = min(execution_deadline, s1_start + float(budgets["preflight_seconds"]))
        set_active_deadline(s1_deadline)

        prod_cfg = pins["product"]
        exp_commit = prod_cfg["commit"]
        exp_tree = prod_cfg["tree"]
        exp_blobs_count = int(prod_cfg["blobs"])
        exp_total_bytes = int(prod_cfg["total_bytes"])
        exp_files = prod_cfg["files"]

        if len(exp_files) != exp_blobs_count:
            raise RuntimeError(f"pins.json files length ({len(exp_files)}) != blobs ({exp_blobs_count})")

        head_sha = run_cmd(["git", "rev-parse", "HEAD"], cwd=repo_root, timeout=10).stdout.strip()
        github_sha = os.environ.get("GITHUB_SHA", "").strip()
        if not re.fullmatch(r"[0-9a-f]{40}", github_sha) or head_sha != github_sha:
            raise RuntimeError(f"HEAD ({head_sha}) != GITHUB_SHA ({github_sha})")
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

        # Verify exact 5-file overlay via git diff-tree and match working files to HEAD blobs
        diff_res = run_cmd(
            ["git", "diff-tree", "-r", "--no-renames", exp_commit, head_sha],
            cwd=repo_root,
            timeout=15,
        )
        overlay_blobs = {}
        for line in diff_res.stdout.splitlines():
            if not line.strip():
                continue
            meta, path_str = line.split("\t", 1)
            validate_rel_path(path_str)
            parts = meta.lstrip(":").split()
            old_mode, new_mode, old_blob, new_blob, status = parts[0], parts[1], parts[2], parts[3], parts[4]
            if status != "A" or old_mode != "000000" or not set(old_blob) == {"0"}:
                raise RuntimeError(f"Non-addition or product change in diff-tree for {path_str}: {status}")
            if new_mode not in ("100644", "100755"):
                raise RuntimeError(f"Unexpected mode {new_mode} for overlay {path_str}")
            if path_str not in ALLOWED_OVERLAY_PATHS:
                raise RuntimeError(f"Disallowed overlay path in diff-tree: {path_str}")
            overlay_blobs[path_str] = new_blob

        if set(overlay_blobs.keys()) != ALLOWED_OVERLAY_PATHS:
            raise RuntimeError(
                f"Overlay paths mismatch: got {sorted(overlay_blobs.keys())}, expected {sorted(ALLOWED_OVERLAY_PATHS)}"
            )
        extra_in_head = sorted(overlay_blobs.keys())

        for ov_rel, exp_ov_blob in overlay_blobs.items():
            remaining(s1_deadline)
            ov_fp = repo_root / ov_rel
            st = os.lstat(ov_fp)
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
                raise RuntimeError(f"Overlay file is not regular: {ov_rel}")
            ov_raw = ov_fp.read_bytes()
            if git_blob_sha1(ov_raw) != exp_ov_blob:
                raise RuntimeError(f"Working overlay file {ov_rel} does not match HEAD blob {exp_ov_blob}")

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
            remaining(s1_deadline)
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
                timeout=remaining(s1_deadline, 10.0),
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

        pre_audit = verify_directory_against_pins(product_dir, exp_files, exp_total_bytes, deadline=s1_deadline)

        # Copy CI runtime files into read-only ci mount directory
        shutil.copy2(repo_root / ".ci" / "inside.mjs", ci_dir / "inside.mjs")
        shutil.copy2(pins_path, ci_dir / "pins.json")
        os.chmod(ci_dir / "inside.mjs", 0o444)
        os.chmod(ci_dir / "pins.json", 0o444)

        s1_dur = time.monotonic() - s1_start
        if s1_dur > float(budgets["preflight_seconds"]):
            raise DeadlineExpiredError(f"Preflight exceeded budget: {s1_dur:.3f}s")
        report["stages"]["preflight"] = {
            "ok": True,
            "duration_seconds": round(s1_dur, 6),
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
        set_active_deadline(s2_deadline)
        tc = pins["toolchain"]
        nm_dir = vendor_dir / "node_modules"
        nm_dir.mkdir(parents=True, exist_ok=True)

        npm_reports = []
        for pkg_spec in tc["npm"]:
            npm_reports.append(download_and_extract_npm_pkg(pkg_spec, nm_dir, s2_deadline))

        for sib in ("playwright", "playwright-core"):
            if not (nm_dir / sib / "package.json").is_file():
                raise RuntimeError(f"Missing extracted sibling package: {sib}")

        run_cmd(
            ["docker", "pull", "--platform", tc["platform"], tc["image"]],
            timeout=remaining(s2_deadline),
            deadline=s2_deadline,
        )
        img_inspect_raw = run_cmd(["docker", "image", "inspect", tc["image"]], timeout=15).stdout
        img_inspect = json.loads(img_inspect_raw)[0]
        repo_digests = img_inspect.get("RepoDigests") or []
        img_id = img_inspect.get("Id")
        img_arch = img_inspect.get("Architecture")
        img_os = img_inspect.get("Os")
        img_cfg = img_inspect.get("Config") or {}
        if tc["image"] not in repo_digests:
            raise RuntimeError(f"Pulled image RepoDigests {repo_digests} does not contain pinned {tc['image']}")
        if img_os != "linux" or img_arch != "amd64":
            raise RuntimeError(f"Pulled image platform mismatch: os={img_os} arch={img_arch}, expected linux/amd64")
        if not img_id:
            raise RuntimeError("Pulled image Id is missing")

        s2_dur = time.monotonic() - s2_start
        if s2_dur > float(budgets["toolchain_seconds"]):
            raise DeadlineExpiredError(f"Toolchain stage exceeded budget: {s2_dur:.3f}s")
        report["stages"]["toolchain"] = {
            "ok": True,
            "duration_seconds": round(s2_dur, 6),
            "image": tc["image"],
            "image_id": img_id,
            "repo_digests": repo_digests,
            "architecture": img_arch,
            "os": img_os,
            "image_config_entrypoint": img_cfg.get("Entrypoint"),
            "image_config_volumes": img_cfg.get("Volumes"),
            "npm_packages": npm_reports,
        }

        # Stage 3-6 Execution budget (isolation 15s + unit 90s + C3a 90s + U1 90s = 285s, hard cutoff at execution_deadline 480s)
        s_exec_start = time.monotonic()
        stage_exec_budget = (
            float(budgets["isolation_seconds"])
            + float(budgets["unit_seconds"])
            + float(budgets["e2e_C3a_seconds"])
            + float(budgets["e2e_U1_seconds"])
        )
        exec_wait_deadline = min(execution_deadline, s_exec_start + stage_exec_budget)
        set_active_deadline(exec_wait_deadline)

        # Create single container (collision precheck by NAME only)
        existing = run_cmd(
            ["docker", "ps", "-aq", "--filter", f"name=^/{container_name}$"],
            timeout=10,
        ).stdout.strip()
        if existing:
            preexisting_before_intent = True
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
        create_timeout = remaining(exec_wait_deadline, 20.0)
        create_intent = True
        create_outcome = "UNCERTAIN"
        try:
            create_res = subprocess.run(
                create_args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=create_timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            create_outcome = "UNCERTAIN"
            raise RuntimeError(f"docker create timed out (outcome uncertain): {exc}") from exc
        except Exception as exc:
            create_outcome = "UNCERTAIN"
            raise RuntimeError(f"docker create execution error (outcome uncertain): {exc}") from exc

        if create_res.returncode != 0:
            create_outcome = "UNCERTAIN"
            raise RuntimeError(f"docker create failed (rc={create_res.returncode}): {create_res.stderr.strip()[:400]}")

        container_id = create_res.stdout.strip()
        if not re.fullmatch(r"[0-9a-f]{64}", container_id):
            create_outcome = "UNCERTAIN"
            raise RuntimeError(f"docker create returned non-64-hex ID: {container_id!r}")
        created_id_from_cli = container_id
        create_outcome = "CREATED"

        pre_inspect = json.loads(run_cmd(["docker", "inspect", container_name], timeout=10).stdout)[0]
        hc = pre_inspect.get("HostConfig") or {}
        ccfg = pre_inspect.get("Config") or {}
        mounts = pre_inspect.get("Mounts") or []
        mount_summary = [
            {
                "Destination": m.get("Destination"),
                "Source": m.get("Source"),
                "RW": m.get("RW"),
                "Type": m.get("Type"),
            }
            for m in mounts
        ]

        profile_mismatches = []
        container_image_id = pre_inspect.get("Image")
        if container_image_id != img_id:
            profile_mismatches.append(f"Container Image {container_image_id} != pinned image_id {img_id}")
        if hc.get("NetworkMode") != "none":
            profile_mismatches.append(f"NetworkMode={hc.get('NetworkMode')} != 'none'")
        if hc.get("ReadonlyRootfs") is not True:
            profile_mismatches.append(f"ReadonlyRootfs={hc.get('ReadonlyRootfs')} != True")
        if hc.get("Init") is not True:
            profile_mismatches.append(f"Init={hc.get('Init')} != True")
        if hc.get("Privileged") is not False:
            profile_mismatches.append(f"Privileged={hc.get('Privileged')} != False")
        if hc.get("CapDrop") != ["ALL"]:
            profile_mismatches.append(f"CapDrop={hc.get('CapDrop')} != ['ALL']")
        if hc.get("CapAdd") not in (None, []):
            profile_mismatches.append(f"CapAdd={hc.get('CapAdd')} must be empty/None")
        sec_opt = hc.get("SecurityOpt") or []
        if not isinstance(sec_opt, list) or len(sec_opt) != 1 or sec_opt[0] not in ("no-new-privileges", "no-new-privileges:true"):
            profile_mismatches.append(f"SecurityOpt={sec_opt} invalid")
        if hc.get("IpcMode") != "private":
            profile_mismatches.append(f"IpcMode={hc.get('IpcMode')} != 'private'")
        exp_shm = int(rt["shm_bytes"])
        if hc.get("ShmSize") != exp_shm:
            profile_mismatches.append(f"ShmSize={hc.get('ShmSize')} != {exp_shm}")
        exp_nano_cpus = int(rt["cpus"]) * 1_000_000_000
        if hc.get("NanoCpus") != exp_nano_cpus:
            profile_mismatches.append(f"NanoCpus={hc.get('NanoCpus')} != {exp_nano_cpus}")
        exp_mem = int(rt["memory_bytes"])
        if hc.get("Memory") != exp_mem:
            profile_mismatches.append(f"Memory={hc.get('Memory')} != {exp_mem}")
        exp_pids = int(rt["pids_limit"])
        if hc.get("PidsLimit") != exp_pids:
            profile_mismatches.append(f"PidsLimit={hc.get('PidsLimit')} != {exp_pids}")
        if hc.get("Binds") not in (None, []):
            profile_mismatches.append(f"HostConfig.Binds={hc.get('Binds')} must be empty/None")
        if hc.get("Devices") not in (None, []):
            profile_mismatches.append(f"HostConfig.Devices={hc.get('Devices')} must be empty/None")
        if ccfg.get("WorkingDir") != "/product":
            profile_mismatches.append(f"Config.WorkingDir={ccfg.get('WorkingDir')} != '/product'")
        if ccfg.get("Volumes") not in (None, {}):
            profile_mismatches.append(f"Config.Volumes={ccfg.get('Volumes')} must be empty/None")

        tmpfs_map = hc.get("Tmpfs") or {}
        exp_tmpfs_bytes = int(rt["tmpfs_bytes"])
        if list(tmpfs_map.keys()) != ["/tmp"]:
            profile_mismatches.append(f"HostConfig.Tmpfs keys={list(tmpfs_map.keys())} != ['/tmp']")
        else:
            tmpfs_opts = [tok.strip() for tok in str(tmpfs_map["/tmp"]).split(",") if tok.strip()]
            allowed_size_tokens = {f"size={exp_tmpfs_bytes}", "size=1048576k", "size=1024m", "size=1g"}
            allowed_mode_tokens = {"mode=1777"}
            has_rw = "rw" in tmpfs_opts
            has_nosuid = "nosuid" in tmpfs_opts
            size_matches = [t for t in tmpfs_opts if t in allowed_size_tokens]
            mode_matches = [t for t in tmpfs_opts if t in allowed_mode_tokens]
            if not (has_rw and has_nosuid and len(size_matches) == 1 and len(mode_matches) == 1 and len(tmpfs_opts) == 4):
                profile_mismatches.append(f"HostConfig.Tmpfs['/tmp']={tmpfs_map['/tmp']!r} invalid")

        expected_binds = {
            "/product": (str(product_dir.resolve()), False),
            "/ci": (str(ci_dir.resolve()), False),
            "/vendor": (str(vendor_dir.resolve()), False),
            "/evidence": (str(evidence_dir.resolve()), True),
        }
        observed_binds = {}
        for m in mount_summary:
            m_type = m.get("Type")
            m_dst = m.get("Destination")
            if m_type == "tmpfs":
                if m_dst != "/tmp" or m.get("RW") is not True:
                    profile_mismatches.append(f"Unexpected tmpfs mount in Mounts: {m}")
            elif m_type == "bind":
                if m_dst in observed_binds:
                    profile_mismatches.append(f"Duplicate bind mount destination: {m_dst}")
                observed_binds[m_dst] = m
            else:
                profile_mismatches.append(f"Disallowed mount type in Mounts: {m}")

        if set(observed_binds.keys()) != set(expected_binds.keys()):
            profile_mismatches.append(
                f"Bind mount destinations {sorted(observed_binds.keys())} != {sorted(expected_binds.keys())}"
            )
        else:
            for dst, (exp_src, exp_rw) in expected_binds.items():
                obs_m = observed_binds[dst]
                obs_src = str(Path(obs_m.get("Source") or "").resolve()) if obs_m.get("Source") else ""
                if obs_src != exp_src:
                    profile_mismatches.append(f"Bind mount {dst} Source {obs_src!r} != {exp_src!r}")
                if obs_m.get("RW") is not exp_rw:
                    profile_mismatches.append(f"Bind mount {dst} RW={obs_m.get('RW')} != {exp_rw}")

        report["stages"]["container_profile_before_start"] = {
            "ok": len(profile_mismatches) == 0,
            "container_id": container_id,
            "container_image_id": container_image_id,
            "pinned_image_id": img_id,
            "network_mode": hc.get("NetworkMode"),
            "readonly_rootfs": hc.get("ReadonlyRootfs"),
            "init": hc.get("Init"),
            "privileged": hc.get("Privileged"),
            "cap_drop": hc.get("CapDrop"),
            "cap_add": hc.get("CapAdd"),
            "security_opt": hc.get("SecurityOpt"),
            "ipc_mode": hc.get("IpcMode"),
            "shm_size": hc.get("ShmSize"),
            "nano_cpus": hc.get("NanoCpus"),
            "memory": hc.get("Memory"),
            "pids_limit": hc.get("PidsLimit"),
            "binds": hc.get("Binds"),
            "devices": hc.get("Devices"),
            "tmpfs": hc.get("Tmpfs"),
            "working_dir": ccfg.get("WorkingDir"),
            "config_volumes": ccfg.get("Volumes"),
            "mounts": mount_summary,
            "mismatches": profile_mismatches,
        }
        if profile_mismatches:
            raise RuntimeError(f"Container profile verification failed before start: {profile_mismatches}")

        run_cmd(["docker", "start", container_name], timeout=15.0, deadline=exec_wait_deadline)
        try:
            wait_res = run_cmd(
                ["docker", "wait", container_name],
                timeout=remaining(exec_wait_deadline),
                deadline=exec_wait_deadline,
                check=False,
            )
            wait_rc_str = wait_res.stdout.strip()
        except (subprocess.TimeoutExpired, DeadlineExpiredError):
            timed_out_waiting = True
            wait_rc_str = "TIMEOUT"

        set_active_deadline(closure_deadline)
        closure_rec = reconcile_and_close_container(
            container_name=container_name,
            pinned_image_id=img_id,
            create_intent=create_intent,
            create_outcome=create_outcome,
            created_id_from_cli=created_id_from_cli,
            preexisting_before_intent=preexisting_before_intent,
            wait_rc_str=wait_rc_str,
            timed_out_waiting=timed_out_waiting,
            closure_deadline=closure_deadline,
        )
        report["cleanup"]["container_closure"] = closure_rec
        t_insp = closure_rec.get("terminal_inspect") or {}
        report["stages"]["container_terminal_state"] = {
            "timed_out_waiting": timed_out_waiting,
            "wait_output": wait_rc_str,
            **t_insp,
        }
        report["cleanup"]["container_removed_before_audit"] = bool(closure_rec.get("closure_confirmed"))
        if not closure_rec.get("closure_confirmed"):
            raise RuntimeError(f"Container closure not confirmed before audit: {closure_rec.get('errors')}")

        # Stage 7: Post-execution audit of 55 product blobs & evidence collection (30s)
        s7_start = time.monotonic()
        s7_deadline = min(total_deadline, s7_start + audit_seconds)
        set_active_deadline(s7_deadline)
        post_audit = verify_directory_against_pins(product_dir, exp_files, exp_total_bytes, deadline=s7_deadline)
        inside_summary_path = evidence_dir / "inside-summary.json"
        inside_summary = None
        try:
            st_sum = os.lstat(inside_summary_path)
        except FileNotFoundError:
            st_sum = None
        if st_sum is not None:
            if stat.S_ISLNK(st_sum.st_mode) or not stat.S_ISREG(st_sum.st_mode):
                raise RuntimeError("inside-summary.json is not a regular file")
            raw_inside = read_regular_file_bounded(inside_summary_path, int(st_sum.st_size), max_file_bytes, deadline=s7_deadline)
            inside_summary = json.loads(raw_inside.decode("utf-8"))

        s7_dur = time.monotonic() - s7_start
        if s7_dur > audit_seconds:
            raise DeadlineExpiredError(f"Post-audit stage exceeded budget: {s7_dur:.3f}s")
        report["stages"]["inside"] = inside_summary
        report["stages"]["post_audit"] = {
            "ok": True,
            "duration_seconds": round(s7_dur, 6),
            "audit_started_after_closure_utc": utc_now(),
            "post_audit": post_audit,
            "container_removed_confirmed": bool(closure_rec.get("closure_confirmed")),
        }

        # Final strict fail-closed verification
        if timed_out_waiting:
            raise RuntimeError("Container execution timed out")
        if t_insp.get("running") is not False or t_insp.get("pid") != 0 or t_insp.get("status") != "exited":
            raise RuntimeError("Container still running at inspect")
        if t_insp.get("oom_killed") is not False:
            raise RuntimeError("Container was OOMKilled")
        if t_insp.get("exit_code") != 0:
            raise RuntimeError(f"Container exited with non-zero code: {t_insp.get('exit_code')}")
        if not t_insp.get("finished_at") or str(t_insp.get("finished_at")).startswith("0001-"):
            raise RuntimeError("Container FinishedAt timestamp invalid")
        if closure_rec.get("post_rm_name_scan") != "":
            raise RuntimeError("Owned container still present after rm")
        if not inside_summary or inside_summary.get("ok") is not True:
            raise RuntimeError(f"inside.mjs reported failure: {inside_summary.get('failure_reason') if inside_summary else 'missing summary'}")

        ev_emission = emit_evidence_files(evidence_dir, max_file_bytes, max_total_bytes, require_all=True, deadline=s7_deadline)
        report["stages"]["evidence_emission"] = ev_emission
        if not ev_emission.get("ok"):
            raise RuntimeError(f"Evidence emission failed: {ev_emission.get('errors')}")

        remaining(s7_deadline)
        if workspace_dir and workspace_dir.exists():
            shutil.rmtree(workspace_dir, ignore_errors=True)
            report["cleanup"]["workspace_removed"] = not workspace_dir.exists()
        workspace_dir = None

        remaining(s7_deadline)
        audit_elapsed = time.monotonic() - s7_start
        if audit_elapsed > audit_seconds:
            raise DeadlineExpiredError(f"Post-audit + evidence + cleanup exceeded budget: {audit_elapsed:.6f}s > {audit_seconds}s")
        report["stages"]["post_audit"]["duration_seconds"] = round(audit_elapsed, 6)

        elapsed = time.monotonic() - t0
        if not (0.0 < elapsed <= total_seconds):
            raise DeadlineExpiredError(f"Total elapsed {elapsed:.6f}s outside valid budget (0, {total_seconds}]")
        signal.setitimer(signal.ITIMER_REAL, 0)
        report["ok"] = True
        report["finished_at_utc"] = utc_now()
        report["total_duration_seconds"] = elapsed
        emit_framed_report(report)
        return 0

    except Exception as exc:
        signal.setitimer(signal.ITIMER_REAL, 0)
        report["ok"] = False
        report["failure_reason"] = str(exc)
        if "container_closure" not in report["cleanup"]:
            closure_rec = reconcile_and_close_container(
                container_name=container_name,
                pinned_image_id=img_id,
                create_intent=create_intent,
                create_outcome=create_outcome,
                created_id_from_cli=created_id_from_cli,
                preexisting_before_intent=preexisting_before_intent,
                wait_rc_str=wait_rc_str,
                timed_out_waiting=timed_out_waiting,
                closure_deadline=closure_deadline,
            )
            report["cleanup"]["container_closure"] = closure_rec
            report["cleanup"]["container_removed_before_audit"] = bool(closure_rec.get("closure_confirmed"))
        else:
            closure_rec = report["cleanup"]["container_closure"]

        if workspace_dir and closure_rec.get("closure_confirmed"):
            fail_audit_deadline = min(total_deadline, time.monotonic() + audit_seconds)
            if product_dir and product_dir.is_dir() and "post_audit" not in report["stages"]:
                try:
                    report["stages"]["post_audit"] = {
                        "ok": True,
                        "audit_started_after_closure_utc": utc_now(),
                        "post_audit": verify_directory_against_pins(
                            product_dir, pins["product"]["files"], int(pins["product"]["total_bytes"]),
                            deadline=fail_audit_deadline,
                        ),
                        "container_removed_confirmed": True,
                    }
                except Exception as pa_exc:
                    report["stages"]["post_audit"] = {"ok": False, "error": str(pa_exc)}
            if evidence_dir and evidence_dir.is_dir():
                sum_fp = evidence_dir / "inside-summary.json"
                if not report["stages"].get("inside"):
                    try:
                        remaining(fail_audit_deadline)
                        st_s = os.lstat(sum_fp)
                        if not stat.S_ISLNK(st_s.st_mode) and stat.S_ISREG(st_s.st_mode):
                            raw_s = read_regular_file_bounded(sum_fp, int(st_s.st_size), max_file_bytes, deadline=fail_audit_deadline)
                            report["stages"]["inside"] = json.loads(raw_s.decode("utf-8"))
                    except Exception:
                        pass
                if "evidence_emission" not in report["stages"]:
                    try:
                        report["stages"]["evidence_emission"] = emit_evidence_files(
                            evidence_dir, max_file_bytes, max_total_bytes, require_all=False, deadline=fail_audit_deadline
                        )
                    except Exception as ev_exc:
                        report["stages"]["evidence_emission"] = {"ok": False, "errors": [str(ev_exc)]}
            if time.monotonic() <= total_deadline:
                shutil.rmtree(workspace_dir, ignore_errors=True)
                report["cleanup"]["workspace_removed"] = not workspace_dir.exists()
            else:
                report["cleanup"]["workspace_retained_due_to_deadline_expiry"] = True
        elif workspace_dir:
            report["cleanup"]["workspace_retained_due_to_unconfirmed_closure"] = True
        signal.setitimer(signal.ITIMER_REAL, 0)
        report["finished_at_utc"] = utc_now()
        report["total_duration_seconds"] = time.monotonic() - t0
        emit_framed_report(report)
        return 1


if __name__ == "__main__":
    sys.exit(main())
