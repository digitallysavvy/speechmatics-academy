"""Select a supported Python and manage the quickstart virtual environment."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional, Tuple

MIN_VERSION = (3, 10)
CANDIDATES = ("python3.13", "python3.12", "python3.11", "python3.10", "python3")


def python_version(executable: str) -> Optional[Tuple[int, int]]:
    result = subprocess.run(
        [str(executable), "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        return None
    try:
        major, minor = result.stdout.strip().split(".", 1)
        return int(major), int(minor)
    except ValueError:
        return None


def select_python() -> Tuple[str, Tuple[int, int]]:
    configured = os.getenv("QUICKSTART_PYTHON")
    names = (configured, *CANDIDATES) if configured else CANDIDATES
    seen: set[str] = set()
    for name in names:
        executable = shutil.which(name) if not os.path.isabs(name) else name
        if not executable or executable in seen:
            continue
        seen.add(executable)
        version = python_version(executable)
        if version and version >= MIN_VERSION:
            return executable, version
    raise RuntimeError("Python 3.10 or newer is required; set QUICKSTART_PYTHON to a supported interpreter")


def check_venv(venv_dir: Path) -> Tuple[int, int]:
    executable = venv_dir / "bin" / "python"
    version = python_version(executable) if executable.exists() else None
    if version is None or version < MIN_VERSION:
        raise RuntimeError("server/venv is missing or uses Python older than 3.10; run bun run setup:backend")
    return version


def ensure_venv(venv_dir: Path, recreate: bool) -> Tuple[Tuple[int, int], bool]:
    try:
        if not recreate:
            return check_venv(venv_dir), False
    except RuntimeError:
        pass

    executable, _ = select_python()
    if venv_dir.exists():
        shutil.rmtree(venv_dir)
    subprocess.run([executable, "-m", "venv", str(venv_dir)], check=True)
    return check_venv(venv_dir), True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-venv", action="store_true")
    parser.add_argument("--ensure-venv", action="store_true")
    parser.add_argument("--recreate", action="store_true")
    args = parser.parse_args()

    server_dir = Path(__file__).resolve().parent.parent
    venv_dir = server_dir / "venv"
    try:
        executable, available_version = select_python()
        print(f"Supported Python available: {executable} ({available_version[0]}.{available_version[1]})")
        if args.check_venv:
            version = check_venv(venv_dir)
            print(f"Backend venv uses Python {version[0]}.{version[1]}")
        if args.ensure_venv:
            version, created = ensure_venv(venv_dir, args.recreate)
            state = "created" if created else "already ready"
            print(f"Backend venv {state} with Python {version[0]}.{version[1]}")
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(exc)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
