---
name: ponytail-help
description: >
  Quick-reference card for all Ponytail modes, skills, and OMP commands.
  One-shot display, not a persistent mode. Trigger: /ponytail-help,
  "ponytail help", "what ponytail commands", "how do I use ponytail".
---

# Ponytail Help

Display this reference card when invoked. One-shot; do not change mode or
persist anything.

## Levels

| Level | Trigger | What changes |
|-------|---------|--------------|
| **Lite** | `/ponytail lite` | Build what's asked, name the lazier alternative in one line. |
| **Full** | `/ponytail` | Enforce the ladder: YAGNI, reuse, stdlib, native, minimum. Default. |
| **Ultra** | `/ponytail ultra` | Deletion first; challenge speculative requirements. |

The level persists in the OMP session history.

## Skills

| Skill | Trigger | What it does |
|-------|---------|--------------|
| **ponytail** | `/ponytail` | Minimal senior-developer mode. |
| **ponytail-review** | `/ponytail-review` | Review a diff only for over-engineering. |
| **ponytail-audit** | `/ponytail-audit` | Audit the repo for removable complexity. |
| **ponytail-debt** | `/ponytail-debt` | Collect `ponytail:` shortcut comments. |
| **ponytail-gain** | `/ponytail-gain` | Show published benchmark impact. |
| **ponytail-help** | `/ponytail-help` | Show this card. |

## Deactivate

Say "stop ponytail" or "normal mode". `/ponytail off` also works. Resume
with `/ponytail`.

## Configure default mode

`PONYTAIL_DEFAULT_MODE=off|lite|full|ultra` has highest priority. Otherwise
set `defaultMode` in `~/.config/ponytail/config.json` (or the platform config
directory). The fallback is `full`.

Optional settings:

```json
{
  "defaultMode": "lite",
  "hideStatus": false,
  "quietStartup": false
}
```

Environment overrides: `PONYTAIL_HIDE_STATUS` and
`PONYTAIL_QUIET_STARTUP`.

## More

Original project and documentation: https://github.com/DietrichGebert/ponytail
