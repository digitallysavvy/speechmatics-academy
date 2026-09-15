"""Create, normalize, and validate the backend's local .env file."""

from __future__ import annotations

import argparse
from pathlib import Path

REQUIRED_KEYS = (
    "AGORA_APP_ID",
    "AGORA_APP_CERTIFICATE",
    "SPEECHMATICS_API_KEY",
)
LEGACY_ALIASES = {
    "AGORA_APP_ID": "APP_ID",
    "AGORA_APP_CERTIFICATE": "APP_CERTIFICATE",
}


def read_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def is_unconfigured(value: str | None) -> bool:
    normalized = (value or "").strip().lower()
    return not normalized or normalized.startswith(("your_", "replace_", "changeme"))


def set_value(lines: list[str], key: str, value: str) -> None:
    prefix = f"{key}="
    for index, line in enumerate(lines):
        if line.startswith(prefix):
            lines[index] = f"{prefix}{value}"
            return
    if lines and lines[-1] != "":
        lines.append("")
    lines.append(f"{prefix}{value}")


def ensure_env(target: Path, template: Path) -> tuple[list[str], list[str]]:
    if target.exists():
        lines = target.read_text().splitlines()
    else:
        lines = template.read_text().splitlines()

    values = read_values(target) if target.exists() else read_values(template)
    template_values = read_values(template)
    added: list[str] = []
    migrated: list[str] = []

    for key in REQUIRED_KEYS:
        alias = LEGACY_ALIASES.get(key)
        alias_value = values.get(alias, "") if alias else ""
        if alias and is_unconfigured(values.get(key)) and not is_unconfigured(alias_value):
            set_value(lines, key, alias_value)
            values[key] = alias_value
            migrated.append(key)
        elif key not in values:
            set_value(lines, key, template_values.get(key, ""))
            values[key] = template_values.get(key, "")
            added.append(key)

    legacy_prefixes = tuple(f"{alias}=" for alias in LEGACY_ALIASES.values())
    lines = [line for line in lines if not line.startswith(legacy_prefixes)]
    target.write_text("\n".join(lines).rstrip() + "\n")
    return added, migrated


def invalid_keys(path: Path) -> list[str]:
    values = read_values(path)
    return [key for key in REQUIRED_KEYS if is_unconfigured(values.get(key))]


def print_next_steps(path: Path) -> None:
    invalid = invalid_keys(path)
    print("\n✅ Setup complete!")
    if not invalid:
        print("Environment is already configured.")
        print("Run: bun run dev\n")
        return

    print("Complete the remaining environment steps:")
    step = 1
    if "AGORA_APP_ID" in invalid or "AGORA_APP_CERTIFICATE" in invalid:
        print(f"   {step}. Run: agora project env write server/.env")
        step += 1
        print(f"   {step}. Run: bun run setup:env")
        step += 1
    if "SPEECHMATICS_API_KEY" in invalid:
        print(f"   {step}. Set SPEECHMATICS_API_KEY in server/.env")
        step += 1
    print(f"   {step}. Run: bun run doctor:local")
    step += 1
    print(f"   {step}. Run: bun run dev\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--next-steps", action="store_true")
    args = parser.parse_args()

    server_dir = Path(__file__).resolve().parent.parent
    target = server_dir / ".env"
    template = server_dir / ".env.example"

    if args.next_steps:
        print_next_steps(target)
        return 0

    if args.check:
        invalid = invalid_keys(target)
        if invalid:
            print(f"server/.env needs real values for: {', '.join(invalid)}")
            return 1
        print("Backend env checks passed")
        return 0

    created = not target.exists()
    added, migrated = ensure_env(target, template)
    if created:
        print("Created server/.env from server/.env.example")
    if migrated:
        print(f"Migrated legacy env names: {', '.join(migrated)}")
    if added:
        print(f"Added missing env keys: {', '.join(added)}")
    if not created and not migrated and not added:
        print("server/.env already has the expected key layout")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
